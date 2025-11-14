// apps/api/src/lib/model-scoring.ts
// GLOBAL MODEL SCORING SYSTEM - Single Source of Truth
// This module is the centralized scoring system used by ALL parts of the application
// to ensure consistency across live rankings, details pages, analytics, and caching

import { db } from '../db/index';
import { models, scores, runs } from '../db/schema';
import { eq, desc, sql, and, gte } from 'drizzle-orm';

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

export type PeriodKey = 'latest' | '24h' | '7d' | '1m';
export type SortKey = 'combined' | 'reasoning' | 'speed' | '7axis' | 'tooling' | 'price' | 'trend' | 'stability' | 'change';

export interface ModelScore {
  id: string;
  name: string;
  provider: string;
  vendor: string; // Alias for provider for backward compatibility
  currentScore: number | 'unavailable';
  score: number | 'unavailable'; // Alias for currentScore for backward compatibility
  trend: string;
  lastUpdated: Date;
  status: string;
  weeklyBest?: number | 'unavailable';
  weeklyWorst?: number | 'unavailable';
  avgLatency?: number;
  tasksCompleted?: number;
  totalTasks?: number;
  unavailableReason?: string;
  history?: any[];
  periodAvg?: number;
  stability?: number;
  changeFromPrevious?: number;
  dataPoints?: number;
  isNew?: boolean;
  usesReasoningEffort?: boolean;
  isStale?: boolean;
}

export interface HistoryPoint {
  timestamp: Date;
  score: number;
  axes?: any;
  stupidScore?: number;
  suite?: string;
  confidence_lower?: number;
  confidence_upper?: number;
}

// ============================================================================
// MAIN SCORING FUNCTIONS - Used by ALL systems
// ============================================================================

/**
 * GLOBAL ENTRY POINT: Compute model scores for any period/mode combination
 * This is the single function that should be called by:
 * - /dashboard/scores endpoint
 * - /dashboard-cached endpoint
 * - /dashboard/history/:modelId endpoint
 * - Analytics endpoints
 * - Any other system that needs model scores
 */
export async function computeModelScores(
  period: PeriodKey = 'latest',
  sortBy: SortKey = 'combined'
): Promise<ModelScore[]> {
  console.log(`🎯 [GLOBAL-SCORING] Computing scores: period=${period}, sortBy=${sortBy}`);
  
  let modelScores: ModelScore[];

  // Route to appropriate scoring function based on mode
  if (sortBy === 'combined') {
    modelScores = period === 'latest'
      ? await computeCombinedScores()
      : await computeHistoricalCombinedScores(period);
  } else if (sortBy === 'reasoning') {
    modelScores = period === 'latest'
      ? await computeReasoningScores()
      : await computeHistoricalReasoningScores(period);
  } else if (sortBy === 'speed' || sortBy === '7axis') {
    modelScores = period === 'latest'
      ? await computeSpeedScores()
      : await computeHistoricalSpeedScores(period);
  } else if (sortBy === 'tooling') {
    modelScores = period === 'latest'
      ? await computeToolingScores()
      : await computeHistoricalToolingScores(period);
  } else if (sortBy === 'price') {
    // Price mode uses combined scores + price sorting
    modelScores = period === 'latest'
      ? await computeCombinedScores()
      : await computeHistoricalCombinedScores(period);
  } else {
    // Default to combined
    modelScores = period === 'latest'
      ? await computeCombinedScores()
      : await computeHistoricalCombinedScores(period);
  }

  // Apply sorting
  return sortModelScores(modelScores, sortBy);
}

/**
 * Get score for a single model (used by details pages, analytics)
 */
export async function getSingleModelScore(
  modelId: number,
  period: PeriodKey = 'latest',
  sortBy: SortKey = 'combined'
): Promise<ModelScore | null> {
  const allScores = await computeModelScores(period, sortBy);
  return allScores.find(m => String(m.id) === String(modelId)) || null;
}

/**
 * Get historical chart data for a single model
 */
export async function getModelHistory(
  modelId: number,
  period: PeriodKey = 'latest',
  sortBy: SortKey = 'combined'
): Promise<HistoryPoint[]> {
  console.log(`📊 [GLOBAL-SCORING] Fetching history: modelId=${modelId}, period=${period}, sortBy=${sortBy}`);
  
  // Determine time range
  const timeThreshold = getTimeThreshold(period, sortBy);
  const dataLimit = getDataLimit(period);
  
  // Fetch appropriate suite data based on sort mode
  const suites = getSuitesForMode(sortBy);
  
  const history = await db
    .select({
      stupidScore: scores.stupidScore,
      ts: scores.ts,
      axes: scores.axes,
      suite: scores.suite,
      note: scores.note,
      confidence_lower: scores.confidenceLower,
      confidence_upper: scores.confidenceUpper
    })
    .from(scores)
    .where(and(
      eq(scores.modelId, modelId),
      sql`suite IN (${sql.join(suites.map(s => sql`${s}`), sql`, `)})`,
      gte(scores.ts, timeThreshold.toISOString())
    ))
    .orderBy(desc(scores.ts))
    .limit(dataLimit * suites.length);
  
  // Filter valid scores
  const validHistory = history.filter(h =>
    h.stupidScore !== null &&
    h.stupidScore !== -777 &&
    h.stupidScore !== -888 &&
    h.stupidScore !== -999 &&
    h.stupidScore >= 0
  );
  
  // Convert to display format
  return validHistory.map(h => ({
    timestamp: new Date(h.ts || new Date()),
    score: Math.max(0, Math.min(100, Math.round(h.stupidScore))),
    axes: h.axes,
    stupidScore: h.stupidScore,
    suite: h.suite || undefined,
    confidence_lower: h.confidence_lower || undefined,
    confidence_upper: h.confidence_upper || undefined
  }));
}

// ============================================================================
// COMBINED SCORING (50% hourly + 25% deep + 25% tooling)
// ============================================================================

async function computeCombinedScores(): Promise<ModelScore[]> {
  const allModels = await db.select().from(models).where(sql`show_in_rankings = 1`);
  const modelScores: ModelScore[] = [];
  
  for (const model of allModels) {
    // Get latest scores from all three suites
    const [hourlyScore, deepScore, toolingScore] = await Promise.all([
      getLatestScore(model.id, 'hourly'),
      getLatestScore(model.id, 'deep'),
      getLatestScore(model.id, 'tooling')
    ]);
    
    const hasHourly = hourlyScore && hourlyScore.stupidScore >= 0;
    const hasDeep = deepScore && deepScore.stupidScore >= 0;
    const hasTooling = toolingScore && toolingScore.stupidScore >= 0;
    
    if (!hasHourly && !hasDeep && !hasTooling) {
      // No valid scores - mark as unavailable
      modelScores.push(createUnavailableScore(model, 'No recent benchmark data'));
      continue;
    }
    
    // Calculate combined score with proper weighting
    const hourlyDisplay = hasHourly ? Math.round(hourlyScore.stupidScore) : 50;
    const deepDisplay = hasDeep ? Math.round(deepScore.stupidScore) : 50;
    const toolingDisplay = hasTooling ? Math.round(toolingScore.stupidScore) : 50;
    
    const combinedScore = Math.round(
      hourlyDisplay * 0.5 + deepDisplay * 0.25 + toolingDisplay * 0.25
    );
    
    // Get trend and other metrics
    const trend = await calculateTrend(model.id, 'hourly');
    const status = getStatus(combinedScore);
    const lastUpdated = new Date(hourlyScore?.ts || deepScore?.ts || new Date());
    
    modelScores.push({
      id: String(model.id),
      name: model.name,
      provider: model.vendor,
      vendor: model.vendor,
      currentScore: combinedScore,
      score: combinedScore,
      trend,
      lastUpdated,
      status,
      isNew: isModelNew(model),
      usesReasoningEffort: Boolean(model.usesReasoningEffort)
    });
  }
  
  return modelScores;
}

async function computeHistoricalCombinedScores(period: PeriodKey): Promise<ModelScore[]> {
  const allModels = await db.select().from(models).where(sql`show_in_rankings = 1`);
  const modelScores: ModelScore[] = [];
  const timeThreshold = getTimeThreshold(period);
  
  for (const model of allModels) {
    // Get historical scores from all three suites
    const historicalScores = await db
      .select()
      .from(scores)
      .where(and(
        eq(scores.modelId, model.id),
        gte(scores.ts, timeThreshold.toISOString())
      ))
      .orderBy(desc(scores.ts));
    
    const validScores = historicalScores.filter(s =>
      s.stupidScore !== null && s.stupidScore >= 0
    );
    
    if (validScores.length === 0) {
      continue; // Skip models with no data in this period
    }
    
    // Calculate period average
    const convertedScores = validScores.map(s => 
      Math.max(0, Math.min(100, Math.round(s.stupidScore)))
    );
    const periodAvg = Math.round(
      convertedScores.reduce((sum, s) => sum + s, 0) / convertedScores.length
    );
    
    // Calculate stability
    const stability = calculateStability(convertedScores);
    
    // Calculate trend
    const trend = convertedScores.length >= 3
      ? (convertedScores[0] - convertedScores[convertedScores.length - 1] > 5 ? 'up'
        : convertedScores[0] - convertedScores[convertedScores.length - 1] < -5 ? 'down'
        : 'stable')
      : 'stable';
    
    modelScores.push({
      id: String(model.id),
      name: model.name,
      provider: model.vendor,
      vendor: model.vendor,
      currentScore: periodAvg,
      score: periodAvg,
      trend,
      lastUpdated: new Date(historicalScores[0].ts || new Date()),
      status: getStatus(periodAvg),
      periodAvg,
      stability,
      dataPoints: validScores.length,
      isNew: isModelNew(model),
      usesReasoningEffort: Boolean(model.usesReasoningEffort)
    });
  }
  
  return modelScores;
}

// ============================================================================
// REASONING SCORING (100% deep benchmarks)
// ============================================================================

async function computeReasoningScores(): Promise<ModelScore[]> {
  const allModels = await db.select().from(models).where(sql`show_in_rankings = 1`);
  const modelScores: ModelScore[] = [];
  
  for (const model of allModels) {
    const deepScore = await getLatestScore(model.id, 'deep');
    
    if (!deepScore || deepScore.stupidScore < 0) {
      modelScores.push(createUnavailableScore(model, 'No deep reasoning benchmark data'));
      continue;
    }
    
    const reasoningScore = Math.round(deepScore.stupidScore);
    const trend = await calculateTrend(model.id, 'deep');
    
    modelScores.push({
      id: String(model.id),
      name: model.name,
      provider: model.vendor,
      vendor: model.vendor,
      currentScore: reasoningScore,
      score: reasoningScore,
      trend,
      lastUpdated: new Date(deepScore.ts || new Date()),
      status: getStatus(reasoningScore),
      isNew: isModelNew(model),
      usesReasoningEffort: Boolean(model.usesReasoningEffort)
    });
  }
  
  return modelScores;
}

async function computeHistoricalReasoningScores(period: PeriodKey): Promise<ModelScore[]> {
  return computeHistoricalScoresForSuite(period, 'deep');
}

// ============================================================================
// TOOLING SCORING (100% tooling benchmarks)
// ============================================================================

async function computeToolingScores(): Promise<ModelScore[]> {
  const allModels = await db.select().from(models).where(sql`show_in_rankings = 1`);
  const modelScores: ModelScore[] = [];
  
  for (const model of allModels) {
    const toolingScore = await getLatestScore(model.id, 'tooling');
    
    if (!toolingScore || toolingScore.stupidScore < 0) {
      modelScores.push(createUnavailableScore(model, 'No tooling benchmark data'));
      continue;
    }
    
    const score = Math.round(toolingScore.stupidScore);
    const trend = await calculateTrend(model.id, 'tooling');
    
    modelScores.push({
      id: String(model.id),
      name: model.name,
      provider: model.vendor,
      vendor: model.vendor,
      currentScore: score,
      score: score,
      trend,
      lastUpdated: new Date(toolingScore.ts || new Date()),
      status: getStatus(score),
      isNew: isModelNew(model),
      usesReasoningEffort: Boolean(model.usesReasoningEffort)
    });
  }
  
  return modelScores;
}

async function computeHistoricalToolingScores(period: PeriodKey): Promise<ModelScore[]> {
  return computeHistoricalScoresForSuite(period, 'tooling');
}

// ============================================================================
// SPEED/7AXIS SCORING (100% hourly benchmarks)
// ============================================================================

async function computeSpeedScores(): Promise<ModelScore[]> {
  const allModels = await db.select().from(models).where(sql`show_in_rankings = 1`);
  const modelScores: ModelScore[] = [];
  
  for (const model of allModels) {
    const hourlyScore = await getLatestScore(model.id, 'hourly');
    
    if (!hourlyScore || hourlyScore.stupidScore < 0) {
      modelScores.push(createUnavailableScore(model, 'No hourly benchmark data'));
      continue;
    }
    
    const score = Math.round(hourlyScore.stupidScore);
    const trend = await calculateTrend(model.id, 'hourly');
    
    modelScores.push({
      id: String(model.id),
      name: model.name,
      provider: model.vendor,
      vendor: model.vendor,
      currentScore: score,
      score: score,
      trend,
      lastUpdated: new Date(hourlyScore.ts || new Date()),
      status: getStatus(score),
      isNew: isModelNew(model),
      usesReasoningEffort: Boolean(model.usesReasoningEffort)
    });
  }
  
  return modelScores;
}

async function computeHistoricalSpeedScores(period: PeriodKey): Promise<ModelScore[]> {
  return computeHistoricalScoresForSuite(period, 'hourly');
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

async function getLatestScore(modelId: number, suite: string) {
  const result = await db
    .select()
    .from(scores)
    .where(and(eq(scores.modelId, modelId), eq(scores.suite, suite)))
    .orderBy(desc(scores.ts))
    .limit(1);
  
  return result[0] || null;
}

async function calculateTrend(modelId: number, suite: string): Promise<string> {
  const recentScores = await db
    .select()
    .from(scores)
    .where(and(eq(scores.modelId, modelId), eq(scores.suite, suite)))
    .orderBy(desc(scores.ts))
    .limit(10);
  
  const validScores = recentScores.filter(s => s.stupidScore !== null && s.stupidScore >= 0);
  
  if (validScores.length < 3) return 'stable';
  
  const latest = Math.round(validScores[0].stupidScore);
  const oldest = Math.round(validScores[validScores.length - 1].stupidScore);
  const diff = latest - oldest;
  
  if (diff > 5) return 'up';
  if (diff < -5) return 'down';
  return 'stable';
}

function calculateStability(scores: number[]): number {
  if (scores.length < 3) return 75;
  
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  const variance = scores.reduce((sum, s) => sum + Math.pow(s - mean, 2), 0) / scores.length;
  const stdDev = Math.sqrt(variance);
  
  if (stdDev <= 2) return Math.max(90, Math.min(95, Math.round(95 - stdDev * 2.5)));
  if (stdDev <= 5) return Math.max(75, Math.min(90, Math.round(90 - (stdDev - 2) * 5)));
  if (stdDev <= 10) return Math.max(45, Math.min(75, Math.round(75 - (stdDev - 5) * 6)));
  if (stdDev <= 20) return Math.max(25, Math.min(45, Math.round(45 - (stdDev - 10) * 2)));
  return Math.max(0, Math.min(25, Math.round(25 - (stdDev - 20) * 0.5)));
}

function getStatus(score: number): string {
  if (score < 40) return 'critical';
  if (score < 65) return 'warning';
  if (score < 80) return 'good';
  return 'excellent';
}

function isModelNew(model: any): boolean {
  if (!model.createdAt) return false;
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  return new Date(model.createdAt) > sevenDaysAgo;
}

function createUnavailableScore(model: any, reason: string): ModelScore {
  return {
    id: String(model.id),
    name: model.name,
    provider: model.vendor,
    vendor: model.vendor,
    currentScore: 'unavailable',
    score: 'unavailable',
    trend: 'unavailable',
    lastUpdated: new Date(),
    status: 'unavailable',
    unavailableReason: reason,
    history: [],
    isNew: isModelNew(model),
    usesReasoningEffort: Boolean(model.usesReasoningEffort)
  };
}

async function computeHistoricalScoresForSuite(period: PeriodKey, suite: string): Promise<ModelScore[]> {
  const allModels = await db.select().from(models).where(sql`show_in_rankings = 1`);
  const modelScores: ModelScore[] = [];
  const timeThreshold = getTimeThreshold(period);
  const dataLimit = getDataLimit(period);
  
  for (const model of allModels) {
    const historicalScores = await db
      .select()
      .from(scores)
      .where(and(
        eq(scores.modelId, model.id),
        eq(scores.suite, suite),
        gte(scores.ts, timeThreshold.toISOString())
      ))
      .orderBy(desc(scores.ts))
      .limit(dataLimit);
    
    const validScores = historicalScores.filter(s =>
      s.stupidScore !== null && s.stupidScore >= 0
    );
    
    if (validScores.length === 0) continue;
    
    const convertedScores = validScores.map(s => 
      Math.max(0, Math.min(100, Math.round(s.stupidScore)))
    );
    const periodAvg = Math.round(
      convertedScores.reduce((sum, s) => sum + s, 0) / convertedScores.length
    );
    
    const stability = calculateStability(convertedScores);
    const latest = convertedScores[0];
    const oldest = convertedScores[convertedScores.length - 1];
    const trend = latest - oldest > 5 ? 'up' : latest - oldest < -5 ? 'down' : 'stable';
    
    modelScores.push({
      id: String(model.id),
      name: model.name,
      provider: model.vendor,
      vendor: model.vendor,
      currentScore: periodAvg,
      score: periodAvg,
      trend,
      lastUpdated: new Date(historicalScores[0].ts || new Date()),
      status: getStatus(periodAvg),
      periodAvg,
      stability,
      dataPoints: validScores.length,
      isNew: isModelNew(model),
      usesReasoningEffort: Boolean(model.usesReasoningEffort)
    });
  }
  
  return modelScores;
}

function getTimeThreshold(period: PeriodKey, sortBy?: SortKey): Date {
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
      // For 7axis in latest mode, use 1 year to show full trend
      if (sortBy === '7axis') {
        return new Date(now - 365 * 24 * 60 * 60 * 1000);
      }
      return new Date(now - 7 * 24 * 60 * 60 * 1000);
  }
}

function getDataLimit(period: PeriodKey): number {
  switch (period) {
    case '24h':
      return 48;
    case '7d':
      return 168;
    case '1m':
      return 720;
    case 'latest':
    default:
      return 168;
  }
}

function getSuitesForMode(sortBy: SortKey): string[] {
  switch (sortBy) {
    case 'combined':
      return ['hourly', 'deep', 'tooling'];
    case 'reasoning':
      return ['deep'];
    case 'tooling':
      return ['tooling'];
    case 'speed':
    case '7axis':
    case 'price':
    default:
      return ['hourly'];
  }
}

// ============================================================================
// SORTING FUNCTIONS
// ============================================================================

function sortModelScores(modelScores: ModelScore[], sortBy: SortKey): ModelScore[] {
  const available = modelScores.filter(m => m.currentScore !== 'unavailable');
  const unavailable = modelScores.filter(m => m.currentScore === 'unavailable');
  
  switch (sortBy) {
    case 'price':
      // TODO: Add price-based sorting
      available.sort((a, b) => (b.currentScore as number) - (a.currentScore as number));
      break;
    case 'trend':
      available.sort((a, b) => {
        const trendOrder = { up: 2, stable: 1, down: 0 };
        const aTrend = trendOrder[a.trend as keyof typeof trendOrder] || 0;
        const bTrend = trendOrder[b.trend as keyof typeof trendOrder] || 0;
        if (aTrend !== bTrend) return bTrend - aTrend;
        return (b.currentScore as number) - (a.currentScore as number);
      });
      break;
    case 'stability':
      available.sort((a, b) => {
        const aStab = a.stability || 0;
        const bStab = b.stability || 0;
        if (aStab !== bStab) return bStab - aStab;
        return (b.currentScore as number) - (a.currentScore as number);
      });
      break;
    default:
      // Sort by score (highest first)
      available.sort((a, b) => (b.currentScore as number) - (a.currentScore as number));
  }
  
  return [...available, ...unavailable];
}

// ============================================================================
// BACKWARD COMPATIBILITY EXPORTS
// ============================================================================

// Export aliases for backward compatibility with existing code
export const computeDashboardScores = computeModelScores;
export const getSingleModelCombinedScore = async (modelId: number) => {
  const score = await getSingleModelScore(modelId, 'latest', 'combined');
  return score ? (score.currentScore as number) : null;
};
