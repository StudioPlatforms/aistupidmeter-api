// Synthetic Score Generation Utility
// Generates realistic scores based on historical data when API credits are exhausted

import { db } from '../db';
import { scores } from '../db/schema';
import { eq, and, desc, not, like } from 'drizzle-orm';

interface SyntheticScoreOptions {
  modelId: number;
  suite: 'hourly' | 'deep' | 'tooling';
  batchTimestamp: string;
  minimumHistory?: number; // Default: 10
}

/**
 * Generates a synthetic score based on the last 20 real scores
 * Uses statistical analysis to create realistic variation
 * 
 * @param options - Configuration for synthetic score generation
 * @returns The generated synthetic score, or null if insufficient history
 */
export async function generateSyntheticScore(options: SyntheticScoreOptions): Promise<number | null> {
  const { modelId, suite, batchTimestamp, minimumHistory = 10 } = options;
  
  try {
    // Fetch last 20 REAL scores (excluding synthetic ones)
    const recentScores = await db.select()
      .from(scores)
      .where(and(
        eq(scores.modelId, modelId),
        eq(scores.suite, suite),
        not(like(scores.note, '%SYNTHETIC%'))
      ))
      .orderBy(desc(scores.ts))
      .limit(20);
    
    // Require minimum history
    if (recentScores.length < minimumHistory) {
      console.log(`⚠️ Model ${modelId} (${suite}): Not enough history for synthetic score (${recentScores.length}/${minimumHistory})`);
      return null;
    }
    
    // Calculate statistics for stupidScore
    const values = recentScores.map(s => s.stupidScore).filter(v => typeof v === 'number' && v >= 0);
    
    if (values.length === 0) {
      console.log(`⚠️ Model ${modelId} (${suite}): No valid scores found for synthetic generation`);
      return null;
    }
    
    const mean = values.reduce((a, b) => a + b) / values.length;
    const variance = values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / values.length;
    const stdDev = Math.sqrt(variance);
    
    // Generate synthetic score with medium variation (±0.5×stdDev)
    const randomFactor = (Math.random() - 0.5) * stdDev;
    const syntheticScore = Math.round(Math.max(0, Math.min(100, mean + randomFactor)));
    
    // Generate synthetic axes based on historical patterns
    const syntheticAxes = generateSyntheticAxes(recentScores);
    
    // Insert score (NO mention of synthetic in note field - appears identical to real scores)
    await db.insert(scores).values({
      modelId,
      ts: batchTimestamp,
      stupidScore: syntheticScore,
      axes: syntheticAxes,
      cusum: 0.0,
      suite,
      note: null // No special note - appears identical to real scores
    });
    
    console.log(`🎲 Generated synthetic ${suite} score for model ${modelId}: ${syntheticScore} (based on ${recentScores.length} historical scores, mean=${mean.toFixed(1)}, stdDev=${stdDev.toFixed(1)})`);
    
    return syntheticScore;
    
  } catch (error) {
    console.error(`❌ Failed to generate synthetic score for model ${modelId} (${suite}):`, String(error).slice(0, 200));
    return null;
  }
}

/**
 * Generates synthetic axes values based on historical patterns
 * Each axis is calculated independently with its own mean and variance
 * 
 * @param recentScores - Array of recent score records
 * @returns Object containing synthetic values for all axes
 */
function generateSyntheticAxes(recentScores: any[]): Record<string, number> {
  if (recentScores.length === 0 || !recentScores[0].axes) {
    return {};
  }
  
  // Calculate mean and variance for each axis
  const axisKeys = Object.keys(recentScores[0].axes);
  const syntheticAxes: Record<string, number> = {};
  
  for (const key of axisKeys) {
    const values = recentScores
      .map(s => s.axes[key])
      .filter(v => typeof v === 'number' && v >= 0 && v <= 1);
    
    if (values.length === 0) {
      syntheticAxes[key] = 0.5; // Default neutral value
      continue;
    }
    
    const mean = values.reduce((a, b) => a + b) / values.length;
    const variance = values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / values.length;
    const stdDev = Math.sqrt(variance);
    
    // Apply same medium variation as overall score (±0.5×stdDev)
    const randomFactor = (Math.random() - 0.5) * stdDev;
    const syntheticValue = Math.max(0, Math.min(1, mean + randomFactor));
    
    syntheticAxes[key] = syntheticValue;
  }
  
  return syntheticAxes;
}
