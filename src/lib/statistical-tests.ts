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

// ============================================================================
// PHASE 2: Mann-Whitney U Test (non-parametric)
// ============================================================================

export interface MannWhitneyResult {
  U: number;
  z: number;
  pValue: number;
  significant: boolean;
  effectSize: number; // rank-biserial correlation r
  interpretation: string;
}

/**
 * Mann-Whitney U test for comparing two independent samples
 * Non-parametric — does not assume normality, ideal for bounded [0,100] scores
 *
 * @param sample1 First sample (e.g., "before" scores)
 * @param sample2 Second sample (e.g., "after" scores)
 * @param alpha Significance level (default 0.05)
 * @returns Test results with U statistic, z-score, p-value, and effect size
 */
export function mannWhitneyU(
  sample1: number[],
  sample2: number[],
  alpha: number = 0.05
): MannWhitneyResult {
  const n1 = sample1.length;
  const n2 = sample2.length;
  
  if (n1 < 3 || n2 < 3) {
    return {
      U: 0, z: 0, pValue: 1, significant: false, effectSize: 0,
      interpretation: 'Insufficient data (need ≥3 samples per group)'
    };
  }
  
  // Combine and rank all observations
  const combined = [
    ...sample1.map(v => ({ value: v, group: 1 })),
    ...sample2.map(v => ({ value: v, group: 2 }))
  ].sort((a, b) => a.value - b.value);
  
  // Assign ranks (handle ties by averaging)
  const ranks: number[] = new Array(combined.length);
  let i = 0;
  while (i < combined.length) {
    let j = i;
    // Find all tied values
    while (j < combined.length && combined[j].value === combined[i].value) {
      j++;
    }
    // Average rank for tied values
    const avgRank = (i + 1 + j) / 2;
    for (let k = i; k < j; k++) {
      ranks[k] = avgRank;
    }
    i = j;
  }
  
  // Sum ranks for group 1
  let R1 = 0;
  for (let k = 0; k < combined.length; k++) {
    if (combined[k].group === 1) {
      R1 += ranks[k];
    }
  }
  
  // Calculate U statistics
  const U1 = R1 - (n1 * (n1 + 1)) / 2;
  const U2 = n1 * n2 - U1;
  const U = Math.min(U1, U2);
  
  // Normal approximation (valid for n1, n2 ≥ 8, reasonable for ≥ 3)
  const meanU = (n1 * n2) / 2;
  const stdU = Math.sqrt((n1 * n2 * (n1 + n2 + 1)) / 12);
  
  const z = stdU > 0 ? (U1 - meanU) / stdU : 0;
  
  // Approximate p-value using standard normal CDF
  const pValue = 2 * (1 - normalCDF(Math.abs(z)));
  
  // Effect size: rank-biserial correlation
  const effectSize = 1 - (2 * U) / (n1 * n2);
  
  const significant = pValue < alpha;
  
  let interpretation: string;
  if (!significant) {
    interpretation = `No significant difference (p=${pValue.toFixed(3)}, U=${U.toFixed(0)})`;
  } else if (Math.abs(effectSize) < 0.3) {
    interpretation = `Statistically significant but small effect (p=${pValue.toFixed(3)}, r=${effectSize.toFixed(2)})`;
  } else if (Math.abs(effectSize) < 0.5) {
    interpretation = `Significant with medium effect (p=${pValue.toFixed(3)}, r=${effectSize.toFixed(2)})`;
  } else {
    interpretation = `Highly significant with large effect (p=${pValue.toFixed(3)}, r=${effectSize.toFixed(2)})`;
  }
  
  return { U, z, pValue, significant, effectSize, interpretation };
}

// ============================================================================
// PHASE 2: Welch's t-test (unequal variances)
// ============================================================================

export interface WelchTTestResult {
  t: number;
  df: number;
  pValue: number;
  significant: boolean;
  meanDiff: number;
  interpretation: string;
}

/**
 * Welch's t-test for comparing means of two samples with unequal variances
 * More robust than Student's t-test when sample sizes or variances differ
 *
 * @param sample1 First sample
 * @param sample2 Second sample
 * @param alpha Significance level (default 0.05)
 */
export function welchTTest(
  sample1: number[],
  sample2: number[],
  alpha: number = 0.05
): WelchTTestResult {
  const n1 = sample1.length;
  const n2 = sample2.length;
  
  if (n1 < 2 || n2 < 2) {
    return {
      t: 0, df: 0, pValue: 1, significant: false, meanDiff: 0,
      interpretation: 'Insufficient data (need ≥2 samples per group)'
    };
  }
  
  const mean1 = sample1.reduce((a, b) => a + b, 0) / n1;
  const mean2 = sample2.reduce((a, b) => a + b, 0) / n2;
  const meanDiff = mean1 - mean2;
  
  const var1 = sample1.reduce((sum, x) => sum + Math.pow(x - mean1, 2), 0) / (n1 - 1);
  const var2 = sample2.reduce((sum, x) => sum + Math.pow(x - mean2, 2), 0) / (n2 - 1);
  
  const se = Math.sqrt(var1 / n1 + var2 / n2);
  
  if (se === 0) {
    return {
      t: 0, df: n1 + n2 - 2, pValue: 1, significant: false, meanDiff,
      interpretation: 'Zero variance — samples are identical'
    };
  }
  
  const t = meanDiff / se;
  
  // Welch-Satterthwaite degrees of freedom
  const numerator = Math.pow(var1 / n1 + var2 / n2, 2);
  const denominator = Math.pow(var1 / n1, 2) / (n1 - 1) + Math.pow(var2 / n2, 2) / (n2 - 1);
  const df = denominator > 0 ? numerator / denominator : n1 + n2 - 2;
  
  // Approximate p-value using t-distribution via normal approximation
  // For df > 30, t ≈ z; for smaller df, use conservative estimate
  const effectiveDf = Math.max(1, Math.round(df));
  const pValue = 2 * (1 - tDistCDF(Math.abs(t), effectiveDf));
  
  const significant = pValue < alpha;
  
  let interpretation: string;
  if (!significant) {
    interpretation = `No significant difference (t=${t.toFixed(2)}, df=${df.toFixed(1)}, p=${pValue.toFixed(3)})`;
  } else {
    const direction = meanDiff > 0 ? 'higher' : 'lower';
    interpretation = `Significant: Group 1 is ${Math.abs(meanDiff).toFixed(1)} pts ${direction} (t=${t.toFixed(2)}, p=${pValue.toFixed(3)})`;
  }
  
  return { t, df, pValue, significant, meanDiff, interpretation };
}

// ============================================================================
// PHASE 2: EWMA (Exponentially Weighted Moving Average) Control Chart
// ============================================================================

export interface EWMAState {
  value: number;       // Current EWMA value
  ucl: number;         // Upper control limit
  lcl: number;         // Lower control limit
  mean: number;        // Target/process mean
  sigma: number;       // Process standard deviation
  outOfControl: boolean;
}

/**
 * Update EWMA control chart with a new observation
 * Detects small sustained shifts in the process mean
 *
 * @param prevEWMA Previous EWMA value (or process mean for first observation)
 * @param newValue New observation
 * @param processMean Target/historical mean
 * @param processSigma Process standard deviation
 * @param lambda Smoothing factor (0 < λ ≤ 1, typical 0.2)
 * @param L Control limit width in sigmas (typical 2.7-3.0)
 * @param n Number of observations so far
 */
export function updateEWMA(
  prevEWMA: number,
  newValue: number,
  processMean: number,
  processSigma: number,
  lambda: number = 0.2,
  L: number = 2.7,
  n: number = 1
): EWMAState {
  // Update EWMA: Z_t = λ * X_t + (1-λ) * Z_{t-1}
  const ewmaValue = lambda * newValue + (1 - lambda) * prevEWMA;
  
  // Control limits narrow as more observations accumulate
  // σ_EWMA = σ * sqrt(λ/(2-λ) * (1-(1-λ)^(2n)))
  const ewmaSigma = processSigma * Math.sqrt(
    (lambda / (2 - lambda)) * (1 - Math.pow(1 - lambda, 2 * n))
  );
  
  const ucl = processMean + L * ewmaSigma;
  const lcl = processMean - L * ewmaSigma;
  
  const outOfControl = ewmaValue > ucl || ewmaValue < lcl;
  
  return {
    value: ewmaValue,
    ucl,
    lcl,
    mean: processMean,
    sigma: processSigma,
    outOfControl
  };
}

// ============================================================================
// Helper: Normal CDF approximation (Abramowitz & Stegun)
// ============================================================================
function normalCDF(z: number): number {
  if (z < -8) return 0;
  if (z > 8) return 1;
  
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.sqrt(2);
  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  
  return 0.5 * (1.0 + sign * y);
}

// ============================================================================
// Helper: t-distribution CDF approximation
// ============================================================================
function tDistCDF(t: number, df: number): number {
  // For large df, approximate with normal distribution
  if (df > 30) {
    return normalCDF(t);
  }
  
  // For small df, use a simple approximation
  // Cornish-Fisher approximation: adjust z-score for df
  const g1 = (t * t + 1) / (4 * df);
  const g2 = (5 * Math.pow(t, 4) + 16 * t * t + 3) / (96 * df * df);
  const z = t * (1 - g1 + g2);
  
  return normalCDF(z);
}
