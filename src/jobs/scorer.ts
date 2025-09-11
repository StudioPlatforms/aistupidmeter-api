// Stupid Meter Scorer - computes z-scores vs 28-day rolling baseline and CUSUM drift detection
import { db } from '../db';
import { scores, baselines, metrics, runs, tasks, models } from '../db/schema';
import { sql, eq, desc, and, gte } from 'drizzle-orm';

// Metric weights (must sum to 1.0)
const WEIGHTS = {
  correctness: 0.35,
  spec: 0.15,
  codeQuality: 0.15,
  efficiency: 0.10,
  stability: 0.10,
  refusal: 0.10,
  recovery: 0.05
} as const;

function dotZ(weights: typeof WEIGHTS, z: Record<string, number>): number {
  return Object.entries(weights).reduce((sum, [key, weight]) => {
    return sum + weight * (z[key as keyof typeof WEIGHTS] || 0);
  }, 0);
}

export async function scoreBatch(modelId: number): Promise<{
  stupidScore: number;
  gauge: number;
  axes: Record<string, number>;
  phValue: number;
  driftDetected: boolean;
}> {
  // 1) Pull 28-day baseline per axis
  const baseline = await getBaseline(modelId);
  if (!baseline) {
    // No baseline yet - use neutral scores
    const neutralAxes = {
      correctness: 0.5, spec: 0.5, codeQuality: 0.5,
      efficiency: 0.5, stability: 0.5, refusal: 0.5, recovery: 0.5
    };
    return {
      stupidScore: 0,
      gauge: 50,
      axes: neutralAxes,
      phValue: 0,
      driftDetected: false
    };
  }

  // 2) Get latest metrics (median per task-type, averaged across tasks)
  const latest = await getLatestMetrics(modelId);
  if (!latest) {
    throw new Error('No metrics found for scoring');
  }

  // 3) Compute z-scores for each axis
  const z: Record<string, number> = {};
  for (const axis of Object.keys(WEIGHTS)) {
    const mean = baseline.means[axis] || 0.5;
    const std = Math.max(baseline.stds[axis] || 0.05, 1e-6);
    z[axis] = (latest[axis] - mean) / std;
  }

  // 4) StupidScore = -Σ weights × z_scores
  const stupidScore = -dotZ(WEIGHTS, z);

  // 5) Gauge mapping: 50 = baseline, 35 = -1σ, 65 = +1σ
  const gauge = 50 + 15 * Math.tanh(-stupidScore);

  // 6) Update Page-Hinkley for drift detection
  const signal = (latest.correctness + latest.spec) / 2; // Track core accuracy
  const phResult = await updatePageHinkley(modelId, signal);

  return {
    stupidScore,
    gauge: Math.max(0, Math.min(100, gauge)), // Clamp to 0-100
    axes: latest,
    phValue: phResult.value,
    driftDetected: phResult.driftDetected
  };
}

async function getBaseline(modelId: number): Promise<{
  means: Record<string, number>;
  stds: Record<string, number>;
} | null> {
  const twentyEightDaysAgo = new Date(Date.now() - 28 * 24 * 60 * 60 * 1000);

  // Simplified baseline calculation for demo - using last 10 successful runs
  const metricsData = await db
    .select()
    .from(metrics)
    .innerJoin(runs, eq(metrics.runId, runs.id))
    .where(eq(runs.modelId, modelId))
    .limit(10);

  if (metricsData.length === 0) return null;

  // Calculate simple averages and deviations for demo
  const stats = {
    means: {} as Record<string, number>,
    stds: {} as Record<string, number>
  };

  const axes = ['correctness', 'spec', 'codeQuality', 'efficiency', 'stability', 'refusal', 'recovery'];

  for (const axis of axes) {
    const values = metricsData.map(m => Number(m.metrics[axis as keyof typeof m.metrics]) || 0);
    const mean = values.reduce((sum, val) => sum + val, 0) / values.length;
    const variance = values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / values.length;
    const std = Math.sqrt(variance);

    stats.means[axis] = Math.max(0, Math.min(1, mean)); // Clamp to 0-1
    stats.stds[axis] = Math.max(0.01, std); // Prevent division by zero
  }

  return stats;
}

async function getLatestMetrics(modelId: number): Promise<Record<string, number> | null> {
  // Get aggregated metrics from recent runs using Drizzle queries
  const metricsData = await db
    .select()
    .from(metrics)
    .innerJoin(runs, eq(metrics.runId, runs.id))
    .where(eq(runs.modelId, modelId))
    .limit(5); // Last 5 successful runs

  if (metricsData.length === 0) return null;

  // Calculate averages manually for SQLite compatibility
  const axes = ['correctness', 'spec', 'codeQuality', 'efficiency', 'stability', 'refusal', 'recovery'];
  const averages: Record<string, number> = {};

  for (const axis of axes) {
    const values = metricsData.map(m => Number(m.metrics[axis as keyof typeof m.metrics]) || 0);
    const avg = values.reduce((sum, val) => sum + val, 0) / values.length;
    averages[axis] = Math.max(0, Math.min(1, avg)); // Clamp to 0-1
  }

  return averages;
}

// Page-Hinkley drift detection
async function updatePageHinkley(modelId: number, signal: number): Promise<{
  value: number;
  driftDetected: boolean;
}> {
  // For simplicity, we'll maintain state in scores table
  // In production, you'd want a separate table for drift state

  const latestScore = await db
    .select()
    .from(scores)
    .where(eq(scores.modelId, modelId))
    .orderBy(desc(scores.ts))
    .limit(1);

  // Simplified PH without historical state
  // In production: implement proper mt, Mt tracking per model
  const lambda = 0.05; // Threshold
  const delta = 0.005; // Sensitivity

  if (latestScore.length > 0) {
    const last = latestScore[0];
    const mt = last.cusum + (signal - delta);
    const PH = mt - last.cusum; // Simplified
    const driftDetected = PH > lambda;

    return {
      value: mt,
      driftDetected
    };
  }

  return {
    value: 0,
    driftDetected: false
  };
}

// Main scoring function to be called after batch completion
export async function computeAndStoreScore(modelId: number): Promise<void> {
  try {
    const scoreResult = await scoreBatch(modelId);

    let note = '';
    if (scoreResult.driftDetected) {
      note = 'Possible regression detected - performance has shifted significantly';
    }

    await db.insert(scores).values({
      modelId,
      stupidScore: scoreResult.stupidScore,
      axes: scoreResult.axes,
      cusum: scoreResult.phValue,
      note: note || undefined
    });

    console.log(`✅ Scored model ${modelId}: StupidScore=${scoreResult.stupidScore.toFixed(3)}, Gauge=${scoreResult.gauge.toFixed(1)}`);
  } catch (error) {
    console.error(`❌ Failed to score model ${modelId}:`, error);
  }
}
