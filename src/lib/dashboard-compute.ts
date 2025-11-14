// apps/api/src/lib/dashboard-compute.ts
// DEPRECATED: This file now re-exports from the new global model-scoring module
// All scoring logic has been moved to model-scoring.ts for consistency

// Re-export everything from the new global module
export {
  computeModelScores as computeDashboardScores,
  getSingleModelScore,
  getModelHistory,
  getSingleModelCombinedScore,
  type PeriodKey,
  type SortKey,
  type ModelScore,
  type HistoryPoint
} from './model-scoring';

// Legacy analytics functions - kept for backward compatibility
import { db } from '../db/index';
import { models } from '../db/schema';
import { getSingleModelCombinedScore, type PeriodKey } from './model-scoring';

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
