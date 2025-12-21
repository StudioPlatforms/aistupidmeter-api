/**
 * PHASE 2: Drift Detection Infrastructure
 * Core library for behavioral drift detection, change-point analysis, and regime classification
 */

import { db } from '../db';
import { scores, models, change_points } from '../db/schema';
import { eq, desc, and, gte, sql } from 'drizzle-orm';
import { calculateConfidenceInterval, calculateStdDev } from './statistical-tests';

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

export interface DriftSignature {
  modelId: number;
  modelName: string;
  timestamp: Date;
  
  // Current state
  baselineScore: number;
  currentScore: number;
  confidenceInterval: [number, number];
  
  // Stability metrics
  regime: 'STABLE' | 'VOLATILE' | 'DEGRADED' | 'RECOVERING';
  variance24h: number;
  driftStatus: 'NORMAL' | 'WARNING' | 'ALERT';
  pageHinkleyCUSUM: number;
  
  // Temporal context
  lastSignificantChange?: Date;
  hoursSinceChange?: number;
  
  // Dimensional breakdown
  axes: {
    [key: string]: AxisMetric;
  };
  
  // Actionability
  primaryIssue?: string;
  recommendation?: string;
}

export interface AxisMetric {
  value: number;
  trend: 'up' | 'down' | 'stable';
  changeMagnitude: number;
  status: 'STABLE' | 'VOLATILE' | 'DEGRADED';
}

export interface ChangePoint {
  id?: number;
  modelId: number;
  timestamp: Date;
  fromScore: number;
  toScore: number;
  delta: number;
  significance: number;
  changeType: 'improvement' | 'degradation' | 'shift';
  affectedAxes?: string[];
  suspectedCause?: string;
}

// ============================================================================
// MAIN DRIFT SIGNATURE COMPUTATION
// ============================================================================

/**
 * Compute comprehensive drift signature for a model
 * This is the main entry point called hourly for each model
 */
export async function computeDriftSignature(modelId: number): Promise<DriftSignature> {
  // Get model name
  const modelRecord = await db.select().from(models).where(eq(models.id, modelId)).limit(1);
  if (modelRecord.length === 0) {
    throw new Error(`Model ${modelId} not found`);
  }
  const modelName = modelRecord[0].name;
  
  // Step 1: Get recent score history
  const twentyEightDaysAgo = new Date(Date.now() - 28 * 24 * 60 * 60 * 1000);
  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  
  const allScores = await db
    .select()
    .from(scores)
    .where(and(
      eq(scores.modelId, modelId),
      gte(scores.ts, twentyEightDaysAgo.toISOString())
    ))
    .orderBy(desc(scores.ts))
    .limit(200); // Get enough data for analysis
  
  if (allScores.length === 0) {
    throw new Error(`No scores found for model ${modelId}`);
  }
  
  const validScores = allScores.filter(s => 
    s.stupidScore !== null && 
    s.stupidScore >= 0 &&
    s.stupidScore !== -777 &&
    s.stupidScore !== -888 &&
    s.stupidScore !== -999
  );
  
  if (validScores.length === 0) {
    throw new Error(`No valid scores found for model ${modelId}`);
  }
  
  // Step 2: Calculate baseline (28-day average)
  const scoreValues = validScores.map(s => Math.max(0, Math.min(100, Math.round(s.stupidScore))));
  const baselineScore = Math.round(
    scoreValues.reduce((a, b) => a + b, 0) / scoreValues.length
  );
  
  // Step 3: Get current score
  const currentScore = scoreValues[0];
  
  // Step 4: Calculate confidence interval
  const recentScores = scoreValues.slice(0, Math.min(5, scoreValues.length));
  const ci = calculateConfidenceInterval(recentScores);
  
  // Step 5: Calculate 24h variance
  const last24hScores = validScores
    .filter(s => s.ts && new Date(s.ts) > twentyFourHoursAgo)
    .map(s => Math.max(0, Math.min(100, Math.round(s.stupidScore))));
  const variance24h = last24hScores.length >= 3 ? calculateStdDev(last24hScores) : 0;
  
  // Step 6: Determine regime
  const regime = determineRegime(currentScore, baselineScore, variance24h, ci);
  
  // Step 7: Calculate Page-Hinkley CUSUM
  const pageHinkleyCUSUM = validScores[0]?.cusum || 0;
  
  // Step 8: Determine drift status
  const driftStatus = determineDriftStatus(regime, pageHinkleyCUSUM, variance24h);
  
  // Step 9: Find last significant change
  const lastChange = await findLastSignificantChange(modelId);
  
  // Step 10: Analyze per-axis trends
  const axes = await analyzeAxesTrends(modelId, validScores);
  
  // Step 11: Identify primary issue and recommendation
  const { primaryIssue, recommendation } = diagnoseIssue(regime, axes, variance24h, currentScore, baselineScore);
  
  // Step 12: Construct signature
  const signature: DriftSignature = {
    modelId,
    modelName,
    timestamp: new Date(),
    baselineScore,
    currentScore,
    confidenceInterval: [Math.round(ci.lower), Math.round(ci.upper)],
    regime,
    variance24h: Math.round(variance24h * 10) / 10,
    driftStatus,
    pageHinkleyCUSUM,
    lastSignificantChange: lastChange?.timestamp,
    hoursSinceChange: lastChange ? 
      Math.round((Date.now() - lastChange.timestamp.getTime()) / (1000 * 60 * 60)) : undefined,
    axes,
    primaryIssue,
    recommendation
  };
  
  return signature;
}

// ============================================================================
// REGIME CLASSIFICATION
// ============================================================================

/**
 * Determine stability regime based on metrics
 */
function determineRegime(
  current: number,
  baseline: number,
  variance: number,
  ci: any
): 'STABLE' | 'VOLATILE' | 'DEGRADED' | 'RECOVERING' {
  const delta = baseline - current; // Positive = degraded, negative = improved
  const ciWidth = ci.upper - ci.lower;
  
  // DEGRADED: Score significantly below baseline and outside CI
  if (delta > ciWidth && delta > 8) {
    return 'DEGRADED';
  }
  
  // RECOVERING: Improving from degraded state (score above baseline)
  if (delta < -5 && variance < 8) {
    // Check if was previously degraded by looking at trend
    return 'RECOVERING';
  }
  
  // VOLATILE: High variance regardless of score
  if (variance > 8) {
    return 'VOLATILE';
  }
  
  // STABLE: Low variance, within expected range
  return 'STABLE';
}

/**
 * Determine drift alert status
 */
function determineDriftStatus(
  regime: string,
  cusum: number,
  variance: number
): 'NORMAL' | 'WARNING' | 'ALERT' {
  // ALERT: Degraded or very high CUSUM
  if (regime === 'DEGRADED' || cusum > 0.10) {
    return 'ALERT';
  }
  
  // WARNING: Volatile or moderate CUSUM
  if (regime === 'VOLATILE' || cusum > 0.05 || variance > 8) {
    return 'WARNING';
  }
  
  // NORMAL: Stable or recovering
  return 'NORMAL';
}

// ============================================================================
// AXIS-LEVEL TREND ANALYSIS
// ============================================================================

/**
 * Analyze trends per axis for dimensional breakdown
 */
async function analyzeAxesTrends(modelId: number, recentScores: any[]): Promise<{[key: string]: AxisMetric}> {
  const axes: {[key: string]: AxisMetric} = {};
  const axisNames = ['correctness', 'spec', 'codeQuality', 'efficiency', 'stability', 'refusal', 'recovery'];
  
  for (const axisName of axisNames) {
    // Extract axis values from recent scores
    const axisValues = recentScores
      .map(s => s.axes?.[axisName])
      .filter(v => v !== null && v !== undefined && typeof v === 'number')
      .slice(0, 10);
    
    if (axisValues.length < 3) {
      axes[axisName] = {
        value: 0.5,
        trend: 'stable',
        changeMagnitude: 0,
        status: 'STABLE'
      };
      continue;
    }
    
    const current = axisValues[0];
    const baseline = axisValues.reduce((a, b) => a + b, 0) / axisValues.length;
    const variance = calculateStdDev(axisValues);
    
    // Determine trend (comparing recent 3 vs older 3)
    const recentAvg = axisValues.slice(0, Math.min(3, axisValues.length)).reduce((a, b) => a + b, 0) / Math.min(3, axisValues.length);
    const olderAvg = axisValues.length >= 6 
      ? axisValues.slice(-3).reduce((a, b) => a + b, 0) / 3
      : baseline;
    const changeMagnitude = Math.round((recentAvg - olderAvg) * 100); // Convert to percentage points
    
    let trend: 'up' | 'down' | 'stable' = 'stable';
    if (changeMagnitude > 5) trend = 'up';
    else if (changeMagnitude < -5) trend = 'down';
    
    // Determine status
    let status: 'STABLE' | 'VOLATILE' | 'DEGRADED' = 'STABLE';
    if (variance > 0.15) status = 'VOLATILE';
    if (changeMagnitude < -10) status = 'DEGRADED';
    
    axes[axisName] = {
      value: Math.round(current * 100) / 100,
      trend,
      changeMagnitude,
      status
    };
  }
  
  return axes;
}

// ============================================================================
// ISSUE DIAGNOSIS
// ============================================================================

/**
 * Diagnose primary issue and provide recommendation
 */
function diagnoseIssue(
  regime: string, 
  axes: {[key: string]: AxisMetric}, 
  variance: number,
  currentScore: number,
  baselineScore: number
): {
  primaryIssue?: string;
  recommendation?: string;
} {
  // Check for safety issues (most critical)
  if (axes.refusal?.status === 'DEGRADED' || axes.refusal?.changeMagnitude < -10) {
    return {
      primaryIssue: 'Safety over-refusal detected',
      recommendation: 'Investigate prompt sensitivity, consider rollback if sustained'
    };
  }
  
  // Check for correctness degradation
  if (axes.correctness?.status === 'DEGRADED' || axes.correctness?.changeMagnitude < -10) {
    return {
      primaryIssue: 'Correctness degradation detected',
      recommendation: 'Review recent model updates, check for logic regressions'
    };
  }
  
  // Check for spec/instruction following issues
  if (axes.spec?.status === 'DEGRADED' || axes.spec?.changeMagnitude < -10) {
    return {
      primaryIssue: 'Instruction following issues detected',
      recommendation: 'Test with explicit prompts, verify specification adherence'
    };
  }
  
  // Check for instability
  if (regime === 'VOLATILE') {
    return {
      primaryIssue: `High performance variance (±${variance.toFixed(1)} points)`,
      recommendation: 'Monitor closely for sustained patterns, investigate if persists >24h'
    };
  }
  
  // Check for general degradation
  if (regime === 'DEGRADED') {
    const dropPercent = Math.round(((baselineScore - currentScore) / baselineScore) * 100);
    return {
      primaryIssue: `Overall performance decline (-${dropPercent}% from baseline)`,
      recommendation: 'Immediate investigation required, consider rollback if business-critical'
    };
  }
  
  // No issues detected
  return {};
}

// ============================================================================
// CHANGE-POINT DETECTION
// ============================================================================

/**
 * Detect change-points in score history using sliding window + CI validation
 * Returns newly detected change-points (not already in database)
 */
export async function detectChangePoints(modelId: number): Promise<ChangePoint[]> {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  
  const recentScores = await db
    .select()
    .from(scores)
    .where(and(
      eq(scores.modelId, modelId),
      gte(scores.ts, sevenDaysAgo.toISOString())
    ))
    .orderBy(desc(scores.ts))
    .limit(100);
  
  if (recentScores.length < 10) return []; // Need minimum history
  
  const validScores = recentScores.filter(s => 
    s.stupidScore !== null && 
    s.stupidScore >= 0 &&
    s.stupidScore !== -777 &&
    s.stupidScore !== -888 &&
    s.stupidScore !== -999
  );
  
  if (validScores.length < 10) return [];
  
  const newChangePoints: ChangePoint[] = [];
  
  // Sliding window approach (window size = 5 scores)
  const windowSize = 5;
  for (let i = 0; i < validScores.length - windowSize * 2; i++) {
    const beforeWindow = validScores.slice(i, i + windowSize);
    const afterWindow = validScores.slice(i + windowSize, i + windowSize * 2);
    
    const beforeScoreVals = beforeWindow.map(s => Math.max(0, Math.min(100, Math.round(s.stupidScore))));
    const afterScoreVals = afterWindow.map(s => Math.max(0, Math.min(100, Math.round(s.stupidScore))));
    
    const beforeAvg = beforeScoreVals.reduce((a, b) => a + b, 0) / beforeScoreVals.length;
    const afterAvg = afterScoreVals.reduce((a, b) => a + b, 0) / afterScoreVals.length;
    const delta = afterAvg - beforeAvg; // Positive = improvement, negative = degradation
    
    // Calculate significance using confidence intervals
    const beforeCI = calculateConfidenceInterval(beforeScoreVals);
    const afterCI = calculateConfidenceInterval(afterScoreVals);
    const ciOverlap = !(beforeCI.lower > afterCI.upper || afterCI.lower > beforeCI.upper);
    
    // Change is significant if:
    // 1. Delta > 8 points
    // 2. No CI overlap
    // 3. Delta > 2x CI width
    const avgCIWidth = (beforeCI.upper - beforeCI.lower + afterCI.upper - afterCI.lower) / 2;
    const isSignificant = Math.abs(delta) > 8 && !ciOverlap && Math.abs(delta) > avgCIWidth * 2;
    
    if (isSignificant) {
      const changeTimestamp = new Date(validScores[i + windowSize].ts || new Date());
      
      // Check if this change-point already recorded (within 1 hour window)
      const existingChanges = await db
        .select()
        .from(change_points)
        .where(eq(change_points.model_id, modelId))
        .orderBy(desc(change_points.detected_at))
        .limit(10);
      
      const alreadyRecorded = existingChanges.some(cp => {
        const timeDiff = Math.abs(new Date(cp.detected_at).getTime() - changeTimestamp.getTime());
        return timeDiff < 60 * 60 * 1000; // Within 1 hour
      });
      
      if (!alreadyRecorded) {
        // Analyze which axes were affected
        const affectedAxes = analyzeAffectedAxes(beforeWindow, afterWindow);
        
        newChangePoints.push({
          modelId,
          timestamp: changeTimestamp,
          fromScore: Math.round(beforeAvg * 10) / 10,
          toScore: Math.round(afterAvg * 10) / 10,
          delta: Math.round(delta * 10) / 10,
          significance: Math.round((Math.abs(delta) / avgCIWidth) * 10) / 10,
          changeType: delta > 0 ? 'improvement' : delta < -2 ? 'degradation' : 'shift',
          affectedAxes,
          suspectedCause: inferCause(affectedAxes, delta)
        });
      }
    }
  }
  
  return newChangePoints;
}

/**
 * Analyze which axes were affected by a change
 */
function analyzeAffectedAxes(beforeWindow: any[], afterWindow: any[]): string[] {
  const affected: string[] = [];
  const axisNames = ['correctness', 'spec', 'codeQuality', 'efficiency', 'stability', 'refusal', 'recovery'];
  
  for (const axis of axisNames) {
    const beforeVals = beforeWindow
      .map(s => s.axes?.[axis])
      .filter(v => v !== null && v !== undefined);
    const afterVals = afterWindow
      .map(s => s.axes?.[axis])
      .filter(v => v !== null && v !== undefined);
    
    if (beforeVals.length < 3 || afterVals.length < 3) continue;
    
    const beforeAvg = beforeVals.reduce((a, b) => a + b, 0) / beforeVals.length;
    const afterAvg = afterVals.reduce((a, b) => a + b, 0) / afterVals.length;
    const changePct = Math.abs((afterAvg - beforeAvg) / beforeAvg) * 100;
    
    if (changePct > 10) { // >10% change in this axis
      affected.push(axis);
    }
  }
  
  return affected;
}

/**
 * Infer likely cause of change based on affected axes
 */
function inferCause(affectedAxes: string[], delta: number): string | undefined {
  if (affectedAxes.length === 0) return undefined;
  
  // Safety tuning signature
  if (affectedAxes.includes('refusal') && !affectedAxes.includes('correctness')) {
    return delta > 0 ? 'safety_relaxation' : 'safety_tightening';
  }
  
  // Model update signature (affects multiple axes)
  if (affectedAxes.length >= 3) {
    return delta > 0 ? 'model_improvement' : 'model_regression';
  }
  
  // Performance issue signature
  if (affectedAxes.includes('efficiency') || affectedAxes.includes('stability')) {
    return 'performance_issue';
  }
  
  // Code quality tuning
  if (affectedAxes.includes('codeQuality') && affectedAxes.includes('spec')) {
    return 'output_format_change';
  }
  
  return 'unknown_change';
}

// ============================================================================
// CHANGE-POINT PERSISTENCE
// ============================================================================

/**
 * Record a change-point in the database
 */
export async function recordChangePoint(changePoint: ChangePoint): Promise<void> {
  try {
    await db.insert(change_points).values({
      model_id: changePoint.modelId,
      detected_at: changePoint.timestamp.toISOString(),
      from_score: changePoint.fromScore,
      to_score: changePoint.toScore,
      delta: changePoint.delta,
      significance: changePoint.significance,
      change_type: changePoint.changeType,
      affected_axes: changePoint.affectedAxes ? JSON.stringify(changePoint.affectedAxes) : null,
      suspected_cause: changePoint.suspectedCause || null
    });
    
    console.log(`🔔 Change-point recorded for model ${changePoint.modelId}: ${changePoint.fromScore} → ${changePoint.toScore} (${changePoint.changeType})`);
  } catch (error) {
    console.error(`Failed to record change-point:`, error);
  }
}

/**
 * Find last significant change for a model
 */
async function findLastSignificantChange(modelId: number): Promise<{
  timestamp: Date;
  fromScore: number;
  toScore: number;
} | null> {
  const lastChanges = await db
    .select()
    .from(change_points)
    .where(eq(change_points.model_id, modelId))
    .orderBy(desc(change_points.detected_at))
    .limit(1);
  
  if (lastChanges.length === 0) return null;
  
  const change = lastChanges[0];
  return {
    timestamp: new Date(change.detected_at),
    fromScore: change.from_score,
    toScore: change.to_score
  };
}

/**
 * Get change-point history for a model
 */
export async function getChangePointHistory(modelId: number, limit: number = 10): Promise<ChangePoint[]> {
  const changes = await db
    .select()
    .from(change_points)
    .where(eq(change_points.model_id, modelId))
    .orderBy(desc(change_points.detected_at))
    .limit(limit);
  
  return changes.map(c => ({
    id: c.id,
    modelId: c.model_id,
    timestamp: new Date(c.detected_at),
    fromScore: c.from_score,
    toScore: c.to_score,
    delta: c.delta,
    significance: c.significance,
    changeType: c.change_type as 'improvement' | 'degradation' | 'shift',
    affectedAxes: c.affected_axes ? JSON.parse(c.affected_axes) : undefined,
    suspectedCause: c.suspected_cause || undefined
  }));
}

// ============================================================================
// BATCH OPERATIONS
// ============================================================================

/**
 * Compute drift signatures for all active models
 * Called hourly by scheduled job
 */
export async function computeAllDriftSignatures(): Promise<{
  success: number;
  failed: number;
  alerts: number;
  warnings: number;
}> {
  console.log('🔍 [DRIFT-DETECTION] Computing drift signatures for all models...');
  
  const allModels = await db.select().from(models).where(sql`show_in_rankings = 1`);
  
  let success = 0;
  let failed = 0;
  let alerts = 0;
  let warnings = 0;
  
  for (const model of allModels) {
    try {
      // Compute drift signature
      const signature = await computeDriftSignature(model.id);
      
      if (signature.driftStatus === 'ALERT') alerts++;
      if (signature.driftStatus === 'WARNING') warnings++;
      
      // Detect and record new change-points
      const newChangePoints = await detectChangePoints(model.id);
      for (const cp of newChangePoints) {
        await recordChangePoint(cp);
      }
      
      console.log(`✅ ${model.name}: ${signature.regime} (${signature.driftStatus})`);
      success++;
    } catch (error) {
      console.error(`❌ Failed to compute drift for ${model.name}:`, error);
      failed++;
    }
  }
  
  console.log(`✅ Drift computation complete: ${success} success, ${failed} failed, ${alerts} alerts, ${warnings} warnings`);
  
  return { success, failed, alerts, warnings };
}
