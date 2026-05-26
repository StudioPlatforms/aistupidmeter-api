import { db } from '../../db/connection-pool';
import { models, scores, runs } from '../../db/schema';
import { routerPreferences, routerProviderKeys } from '../../db/router-schema';
import { eq, and, desc, sql, inArray } from 'drizzle-orm';
import { computeDashboardScores } from '../../lib/dashboard-compute';

// Smart caching for router rankings (5-minute TTL)
const rankingsCache = new Map<string, { data: ModelRanking[]; timestamp: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Cost data per provider (per 1k tokens)
// OFFICIAL VERIFIED pricing per 1k tokens (May 26, 2026)
// TODO: consolidate pricing into a single source (duplicated in proxy/index.ts)
const PROVIDER_COSTS = {
  openai: { input: 0.00125, output: 0.01 },   // GPT-5.1 average
  anthropic: { input: 0.003, output: 0.015 }, // Sonnet 4 average
  google: { input: 0.00125, output: 0.01 },   // Gemini 2.5 Pro average
  xai: { input: 0.003, output: 0.015 },       // Grok 4.3 average
  glm: { input: 0.0006, output: 0.0022 },     // GLM-5 average
  deepseek: { input: 0.00028, output: 0.00042 }, // DeepSeek V4 average
  kimi: { input: 0.0006, output: 0.0025 }     // Kimi K2 average
} as const;

// Model-specific cost overrides (per 1k tokens) - OFFICIAL VERIFIED May 26, 2026
const MODEL_COSTS = {
  // OpenAI
  'gpt-4o-mini': { input: 0.00015, output: 0.0006 },
  'gpt-4o': { input: 0.0025, output: 0.01 },
  'gpt-5': { input: 0.00125, output: 0.01 },
  'gpt-5.1': { input: 0.00125, output: 0.01 },
  'gpt-5.2': { input: 0.00175, output: 0.014 },
  'gpt-5.4': { input: 0.0025, output: 0.015 },
  'gpt-5.5': { input: 0.005, output: 0.03 },
  'gpt-5.5-pro': { input: 0.005, output: 0.03 },
  'gpt-5.5-2026-04-23': { input: 0.005, output: 0.03 },
  'gpt-5-codex': { input: 0.00125, output: 0.01 },
  'gpt-5.1-codex': { input: 0.00125, output: 0.01 },
  
  // Anthropic (May 2026 — removed deprecated dated IDs)
  'claude-3-5-haiku': { input: 0.00025, output: 0.00125 },
  'claude-haiku-4-5': { input: 0.00025, output: 0.00125 },
  'claude-sonnet-4-5': { input: 0.003, output: 0.015 },
  'claude-sonnet-4-5-20250929': { input: 0.003, output: 0.015 },
  'claude-sonnet-4-6': { input: 0.003, output: 0.015 },
  'claude-opus-4-5-20251101': { input: 0.005, output: 0.025 },
  'claude-opus-4-6': { input: 0.005, output: 0.025 },
  'claude-opus-4-7': { input: 0.005, output: 0.025 },
  // REMOVED: claude-sonnet-4-20250514, claude-opus-4-20250514 — retire June 15, 2026
  // REMOVED: claude-opus-4-1-20250805 — legacy, verify deprecation date
  
  // Google (May 2026 — removed gemini-1.5-*)
  'gemini-2.5-pro': { input: 0.00125, output: 0.01 },
  'gemini-2.5-flash': { input: 0.0003, output: 0.0025 },
  'gemini-2.5-flash-lite': { input: 0.0001, output: 0.0004 },
  'gemini-3.1-pro-preview': { input: 0.002, output: 0.012 },
  'gemini-3.1-flash-lite': { input: 0.00025, output: 0.0015 },
  'gemini-3.5-flash': { input: 0.00025, output: 0.002 },
  // REMOVED: gemini-1.5-pro, gemini-1.5-flash — retiring June 1, 2026
  
  // xAI (May 2026 — retired grok-4-0709, grok-code-fast-1, grok-2-latest)
  'grok-4.3': { input: 0.003, output: 0.015 },
  'grok-build-0.1': { input: 0.0002, output: 0.0015 },
  
  // DeepSeek (May 2026 — removed deprecated aliases)
  'deepseek-v4-flash': { input: 0.0000028, output: 0.00028 },
  'deepseek-v4-pro': { input: 0.000003625, output: 0.00087 },
  // REMOVED: deepseek-chat, deepseek-reasoner — hard retire July 24, 2026
  
  // Kimi
  'kimi-k2.5': { input: 0.0003, output: 0.0015 },
  'kimi-k2.6': { input: 0.0003, output: 0.0015 },
  
  // GLM (May 2026 — removed hallucinated flash models, added GLM-5)
  'glm-4.6': { input: 0.0001, output: 0.0005 },
  'glm-4.7': { input: 0.00015, output: 0.00075 },
  'glm-5': { input: 0.0002, output: 0.001 },
  'glm-5.1': { input: 0.0002, output: 0.001 }
  // REMOVED: glm-4.7-flash, glm-4.7-flashx — not in Z.AI catalog
} as const;

// Models known to support tool/function calling (May 2026)
const TOOL_CALLING_MODELS = new Set([
  // OpenAI
  'gpt-4o', 'gpt-4o-mini', 'gpt-5', 'gpt-5.1', 'gpt-5.2', 'gpt-5.4', 'gpt-5.5',
  'gpt-5.5-pro', 'gpt-5.5-2026-04-23', 'gpt-5-codex', 'gpt-5.1-codex',
  // Anthropic (removed deprecated dated IDs)
  'claude-3-5-haiku', 'claude-haiku-4-5',
  'claude-sonnet-4-5', 'claude-sonnet-4-5-20250929', 'claude-sonnet-4-6',
  'claude-opus-4-5-20251101', 'claude-opus-4-6', 'claude-opus-4-7',
  // Google (removed gemini-1.5-*)
  'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite',
  'gemini-3.1-pro-preview', 'gemini-3.1-flash-lite', 'gemini-3.5-flash',
  // xAI (May 2026 — retired old models)
  'grok-4.3', 'grok-build-0.1',
  // DeepSeek (removed deprecated aliases)
  'deepseek-v4-flash', 'deepseek-v4-pro',
  // Kimi
  'kimi-k2.5', 'kimi-k2.6',
  // GLM (removed hallucinated flash models, added GLM-5)
  'glm-4.6', 'glm-4.7', 'glm-5', 'glm-5.1'
]);

// Models known to support streaming
const STREAMING_MODELS = new Set([
  // Nearly all modern models support streaming — list exceptions instead
  // For now, assume all models support streaming; this set is used as a whitelist
  ...TOOL_CALLING_MODELS // All tool-calling models also support streaming
]);

interface ModelRanking {
  id: number;
  name: string;
  vendor: string;
  score: number;
  axes: Record<string, number>;
  lastUpdated: string;
  estimatedCost: number;
  avgLatency?: number;
  supportsToolCalling: boolean;
  supportsStreaming: boolean;
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
 * Get cached rankings using the SAME computed scores as the dashboard
 * This ensures consistency between what users see on the website and what the router selects
 */
async function getCachedRankings(suite: string, strategy: string): Promise<ModelRanking[]> {
  const cacheKey = `${suite}:${strategy}`;
  const cached = rankingsCache.get(cacheKey);
  
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }
  
  console.log(`🔄 Cache miss for ${cacheKey}, using dashboard compute...`);
  
  // CRITICAL FIX: Use the SAME computeDashboardScores function as the website
  // This ensures the router sees the same scores (e.g., Claude=71, not 82)
  const sortByMap: Record<string, 'combined' | 'reasoning' | 'speed' | '7axis' | 'tooling'> = {
    'best_overall': 'combined',
    'best_coding': '7axis',
    'best_reasoning': 'reasoning',
    'best_creative': 'combined',
    'cheapest': 'combined',
    'fastest': 'speed'
  };
  
  const sortBy = sortByMap[strategy] || 'combined';
  const dashboardScores = await computeDashboardScores('latest', sortBy);
  
  // Convert dashboard scores to ModelRanking format
  // FIX: Include axes data so strategy-specific sorting works correctly
  const rankings: ModelRanking[] = dashboardScores
    .filter((score: any) => score.currentScore !== 'unavailable')
    .map((score: any) => {
      const modelName = score.name as string;
      const vendor = score.provider as string;
      
      // Extract axes from the dashboard score — these contain the per-dimension metrics
      // that drive coding/reasoning/creative strategy sorting
      const axes = extractAxes(score);
      
      return {
        id: parseInt(score.id),
        name: modelName,
        vendor,
        score: score.currentScore as number,
        axes,
        lastUpdated: score.lastUpdated?.toISOString() || new Date().toISOString(),
        estimatedCost: calculateModelCost(modelName, vendor),
        supportsToolCalling: TOOL_CALLING_MODELS.has(modelName),
        supportsStreaming: STREAMING_MODELS.has(modelName)
      };
    });
  
  // Add latency data for speed-focused strategies
  if (strategy === 'fastest') {
    await addLatencyData(rankings);
  }
  
  // Sort based on strategy
  const sortedRankings = sortRankingsByStrategy(rankings, strategy);
  
  // Cache the results
  rankingsCache.set(cacheKey, { data: sortedRankings, timestamp: Date.now() });
  
  console.log(`✅ Cached ${sortedRankings.length} rankings for ${cacheKey} using dashboard scores`);
  return sortedRankings;
}

/**
 * Extract axes metrics from a dashboard score object
 * Dashboard scores include axes from the latest benchmark run
 */
function extractAxes(score: any): Record<string, number> {
  // The dashboard score object may have axes in various locations
  // depending on sortBy mode and data freshness
  const axes: Record<string, number> = {};
  
  // Try direct axes property (from computeDashboardScores result)
  if (score.axes && typeof score.axes === 'object') {
    Object.entries(score.axes).forEach(([key, value]) => {
      if (typeof value === 'number' && !Number.isNaN(value)) {
        axes[key] = value;
      }
    });
  }
  
  // If no axes found, try to extract from weeklyBest/weeklyWorst and score
  // to create approximate axis values for strategy sorting
  if (Object.keys(axes).length === 0) {
    const normalizedScore = typeof score.currentScore === 'number' ? score.currentScore / 100 : 0.5;
    // Create balanced defaults based on overall score so sorting still works
    axes.correctness = normalizedScore;
    axes.complexity = normalizedScore;
    axes.codeQuality = normalizedScore;
    axes.efficiency = normalizedScore;
    axes.stability = normalizedScore;
    axes.edgeCases = normalizedScore;
    axes.debugging = normalizedScore;
    axes.format = normalizedScore;
    axes.safety = normalizedScore;
    // Deep-specific axes
    axes.memoryRetention = normalizedScore;
    axes.hallucinationRate = normalizedScore;
    axes.planCoherence = normalizedScore;
    axes.contextWindow = normalizedScore;
  }
  
  return axes;
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
 * FIXED: Now uses actual axes data instead of undefined
 */
function sortRankingsByStrategy(rankings: ModelRanking[], strategy: string): ModelRanking[] {
  switch (strategy) {
    case 'best_overall':
      // Higher score is better (score is 0-100 from dashboard)
      return rankings.sort((a, b) => b.score - a.score);
      
    case 'best_coding':
      // Prioritize correctness, complexity, and code quality from axes
      return rankings.sort((a, b) => {
        const aCodeScore = (a.axes.correctness || 0) * 0.4 +
                          (a.axes.complexity || 0) * 0.3 +
                          (a.axes.codeQuality || 0) * 0.2 +
                          (a.axes.debugging || 0) * 0.1;
        const bCodeScore = (b.axes.correctness || 0) * 0.4 +
                          (b.axes.complexity || 0) * 0.3 +
                          (b.axes.codeQuality || 0) * 0.2 +
                          (b.axes.debugging || 0) * 0.1;
        // Break ties with overall score
        if (Math.abs(bCodeScore - aCodeScore) < 0.01) return b.score - a.score;
        return bCodeScore - aCodeScore; // Higher is better
      });
      
    case 'best_reasoning':
      // Prioritize correctness, edge cases, and deep-specific axes
      return rankings.sort((a, b) => {
        const aReasonScore = (a.axes.correctness || 0) * 0.3 +
                            (a.axes.edgeCases || 0) * 0.2 +
                            (a.axes.memoryRetention || 0) * 0.2 +
                            (a.axes.planCoherence || 0) * 0.15 +
                            (a.axes.hallucinationRate || 0) * 0.15;
        const bReasonScore = (b.axes.correctness || 0) * 0.3 +
                            (b.axes.edgeCases || 0) * 0.2 +
                            (b.axes.memoryRetention || 0) * 0.2 +
                            (b.axes.planCoherence || 0) * 0.15 +
                            (b.axes.hallucinationRate || 0) * 0.15;
        // Break ties with overall score
        if (Math.abs(bReasonScore - aReasonScore) < 0.01) return b.score - a.score;
        return bReasonScore - aReasonScore; // Higher is better
      });
      
    case 'best_creative':
      // Prioritize format, stability, and overall quality
      return rankings.sort((a, b) => {
        const aCreativeScore = (a.axes.format || 0) * 0.3 +
                              (a.axes.stability || 0) * 0.2 +
                              (a.axes.codeQuality || 0) * 0.2 +
                              (a.axes.safety || 0) * 0.15 +
                              (a.axes.correctness || 0) * 0.15;
        const bCreativeScore = (b.axes.format || 0) * 0.3 +
                              (b.axes.stability || 0) * 0.2 +
                              (b.axes.codeQuality || 0) * 0.2 +
                              (b.axes.safety || 0) * 0.15 +
                              (b.axes.correctness || 0) * 0.15;
        // Break ties with overall score
        if (Math.abs(bCreativeScore - aCreativeScore) < 0.01) return b.score - a.score;
        return bCreativeScore - aCreativeScore; // Higher is better
      });
      
    case 'cheapest':
      // Lower cost is better
      return rankings.sort((a, b) => a.estimatedCost - b.estimatedCost);
      
    case 'fastest':
      // Lower latency is better
      return rankings.sort((a, b) => (a.avgLatency || 5000) - (b.avgLatency || 5000));
      
    default:
      return rankings.sort((a, b) => b.score - a.score);
  }
}

/**
 * Get user preferences and constraints — now includes ALL preference fields
 */
async function getUserPreferences(userId: number): Promise<{
  strategy: string;
  maxCost?: number;
  maxLatency?: number;
  excludeProviders: string[];
  excludeModels: string[];
  requireToolCalling: boolean;
  requireStreaming: boolean;
  fallbackEnabled: boolean;
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
      excludeModels: [],
      requireToolCalling: false,
      requireStreaming: false,
      fallbackEnabled: true
    };
  }
  
  const prefs = preferences[0];
  return {
    strategy: prefs.routing_strategy || 'best_overall',
    maxCost: prefs.max_cost_per_1k_tokens || undefined,
    maxLatency: prefs.max_latency_ms || undefined,
    excludeProviders: JSON.parse(prefs.excluded_providers || '[]'),
    excludeModels: JSON.parse(prefs.excluded_models || '[]'),
    requireToolCalling: prefs.require_tool_calling ?? false,
    requireStreaming: prefs.require_streaming ?? false,
    fallbackEnabled: prefs.fallback_enabled ?? true
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
 * Returns primary model + fallback candidates when fallback is enabled
 */
export async function selectBestModel(criteria: SelectionCriteria): Promise<ModelSelection> {
  const result = await selectModelsWithFallbacks(criteria);
  return result.primary;
}

/**
 * Extended selection that returns primary + fallback models
 * Used by the proxy for automatic retry on failure
 */
export async function selectModelsWithFallbacks(criteria: SelectionCriteria): Promise<{
  primary: ModelSelection;
  fallbacks: ModelSelection[];
  fallbackEnabled: boolean;
}> {
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
  const suiteMap: Record<string, string> = {
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
  
  // Apply user constraints (including tool calling and streaming requirements)
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
    
    // FIX: Apply tool calling requirement
    if (userPrefs.requireToolCalling && !ranking.supportsToolCalling) {
      return false;
    }
    
    // FIX: Apply streaming requirement
    if (userPrefs.requireStreaming && !ranking.supportsStreaming) {
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
  
  const primary: ModelSelection = {
    model: selectedModel.name,
    provider: selectedModel.vendor,
    score: selectedModel.score,
    reasoning,
    estimatedCost: selectedModel.estimatedCost,
    avgLatency: selectedModel.avgLatency
  };
  
  // Collect fallback models (next 2 candidates from different providers when possible)
  const fallbacks: ModelSelection[] = [];
  if (userPrefs.fallbackEnabled && filteredRankings.length > 1) {
    const usedProviders = new Set([selectedModel.vendor]);
    
    for (let i = 1; i < filteredRankings.length && fallbacks.length < 2; i++) {
      const candidate = filteredRankings[i];
      // Prefer fallbacks from different providers for true redundancy
      const isDifferentProvider = !usedProviders.has(candidate.vendor);
      const needMore = fallbacks.length < 2;
      
      if (isDifferentProvider || (needMore && fallbacks.length < 1)) {
        fallbacks.push({
          model: candidate.name,
          provider: candidate.vendor,
          score: candidate.score,
          reasoning: `Fallback: ${candidate.name} from ${candidate.vendor} (score: ${candidate.score.toFixed(1)})`,
          estimatedCost: candidate.estimatedCost,
          avgLatency: candidate.avgLatency
        });
        usedProviders.add(candidate.vendor);
      }
    }
    
    // If we couldn't find different-provider fallbacks, fill with same-provider ones
    if (fallbacks.length < 2) {
      for (let i = 1; i < filteredRankings.length && fallbacks.length < 2; i++) {
        const candidate = filteredRankings[i];
        const alreadyAdded = fallbacks.some(f => f.model === candidate.name);
        if (!alreadyAdded) {
          fallbacks.push({
            model: candidate.name,
            provider: candidate.vendor,
            score: candidate.score,
            reasoning: `Fallback: ${candidate.name} from ${candidate.vendor} (score: ${candidate.score.toFixed(1)})`,
            estimatedCost: candidate.estimatedCost,
            avgLatency: candidate.avgLatency
          });
        }
      }
    }
  }
  
  return {
    primary,
    fallbacks,
    fallbackEnabled: userPrefs.fallbackEnabled
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
  const strategyNames: Record<string, string> = {
    'best_overall': 'best overall performance',
    'best_coding': 'best coding capabilities', 
    'best_reasoning': 'best reasoning abilities',
    'best_creative': 'best creative writing',
    'cheapest': 'most cost-effective',
    'fastest': 'fastest response time'
  };
  
  const strategyName = strategyNames[strategy] || strategy;
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
