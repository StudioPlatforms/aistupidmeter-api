/**
 * PHASE 2: Drift Detection Infrastructure
 * Core library for behavioral drift detection, change-point analysis, and regime classification
 */

import { db } from '../db';
import { scores, models, change_points, runs, tasks } from '../db/schema';
import { eq, desc, asc, and, gte, sql, inArray } from 'drizzle-orm';
import { calculateConfidenceInterval, calculateStdDev, mannWhitneyU, welchTTest } from './statistical-tests';

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

  // Frozen "golden" reference (A1): the model's earliest stable performance window.
  // The 28-day rolling baseline gradually absorbs slow drift; comparing against this
  // fixed anchor surfaces creeping degradation the rolling baseline forgets.
  goldenBaselineScore?: number;
  driftVsGolden?: number; // goldenBaseline - current (positive = degraded since launch)
  
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
 * A1: Compute the frozen "golden" baseline — the model's earliest stable performance.
 *
 * Returns the average of an early, post-warmup window of real (non-synthetic) scores.
 * Because the earliest scores never change, this acts as a fixed anchor: a model that
 * degrades gradually over weeks keeps a near-flat 28-day rolling baseline (which absorbs
 * the drift) but shows a growing gap against this golden baseline. Returns null when there
 * is too little early history to anchor reliably.
 */
async function getGoldenBaseline(modelId: number): Promise<number | null> {
  const earliest = await db
    .select({ stupidScore: scores.stupidScore })
    .from(scores)
    .where(and(
      eq(scores.modelId, modelId),
      sql`suite IN ('hourly', 'deep', 'tooling')`,
      sql`(note IS NULL OR note NOT LIKE '%SYNTHETIC%')`
    ))
    .orderBy(asc(scores.ts))
    .limit(40);

  let vals = earliest
    .map(s => s.stupidScore)
    .filter((v): v is number => v !== null && v >= 0 && v !== -777 && v !== -888 && v !== -999)
    .map(v => Math.max(0, Math.min(100, Math.round(v))));

  // Drop a leading run of cold-start / calibration scores (near-zero before the model
  // has stabilized) so the anchor reflects genuine early-healthy performance, not warmup.
  let start = 0;
  while (start < vals.length && vals[start] < 20) start++;
  if (vals.length - start >= 5) vals = vals.slice(start);

  if (vals.length < 5) return null; // not enough early history to anchor
  // Average the first stable window after warmup.
  const window = vals.slice(0, 10);
  return Math.round(window.reduce((a, b) => a + b, 0) / window.length);
}

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
  // PHASE 1 FIX: Filter by suite to avoid mixing canary (binary 30/80) with real scores.
  // Only use hourly, deep, and tooling scores for drift analysis.
  // Also exclude synthetic scores (note contains 'SYNTHETIC' or is_synthetic flag).
  const twentyEightDaysAgo = new Date(Date.now() - 28 * 24 * 60 * 60 * 1000);
  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  
  const allScores = await db
    .select()
    .from(scores)
    .where(and(
      eq(scores.modelId, modelId),
      gte(scores.ts, twentyEightDaysAgo.toISOString()),
      sql`suite IN ('hourly', 'deep', 'tooling')`,
      sql`(note IS NULL OR note NOT LIKE '%SYNTHETIC%')`
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

  // A1: Frozen golden baseline (earliest stable window) + creeping-drift gap.
  const goldenBaselineScore = await getGoldenBaseline(modelId);
  const driftVsGolden = goldenBaselineScore !== null ? goldenBaselineScore - currentScore : undefined;
  
  // Step 4: Calculate confidence interval
  const recentScores = scoreValues.slice(0, Math.min(5, scoreValues.length));
  const ci = calculateConfidenceInterval(recentScores);
  
  // Step 5: Calculate 24h variance
  const last24hScores = validScores
    .filter(s => s.ts && new Date(s.ts) > twentyFourHoursAgo)
    .map(s => Math.max(0, Math.min(100, Math.round(s.stupidScore))));
  const variance24h = last24hScores.length >= 3 ? calculateStdDev(last24hScores) : 0;
  
  // PHASE 2 FIX: Calculate historical standard deviation for adaptive thresholds
  const historicalStdDev = scoreValues.length >= 5 ? calculateStdDev(scoreValues) : 5;
  
  // Step 6: Determine regime with ADAPTIVE thresholds based on model's own history
  const regime = determineRegime(currentScore, baselineScore, variance24h, ci, historicalStdDev);
  
  // Step 7: Calculate Page-Hinkley CUSUM
  const pageHinkleyCUSUM = validScores[0]?.cusum || 0;
  
  // Step 8: Determine drift status with adaptive thresholds
  let driftStatus = determineDriftStatus(regime, pageHinkleyCUSUM, variance24h, historicalStdDev);

  // A1: Escalate on creeping degradation vs the frozen golden baseline. Slow drift keeps
  // the rolling-baseline delta small (the baseline moves with the model), so the standard
  // checks can read NORMAL while the model is meaningfully worse than at launch. The golden
  // gap catches that. Threshold scales with the model's own variability.
  if (driftVsGolden !== undefined) {
    const goldenWarn = Math.max(8, historicalStdDev * 2.5);
    const goldenAlert = Math.max(12, historicalStdDev * 4);
    if (driftVsGolden > goldenAlert && driftStatus !== 'ALERT') {
      driftStatus = 'ALERT';
    } else if (driftVsGolden > goldenWarn && driftStatus === 'NORMAL') {
      driftStatus = 'WARNING';
    }
  }
  
  // Step 9: Find last significant change
  const lastChange = await findLastSignificantChange(modelId);
  
  // Step 10: Analyze per-axis trends
  const axes = await analyzeAxesTrends(modelId, validScores);
  
  // Step 11: Identify primary issue and recommendation
  let { primaryIssue, recommendation } = diagnoseIssue(regime, axes, variance24h, currentScore, baselineScore);

  // A1: Surface creeping degradation when the rolling-baseline diagnosis missed it.
  if (driftVsGolden !== undefined && driftVsGolden > Math.max(8, historicalStdDev * 2.5) && !primaryIssue) {
    primaryIssue = `Creeping degradation: ${driftVsGolden} pts below launch baseline (${goldenBaselineScore}) despite a stable rolling average`;
    recommendation = recommendation || 'Compare against the frozen golden baseline — slow drift has been absorbed by the 28-day rolling window.';
  }

  // Step 12: Construct signature
  const signature: DriftSignature = {
    modelId,
    modelName,
    timestamp: new Date(),
    baselineScore,
    currentScore,
    confidenceInterval: [Math.round(ci.lower), Math.round(ci.upper)],
    goldenBaselineScore: goldenBaselineScore ?? undefined,
    driftVsGolden,
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
 * PHASE 2 FIX: Determine stability regime with ADAPTIVE per-model thresholds
 *
 * Instead of hardcoded thresholds (> 8 pts), thresholds scale with the model's
 * historical variability. A model that typically varies ±2 pts should flag
 * VOLATILE at ±5 pts, while one that typically varies ±10 pts should not.
 */
function determineRegime(
  current: number,
  baseline: number,
  variance: number,
  ci: any,
  historicalStdDev: number = 5
): 'STABLE' | 'VOLATILE' | 'DEGRADED' | 'RECOVERING' {
  const delta = baseline - current; // Positive = degraded, negative = improved
  const ciWidth = ci.upper - ci.lower;
  
  // Adaptive thresholds based on model's historical standard deviation
  const degradedDelta = Math.max(5, historicalStdDev * 2.5);   // 2.5σ below baseline
  const volatileThreshold = Math.max(3, historicalStdDev * 2);  // 2σ above typical variance
  const recoveringDelta = Math.max(3, historicalStdDev * 1.5);  // 1.5σ above baseline
  const recoveringVariance = Math.max(4, historicalStdDev * 2); // Max variance for recovering
  
  // DEGRADED: Score significantly below baseline and outside CI
  if (delta > ciWidth * 1.5 && delta > degradedDelta) {
    return 'DEGRADED';
  }
  
  // RECOVERING: Improving from degraded state (score above baseline)
  if (delta < -recoveringDelta && variance < recoveringVariance) {
    return 'RECOVERING';
  }
  
  // VOLATILE: High variance relative to model's historical behavior
  if (variance > volatileThreshold) {
    return 'VOLATILE';
  }
  
  // STABLE: Low variance, within expected range
  return 'STABLE';
}

/**
 * PHASE 2 FIX: Determine drift alert status with adaptive thresholds
 */
function determineDriftStatus(
  regime: string,
  cusum: number,
  variance: number,
  historicalStdDev: number = 5
): 'NORMAL' | 'WARNING' | 'ALERT' {
  // Adaptive CUSUM thresholds
  const alertCusum = 0.10;
  const warningCusum = 0.05;
  const warningVariance = Math.max(4, historicalStdDev * 2);
  
  // ALERT: Degraded or very high CUSUM
  if (regime === 'DEGRADED' || cusum > alertCusum) {
    return 'ALERT';
  }
  
  // WARNING: Volatile or moderate CUSUM
  if (regime === 'VOLATILE' || cusum > warningCusum || variance > warningVariance) {
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
 * PHASE 2 FIX: Multi-scale change-point detection
 *
 * Uses multiple window sizes (3, 5, 10) and requires detection at ≥2 scales
 * to confirm. Also uses Mann-Whitney U test for proper non-parametric
 * significance testing instead of simple CI overlap.
 */
export async function detectChangePoints(modelId: number): Promise<ChangePoint[]> {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  
  // PHASE 1 FIX: Exclude canary and synthetic scores from change-point detection
  const recentScores = await db
    .select()
    .from(scores)
    .where(and(
      eq(scores.modelId, modelId),
      gte(scores.ts, sevenDaysAgo.toISOString()),
      sql`suite IN ('hourly', 'deep', 'tooling')`,
      sql`(note IS NULL OR note NOT LIKE '%SYNTHETIC%')`
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
  
  // Multi-scale detection: check at window sizes 3, 5, and 10
  const windowSizes = [3, 5, 10];
  const candidatePositions = new Map<number, { scales: number; bestDelta: number; bestSignificance: number }>();
  
  for (const windowSize of windowSizes) {
    if (validScores.length < windowSize * 2) continue;
    
    for (let i = 0; i < validScores.length - windowSize * 2; i++) {
      const beforeWindow = validScores.slice(i, i + windowSize);
      const afterWindow = validScores.slice(i + windowSize, i + windowSize * 2);
      
      const beforeScoreVals = beforeWindow.map(s => Math.max(0, Math.min(100, Math.round(s.stupidScore))));
      const afterScoreVals = afterWindow.map(s => Math.max(0, Math.min(100, Math.round(s.stupidScore))));
      
      const beforeAvg = beforeScoreVals.reduce((a, b) => a + b, 0) / beforeScoreVals.length;
      const afterAvg = afterScoreVals.reduce((a, b) => a + b, 0) / afterScoreVals.length;
      const delta = afterAvg - beforeAvg;
      
      // PHASE 2: Use Mann-Whitney U for non-parametric significance
      const mwResult = mannWhitneyU(beforeScoreVals, afterScoreVals);
      
      // Also check CI overlap as secondary confirmation
      const beforeCI = calculateConfidenceInterval(beforeScoreVals);
      const afterCI = calculateConfidenceInterval(afterScoreVals);
      const ciOverlap = !(beforeCI.lower > afterCI.upper || afterCI.lower > beforeCI.upper);
      
      // Significant if Mann-Whitney p < 0.05 AND delta > 5 points
      const isSignificant = mwResult.significant && Math.abs(delta) > 5;
      // Also flag if CI doesn't overlap and delta is large (catch what MW misses at small n)
      const isSignificantCI = !ciOverlap && Math.abs(delta) > 8;
      
      if (isSignificant || isSignificantCI) {
        const position = i + windowSize;
        const existing = candidatePositions.get(position) || { scales: 0, bestDelta: 0, bestSignificance: 0 };
        existing.scales += 1;
        if (Math.abs(delta) > Math.abs(existing.bestDelta)) {
          existing.bestDelta = delta;
          existing.bestSignificance = mwResult.significant
            ? Math.abs(mwResult.effectSize)
            : Math.abs(delta) / Math.max(1, (beforeCI.upper - beforeCI.lower));
        }
        candidatePositions.set(position, existing);
      }
    }
  }
  
  // Only keep change-points detected at ≥ 2 scales (reduces false positives)
  const newChangePoints: ChangePoint[] = [];
  
  // Pre-fetch existing change-points for deduplication
  const existingChanges = await db
    .select()
    .from(change_points)
    .where(eq(change_points.model_id, modelId))
    .orderBy(desc(change_points.detected_at))
    .limit(20);
  
  for (const [position, candidate] of candidatePositions.entries()) {
    // Require detection at multiple scales for confidence (unless very strong signal)
    if (candidate.scales < 2 && Math.abs(candidate.bestDelta) < 15) continue;
    
    const changeTimestamp = new Date(validScores[position].ts || new Date());
    
    // Check if this change-point already recorded (within 2 hour window)
    const alreadyRecorded = existingChanges.some(cp => {
      const timeDiff = Math.abs(new Date(cp.detected_at).getTime() - changeTimestamp.getTime());
      return timeDiff < 2 * 60 * 60 * 1000; // Within 2 hours
    });
    
    if (!alreadyRecorded) {
      // Use the widest available window for axis analysis
      const analysisWindow = Math.min(5, Math.floor(validScores.length / 2));
      const beforeWindow = validScores.slice(Math.max(0, position - analysisWindow), position);
      const afterWindow = validScores.slice(position, Math.min(validScores.length, position + analysisWindow));
      
      const affectedAxes = analyzeAffectedAxes(beforeWindow, afterWindow);
      
      const beforeAvg = beforeWindow.reduce((s, x) => s + Math.round(x.stupidScore), 0) / beforeWindow.length;
      const afterAvg = afterWindow.reduce((s, x) => s + Math.round(x.stupidScore), 0) / afterWindow.length;
      
      newChangePoints.push({
        modelId,
        timestamp: changeTimestamp,
        fromScore: Math.round(beforeAvg * 10) / 10,
        toScore: Math.round(afterAvg * 10) / 10,
        delta: Math.round(candidate.bestDelta * 10) / 10,
        significance: Math.round(candidate.bestSignificance * 10) / 10,
        changeType: candidate.bestDelta > 0 ? 'improvement' : candidate.bestDelta < -2 ? 'degradation' : 'shift',
        affectedAxes,
        suspectedCause: inferCause(affectedAxes, candidate.bestDelta)
      });
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

// A2: Task families for per-capability drift detection
const TASK_FAMILIES: Record<string, string[]> = {
  math:       ['py/factorial', 'py/fibonacci', 'py/prime_check', 'py/optimize_fibonacci'],
  strings:    ['py/is_palindrome', 'py/reverse_string', 'py/regex_match'],
  graphs:     ['py/binary_search', 'py/dijkstra', 'py/topological_sort'],
  dp_complex: ['py/word_break', 'py/lru_cache', 'py/mini_interpreter'],
  debug_data: ['py/debug_sort', 'py/merge_intervals'],
};

export interface CapabilityDriftResult {
  family: string;
  slugs: string[];
  currentPassRate: number;   // avg pass rate last 7d (0-100)
  baselinePassRate: number;  // avg pass rate days 8-28
  delta: number;             // current - baseline (negative = degraded)
  isDrifting: boolean;
  significance: number;      // Mann-Whitney effect size or CI ratio
}

/**
 * A2: Per-capability drift detection.
 * Groups tasks by family and computes daily pass rates from raw runs,
 * then applies Mann-Whitney sliding-window detection on the time series.
 * Surfaces regressions hidden by the aggregate stupidScore.
 */
export async function detectCapabilityDrift(modelId: number): Promise<CapabilityDriftResult[]> {
  const windowStart = new Date(Date.now() - 28 * 24 * 60 * 60 * 1000).toISOString();
  const results: CapabilityDriftResult[] = [];

  for (const [family, slugs] of Object.entries(TASK_FAMILIES)) {
    // Resolve task IDs for this family
    const familyTasks = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(inArray(tasks.slug, slugs));

    if (familyTasks.length === 0) continue;
    const taskIds = familyTasks.map(t => t.id);

    // Daily pass rate: avg of runs.passed (0 or 1) × 100 for this model+family
    const dailyRows = await db
      .select({
        day: sql<string>`date(${runs.ts})`,
        passRate: sql<number>`avg(CASE WHEN ${runs.passed} = 1 THEN 100.0 ELSE 0.0 END)`,
        nRuns: sql<number>`count(*)`,
      })
      .from(runs)
      .where(
        and(
          eq(runs.modelId, modelId),
          inArray(runs.taskId as any, taskIds),
          gte(runs.ts, windowStart)
        )
      )
      .groupBy(sql`date(${runs.ts})`)
      .orderBy(sql`date(${runs.ts})`);

    if (dailyRows.length < 4) continue; // not enough daily points

    const series = dailyRows.map(r => r.passRate);
    const cutoff = Math.max(1, series.length - 7); // last 7 data-days vs earlier

    const recent = series.slice(cutoff);
    const baseline = series.slice(0, cutoff);

    if (baseline.length < 3 || recent.length < 2) continue;

    const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
    const baselineAvg = baseline.reduce((a, b) => a + b, 0) / baseline.length;
    const delta = recentAvg - baselineAvg;

    // Mann-Whitney on recent vs baseline
    const mwResult = mannWhitneyU(
      baseline.map(v => Math.round(v)),
      recent.map(v => Math.round(v))
    );

    const ciBaseline = calculateConfidenceInterval(baseline.map(Math.round));
    const ciRecent = calculateConfidenceInterval(recent.map(Math.round));
    const ciOverlap = !(ciBaseline.lower > ciRecent.upper || ciRecent.lower > ciBaseline.upper);

    const isDrifting = (mwResult.significant && Math.abs(delta) > 8) ||
                       (!ciOverlap && Math.abs(delta) > 12);
    const significance = mwResult.significant
      ? Math.abs(mwResult.effectSize)
      : Math.abs(delta) / Math.max(1, ciBaseline.upper - ciBaseline.lower);

    results.push({
      family,
      slugs,
      currentPassRate: Math.round(recentAvg * 10) / 10,
      baselinePassRate: Math.round(baselineAvg * 10) / 10,
      delta: Math.round(delta * 10) / 10,
      isDrifting,
      significance: Math.round(significance * 100) / 100,
    });
  }

  return results;
}

/**
 * A2: Run capability drift for all whitelisted models, log findings.
 * Intended as a nightly job — runs once per night after benchmarks complete.
 */
export async function detectAllCapabilityDrift(): Promise<void> {
  const allModels = await db.select().from(models).where(sql`show_in_rankings = 1`);
  let driftCount = 0;

  for (const model of allModels) {
    try {
      const results = await detectCapabilityDrift(model.id);
      const drifting = results.filter(r => r.isDrifting);

      if (drifting.length > 0) {
        driftCount += drifting.length;
        for (const r of drifting) {
          const dir = r.delta < 0 ? '📉' : '📈';
          console.log(
            `${dir} Capability drift [${model.name}/${r.family}]: ` +
            `${r.baselinePassRate}% → ${r.currentPassRate}% (Δ${r.delta > 0 ? '+' : ''}${r.delta}%, ` +
            `sig=${r.significance.toFixed(2)})`
          );
        }
      }
    } catch (err) {
      console.error(`❌ Capability drift failed for ${model.name}:`, err);
    }
  }

  if (driftCount > 0) {
    console.log(`⚠️  Capability drift: ${driftCount} family/model combinations drifting`);
  } else {
    console.log(`✅ Capability drift: all families stable`);
  }
}

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
        
        // PHASE 3: Send webhook alert for change-points
        try {
          const { alertChangePoint } = await import('./drift-alerts');
          await alertChangePoint(cp, model.name, model.vendor);
        } catch (alertErr) {
          // Non-fatal — alert delivery should never block drift computation
        }
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
