import { db } from '../../db/connection-pool';
import { models, scores, runs } from '../../db/schema';
import { routerPreferences, routerProviderKeys } from '../../db/router-schema';
import { eq, and, desc, sql, inArray } from 'drizzle-orm';

// Smart caching for router rankings (5-minute TTL)
const rankingsCache = new Map<string, { data: any[]; timestamp: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Cost data per provider (per 1k tokens)
const PROVIDER_COSTS = {
  openai: { input: 0.03, output: 0.06 },     // GPT-4 average
  anthropic: { input: 0.03, output: 0.15 },  // Claude average
  google: { input: 0.0125, output: 0.0375 }, // Gemini average
  xai: { input: 0.002, output: 0.002 },      // Grok average
  glm: { input: 0.00055, output: 0.00219 },  // GLM average
  deepseek: { input: 0.00055, output: 0.00219 }, // DeepSeek average
  kimi: { input: 0.00015, output: 0.0025 }   // Kimi average
} as const;

// Model-specific cost overrides (per 1k tokens)
const MODEL_COSTS = {
  // OpenAI
  'gpt-4o-mini': { input: 0.00015, output: 0.0006 },
  'gpt-4o': { input: 0.0025, output: 0.01 },
  'gpt-5-codex': { input: 0.005, output: 0.015 },
  
  // Anthropic
  'claude-3-5-haiku-20241022': { input: 0.00025, output: 0.001 },
  'claude-3-5-sonnet-20241022': { input: 0.003, output: 0.015 },
  'claude-opus-4-1-20250805': { input: 0.015, output: 0.075 },
  
  // Google
  'gemini-1.5-flash': { input: 0.000075, output: 0.0003 },
  'gemini-2.5-pro': { input: 0.00125, output: 0.005 },
  
  // xAI
  'grok-2-latest': { input: 0.001, output: 0.005 },
  'grok-4-latest': { input: 0.002, output: 0.01 }
} as const;

interface ModelRanking {
  id: number;
  name: string;
  vendor: string;
  score: number;
  axes?: Record<string, number>;
  lastUpdated: string;
  estimatedCost: number;
  avgLatency?: number;
}

export interface SelectionCriteria {
  userId: number;
  strategy: 'best_overall' | 'best_coding' | 'best_reasoning' | 'best_creative' | 'cheapest' | 'fastest';
  excludeProviders?: string[];
  excludeModels?: string[];
  maxCost?: number;
  maxLatency?: number;
}

export interface ModelSelection {
  model: string;
  provider: string;
  score: number;
  reasoning: string;
  estimatedCost: number;
  avgLatency?: number;
}

/**
 * Get cached rankings for a specific suite and strategy
 */
async function getCachedRankings(suite: string, strategy: string): Promise<ModelRanking[]> {
  const cacheKey = `${suite}:${strategy}`;
  const cached = rankingsCache.get(cacheKey);
  
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }
  
  console.log(`🔄 Cache miss for ${cacheKey}, querying database...`);
  
  // Query scores table directly (same logic as dashboard)
  const latestScores = await db
    .select({
      modelId: models.id,
      modelName: models.name,
      vendor: models.vendor,
      score: scores.stupidScore,
      axes: scores.axes,
      ts: scores.ts
    })
    .from(scores)
    .innerJoin(models, eq(scores.modelId, models.id))
    .where(
      and(
        eq(models.showInRankings, true),
        eq(scores.suite, suite)
      )
    )
    .orderBy(desc(scores.ts));
  
  // Group by model and get latest score for each
  const modelScores = new Map<number, any>();
  for (const score of latestScores) {
    if (!modelScores.has(score.modelId)) {
      modelScores.set(score.modelId, score);
    }
  }
  
  // Convert to rankings with cost estimates
  const rankings: ModelRanking[] = Array.from(modelScores.values()).map(score => ({
    id: score.modelId,
    name: score.modelName,
    vendor: score.vendor,
    score: score.score,
    axes: score.axes,
    lastUpdated: score.ts,
    estimatedCost: calculateModelCost(score.modelName, score.vendor)
  }));
  
  // Add latency data for speed-focused strategies
  if (strategy === 'fastest') {
    await addLatencyData(rankings);
  }
  
  // Sort based on strategy
  const sortedRankings = sortRankingsByStrategy(rankings, strategy);
  
  // Cache the results
  rankingsCache.set(cacheKey, { data: sortedRankings, timestamp: Date.now() });
  
  console.log(`✅ Cached ${sortedRankings.length} rankings for ${cacheKey}`);
  return sortedRankings;
}

/**
 * Calculate estimated cost per 1k tokens for a model
 */
export function calculateModelCost(modelName: string, vendor: string): number {
  // Check for model-specific pricing first
  const modelCost = MODEL_COSTS[modelName as keyof typeof MODEL_COSTS];
  if (modelCost) {
    return (modelCost.input + modelCost.output) / 2; // Average of input/output
  }
  
  // Fall back to provider average
  const providerCost = PROVIDER_COSTS[vendor as keyof typeof PROVIDER_COSTS];
  if (providerCost) {
    return (providerCost.input + providerCost.output) / 2;
  }
  
  return 0.01; // Default fallback
}

/**
 * Add latency data to rankings for speed optimization
 */
async function addLatencyData(rankings: ModelRanking[]): Promise<void> {
  const modelIds = rankings.map(r => r.id);
  
  if (modelIds.length === 0) return;
  
  // Get recent latency data from runs table
  const latencyData = await db
    .select({
      modelId: runs.modelId,
      avgLatency: sql<number>`AVG(${runs.latencyMs})`.as('avgLatency')
    })
    .from(runs)
    .where(inArray(runs.modelId, modelIds))
    .groupBy(runs.modelId);
  
  // Map latency data back to rankings
  const latencyMap = new Map(latencyData.map(l => [l.modelId, l.avgLatency]));
  
  for (const ranking of rankings) {
    ranking.avgLatency = latencyMap.get(ranking.id) || 5000; // Default 5s if no data
  }
}

/**
 * Sort rankings based on strategy
 */
function sortRankingsByStrategy(rankings: ModelRanking[], strategy: string): ModelRanking[] {
  switch (strategy) {
    case 'best_overall':
      // Lower stupidScore is better
      return rankings.sort((a, b) => a.score - b.score);
      
    case 'best_coding':
      // Prioritize complexity and code quality from axes
      return rankings.sort((a, b) => {
        const aCodeScore = (a.axes?.complexity || 0) * 0.6 + (a.axes?.codeQuality || 0) * 0.4;
        const bCodeScore = (b.axes?.complexity || 0) * 0.6 + (b.axes?.codeQuality || 0) * 0.4;
        return bCodeScore - aCodeScore; // Higher is better
      });
      
    case 'best_reasoning':
      // For deep suite, lower stupidScore is better
      // For hourly suite, prioritize correctness and edge cases
      if (rankings[0]?.axes?.memoryRetention !== undefined) {
        // Deep suite - use stupidScore
        return rankings.sort((a, b) => a.score - b.score);
      } else {
        // Hourly suite - use reasoning-focused axes
        return rankings.sort((a, b) => {
          const aReasonScore = (a.axes?.correctness || 0) * 0.7 + (a.axes?.edgeCases || 0) * 0.3;
          const bReasonScore = (b.axes?.correctness || 0) * 0.7 + (b.axes?.edgeCases || 0) * 0.3;
          return bReasonScore - aReasonScore; // Higher is better
        });
      }
      
    case 'best_creative':
      // Prioritize format and safety (creative writing quality)
      return rankings.sort((a, b) => {
        const aCreativeScore = (a.axes?.format || 0) * 0.6 + (a.axes?.safety || 0) * 0.4;
        const bCreativeScore = (b.axes?.format || 0) * 0.6 + (b.axes?.safety || 0) * 0.4;
        return bCreativeScore - aCreativeScore; // Higher is better
      });
      
    case 'cheapest':
      // Lower cost is better
      return rankings.sort((a, b) => a.estimatedCost - b.estimatedCost);
      
    case 'fastest':
      // Lower latency is better
      return rankings.sort((a, b) => (a.avgLatency || 5000) - (b.avgLatency || 5000));
      
    default:
      return rankings.sort((a, b) => a.score - b.score);
  }
}

/**
 * Get user preferences and constraints
 */
async function getUserPreferences(userId: number): Promise<{
  strategy: string;
  maxCost?: number;
  maxLatency?: number;
  excludeProviders: string[];
  excludeModels: string[];
}> {
  const preferences = await db
    .select()
    .from(routerPreferences)
    .where(eq(routerPreferences.user_id, userId))
    .limit(1);
  
  if (preferences.length === 0) {
    return {
      strategy: 'best_overall',
      excludeProviders: [],
      excludeModels: []
    };
  }
  
  const prefs = preferences[0];
  return {
    strategy: prefs.routing_strategy || 'best_overall',
    maxCost: prefs.max_cost_per_1k_tokens || undefined,
    maxLatency: prefs.max_latency_ms || undefined,
    excludeProviders: JSON.parse(prefs.excluded_providers || '[]'),
    excludeModels: JSON.parse(prefs.excluded_models || '[]')
  };
}

/**
 * Get user's available providers
 */
async function getUserProviders(userId: number): Promise<string[]> {
  const providerKeys = await db
    .select({ provider: routerProviderKeys.provider })
    .from(routerProviderKeys)
    .where(
      and(
        eq(routerProviderKeys.user_id, userId),
        eq(routerProviderKeys.is_active, true)
      )
    );
  
  return providerKeys.map(pk => pk.provider);
}

/**
 * Main model selection function
 */
export async function selectBestModel(criteria: SelectionCriteria): Promise<ModelSelection> {
  const { userId, strategy } = criteria;
  
  // Get user preferences and available providers
  const [userPrefs, availableProviders] = await Promise.all([
    getUserPreferences(userId),
    getUserProviders(userId)
  ]);
  
  if (availableProviders.length === 0) {
    throw new Error('No active provider API keys found. Please add provider keys in your dashboard.');
  }
  
  // Determine which suite to query based on strategy
  const suiteMap = {
    'best_overall': 'hourly',
    'best_coding': 'hourly', 
    'best_reasoning': 'deep',  // Use deep benchmarks for reasoning
    'best_creative': 'hourly',
    'cheapest': 'hourly',
    'fastest': 'hourly'
  };
  
  const suite = suiteMap[strategy] || 'hourly';
  
  // Get rankings for this strategy
  let rankings = await getCachedRankings(suite, strategy);
  
  // Fallback to hourly suite if deep suite has no data
  if (rankings.length === 0 && suite === 'deep') {
    console.log('⚠️ No deep benchmark data found, falling back to hourly suite');
    rankings = await getCachedRankings('hourly', strategy);
  }
  
  if (rankings.length === 0) {
    throw new Error('No model rankings available. Please wait for benchmarks to complete.');
  }
  
  // Apply user constraints
  const filteredRankings = rankings.filter(ranking => {
    // Must have available provider
    if (!availableProviders.includes(ranking.vendor)) {
      return false;
    }
    
    // Apply user exclusions
    if (userPrefs.excludeProviders.includes(ranking.vendor)) {
      return false;
    }
    
    if (userPrefs.excludeModels.includes(ranking.name)) {
      return false;
    }
    
    // Apply cost constraint
    if (userPrefs.maxCost && ranking.estimatedCost > userPrefs.maxCost) {
      return false;
    }
    
    // Apply latency constraint
    if (userPrefs.maxLatency && ranking.avgLatency && ranking.avgLatency > userPrefs.maxLatency) {
      return false;
    }
    
    return true;
  });
  
  if (filteredRankings.length === 0) {
    throw new Error('No models match your preferences and available providers. Please adjust your settings.');
  }
  
  // Select the top model
  const selectedModel = filteredRankings[0];
  
  // Generate reasoning message
  const reasoning = generateReasoningMessage(selectedModel, strategy, suite, filteredRankings.length);
  
  return {
    model: selectedModel.name,
    provider: selectedModel.vendor,
    score: selectedModel.score,
    reasoning,
    estimatedCost: selectedModel.estimatedCost,
    avgLatency: selectedModel.avgLatency
  };
}

/**
 * Generate human-readable reasoning for model selection
 */
function generateReasoningMessage(
  model: ModelRanking, 
  strategy: string, 
  suite: string,
  totalCandidates: number
): string {
  const strategyNames = {
    'best_overall': 'best overall performance',
    'best_coding': 'best coding capabilities', 
    'best_reasoning': 'best reasoning abilities',
    'best_creative': 'best creative writing',
    'cheapest': 'most cost-effective',
    'fastest': 'fastest response time'
  };
  
  const strategyName = strategyNames[strategy as keyof typeof strategyNames] || strategy;
  const suiteInfo = suite === 'deep' ? ' (deep reasoning benchmarks)' : '';
  const timeAgo = getTimeAgo(model.lastUpdated);
  
  let scoreInfo = '';
  if (strategy === 'cheapest') {
    scoreInfo = ` at $${model.estimatedCost.toFixed(4)}/1k tokens`;
  } else if (strategy === 'fastest') {
    scoreInfo = ` with ${model.avgLatency}ms avg latency`;
  } else {
    scoreInfo = ` (score: ${model.score.toFixed(1)})`;
  }
  
  return `Selected ${model.name} from ${model.vendor} for ${strategyName}${scoreInfo}${suiteInfo}. Ranked #1 of ${totalCandidates} available models. Last updated ${timeAgo}.`;
}

/**
 * Convert timestamp to human-readable time ago
 */
function getTimeAgo(timestamp: string): string {
  const now = Date.now();
  const then = new Date(timestamp).getTime();
  const diffMs = now - then;
  
  const minutes = Math.floor(diffMs / 60000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  
  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return 'just now';
}

/**
 * Invalidate cache for a specific suite (called after benchmarks complete)
 */
export function invalidateRouterCache(suite?: string): void {
  if (suite) {
    // Invalidate specific suite
    for (const [key] of rankingsCache) {
      if (key.startsWith(`${suite}:`)) {
        rankingsCache.delete(key);
      }
    }
    console.log(`🗑️ Invalidated router cache for suite: ${suite}`);
  } else {
    // Invalidate all cache
    rankingsCache.clear();
    console.log('🗑️ Invalidated all router cache');
  }
}

/**
 * Get cache statistics for monitoring
 */
export function getCacheStats(): { size: number; keys: string[]; oldestEntry: number } {
  const now = Date.now();
  let oldestEntry = now;
  
  for (const [, cached] of rankingsCache) {
    if (cached.timestamp < oldestEntry) {
      oldestEntry = cached.timestamp;
    }
  }
  
  return {
    size: rankingsCache.size,
    keys: Array.from(rankingsCache.keys()),
    oldestEntry: now - oldestEntry
  };
}
