// apps/api/src/lib/dashboard-compute.ts
import { getCombinedModelScores, getDeepReasoningScores, getModelScoresFromDB, getHistoricalModelScores, sortModelScores } from '../routes/dashboard';
import { db } from '../db/index';
import { models, scores } from '../db/schema';
import { eq, desc, sql, and, gte } from 'drizzle-orm';

// single, canonical compute used everywhere
export type PeriodKey = 'latest' | '24h' | '7d' | '1m';
export type SortKey = 'combined' | 'reasoning' | 'speed' | '7axis' | 'price';

export async function computeDashboardScores(period: PeriodKey, sortBy: SortKey) {
  let modelScores: any[];

  if (sortBy === 'combined') {
    modelScores = period === 'latest'
      ? await getCombinedModelScores()
      : await getHistoricalModelScores(period);
  } else if (sortBy === 'reasoning') {
    modelScores = period === 'latest'
      ? await getDeepReasoningScores()
      : await getHistoricalModelScores(period);
  } else if (sortBy === 'speed' || sortBy === '7axis') {
    modelScores = period === 'latest'
      ? await getModelScoresFromDB()
      : await getHistoricalModelScores(period);
  } else if (sortBy === 'price') {
    // exactly same as raw route: compute first, sort inside sortModelScores
    modelScores = period === 'latest'
      ? await getCombinedModelScores() // or whatever the raw route currently does before price-sort
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
    // Get latest hourly score
    const latestHourlyScore = await db
      .select()
      .from(scores)
      .where(and(eq(scores.modelId, modelId), eq(scores.suite, 'hourly')))
      .orderBy(desc(scores.ts))
      .limit(1);

    // Get latest deep score  
    const latestDeepScore = await db
      .select()
      .from(scores)
      .where(and(eq(scores.modelId, modelId), eq(scores.suite, 'deep')))
      .orderBy(desc(scores.ts))
      .limit(1);

    const hourlyScore = latestHourlyScore[0];
    const deepScore = latestDeepScore[0];
    
    // Combine scores with 70% hourly, 30% deep weighting
    let combinedScore: number | null = null;
    
    if (hourlyScore && hourlyScore.stupidScore !== null && hourlyScore.stupidScore >= 0) {
      let hourlyDisplay = Math.max(0, Math.min(100, Math.round(hourlyScore.stupidScore)));
      
      if (deepScore && deepScore.stupidScore !== null && deepScore.stupidScore >= 0) {
        // Has both scores - combine them
        let deepDisplay = Math.max(0, Math.min(100, Math.round(deepScore.stupidScore)));
        combinedScore = Math.round(hourlyDisplay * 0.7 + deepDisplay * 0.3);
      } else {
        // Only hourly score - use it directly
        combinedScore = hourlyDisplay;
      }
    } else if (deepScore && deepScore.stupidScore !== null && deepScore.stupidScore >= 0) {
      // Only deep score - use it directly
      let deepDisplay = Math.max(0, Math.min(100, Math.round(deepScore.stupidScore)));
      combinedScore = deepDisplay;
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
