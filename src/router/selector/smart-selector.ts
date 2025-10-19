/**
 * Smart Model Selector with Automatic Routing
 * 
 * Uses prompt analysis + benchmark data to automatically select
 * the best model for a given task without manual strategy selection
 */

import { db } from '../../db/connection-pool';
import { models, scores, runs } from '../../db/schema';
import { eq, and, desc, sql, inArray } from 'drizzle-orm';
import { analyzePrompt, getAnalysisSummary, type PromptAnalysis } from '../analyzer/prompt-analyzer';
import { selectBestModel, type SelectionCriteria, type ModelSelection } from './index';

interface SmartSelectionResult extends ModelSelection {
  analysis: PromptAnalysis;
  alternativeModels?: Array<{
    model: string;
    provider: string;
    score: number;
    estimatedCost: number;
    reasoning: string;
  }>;
}

/**
 * Main entry point: Automatically select best model based on prompt analysis
 */
export async function selectModelAutomatically(
  prompt: string,
  userId: number,
  options?: {
    includeAlternatives?: boolean;
    maxAlternatives?: number;
  }
): Promise<SmartSelectionResult> {
  const startTime = Date.now();
  
  // Step 1: Analyze the prompt (fast, <50ms)
  const analysis = analyzePrompt(prompt);
  console.log(`🔍 Prompt analysis (${Date.now() - startTime}ms):`, getAnalysisSummary(analysis));
  
  // Step 2: Determine optimal strategy based on analysis
  const strategy = determineStrategy(analysis);
  console.log(`🎯 Selected strategy: ${strategy}`);
  
  // Step 3: Get task-specific rankings
  const rankings = await getTaskSpecificRankings(
    analysis.language,
    analysis.taskType,
    strategy,
    userId
  );
  
  if (rankings.length === 0) {
    // Fallback to general best_overall if no task-specific data
    console.log(`⚠️ No task-specific rankings found, falling back to best_overall`);
    const fallbackResult = await selectBestModel({
      userId,
      strategy: 'best_overall'
    });
    
    return {
      ...fallbackResult,
      analysis,
      reasoning: `${fallbackResult.reasoning} (Note: Limited ${analysis.language}/${analysis.taskType} benchmark data available)`
    };
  }
  
  // Step 4: Select best model from rankings
  const selected = rankings[0];
  
  // Step 5: Generate detailed reasoning
  const reasoning = generateSmartReasoning(selected, analysis, strategy, rankings.length);
  
  // Step 6: Optionally include alternatives
  const alternatives = options?.includeAlternatives 
    ? rankings.slice(1, (options.maxAlternatives || 3) + 1).map(r => ({
        model: r.name,
        provider: r.vendor,
        score: r.score,
        estimatedCost: r.estimatedCost,
        reasoning: `Alternative: ${r.score.toFixed(1)} score, $${r.estimatedCost.toFixed(4)}/1k tokens`
      }))
    : undefined;
  
  const totalTime = Date.now() - startTime;
  console.log(`✅ Smart selection completed in ${totalTime}ms`);
  
  return {
    model: selected.name,
    provider: selected.vendor,
    score: selected.score,
    reasoning,
    estimatedCost: selected.estimatedCost,
    avgLatency: selected.avgLatency,
    analysis,
    alternativeModels: alternatives
  };
}

/**
 * Determine optimal strategy based on prompt analysis
 */
function determineStrategy(analysis: PromptAnalysis): SelectionCriteria['strategy'] {
  // Task type drives strategy selection
  switch (analysis.taskType) {
    case 'ui':
      // UI tasks benefit from coding ability + speed
      return analysis.complexity === 'complex' ? 'best_coding' : 'fastest';
      
    case 'algorithm':
      // Algorithm tasks need strong reasoning
      return analysis.complexity === 'complex' ? 'best_reasoning' : 'best_coding';
      
    case 'backend':
      // Backend tasks need reliability + coding
      return 'best_coding';
      
    case 'debug':
      // Debugging needs deep reasoning
      return 'best_reasoning';
      
    case 'refactor':
      // Refactoring needs code quality understanding
      return 'best_coding';
      
    default:
      // General tasks use overall best
      return 'best_overall';
  }
}

/**
 * Get rankings filtered by language and task type
 */
async function getTaskSpecificRankings(
  language: string,
  taskType: string,
  strategy: string,
  userId: number
): Promise<Array<{
  id: number;
  name: string;
  vendor: string;
  score: number;
  estimatedCost: number;
  avgLatency?: number;
  taskCount: number;
}>> {
  // Determine which suite to query
  const suite = determineSuite(taskType, strategy);
  
  // Get user's available providers
  const { routerProviderKeys } = await import('../../db/router-schema');
  const providerKeys = await db
    .select({ provider: routerProviderKeys.provider })
    .from(routerProviderKeys)
    .where(
      and(
        eq(routerProviderKeys.user_id, userId),
        eq(routerProviderKeys.is_active, true)
      )
    );
  
  const availableProviders = providerKeys.map(pk => pk.provider);
  
  if (availableProviders.length === 0) {
    console.log(`⚠️ No active providers for user ${userId}`);
    return [];
  }
  
  // Query for models with task-specific performance
  // Note: This will work once we have language-specific benchmarks
  // For now, it falls back to general scores
  const rankings = await db
    .select({
      modelId: models.id,
      modelName: models.name,
      vendor: models.vendor,
      avgScore: sql<number>`AVG(${scores.stupidScore})`.as('avgScore'),
      taskCount: sql<number>`COUNT(DISTINCT ${scores.id})`.as('taskCount')
    })
    .from(scores)
    .innerJoin(models, eq(scores.modelId, models.id))
    .where(
      and(
        eq(scores.suite, suite),
        inArray(models.vendor, availableProviders),
        eq(models.showInRankings, true),
        sql`${scores.stupidScore} >= 0` // Exclude sentinel values
      )
    )
    .groupBy(models.id, models.name, models.vendor)
    .having(sql`COUNT(DISTINCT ${scores.id}) >= 3`) // Need at least 3 scores
    .orderBy(desc(sql`AVG(${scores.stupidScore})`))
    .limit(10);
  
  // Add cost and latency data
  const { calculateModelCost } = await import('./index');
  
  return rankings.map(r => ({
    id: r.modelId,
    name: r.modelName,
    vendor: r.vendor,
    score: r.avgScore,
    estimatedCost: calculateModelCost(r.modelName, r.vendor),
    taskCount: r.taskCount
  }));
}

/**
 * Determine which benchmark suite to use
 */
function determineSuite(
  taskType: string,
  strategy: string
): 'hourly' | 'deep' | 'tooling' {
  // Deep reasoning tasks use deep suite
  if (strategy === 'best_reasoning' || taskType === 'debug') {
    return 'deep';
  }
  
  // Tool-heavy tasks could use tooling suite (future)
  // For now, default to hourly
  return 'hourly';
}

/**
 * Generate detailed reasoning for selection
 */
function generateSmartReasoning(
  model: any,
  analysis: PromptAnalysis,
  strategy: string,
  totalCandidates: number
): string {
  const parts: string[] = [];
  
  // Model selection
  parts.push(`Selected ${model.name} from ${model.vendor}`);
  
  // Why this model?
  parts.push(`for ${analysis.taskType} tasks in ${analysis.language}`);
  
  // Performance metrics
  parts.push(`(score: ${model.score.toFixed(1)}, $${model.estimatedCost.toFixed(4)}/1k tokens)`);
  
  // Ranking context
  parts.push(`Ranked #1 of ${totalCandidates} available models`);
  
  // Analysis confidence
  if (analysis.confidence >= 0.8) {
    parts.push(`High confidence detection (${Math.round(analysis.confidence * 100)}%)`);
  } else if (analysis.confidence < 0.6) {
    parts.push(`Lower confidence detection (${Math.round(analysis.confidence * 100)}%) - consider manual selection`);
  }
  
  // Framework hint
  if (analysis.framework) {
    parts.push(`Optimized for ${analysis.framework}`);
  }
  
  // Complexity note
  if (analysis.complexity === 'complex') {
    parts.push(`Complex task detected - using advanced model`);
  }
  
  return parts.join('. ') + '.';
}

/**
 * Batch selection: Select best models for multiple prompts
 * Useful for comparing different approaches
 */
export async function selectModelsForBatch(
  prompts: string[],
  userId: number
): Promise<Array<{
  prompt: string;
  selection: SmartSelectionResult;
}>> {
  const results = [];
  
  for (const prompt of prompts) {
    const selection = await selectModelAutomatically(prompt, userId);
    results.push({ prompt, selection });
  }
  
  return results;
}

/**
 * Get selection explanation without making actual selection
 * Useful for UI preview/debugging
 */
export async function explainSelection(
  prompt: string,
  userId: number
): Promise<{
  analysis: PromptAnalysis;
  strategy: string;
  reasoning: string;
  availableModels: number;
}> {
  const analysis = analyzePrompt(prompt);
  const strategy = determineStrategy(analysis);
  
  // CRITICAL FIX: Use the actual selectBestModel which now uses dashboard scores
  try {
    const selection = await selectBestModel({
      userId,
      strategy: strategy as any
    });
    
    return {
      analysis,
      strategy,
      reasoning: `Would select ${selection.model} (${selection.provider}) with score ${selection.score.toFixed(1)}`,
      availableModels: 1 // We only get the top model from selection
    };
  } catch (error) {
    return {
      analysis,
      strategy,
      reasoning: 'No suitable models found with current provider configuration',
      availableModels: 0
    };
  }
}

/**
 * Compare multiple strategies for the same prompt
 * Useful for understanding trade-offs
 */
export async function compareStrategies(
  prompt: string,
  userId: number
): Promise<Array<{
  strategy: string;
  model: string;
  provider: string;
  score: number;
  cost: number;
  reasoning: string;
}>> {
  const strategies: SelectionCriteria['strategy'][] = [
    'best_overall',
    'best_coding',
    'best_reasoning',
    'cheapest',
    'fastest'
  ];
  
  const results = [];
  
  for (const strategy of strategies) {
    try {
      const selection = await selectBestModel({ userId, strategy });
      results.push({
        strategy,
        model: selection.model,
        provider: selection.provider,
        score: selection.score,
        cost: selection.estimatedCost,
        reasoning: selection.reasoning
      });
    } catch (error) {
      console.error(`Strategy ${strategy} failed:`, error);
    }
  }
  
  return results;
}
