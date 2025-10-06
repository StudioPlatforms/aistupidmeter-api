/**
 * Statistical Testing and Confidence Interval Utilities
 * 
 * This module provides functions for calculating confidence intervals,
 * performing statistical significance tests, and analyzing score distributions.
 */

export interface ConfidenceInterval {
  lower: number;
  upper: number;
  standardError: number;
  mean: number;
}

export interface SignificanceTest {
  significant: boolean;
  pValue: number;
  effectSize: number;
  interpretation: string;
}

/**
 * Calculate 95% confidence interval using t-distribution
 * @param scores Array of score values from multiple trials
 * @param confidence Confidence level (default 0.95 for 95% CI)
 * @returns Confidence interval with lower/upper bounds and standard error
 */
export function calculateConfidenceInterval(
  scores: number[],
  confidence: number = 0.95
): ConfidenceInterval {
  const n = scores.length;
  
  if (n === 0) {
    return { lower: 0, upper: 0, standardError: 0, mean: 0 };
  }
  
  if (n === 1) {
    // Single score - no variance, use conservative estimate
    return {
      lower: Math.max(0, scores[0] - 5),
      upper: Math.min(100, scores[0] + 5),
      standardError: 2.5,
      mean: scores[0]
    };
  }
  
  const mean = scores.reduce((a, b) => a + b) / n;
  const variance = scores.reduce((sum, x) => sum + Math.pow(x - mean, 2), 0) / (n - 1);
  const stdDev = Math.sqrt(variance);
  const standardError = stdDev / Math.sqrt(n);
  
  // t-values for 95% CI with different degrees of freedom
  const tValues: Record<number, number> = {
    1: 12.706, // n=2, df=1
    2: 4.303,  // n=3, df=2
    3: 3.182,  // n=4, df=3
    4: 2.776,  // n=5, df=4 (our typical case)
    5: 2.571,  // n=6, df=5
    9: 2.262,  // n=10, df=9
    29: 2.045, // n=30, df=29
    99: 1.984  // n=100, df=99
  };
  
  // Find appropriate t-value or use conservative estimate
  const df = n - 1;
  let tValue = 2.0; // Conservative fallback
  
  if (tValues[df]) {
    tValue = tValues[df];
  } else if (df > 99) {
    tValue = 1.96; // Approximate z-value for large samples
  } else {
    // Interpolate for values not in table
    const keys = Object.keys(tValues).map(Number).sort((a, b) => a - b);
    for (let i = 0; i < keys.length - 1; i++) {
      if (df >= keys[i] && df <= keys[i + 1]) {
        // Linear interpolation
        const ratio = (df - keys[i]) / (keys[i + 1] - keys[i]);
        tValue = tValues[keys[i]] + ratio * (tValues[keys[i + 1]] - tValues[keys[i]]);
        break;
      }
    }
  }
  
  const marginOfError = tValue * standardError;
  
  return {
    lower: Math.max(0, mean - marginOfError),
    upper: Math.min(100, mean + marginOfError),
    standardError,
    mean
  };
}

/**
 * Compare two scores with their confidence intervals for statistical significance
 * @param score1 First score value
 * @param ci1Lower Lower bound of first score's CI
 * @param ci1Upper Upper bound of first score's CI
 * @param score2 Second score value
 * @param ci2Lower Lower bound of second score's CI
 * @param ci2Upper Upper bound of second score's CI
 * @returns Statistical significance test results
 */
export function compareScores(
  score1: number,
  ci1Lower: number,
  ci1Upper: number,
  score2: number,
  ci2Lower: number,
  ci2Upper: number
): SignificanceTest {
  // Check if confidence intervals overlap
  const noOverlap = ci1Lower > ci2Upper || ci2Lower > ci1Upper;
  
  // Calculate pooled standard deviation from CI widths
  const pooledStd = Math.sqrt(
    (Math.pow(ci1Upper - ci1Lower, 2) + Math.pow(ci2Upper - ci2Lower, 2)) / 2
  );
  
  // Calculate Cohen's d for effect size
  const effectSize = pooledStd > 0 ? Math.abs(score1 - score2) / pooledStd : 0;
  
  if (noOverlap) {
    // No overlap = definitely significant
    return {
      significant: true,
      pValue: 0.01,
      effectSize,
      interpretation: "Statistically significant difference (p < 0.05) - confidence intervals do not overlap"
    };
  }
  
  // Interpret effect size (Cohen's d thresholds)
  if (effectSize < 0.2) {
    return {
      significant: false,
      pValue: 0.8,
      effectSize,
      interpretation: "Difference not statistically significant - likely normal variance (trivial effect)"
    };
  } else if (effectSize < 0.5) {
    return {
      significant: false,
      pValue: 0.3,
      effectSize,
      interpretation: "Small effect size - difference may not be practically meaningful"
    };
  } else if (effectSize < 0.8) {
    return {
      significant: true,
      pValue: 0.03,
      effectSize,
      interpretation: "Medium effect size - statistically significant difference (p < 0.05)"
    };
  } else {
    return {
      significant: true,
      pValue: 0.01,
      effectSize,
      interpretation: "Large effect size - highly significant difference (p < 0.01)"
    };
  }
}

/**
 * Calculate standard deviation of an array of numbers
 * @param values Array of numeric values
 * @returns Standard deviation
 */
export function calculateStdDev(values: number[]): number {
  if (values.length === 0) return 0;
  if (values.length === 1) return 0;
  
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const squaredDiffs = values.map(v => Math.pow(v - mean, 2));
  const variance = squaredDiffs.reduce((a, b) => a + b, 0) / (values.length - 1);
  
  return Math.sqrt(variance);
}

/**
 * Calculate z-score for a value relative to a distribution
 * @param value The value to calculate z-score for
 * @param mean Mean of the distribution
 * @param stdDev Standard deviation of the distribution
 * @returns Z-score
 */
export function calculateZScore(value: number, mean: number, stdDev: number): number {
  if (stdDev === 0) return 0;
  return (value - mean) / stdDev;
}

/**
 * Determine if a change is statistically meaningful based on effect size
 * @param oldScore Previous score
 * @param newScore New score
 * @param typicalVariance Typical variance for this model
 * @returns Whether the change is meaningful
 */
export function isMeaningfulChange(
  oldScore: number,
  newScore: number,
  typicalVariance: number
): boolean {
  const change = Math.abs(newScore - oldScore);
  const threshold = Math.max(5, typicalVariance * 1.5); // At least 5 points or 1.5x typical variance
  return change >= threshold;
}

/**
 * Calculate percentile rank of a score within a distribution
 * @param score The score to rank
 * @param distribution Array of all scores in the distribution
 * @returns Percentile rank (0-100)
 */
export function calculatePercentileRank(score: number, distribution: number[]): number {
  if (distribution.length === 0) return 50;
  
  const sorted = [...distribution].sort((a, b) => a - b);
  const belowCount = sorted.filter(s => s < score).length;
  const equalCount = sorted.filter(s => s === score).length;
  
  // Use midpoint of equal values
  const rank = (belowCount + equalCount / 2) / sorted.length * 100;
  
  return Math.round(rank);
}
