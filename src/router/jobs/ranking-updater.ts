import { db } from '../../db/connection-pool';
import { models, scores } from '../../db/schema';
import { routerModelRankings } from '../../db/router-schema';
import { eq, desc, and, sql } from 'drizzle-orm';

/**
 * Model pricing data (per 1k tokens)
 * Updated periodically from provider pricing pages
 */
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  // OpenAI
  'gpt-4o': { input: 0.0025, output: 0.01 },
  'gpt-4o-mini': { input: 0.00015, output: 0.0006 },
  'gpt-5-codex': { input: 0.005, output: 0.015 },
  'o1': { input: 0.015, output: 0.06 },
  'o1-mini': { input: 0.003, output: 0.012 },
  
  // Anthropic
  'claude-sonnet-4-20250514': { input: 0.003, output: 0.015 },
  'claude-sonnet-4-5-20250929': { input: 0.003, output: 0.015 },
  'claude-opus-4-20250514': { input: 0.015, output: 0.075 },
  'claude-opus-4-1-20250805': { input: 0.015, output: 0.075 },
  'claude-3-5-sonnet': { input: 0.003, output: 0.015 },
  'claude-3-5-haiku': { input: 0.0008, output: 0.004 },
  
  // XAI
  'grok-4-latest': { input: 0.002, output: 0.01 },
  'grok-2-latest': { input: 0.001, output: 0.005 },
  'grok-code-fast-1': { input: 0.001, output: 0.005 },
  
  // Google
  'gemini-2.5-pro': { input: 0.00125, output: 0.005 },
  'gemini-2.5-flash': { input: 0.000075, output: 0.0003 },
  'gemini-1.5-pro': { input: 0.00125, output: 0.005 },
  'gemini-1.5-flash': { input: 0.000075, output: 0.0003 },
};

/**
 * Get average cost per 1k tokens for a model
 */
function getModelCost(modelName: string): number {
  const pricing = MODEL_PRICING[modelName];
  if (!pricing) {
    // Default fallback pricing
    return 0.002; // Average of input and output
  }
  // Average of input and output for simplicity
  return (pricing.input + pricing.output) / 2;
}

/**
 * Determine if a model supports tool calling
 */
function supportsToolCalling(modelName: string): boolean {
  // Most modern models support tool calling
  const toolCallingModels = [
    'gpt-4o', 'gpt-5-codex', 'o1', 'o1-mini',
    'claude-sonnet-4', 'claude-opus-4', 'claude-3-5-sonnet',
    'grok-4-latest', 'grok-2-latest',
    'gemini-2.5-pro', 'gemini-1.5-pro'
  ];
  
  return toolCallingModels.some(pattern => modelName.includes(pattern));
}

/**
 * Calculate rankings for a specific category
 */
async function calculateRankings(category: string, taskFilter?: string) {
  console.log(`📊 Calculating rankings for category: ${category}`);
  
  // Get latest scores for each model
  // Join with models table to get vendor info
  const latestScores = await db
    .select({
      modelId: models.id,
      modelName: models.name,
      vendor: models.vendor,
      stupidScore: scores.stupidScore,
      ts: scores.ts
    })
    .from(scores)
    .innerJoin(models, eq(scores.modelId, models.id))
    .where(
      and(
        eq(models.showInRankings, true),
        eq(scores.suite, 'hourly') // Use hourly benchmarks for rankings
      )
    )
    .orderBy(desc(scores.ts));
  
  // Group by model and get latest score
  const modelScores = new Map<number, typeof latestScores[0]>();
  for (const score of latestScores) {
    if (!modelScores.has(score.modelId)) {
      modelScores.set(score.modelId, score);
    }
  }
  
  // Convert to array and sort by stupid score (lower is better)
  const sortedModels = Array.from(modelScores.values())
    .sort((a, b) => a.stupidScore - b.stupidScore);
  
  console.log(`  Found ${sortedModels.length} models with scores`);
  
  // Create rankings
  const rankings = sortedModels.map((model, index) => ({
    category,
    rank: index + 1,
    model_id: model.modelId,
    provider: model.vendor,
    model_name: model.modelName,
    stupid_score: model.stupidScore,
    avg_cost_per_1k: getModelCost(model.modelName),
    avg_latency_ms: 1500, // TODO: Calculate from actual latency data
    supports_tool_calling: supportsToolCalling(model.modelName),
    supports_streaming: true, // Most models support streaming
    last_updated: new Date().toISOString()
  }));
  
  return rankings;
}

/**
 * Update model rankings for all categories
 */
export async function updateModelRankings() {
  console.log('🔄 Starting model rankings update...');
  
  try {
    // Clear existing rankings
    await db.delete(routerModelRankings);
    console.log('  Cleared existing rankings');
    
    // Calculate rankings for each category
    const categories = [
      { name: 'overall', filter: undefined },
      { name: 'coding', filter: 'code' },
      { name: 'reasoning', filter: 'reasoning' },
      { name: 'creative', filter: 'creative' },
      { name: 'tool_calling', filter: 'tool' }
    ];
    
    for (const category of categories) {
      const rankings = await calculateRankings(category.name, category.filter);
      
      if (rankings.length > 0) {
        // Insert rankings in batches
        const batchSize = 50;
        for (let i = 0; i < rankings.length; i += batchSize) {
          const batch = rankings.slice(i, i + batchSize);
          await db.insert(routerModelRankings).values(batch);
        }
        console.log(`  ✅ Inserted ${rankings.length} rankings for ${category.name}`);
      } else {
        console.log(`  ⚠️  No rankings found for ${category.name}`);
      }
    }
    
    // Get summary
    const totalRankings = await db
      .select({ count: sql<number>`count(*)` })
      .from(routerModelRankings);
    
    console.log(`✅ Rankings update complete! Total rankings: ${totalRankings[0].count}`);
    
    return {
      success: true,
      totalRankings: totalRankings[0].count,
      categories: categories.length
    };
    
  } catch (error) {
    console.error('❌ Failed to update rankings:', error);
    throw error;
  }
}

/**
 * Get ranking statistics
 */
export async function getRankingStats() {
  const stats = await db
    .select({
      category: routerModelRankings.category,
      count: sql<number>`count(*)`,
      lastUpdated: sql<string>`max(${routerModelRankings.last_updated})`
    })
    .from(routerModelRankings)
    .groupBy(routerModelRankings.category);
  
  return stats;
}
