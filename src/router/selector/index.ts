import { db } from '../../db/connection-pool';
import { routerModelRankings, routerProviderKeys, routerPreferences } from '../../db/router-schema';
import { eq, and, sql } from 'drizzle-orm';

export type RoutingStrategy = 
  | 'best_overall' 
  | 'best_coding' 
  | 'best_reasoning' 
  | 'best_creative'
  | 'cheapest' 
  | 'fastest';

export interface SelectionCriteria {
  userId: number;
  strategy: RoutingStrategy;
  maxCost?: number;
  maxLatency?: number;
  requireToolCalling?: boolean;
  requireStreaming?: boolean;
  excludedProviders?: string[];
  excludedModels?: string[];
}

export interface SelectedModel {
  provider: string;
  model: string;
  reasoning: string;
  score: number;
  estimatedCost: number;
  estimatedLatency: number;
  fallbackChain: Array<{ provider: string; model: string }>;
}

/**
 * Get user's available providers based on stored API keys
 */
async function getUserProviders(userId: number): Promise<string[]> {
  const keys = await db
    .select({ provider: routerProviderKeys.provider })
    .from(routerProviderKeys)
    .where(
      and(
        eq(routerProviderKeys.user_id, userId),
        eq(routerProviderKeys.is_active, true)
      )
    );
  
  return keys.map(k => k.provider);
}

/**
 * Map routing strategy to ranking category
 */
function strategyToCategory(strategy: RoutingStrategy): string {
  const mapping: Record<RoutingStrategy, string> = {
    'best_overall': 'overall',
    'best_coding': 'coding',
    'best_reasoning': 'reasoning',
    'best_creative': 'creative',
    'cheapest': 'overall', // Will sort by cost instead
    'fastest': 'overall'   // Will sort by latency instead
  };
  return mapping[strategy];
}

/**
 * Select the best model based on user preferences and available providers
 */
export async function selectBestModel(criteria: SelectionCriteria): Promise<SelectedModel> {
  // 1. Get user's available providers
  const availableProviders = await getUserProviders(criteria.userId);
  
  if (availableProviders.length === 0) {
    throw new Error('No provider API keys configured. Please add at least one provider key.');
  }
  
  // 2. Get user preferences if not provided in criteria
  let preferences = criteria;
  if (!criteria.strategy) {
    const userPrefs = await db
      .select()
      .from(routerPreferences)
      .where(eq(routerPreferences.user_id, criteria.userId))
      .limit(1);
    
    if (userPrefs.length > 0) {
      const prefs = userPrefs[0];
      preferences = {
        ...criteria,
        strategy: (prefs.routing_strategy as RoutingStrategy) || 'best_overall',
        maxCost: prefs.max_cost_per_1k_tokens || undefined,
        maxLatency: prefs.max_latency_ms || undefined,
        requireToolCalling: prefs.require_tool_calling || false,
        requireStreaming: prefs.require_streaming || false,
        excludedProviders: prefs.excluded_providers ? JSON.parse(prefs.excluded_providers) : [],
        excludedModels: prefs.excluded_models ? JSON.parse(prefs.excluded_models) : []
      };
    }
  }
  
  // 3. Query rankings based on strategy
  const category = strategyToCategory(preferences.strategy);
  const rankings = await db
    .select()
    .from(routerModelRankings)
    .where(eq(routerModelRankings.category, category))
    .orderBy(routerModelRankings.rank);
  
  // 4. Filter candidates based on constraints
  const candidates = rankings.filter(r => {
    // Must be in user's available providers
    if (!availableProviders.includes(r.provider)) {
      return false;
    }
    
    // Apply cost constraint
    if (preferences.maxCost && r.avg_cost_per_1k && r.avg_cost_per_1k > preferences.maxCost) {
      return false;
    }
    
    // Apply latency constraint
    if (preferences.maxLatency && r.avg_latency_ms && r.avg_latency_ms > preferences.maxLatency) {
      return false;
    }
    
    // Check tool calling requirement
    if (preferences.requireToolCalling && !r.supports_tool_calling) {
      return false;
    }
    
    // Check streaming requirement
    if (preferences.requireStreaming && !r.supports_streaming) {
      return false;
    }
    
    // Check provider exclusions
    if (preferences.excludedProviders?.includes(r.provider)) {
      return false;
    }
    
    // Check model exclusions
    if (preferences.excludedModels?.includes(r.model_name)) {
      return false;
    }
    
    return true;
  });
  
  if (candidates.length === 0) {
    throw new Error(
      'No models match your preferences and constraints. ' +
      'Try relaxing your cost/latency limits or adding more provider keys.'
    );
  }
  
  // 5. Apply strategy-specific sorting
  let sortedCandidates = [...candidates];
  
  if (preferences.strategy === 'cheapest') {
    // Sort by cost (lowest first)
    sortedCandidates.sort((a, b) => {
      const costA = a.avg_cost_per_1k || Infinity;
      const costB = b.avg_cost_per_1k || Infinity;
      return costA - costB;
    });
  } else if (preferences.strategy === 'fastest') {
    // Sort by latency (lowest first)
    sortedCandidates.sort((a, b) => {
      const latencyA = a.avg_latency_ms || Infinity;
      const latencyB = b.avg_latency_ms || Infinity;
      return latencyA - latencyB;
    });
  }
  // For other strategies, already sorted by rank (stupid_score)
  
  // 6. Select top candidate
  const selected = sortedCandidates[0];
  
  // 7. Build fallback chain (next 2 best options)
  const fallbackChain = sortedCandidates
    .slice(1, 3)
    .map(c => ({
      provider: c.provider,
      model: c.model_name
    }));
  
  // 8. Generate reasoning message
  let reasoning = `Selected ${selected.model_name} from ${selected.provider}`;
  
  if (preferences.strategy === 'cheapest') {
    reasoning += ` (lowest cost: $${selected.avg_cost_per_1k?.toFixed(4)}/1k tokens)`;
  } else if (preferences.strategy === 'fastest') {
    reasoning += ` (lowest latency: ${selected.avg_latency_ms}ms avg)`;
  } else {
    reasoning += ` (best ${preferences.strategy.replace('best_', '')} score: ${selected.stupid_score.toFixed(2)})`;
  }
  
  return {
    provider: selected.provider,
    model: selected.model_name,
    reasoning,
    score: selected.stupid_score,
    estimatedCost: selected.avg_cost_per_1k || 0,
    estimatedLatency: selected.avg_latency_ms || 0,
    fallbackChain
  };
}

/**
 * Get model rankings for a specific category
 */
export async function getModelRankings(category: string, limit: number = 10) {
  return await db
    .select()
    .from(routerModelRankings)
    .where(eq(routerModelRankings.category, category))
    .orderBy(routerModelRankings.rank)
    .limit(limit);
}

/**
 * Check if a specific model is available for a user
 */
export async function isModelAvailable(
  userId: number, 
  provider: string, 
  modelName: string
): Promise<boolean> {
  const availableProviders = await getUserProviders(userId);
  
  if (!availableProviders.includes(provider)) {
    return false;
  }
  
  // Check if model exists in rankings
  const model = await db
    .select()
    .from(routerModelRankings)
    .where(
      and(
        eq(routerModelRankings.provider, provider),
        eq(routerModelRankings.model_name, modelName)
      )
    )
    .limit(1);
  
  return model.length > 0;
}
