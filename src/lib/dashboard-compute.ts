// apps/api/src/lib/dashboard-compute.ts
import { 
  getCombinedModelScores, 
  getDeepReasoningScores, 
  getToolingScores, 
  getModelScoresFromDB, 
  getHistoricalModelScores,
  getHistoricalReasoningScores,
  getHistoricalSpeedScores,
  getHistoricalToolingScores,
  sortModelScores 
} from '../routes/dashboard';
import { db } from '../db/index';
import { models, scores } from '../db/schema';
import { eq, desc, sql, and, gte } from 'drizzle-orm';

// single, canonical compute used everywhere
export type PeriodKey = 'latest' | '24h' | '7d' | '1m';
export type SortKey = 'combined' | 'reasoning' | 'speed' | '7axis' | 'tooling' | 'price';

export async function computeDashboardScores(period: PeriodKey, sortBy: SortKey) {
  let modelScores: any[];

  if (sortBy === 'combined') {
    modelScores = period === 'latest'
      ? await getCombinedModelScores()
      : await getHistoricalModelScores(period);
  } else if (sortBy === 'reasoning') {
    // FIXED: Use mode-specific historical function for reasoning
    modelScores = period === 'latest'
      ? await getDeepReasoningScores()
      : await getHistoricalReasoningScores(period);
  } else if (sortBy === 'speed' || sortBy === '7axis') {
    // FIXED: Use mode-specific historical function for speed/7axis
    modelScores = period === 'latest'
      ? await getModelScoresFromDB()
      : await getHistoricalSpeedScores(period);
  } else if (sortBy === 'tooling') {
    // FIXED: Use mode-specific historical function for tooling
    modelScores = period === 'latest'
      ? await getToolingScores()
      : await getHistoricalToolingScores(period);
  } else if (sortBy === 'price') {
    // exactly same as raw route: compute first, sort inside sortModelScores
    modelScores = period === 'latest'
      ? await getCombinedModelScores()
      : await getHistoricalModelScores(period);
  } else {
    modelScores = period === 'latest'
      ? await getCombinedModelScores()
      : await getHistoricalModelScores(period);
  }

  return sortModelScores(modelScores, sortBy);
}

// ========== ANALYTICS SHARED FUNCTIONS ==========
// These functions are used by analytics endpoints and should be the single source of truth

// Get combined score for a single model (shared across dashboard, analytics, batch)
export async function getSingleModelCombinedScore(modelId: number): Promise<number | null> {
  try {
    // Get latest hourly score (7-axis/speed)
    const latestHourlyScore = await db
      .select()
      .from(scores)
      .where(and(eq(scores.modelId, modelId), eq(scores.suite, 'hourly')))
      .orderBy(desc(scores.ts))
      .limit(1);

    // Get latest deep score (reasoning)
    const latestDeepScore = await db
      .select()
      .from(scores)
      .where(and(eq(scores.modelId, modelId), eq(scores.suite, 'deep')))
      .orderBy(desc(scores.ts))
      .limit(1);

    // Get latest tooling score
    const latestToolingScore = await db
      .select()
      .from(scores)
      .where(and(eq(scores.modelId, modelId), eq(scores.suite, 'tooling')))
      .orderBy(desc(scores.ts))
      .limit(1);

    const hourlyScore = latestHourlyScore[0];
    const deepScore = latestDeepScore[0];
    const toolingScore = latestToolingScore[0];
    
    // Combine scores with 50% hourly, 25% deep, 25% tooling weighting
    let combinedScore: number | null = null;
    
    // Count how many scores we have
    const hasHourly = hourlyScore && hourlyScore.stupidScore !== null && hourlyScore.stupidScore >= 0;
    const hasDeep = deepScore && deepScore.stupidScore !== null && deepScore.stupidScore >= 0;
    const hasTooling = toolingScore && toolingScore.stupidScore !== null && toolingScore.stupidScore >= 0;
    
    const scoreCount = (hasHourly ? 1 : 0) + (hasDeep ? 1 : 0) + (hasTooling ? 1 : 0);
    
    if (scoreCount === 0) {
      return null; // No scores available
    }
    
    // Get display scores (0-100 range)
    const hourlyDisplay = hasHourly ? Math.max(0, Math.min(100, Math.round(hourlyScore.stupidScore))) : 50;
    const deepDisplay = hasDeep ? Math.max(0, Math.min(100, Math.round(deepScore.stupidScore))) : 50;
    const toolingDisplay = hasTooling ? Math.max(0, Math.min(100, Math.round(toolingScore.stupidScore))) : 50;
    
    if (scoreCount === 3) {
      // All three scores available - full weighting
      combinedScore = Math.round(hourlyDisplay * 0.5 + deepDisplay * 0.25 + toolingDisplay * 0.25);
    } else if (scoreCount === 2) {
      // Two scores available - apply 10% penalty for incomplete data
      const preliminaryScore = Math.round(hourlyDisplay * 0.5 + deepDisplay * 0.25 + toolingDisplay * 0.25);
      combinedScore = Math.round(preliminaryScore * 0.9); // 10% penalty for missing one benchmark
    } else {
      // Only one score available - apply 20% penalty for incomplete data
      const preliminaryScore = Math.round(hourlyDisplay * 0.5 + deepDisplay * 0.25 + toolingDisplay * 0.25);
      combinedScore = Math.round(preliminaryScore * 0.8); // 20% penalty for missing two benchmarks
    }
    
    return combinedScore;
  } catch (error) {
    console.error(`Error getting combined score for model ${modelId}:`, error);
    return null;
  }
}

// Get all combined model scores (shared across analytics endpoints)
export async function getAllCombinedModelScores() {
  try {
    const allModels = await db.select().from(models);
    const modelScores = [];
    
    for (const model of allModels) {
      const combinedScore = await getSingleModelCombinedScore(model.id);
      
      if (combinedScore !== null) {
        modelScores.push({
          id: model.id,
          name: model.name,
          vendor: model.vendor,
          score: combinedScore
        });
      }
    }
    
    return modelScores;
  } catch (error) {
    console.error('Error fetching combined model scores:', error);
    return [];
  }
}

// Get date range from period (shared utility)
export function getDateRangeFromPeriod(period: PeriodKey = 'latest'): Date {
  const now = Date.now();
  switch (period) {
    case '24h':
      return new Date(now - 24 * 60 * 60 * 1000);
    case '7d':
      return new Date(now - 7 * 24 * 60 * 60 * 1000);
    case '1m':
      return new Date(now - 30 * 24 * 60 * 60 * 1000);
    case 'latest':
    default:
      return new Date(now - 7 * 24 * 60 * 60 * 1000); // Default to 7 days for latest
  }
}

// Calculate standard deviation (shared utility)
export function calculateStdDev(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const squaredDiffs = values.map(v => Math.pow(v - mean, 2));
  return Math.sqrt(squaredDiffs.reduce((a, b) => a + b, 0) / values.length);
}

// Calculate z-score (shared utility)
export function calculateZScore(value: number, mean: number, stdDev: number): number {
  if (stdDev === 0) return 0;
  return (value - mean) / stdDev;
}
