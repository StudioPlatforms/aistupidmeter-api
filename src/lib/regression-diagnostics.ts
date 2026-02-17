/**
 * Regression Diagnostics & Root Cause Analysis
 * 
 * Enhances the existing change_points table with task-level diagnostics
 * to identify exactly which tasks caused score regressions.
 * 
 * HIGH VALUE: Root cause analysis is critical for rapid incident response
 */

import { db } from '../db';
import { scores, change_points, models, runs, metrics, test_case_results } from '../db/schema';
import { eq, desc, and, gte, sql } from 'drizzle-orm';

export interface RegressionDiagnostic {
  modelId: number;
  modelName: string;
  detectedAt: string;
  overallScoreDelta: number;
  affectedTasks: Array<{
    taskId: number;
    taskSlug: string;
    scoreBefore: number;
    scoreAfter: number;
    delta: number;
    failureRate: number;
  }>;
  affectedAxes: Array<{
    axis: string;
    deltaBefore: number;
    deltaAfter: number;
    delta: number;
  }>;
  rootCause: string;
  severity: 'minor' | 'moderate' | 'major' | 'critical';
  recommendation: string;
}

/**
 * Analyze which specific tasks contributed to a score regression
 */
export async function diagnoseRegressionByTask(
  modelId: number,
  beforeTimestamp: string,
  afterTimestamp: string
): Promise<RegressionDiagnostic | null> {
  // Get scores before and after
  const scoresBefore = await db
    .select()
    .from(scores)
    .where(
      and(
        eq(scores.modelId, modelId),
        sql`${scores.ts} < ${beforeTimestamp}`
      )
    )
    .orderBy(desc(scores.ts))
    .limit(5);
  
  const scoresAfter = await db
    .select()
    .from(scores)
    .where(
      and(
        eq(scores.modelId, modelId),
        sql`${scores.ts} >= ${beforeTimestamp}`,
        sql`${scores.ts} <= ${afterTimestamp}`
      )
    )
    .limit(5);
  
  if (scoresBefore.length === 0 || scoresAfter.length === 0) {
    return null;
  }
  
  const avgBefore = scoresBefore.reduce((s, x) => s + x.stupidScore, 0) / scoresBefore.length;
  const avgAfter = scoresAfter.reduce((s, x) => s + x.stupidScore, 0) / scoresAfter.length;
  const overallDelta = avgAfter - avgBefore;
  
  // Only analyze if there's a significant regression
  if (overallDelta >= -2) {
    return null; // Not a meaningful regression
  }
  
  // Analyze task-level performance
  const taskPerformance: Map<number, { before: number[]; after: number[] }> = new Map();
  
  // Get runs before and after
  const runsBefore = await db
    .select({
      taskId: runs.taskId,
      passed: runs.passed
    })
    .from(runs)
    .where(
      and(
        eq(runs.modelId, modelId),
        sql`${runs.ts} < ${beforeTimestamp}`
      )
    )
    .limit(500);
  
  const runsAfter = await db
    .select({
      taskId: runs.taskId,
      passed: runs.passed
    })
    .from(runs)
    .where(
      and(
        eq(runs.modelId, modelId),
        sql`${runs.ts} >= ${beforeTimestamp}`,
        sql`${runs.ts} <= ${afterTimestamp}`
      )
    )
    .limit(500);
  
  // Group by task
  for (const run of runsBefore) {
    if (!run.taskId) continue;
    if (!taskPerformance.has(run.taskId)) {
      taskPerformance.set(run.taskId, { before: [], after: [] });
    }
    taskPerformance.get(run.taskId)!.before.push(run.passed ? 100 : 0);
  }
  
  for (const run of runsAfter) {
    if (!run.taskId) continue;
    if (!taskPerformance.has(run.taskId)) {
      taskPerformance.set(run.taskId, { before: [], after: [] });
    }
    taskPerformance.get(run.taskId)!.after.push(run.passed ? 100 : 0);
  }
  
  // Calculate per-task deltas
  const affectedTasks: Array<{
    taskId: number;
    taskSlug: string;
    scoreBefore: number;
    scoreAfter: number;
    delta: number;
    failureRate: number;
  }> = [];
  
  for (const [taskId, perf] of taskPerformance.entries()) {
    if (perf.before.length < 2 || perf.after.length < 2) continue;
    
    const avgBefore = perf.before.reduce((s, x) => s + x, 0) / perf.before.length;
    const avgAfter = perf.after.reduce((s, x) => s + x, 0) / perf.after.length;
    const delta = avgAfter - avgBefore;
    
    if (delta < -10) { // Significant task-level regression
      const failureRate = perf.after.filter(x => x === 0).length / perf.after.length;
      affectedTasks.push({
        taskId,
        taskSlug: `task_${taskId}`, // Would join with tasks table in production
        scoreBefore: avgBefore,
        scoreAfter: avgAfter,
        delta,
        failureRate
      });
    }
  }
  
  // Analyze axis-level changes
  const affectedAxes: Array<{
    axis: string;
    deltaBefore: number;
    deltaAfter: number;
    delta: number;
  }> = [];
  
  // Compare axes before/after
  const axesBefore = scoresBefore[0]?.axes as Record<string, number> || {};
  const axesAfter = scoresAfter[0]?.axes as Record<string, number> || {};
  
  for (const axis of Object.keys(axesBefore)) {
    if (axis in axesAfter) {
      const delta = axesAfter[axis] - axesBefore[axis];
      if (Math.abs(delta) > 5) { // Significant axis change
        affectedAxes.push({
          axis,
          deltaBefore: axesBefore[axis],
          deltaAfter: axesAfter[axis],
          delta
        });
      }
    }
  }
  
  // Sort affected tasks by severity
  affectedTasks.sort((a, b) => a.delta - b.delta);
  affectedAxes.sort((a, b) => a.delta - b.delta);
  
  // Determine root cause
  let rootCause = 'Unknown';
  if (affectedTasks.length > 0) {
    const worstTask = affectedTasks[0];
    if (worstTask.failureRate > 0.5) {
      rootCause = `High failure rate on ${worstTask.taskSlug} (${(worstTask.failureRate * 100).toFixed(0)}% failures)`;
    } else {
      rootCause = `Performance degradation on ${affectedTasks.length} task(s), worst: ${worstTask.taskSlug} (-${Math.abs(worstTask.delta).toFixed(1)} points)`;
    }
  } else if (affectedAxes.length > 0) {
    const worstAxis = affectedAxes[0];
    rootCause = `${worstAxis.axis} axis degradation (-${Math.abs(worstAxis.delta).toFixed(1)} points)`;
  }
  
  // Determine severity
  let severity: 'minor' | 'moderate' | 'major' | 'critical';
  if (Math.abs(overallDelta) > 15) {
    severity = 'critical';
  } else if (Math.abs(overallDelta) > 10) {
    severity = 'major';
  } else if (Math.abs(overallDelta) > 5) {
    severity = 'moderate';
  } else {
    severity = 'minor';
  }
  
  // Generate recommendation
  let recommendation = '';
  if (affectedTasks.length > 5) {
    recommendation = 'Widespread regression - likely model update or safety tuning. Consider rolling back or investigating API version change.';
  } else if (affectedTasks.length > 0) {
    recommendation = `Investigate specific tasks: ${affectedTasks.slice(0, 3).map(t => t.taskSlug).join(', ')}. May be category-specific issue.`;
  } else {
    recommendation = 'Monitor for continued degradation. May be transient issue.';
  }
  
  // Get model name
  const modelInfo = await db.select().from(models).where(eq(models.id, modelId)).limit(1);
  
  return {
    modelId,
    modelName: modelInfo[0]?.name || 'Unknown',
    detectedAt: afterTimestamp,
    overallScoreDelta: overallDelta,
    affectedTasks: affectedTasks.slice(0, 10), // Top 10
    affectedAxes: affectedAxes.slice(0, 5), // Top 5
    rootCause,
    severity,
    recommendation
  };
}

/**
 * Generate comprehensive regression report
 */
export async function generateRegressionReport(windowDays: number = 7): Promise<string> {
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - windowDays);
  const startTs = startDate.toISOString();
  
  // Get all recent change points
  const recentChanges = await db
    .select()
    .from(change_points)
    .where(
      and(
        gte(change_points.detected_at, startTs),
        eq(change_points.change_type, 'degradation')
      )
    )
    .orderBy(desc(change_points.detected_at))
    .limit(20);
  
  let report = `=== REGRESSION DIAGNOSTICS REPORT ===\n`;
  report += `Analysis Window: Last ${windowDays} days\n`;
  report += `Generated: ${new Date().toISOString()}\n`;
  report += `Total degradations detected: ${recentChanges.length}\n\n`;
  
  for (const change of recentChanges) {
    const diagnostic = await diagnoseRegressionByTask(
      change.model_id,
      change.detected_at,
      new Date(new Date(change.detected_at).getTime() + 24 * 60 * 60 * 1000).toISOString()
    );
    
    if (diagnostic) {
      report += `\n## ${diagnostic.modelName}\n`;
      report += `Detected: ${diagnostic.detectedAt}\n`;
      report += `Severity: ${diagnostic.severity.toUpperCase()}\n`;
      report += `Overall Score Change: ${diagnostic.overallScoreDelta.toFixed(1)} points\n`;
      report += `Root Cause: ${diagnostic.rootCause}\n`;
      report += `Recommendation: ${diagnostic.recommendation}\n`;
      
      if (diagnostic.affectedTasks.length > 0) {
        report += `\nMost Affected Tasks:\n`;
        for (const task of diagnostic.affectedTasks.slice(0, 5)) {
          report += `- ${task.taskSlug}: ${task.scoreBefore.toFixed(0)}% → ${task.scoreAfter.toFixed(0)}% (${task.delta.toFixed(1)} points, ${(task.failureRate * 100).toFixed(0)}% failure rate)\n`;
        }
      }
      
      if (diagnostic.affectedAxes.length > 0) {
        report += `\nAffected Performance Axes:\n`;
        for (const axis of diagnostic.affectedAxes) {
          report += `- ${axis.axis}: ${axis.deltaBefore.toFixed(1)} → ${axis.deltaAfter.toFixed(1)} (${axis.delta > 0 ? '+' : ''}${axis.delta.toFixed(1)})\n`;
        }
      }
      
      report += `\n`;
    }
  }
  
  if (recentChanges.length === 0) {
    report += `\nNo regressions detected in the analysis window.\n`;
  }
  
  return report;
}

/**
 * Store enhanced diagnostic data in change_points table
 */
export async function storeRegressionDiagnostic(
  modelId: number,
  diagnostic: RegressionDiagnostic
): Promise<void> {
  await db.insert(change_points).values({
    model_id: modelId,
    detected_at: diagnostic.detectedAt,
    from_score: diagnostic.affectedTasks[0]?.scoreBefore || 0,
    to_score: diagnostic.affectedTasks[0]?.scoreAfter || 0,
    delta: diagnostic.overallScoreDelta,
    significance: Math.abs(diagnostic.overallScoreDelta) / 2, // Rough estimate
    change_type: 'degradation',
    affected_axes: JSON.stringify(diagnostic.affectedAxes.map(a => a.axis)),
    suspected_cause: diagnostic.rootCause,
    confirmed: false,
    false_alarm: false,
    notes: `Affected ${diagnostic.affectedTasks.length} tasks. ${diagnostic.recommendation}`
  });
}

/**
 * Analyze failure patterns across test cases
 */
export async function analyzeFailurePatterns(
  modelId: number,
  windowDays: number = 7
): Promise<{
  commonFailures: Array<{
    testInput: string;
    failureCount: number;
    errorMessages: string[];
  }>;
  failureRate: number;
  totalTests: number;
}> {
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - windowDays);
  const startTs = startDate.toISOString();
  
  // Get all test case results for this model in the window
  const testResults = await db
    .select({
      testInput: test_case_results.testInput,
      passed: test_case_results.passed,
      errorMessage: test_case_results.errorMessage
    })
    .from(test_case_results)
    .innerJoin(runs, eq(test_case_results.runId, runs.id))
    .where(
      and(
        eq(runs.modelId, modelId),
        gte(runs.ts, startTs)
      )
    )
    .limit(1000);
  
  // Group by test input
  const failureMap = new Map<string, { count: number; errors: string[] }>();
  let totalTests = testResults.length;
  let failedTests = 0;
  
  for (const result of testResults) {
    if (!result.passed) {
      failedTests++;
      const key = result.testInput || 'unknown';
      if (!failureMap.has(key)) {
        failureMap.set(key, { count: 0, errors: [] });
      }
      const entry = failureMap.get(key)!;
      entry.count++;
      if (result.errorMessage && !entry.errors.includes(result.errorMessage)) {
        entry.errors.push(result.errorMessage);
      }
    }
  }
  
  const commonFailures = Array.from(failureMap.entries())
    .map(([testInput, data]) => ({
      testInput,
      failureCount: data.count,
      errorMessages: data.errors.slice(0, 3) // Top 3 error messages
    }))
    .sort((a, b) => b.failureCount - a.failureCount)
    .slice(0, 10); // Top 10 most common failures
  
  return {
    commonFailures,
    failureRate: totalTests > 0 ? failedTests / totalTests : 0,
    totalTests
  };
}
