/**
 * Score Conversion Utilities
 * 
 * Provides consistent score conversion logic across the entire application.
 * Handles conversion between different score formats and validates score data.
 */

/**
 * Convert raw score to display score (0-100 range where higher is better)
 * 
 * @param rawScore - The raw score from the database
 * @param isUserTest - Whether this is from a user API key test
 * @returns Display score in 0-100 range, or null if invalid
 */
export function convertToDisplayScore(
  rawScore: number | null,
  isUserTest: boolean = false
): number | null {
  if (rawScore === null || rawScore === undefined || isNaN(rawScore)) {
    return null;
  }

  // Check for sentinel values that indicate unavailable/error states
  if (rawScore === -777 || rawScore === -888 || rawScore === -999 || rawScore === -100) {
    return null;
  }

  let displayScore: number;

  if (isUserTest) {
    // For user tests, stupidScore is already inverted (lower = better)
    // Convert back to display score: displayScore = 100 - (stupidScore / 0.8)
    displayScore = Math.max(0, Math.min(100, Math.round(100 - (rawScore / 0.8))));
  } else if (Math.abs(rawScore) < 1 && rawScore !== 0) {
    // Old format: small decimal values (e.g., 0.123, -0.456)
    // Convert to 0-100 scale
    displayScore = Math.max(0, Math.min(100, Math.round(50 - rawScore * 100)));
  } else if (rawScore >= 0 && rawScore <= 100) {
    // Standard format: already in 0-100 range
    displayScore = Math.max(0, Math.min(100, Math.round(rawScore)));
  } else {
    // Unexpected format: clamp to safe range
    displayScore = Math.max(0, Math.min(100, Math.round(Math.abs(rawScore))));
  }

  return displayScore;
}

/**
 * Combine hourly and deep scores with weighted average
 * 
 * @param hourlyScore - Score from hourly benchmarks (0-100)
 * @param deepScore - Score from deep reasoning benchmarks (0-100)
 * @returns Combined score with 70% hourly, 30% deep weighting
 */
export function combineScores(
  hourlyScore: number | null,
  deepScore: number | null
): number | null {
  // If both scores are available, combine them
  if (hourlyScore !== null && deepScore !== null) {
    return Math.round(hourlyScore * 0.7 + deepScore * 0.3);
  }

  // If only hourly score is available, use it
  if (hourlyScore !== null) {
    return hourlyScore;
  }

  // If only deep score is available, use it
  if (deepScore !== null) {
    return deepScore;
  }

  // No valid scores available
  return null;
}

/**
 * Validate if a score is valid and usable
 * 
 * @param score - The score to validate
 * @returns true if score is valid, false otherwise
 */
export function isValidScore(score: number | null): boolean {
  if (score === null || score === undefined || isNaN(score)) {
    return false;
  }

  // Check for sentinel values that indicate errors/unavailable
  if (score === -777 || score === -888 || score === -999 || score === -100) {
    return false;
  }

  // Check if score is negative (except for old format small decimals)
  if (score < 0 && Math.abs(score) >= 1) {
    return false;
  }

  return true;
}

/**
 * Calculate stability score from a series of scores
 * 
 * @param scores - Array of scores to analyze
 * @returns Stability score (0-100, higher = more stable)
 */
export function calculateStability(scores: number[]): number {
  if (scores.length < 2) {
    return 75; // Default moderate stability for insufficient data
  }

  // Calculate standard deviation
  const avg = scores.reduce((sum, s) => sum + s, 0) / scores.length;
  const variance = scores.reduce((sum, s) => {
    const diff = s - avg;
    return sum + (diff * diff);
  }, 0) / scores.length;
  const stdDev = Math.sqrt(variance);

  // Convert standard deviation to stability score
  // For 0-100 score range, stdDev of 2-3 is stable, 5-8 is moderate, 10+ is unstable
  let stability: number;

  if (stdDev <= 2) {
    // Very stable: 90-95%
    stability = Math.max(90, Math.min(95, Math.round(95 - (stdDev * 2.5))));
  } else if (stdDev <= 5) {
    // Good stability: 75-90%
    stability = Math.max(75, Math.min(90, Math.round(90 - ((stdDev - 2) * 5))));
  } else if (stdDev <= 10) {
    // Moderate stability: 45-75%
    stability = Math.max(45, Math.min(75, Math.round(75 - ((stdDev - 5) * 6))));
  } else if (stdDev <= 20) {
    // Poor stability: 25-45%
    stability = Math.max(25, Math.min(45, Math.round(45 - ((stdDev - 10) * 2))));
  } else {
    // Very unstable: 0-25%
    stability = Math.max(0, Math.min(25, Math.round(25 - ((stdDev - 20) * 0.5))));
  }

  return Math.round(stability);
}

/**
 * Calculate trend from a series of scores
 * 
 * @param scores - Array of scores (newest first)
 * @param threshold - Minimum change to consider as trend (default: 5)
 * @returns 'up', 'down', or 'stable'
 */
export function calculateTrend(
  scores: number[],
  threshold: number = 5
): 'up' | 'down' | 'stable' {
  if (scores.length < 2) {
    return 'stable';
  }

  const latest = scores[0];
  const oldest = scores[scores.length - 1];
  const change = latest - oldest;

  if (change > threshold) {
    return 'up';
  } else if (change < -threshold) {
    return 'down';
  } else {
    return 'stable';
  }
}

/**
 * Get status label based on score
 * 
 * @param score - The score to evaluate
 * @returns Status label
 */
export function getStatusFromScore(score: number | null | 'unavailable'): string {
  if (score === null || score === 'unavailable') {
    return 'unavailable';
  }

  if (typeof score !== 'number') {
    return 'unavailable';
  }

  if (score >= 80) return 'excellent';
  if (score >= 65) return 'good';
  if (score >= 40) return 'warning';
  return 'critical';
}

/**
 * Batch convert multiple scores
 * 
 * @param scores - Array of raw scores with metadata
 * @returns Array of converted scores
 */
export function batchConvertScores(
  scores: Array<{ stupidScore: number; note?: string; ts?: string }>
): Array<{ displayScore: number | null; timestamp: string }> {
  return scores.map(score => {
    const isUserTest = score.note?.includes('User API key test') || false;
    const displayScore = convertToDisplayScore(score.stupidScore, isUserTest);
    
    return {
      displayScore,
      timestamp: score.ts || new Date().toISOString()
    };
  });
}
