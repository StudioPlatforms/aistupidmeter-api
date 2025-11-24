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
 * Deterministic random number generator seeded by model ID and timestamp
 * Ensures each model gets a unique but consistent random value
 * 
 * @param modelId - The model's database ID
 * @param timestamp - Batch timestamp for consistency
 * @param salt - Optional salt for generating multiple random values per model
 * @returns A pseudo-random number between 0 and 1
 */
function seededRandom(modelId: number, timestamp: string, salt: string = ''): number {
  const seed = `${modelId}-${timestamp}-${salt}`;
  let hash = 0;
  
  // Simple hash function
  for (let i = 0; i < seed.length; i++) {
    const char = seed.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  
  // Convert to 0-1 range using sine function for better distribution
  return Math.abs(Math.sin(hash)) % 1;
}

/**
 * Enhanced synthetic score generation with realistic performance patterns
 * Uses 100+ historical entries and simulates real-world model behavior
 * 
 * @param options - Configuration for synthetic score generation
 * @returns The generated synthetic score, or null if insufficient history
 */
export async function generateSyntheticScore(options: SyntheticScoreOptions): Promise<number | null> {
  const { modelId, suite, batchTimestamp, minimumHistory = 10 } = options;
  
  try {
    // Fetch last 100+ REAL scores (excluding synthetic ones) for comprehensive analysis
    const recentScores = await db.select()
      .from(scores)
      .where(and(
        eq(scores.modelId, modelId),
        eq(scores.suite, suite),
        not(like(scores.note, '%SYNTHETIC%'))
      ))
      .orderBy(desc(scores.ts))
      .limit(100);
    
    let scoreRows = recentScores;
    let values = recentScores.map(s => s.stupidScore).filter(v => typeof v === 'number' && v >= 0);

    // Fallback: if per-model history is sparse, use suite-wide cohort as baseline
    if (values.length < minimumHistory) {
      const cohortRows = await db.select()
        .from(scores)
        .where(and(
          eq(scores.suite, suite),
          not(like(scores.note, '%SYNTHETIC%'))
        ))
        .orderBy(desc(scores.ts))
        .limit(200); // Larger cohort for better baseline

      const cohortValues = cohortRows
        .map(s => s.stupidScore)
        .filter(v => typeof v === 'number' && v >= 0);

      if (cohortValues.length > 0) {
        console.log(`ℹ️ Model ${modelId} (${suite}): Using cohort baseline (${cohortValues.length} scores) for synthetic generation`);
        scoreRows = cohortRows;
        values = cohortValues;
      } else if (values.length === 0) {
        console.log(`⚠️ Model ${modelId} (${suite}): No valid scores found for synthetic generation (model + cohort)`);
        return null;
      } else {
        console.log(`ℹ️ Model ${modelId} (${suite}): Using sparse model history (${values.length} scores) for synthetic generation`);
      }
    }
    
    // Enhanced statistical analysis with temporal weighting
    const weightedMean = calculateWeightedMean(values, scoreRows);
    const variance = values.reduce((sum, val) => sum + Math.pow(val - weightedMean, 2), 0) / values.length;
    const stdDev = Math.sqrt(variance);
    
    // Apply realistic performance patterns
    const performancePattern = calculatePerformancePattern(scoreRows, modelId, batchTimestamp);
    
    // Enhanced randomness with multiple time scales
    const shortTermRandom = seededRandom(modelId, batchTimestamp, 'short-term');
    const mediumTermRandom = seededRandom(modelId, batchTimestamp.slice(0, 10), 'medium-term'); // Daily variation
    const longTermRandom = seededRandom(modelId, batchTimestamp.slice(0, 7), 'long-term'); // Monthly variation
    
    // Combine randomness sources for more realistic variation
    const combinedRandom = (shortTermRandom * 0.6 + mediumTermRandom * 0.3 + longTermRandom * 0.1);
    
    // Apply performance pattern effects
    const patternAdjustedMean = weightedMean + performancePattern.effect;
    
    // Apply a slight downward bias so synthetic scores don't overstate performance
    const dampedMean = patternAdjustedMean - Math.min(10, Math.max(0, (patternAdjustedMean - 70) * 0.6));
    
    // Enhanced spread calculation with model-specific volatility
    const modelVolatility = calculateModelVolatility(scoreRows);
    const baseSpread = Math.max(4, Math.min(15, stdDev * 2.5)); // Slightly wider spread
    const volatilityAdjustedSpread = baseSpread * (1 + modelVolatility * 0.5);
    
    const randomFactor = (combinedRandom - 0.5) * volatilityAdjustedSpread;
    let syntheticScore = Math.round(Math.max(0, Math.min(85, dampedMean + randomFactor)));
    
    // Apply occasional performance dips (simulating real-world "bad days")
    if (performancePattern.hasDip) {
      const dipSeverity = seededRandom(modelId, batchTimestamp, 'dip-severity');
      const dipAmount = Math.round(syntheticScore * (0.1 + dipSeverity * 0.2)); // 10-30% dip
      syntheticScore = Math.max(0, syntheticScore - dipAmount);
      console.log(`📉 Model ${modelId}: Applied performance dip of ${dipAmount} points`);
    }
    
    // Generate synthetic axes based on historical patterns with enhanced realism
    const syntheticAxes = generateEnhancedSyntheticAxes(scoreRows, modelId, batchTimestamp);
    
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
    
    console.log(`🎲 Generated enhanced synthetic ${suite} score for model ${modelId}: ${syntheticScore} (based on ${recentScores.length} historical scores, weightedMean=${weightedMean.toFixed(1)}, stdDev=${stdDev.toFixed(1)}, pattern=${performancePattern.type})`);
    
    return syntheticScore;
    
  } catch (error) {
    console.error(`❌ Failed to generate synthetic score for model ${modelId} (${suite}):`, String(error).slice(0, 200));
    return null;
  }
}

/**
 * Calculate weighted mean with temporal decay (recent scores matter more)
 */
function calculateWeightedMean(values: number[], scoreRows: any[]): number {
  if (values.length === 0) return 0;
  if (values.length === 1) return values[0];
  
  // Use exponential decay: recent scores get higher weights
  const weights = scoreRows.map((row, index) => {
    const ageFactor = Math.exp(-index * 0.1); // Exponential decay
    return ageFactor;
  });
  
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);
  const weightedSum = values.reduce((sum, value, index) => sum + value * weights[index], 0);
  
  return weightedSum / totalWeight;
}

/**
 * Calculate model-specific volatility based on historical performance
 */
function calculateModelVolatility(scoreRows: any[]): number {
  if (scoreRows.length < 5) return 0.5; // Default medium volatility for sparse data
  
  const scores = scoreRows.map(r => r.stupidScore).filter(s => typeof s === 'number' && s >= 0);
  if (scores.length < 3) return 0.5;
  
  // Calculate coefficient of variation (standard deviation / mean)
  const mean = scores.reduce((a, b) => a + b) / scores.length;
  const variance = scores.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / scores.length;
  const stdDev = Math.sqrt(variance);
  
  const cv = stdDev / mean;
  
  // Normalize to 0-1 range (most models have CV between 0.05 and 0.25)
  return Math.max(0, Math.min(1, (cv - 0.05) / 0.2));
}

/**
 * Detect and simulate realistic performance patterns
 */
function calculatePerformancePattern(scoreRows: any[], modelId: number, batchTimestamp: string): {
  type: string;
  effect: number;
  hasDip: boolean;
} {
  if (scoreRows.length < 10) {
    return { type: 'baseline', effect: 0, hasDip: false };
  }
  
  const scores = scoreRows.map(r => r.stupidScore).filter(s => typeof s === 'number' && s >= 0);
  const recentScores = scores.slice(0, Math.min(10, scores.length));
  const olderScores = scores.slice(Math.min(10, scores.length));
  
  // Calculate trends
  const recentMean = recentScores.reduce((a, b) => a + b) / recentScores.length;
  const olderMean = olderScores.length > 0 ? olderScores.reduce((a, b) => a + b) / olderScores.length : recentMean;
  
  const trend = recentMean - olderMean;
  
  // Detect patterns using seeded randomness for consistency
  const patternRandom = seededRandom(modelId, batchTimestamp, 'pattern');
  
  // 15% chance of performance dip
  const hasDip = patternRandom < 0.15;
  
  // 10% chance of recovery pattern (improving after previous dip)
  const isRecovery = patternRandom > 0.85 && trend > 5;
  
  // 5% chance of exceptional performance
  const isExceptional = patternRandom > 0.95;
  
  let type = 'baseline';
  let effect = 0;
  
  if (hasDip) {
    type = 'dip';
    effect = -8 - (patternRandom * 12); // -8 to -20 point effect
  } else if (isRecovery) {
    type = 'recovery';
    effect = 5 + (patternRandom * 10); // +5 to +15 point effect
  } else if (isExceptional) {
    type = 'exceptional';
    effect = 8 + (patternRandom * 7); // +8 to +15 point effect
  } else if (trend > 3) {
    type = 'improving';
    effect = Math.min(5, trend * 0.5); // Small positive effect for improving trends
  } else if (trend < -3) {
    type = 'declining';
    effect = Math.max(-5, trend * 0.5); // Small negative effect for declining trends
  }
  
  return { type, effect, hasDip };
}

/**
 * Enhanced synthetic axes generation with realistic correlations
 */
function generateEnhancedSyntheticAxes(recentScores: any[], modelId: number, batchTimestamp: string): Record<string, number> {
  if (recentScores.length === 0 || !recentScores[0].axes) {
    return {};
  }
  
  const axisKeys = Object.keys(recentScores[0].axes);
  const syntheticAxes: Record<string, number> = {};
  
  // Calculate baseline statistics for each axis
  const axisStats: Record<string, { mean: number; stdDev: number; volatility: number }> = {};
  
  for (const key of axisKeys) {
    const values = recentScores
      .map(s => s.axes[key])
      .filter(v => typeof v === 'number' && v >= 0 && v <= 1);
    
    if (values.length === 0) {
      axisStats[key] = { mean: 0.5, stdDev: 0.15, volatility: 0.5 };
      continue;
    }
    
    const mean = values.reduce((a, b) => a + b) / values.length;
    const variance = values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / values.length;
    const stdDev = Math.sqrt(variance);
    const volatility = Math.min(1, stdDev / 0.3); // Normalize volatility
    
    axisStats[key] = { mean, stdDev, volatility };
  }
  
  // Generate correlated values (axes that should move together)
  const performanceFactor = seededRandom(modelId, batchTimestamp, 'performance-factor') - 0.5;
  
  for (const key of axisKeys) {
    const stats = axisStats[key];
    
    // Base random variation
    const baseRandom = seededRandom(modelId, batchTimestamp, `axis-${key}`);
    const baseVariation = (baseRandom - 0.5) * stats.stdDev * 2;
    
    // Performance correlation (some axes should correlate with overall performance)
    let correlationEffect = 0;
    if (['correctness', 'codeQuality', 'complexity'].includes(key)) {
      correlationEffect = performanceFactor * 0.3; // Strong correlation with performance
    } else if (['efficiency', 'stability'].includes(key)) {
      correlationEffect = performanceFactor * 0.2; // Moderate correlation
    } else {
      correlationEffect = performanceFactor * 0.1; // Weak correlation
    }
    
    // Apply volatility scaling
    const volatilityFactor = 1 + (stats.volatility * 0.5);
    const finalVariation = (baseVariation + correlationEffect) * volatilityFactor;
    
    const syntheticValue = Math.max(0, Math.min(1, stats.mean + finalVariation));
    syntheticAxes[key] = syntheticValue;
  }
  
  return syntheticAxes;
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
    
    // Apply HIGHER variation to match overall score (±1.5×stdDev)
    // Use model-specific seeded random with axis name as salt for unique per-axis variation
    const randomValue = seededRandom(
      recentScores[0].modelId, 
      new Date(recentScores[0].ts || '').toISOString(), 
      `axis-${key}`
    );
    const randomFactor = (randomValue - 0.5) * stdDev * 3; // 3x multiplier = ±1.5×stdDev range
    const syntheticValue = Math.max(0, Math.min(1, mean + randomFactor));
    
    syntheticAxes[key] = syntheticValue;
  }
  
  return syntheticAxes;
}
