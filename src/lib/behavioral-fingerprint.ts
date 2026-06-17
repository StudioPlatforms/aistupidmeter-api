/**
 * PHASE 3: Behavioral Fingerprint Drift Detection
 * 
 * Detects drift in response characteristics (token count, latency, code length)
 * BEFORE correctness drops — these are leading indicators.
 * 
 * A model that suddenly starts using 3× more tokens or returning 50% shorter
 * code is drifting, even if test pass rate hasn't changed yet.
 */

import { db } from '../db';
import { runs, models, raw_outputs } from '../db/schema';
import { eq, desc, and, gte, sql } from 'drizzle-orm';
import { calculateStdDev, updateEWMA, EWMAState } from './statistical-tests';
import { cache } from '../cache/redis-cache';

// ============================================================================
// TYPES
// ============================================================================

export interface BehavioralFingerprint {
  modelId: number;
  modelName: string;
  timestamp: Date;
  metrics: {
    tokensOut: MetricSnapshot;
    latencyMs: MetricSnapshot;
    tokensIn: MetricSnapshot;
    // A3: output-characteristic signals (leading indicators from raw_outputs)
    refusalRate?: MetricSnapshot;  // % responses containing refusal phrases
    codeLength?: MetricSnapshot;   // avg chars of extracted code
    hedgingRate?: MetricSnapshot;  // % responses containing hedging phrases
  };
  driftDetected: boolean;
  driftingMetrics: string[];
  severity: 'none' | 'minor' | 'warning' | 'alert';
  recommendation?: string;
}

interface MetricSnapshot {
  current: number;       // Latest value
  baseline7d: number;    // 7-day average
  stdDev7d: number;      // 7-day standard deviation
  zScore: number;        // How many σ from baseline
  ewma: number;          // EWMA-smoothed value
  outOfControl: boolean; // EWMA control chart flag
  trend: 'rising' | 'falling' | 'stable';
}

const EWMA_LAMBDA = 0.2;       // Smoothing factor
const EWMA_L = 2.7;            // Control limit width
const EWMA_CACHE_TTL = 86400;  // 1 day
const Z_THRESHOLD = 2.0;       // Flag at 2σ

// ============================================================================
// MAIN ANALYSIS
// ============================================================================

/**
 * Compute behavioral fingerprint for a model
 * Analyzes response characteristics for drift signals
 */
export async function computeBehavioralFingerprint(modelId: number): Promise<BehavioralFingerprint | null> {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  
  // Get model info
  const modelRecord = await db.select().from(models).where(eq(models.id, modelId)).limit(1);
  if (modelRecord.length === 0) return null;
  
  // Get recent runs
  const recentRuns = await db
    .select({
      tokensIn: runs.tokensIn,
      tokensOut: runs.tokensOut,
      latencyMs: runs.latencyMs,
      ts: runs.ts
    })
    .from(runs)
    .where(and(
      eq(runs.modelId, modelId),
      gte(runs.ts, sevenDaysAgo.toISOString())
    ))
    .orderBy(desc(runs.ts))
    .limit(200);
  
  if (recentRuns.length < 10) return null;
  
  // Split into recent (24h) and baseline (7d)
  const recent = recentRuns.filter(r => r.ts && new Date(r.ts) > oneDayAgo);
  const baseline = recentRuns;
  
  if (recent.length < 3) return null;
  
  // Analyze each metric
  const analyzeMetric = async (
    metricName: string,
    getter: (r: typeof recentRuns[0]) => number
  ): Promise<MetricSnapshot> => {
    const recentVals = recent.map(getter).filter(v => v > 0);
    const baselineVals = baseline.map(getter).filter(v => v > 0);
    
    if (recentVals.length === 0 || baselineVals.length === 0) {
      return {
        current: 0, baseline7d: 0, stdDev7d: 0, zScore: 0,
        ewma: 0, outOfControl: false, trend: 'stable'
      };
    }
    
    const currentVal = recentVals[0];
    const baselineMean = baselineVals.reduce((a, b) => a + b, 0) / baselineVals.length;
    const baselineStd = calculateStdDev(baselineVals);
    const zScore = baselineStd > 0 ? (currentVal - baselineMean) / baselineStd : 0;
    
    // EWMA tracking
    const ewmaKey = `ewma:${modelId}:${metricName}`;
    let prevEwma = baselineMean;
    let ewmaCount = 1;
    try {
      const cached = await cache.get(ewmaKey);
      if (cached) {
        const state = JSON.parse(cached);
        prevEwma = state.value;
        ewmaCount = state.count || 1;
      }
    } catch { /* start fresh */ }
    
    const ewmaState = updateEWMA(prevEwma, currentVal, baselineMean, baselineStd, EWMA_LAMBDA, EWMA_L, ewmaCount);
    
    // Persist EWMA state
    try {
      await cache.set(ewmaKey, JSON.stringify({ value: ewmaState.value, count: ewmaCount + 1 }), EWMA_CACHE_TTL);
    } catch { /* best effort */ }
    
    // Trend detection
    const recentMean = recentVals.reduce((a, b) => a + b, 0) / recentVals.length;
    const trend: MetricSnapshot['trend'] = 
      recentMean > baselineMean * 1.15 ? 'rising' :
      recentMean < baselineMean * 0.85 ? 'falling' :
      'stable';
    
    return {
      current: Math.round(currentVal),
      baseline7d: Math.round(baselineMean),
      stdDev7d: Math.round(baselineStd * 10) / 10,
      zScore: Math.round(zScore * 100) / 100,
      ewma: Math.round(ewmaState.value),
      outOfControl: ewmaState.outOfControl,
      trend
    };
  };
  
  const tokensOut = await analyzeMetric('tokensOut', r => r.tokensOut);
  const latencyMs = await analyzeMetric('latencyMs', r => r.latencyMs);
  const tokensIn = await analyzeMetric('tokensIn', r => r.tokensIn);

  // A3: Output-characteristic signals from raw_outputs (leading indicators)
  let refusalRate: MetricSnapshot | undefined;
  let codeLength: MetricSnapshot | undefined;
  let hedgingRate: MetricSnapshot | undefined;

  try {
    const rawRows = await db
      .select({
        rawText: raw_outputs.rawText,
        extractedCode: raw_outputs.extractedCode,
        ts: raw_outputs.ts,
      })
      .from(raw_outputs)
      .innerJoin(runs, eq(raw_outputs.runId, runs.id))
      .where(and(
        eq(runs.modelId, modelId),
        gte(raw_outputs.ts, sevenDaysAgo.toISOString())
      ))
      .orderBy(desc(raw_outputs.ts))
      .limit(500);

    if (rawRows.length >= 10) {
      const recentRaw = rawRows.filter(r => r.ts && new Date(r.ts) > oneDayAgo);
      const baselineRaw = rawRows;

      if (recentRaw.length >= 3) {
        const REFUSAL = ['i cannot', "i can't", "i'm unable", "i'm sorry, but", 'i apologize', 'as an ai', "i won't", 'i am not able to'];
        const HEDGING = ["might ", 'could be', 'it seems', 'i think', 'possibly', 'perhaps', 'probably', 'may have', 'i believe', "i'm not sure", 'not certain'];

        const hasRefusal = (t: string) => REFUSAL.some(p => t.toLowerCase().includes(p));
        const hasHedging = (t: string) => HEDGING.some(p => t.toLowerCase().includes(p));

        const rateOf = (texts: string[], fn: (t: string) => boolean) =>
          texts.length > 0 ? (texts.filter(fn).length / texts.length) * 100 : 0;

        const avgCodeLen = (rows: typeof rawRows) => {
          const valid = rows.map(r => r.extractedCode?.length ?? 0).filter(n => n > 0);
          return valid.length > 0 ? valid.reduce((a, b) => a + b, 0) / valid.length : 0;
        };

        const buildSnapshot = async (
          key: string,
          recentVal: number,
          baselineVals: number[]
        ): Promise<MetricSnapshot> => {
          const baselineMean = baselineVals.reduce((a, b) => a + b, 0) / baselineVals.length;
          const baselineStd = calculateStdDev(baselineVals);
          const zScore = baselineStd > 0 ? (recentVal - baselineMean) / baselineStd : 0;
          const ewmaKey = `ewma:${modelId}:${key}`;
          let prevEwma = baselineMean;
          let ewmaCount = 1;
          try {
            const cached = await cache.get(ewmaKey);
            if (cached) { const s = JSON.parse(cached); prevEwma = s.value; ewmaCount = s.count || 1; }
          } catch { /* start fresh */ }
          const ewmaState = updateEWMA(prevEwma, recentVal, baselineMean, baselineStd, EWMA_LAMBDA, EWMA_L, ewmaCount);
          try { await cache.set(ewmaKey, JSON.stringify({ value: ewmaState.value, count: ewmaCount + 1 }), EWMA_CACHE_TTL); } catch { /* best effort */ }
          const recentMean = recentVal;
          const trend: MetricSnapshot['trend'] = recentMean > baselineMean * 1.15 ? 'rising' : recentMean < baselineMean * 0.85 ? 'falling' : 'stable';
          return {
            current: Math.round(recentVal * 10) / 10,
            baseline7d: Math.round(baselineMean * 10) / 10,
            stdDev7d: Math.round(baselineStd * 10) / 10,
            zScore: Math.round(zScore * 100) / 100,
            ewma: Math.round(ewmaState.value * 10) / 10,
            outOfControl: ewmaState.outOfControl,
            trend
          };
        };

        const recentTexts = recentRaw.map(r => r.rawText);

        refusalRate = await buildSnapshot(
          'refusalRate',
          rateOf(recentTexts, hasRefusal),
          baselineRaw.map((_, i) => rateOf(baselineRaw.slice(Math.max(0, i - 5), i + 1).map(r => r.rawText), hasRefusal))
        );
        hedgingRate = await buildSnapshot(
          'hedgingRate',
          rateOf(recentTexts, hasHedging),
          baselineRaw.map((_, i) => rateOf(baselineRaw.slice(Math.max(0, i - 5), i + 1).map(r => r.rawText), hasHedging))
        );
        codeLength = await buildSnapshot(
          'codeLength',
          avgCodeLen(recentRaw),
          baselineRaw.map((_, i) => avgCodeLen(baselineRaw.slice(Math.max(0, i - 5), i + 1)))
        );
      }
    }
  } catch (err) {
    // raw_outputs signals are best-effort — never abort the fingerprint
  }

  // Determine which metrics are drifting
  const driftingMetrics: string[] = [];
  const metrics = { tokensOut, latencyMs, tokensIn, refusalRate, hedgingRate, codeLength };
  
  for (const [name, snapshot] of Object.entries(metrics)) {
    if (!snapshot) continue;
    if (Math.abs(snapshot.zScore) > Z_THRESHOLD || snapshot.outOfControl) {
      driftingMetrics.push(name);
    }
  }
  
  const driftDetected = driftingMetrics.length > 0;
  
  // Severity based on number and magnitude of drifting metrics
  let severity: BehavioralFingerprint['severity'] = 'none';
  if (driftingMetrics.length >= 3) severity = 'alert';
  else if (driftingMetrics.length >= 2) severity = 'warning';
  else if (driftingMetrics.length >= 1) severity = 'minor';
  
  // Generate recommendation
  let recommendation: string | undefined;
  if (driftDetected) {
    const details = driftingMetrics.map(m => {
      const snap = metrics[m as keyof typeof metrics];
      if (!snap) return m;
      return `${m}: ${snap.current} (baseline: ${snap.baseline7d}, z=${snap.zScore.toFixed(1)})`;
    }).join('; ');
    
    recommendation = `Behavioral drift detected in: ${details}. ` +
      `This is a LEADING INDICATOR — score degradation may follow within 1-3 benchmark cycles.`;
  }
  
  return {
    modelId,
    modelName: modelRecord[0].name,
    timestamp: new Date(),
    metrics,
    driftDetected,
    driftingMetrics,
    severity,
    recommendation
  };
}

/**
 * Compute behavioral fingerprints for all active models
 */
export async function computeAllBehavioralFingerprints(): Promise<{
  total: number;
  drifting: number;
  alerts: string[];
}> {
  console.log('🔬 [BEHAVIORAL-FINGERPRINT] Computing fingerprints for all models...');
  
  const allModels = await db.select().from(models).where(sql`show_in_rankings = 1`);
  
  let total = 0;
  let drifting = 0;
  const alerts: string[] = [];
  
  for (const model of allModels) {
    try {
      const fingerprint = await computeBehavioralFingerprint(model.id);
      if (!fingerprint) continue;
      
      total++;
      if (fingerprint.driftDetected) {
        drifting++;
        const msg = `${model.name}: ${fingerprint.driftingMetrics.join(', ')} drifting (${fingerprint.severity})`;
        alerts.push(msg);
        
        if (fingerprint.severity === 'alert' || fingerprint.severity === 'warning') {
          console.log(`⚠️ [BEHAVIORAL-FINGERPRINT] ${msg}`);
        }
      }
    } catch (error) {
      console.warn(`⚠️ Behavioral fingerprint failed for ${model.name}:`, String(error).slice(0, 80));
    }
  }
  
  console.log(`✅ [BEHAVIORAL-FINGERPRINT] ${total} models analyzed, ${drifting} with behavioral drift`);
  
  return { total, drifting, alerts };
}
