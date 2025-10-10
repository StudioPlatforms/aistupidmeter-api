// Tool Calling Benchmarks Runner
// Main entry point for running tool calling benchmarks, similar to real-benchmarks.ts

import dotenv from 'dotenv';
// Load environment variables for standalone execution
dotenv.config({ path: '/root/.env' });

import { db } from '../db';
import { models, scores, tool_sessions } from '../db/schema';
import { eq, and, desc } from 'drizzle-orm';
import { OpenAIAdapter, XAIAdapter, AnthropicAdapter, GoogleAdapter, Provider, LLMAdapter } from '../llm/adapters';
import { ToolBenchmarkSession } from '../toolbench/session/benchmark-session';
import { ALL_TASKS, EASY_TASKS, MEDIUM_TASKS, HARD_TASKS } from '../toolbench/tasks/definitions';
import { sandboxManager } from '../toolbench/sandbox/manager';

// Import the working adapter functions from real-benchmarks.ts
import { getKeysForProvider, getAdapter } from './real-benchmarks';

interface ToolBenchmarkConfig {
  runEasyTasks: boolean;
  runMediumTasks: boolean;
  runHardTasks: boolean;
  maxConcurrentSessions: number;
  skipRecentlyTested: boolean;
  recentTestThresholdHours: number;
}

const DEFAULT_CONFIG: ToolBenchmarkConfig = {
  runEasyTasks: true,
  runMediumTasks: true,
  runHardTasks: true,
  maxConcurrentSessions: 3, // Limit concurrent Docker containers
  skipRecentlyTested: true,
  recentTestThresholdHours: 24
};

export async function runToolBenchmarks(config: Partial<ToolBenchmarkConfig> = {}): Promise<void> {
  const finalConfig = { ...DEFAULT_CONFIG, ...config };
  
  console.log('🔧 Starting Tool Calling Benchmarks...');
  console.log(`Configuration:`, finalConfig);

  try {
    // Clean up any expired sandboxes first
    await sandboxManager.cleanupExpiredSandboxes();

    // Get all models that are in regular benchmarks (show_in_rankings = true)
    const toolCapableModels = await db.select()
      .from(models)
      .where(eq(models.showInRankings, true));

    if (toolCapableModels.length === 0) {
      console.log('⚠️ No models found with show_in_rankings = true');
      return;
    }

    console.log(`📋 Found ${toolCapableModels.length} tool-capable models`);

    // Select tasks to run based on config
    const tasksToRun = [];
    if (finalConfig.runEasyTasks) tasksToRun.push(...EASY_TASKS);
    if (finalConfig.runMediumTasks) tasksToRun.push(...MEDIUM_TASKS);
    if (finalConfig.runHardTasks) tasksToRun.push(...HARD_TASKS);

    console.log(`🎯 Running ${tasksToRun.length} tasks across ${toolCapableModels.length} models`);

    // Create benchmark jobs
    const benchmarkJobs = [];
    for (const model of toolCapableModels) {
      for (const task of tasksToRun) {
        // Skip if recently tested (per model+task combination)
        if (finalConfig.skipRecentlyTested) {
          const wasRecent = await wasModelTaskRunRecently(model.id, task.slug, finalConfig.recentTestThresholdHours);
          if (wasRecent) {
            console.log(`⏭️ Skipping ${model.name} on ${task.slug} - tested recently`);
            continue;
          }
        }

        benchmarkJobs.push({ model, task });
      }
    }

    console.log(`🚀 Executing ${benchmarkJobs.length} benchmark sessions`);

    // Run benchmarks with concurrency control
    await runBenchmarksWithConcurrency(benchmarkJobs, finalConfig.maxConcurrentSessions);

    console.log('✅ Tool Calling Benchmarks completed successfully');

  } catch (error) {
    console.error('❌ Tool Calling Benchmarks failed:', error);
    throw error;
  }
}

async function runBenchmarksWithConcurrency(
  jobs: Array<{ model: any; task: any }>,
  maxConcurrent: number
): Promise<void> {
  const results: any[] = [];
  const running = new Set<Promise<any>>();

  for (const job of jobs) {
    // Wait if we've hit the concurrency limit
    if (running.size >= maxConcurrent) {
      await Promise.race(running);
    }

    // Start the benchmark
    const benchmarkPromise = runSingleBenchmark(job.model, job.task)
      .then(result => {
        results.push(result);
        running.delete(benchmarkPromise);
        return result;
      })
      .catch(error => {
        console.error(`❌ Benchmark failed for ${job.model.name} on ${job.task.slug}:`, error);
        running.delete(benchmarkPromise);
        return null;
      });

    running.add(benchmarkPromise);
  }

  // Wait for all remaining benchmarks to complete
  await Promise.all(running);

  // Calculate and save aggregate scores
  await calculateAggregateScores(results.filter(r => r !== null));
}

async function runSingleBenchmark(model: any, task: any): Promise<any> {
  console.log(`🔄 Running ${model.name} on ${task.name} (${task.difficulty})`);
  
  const adapter = createAdapter(model);
  if (!adapter) {
    throw new Error(`No adapter available for model ${model.name}`);
  }

  const session = new ToolBenchmarkSession(model, task, adapter);
  
  try {
    const result = await session.run();
    console.log(`✅ ${model.name} on ${task.name}: ${result.passed ? 'PASSED' : 'FAILED'} (Score: ${result.finalScore})`);
    
    return {
      modelId: model.id,
      modelName: model.name,
      taskSlug: task.slug,
      taskDifficulty: task.difficulty,
      result
    };

  } catch (error) {
    console.error(`❌ ${model.name} on ${task.name} failed:`, error);
    return null;
  } finally {
    // Guaranteed cleanup - prevent zombie containers
    try {
      await (session as any).cleanup?.();
    } catch (cleanupError) {
      console.warn(`⚠️ Session cleanup failed for ${model.name}:`, cleanupError);
    }
    
    try {
      await sandboxManager.cleanupExpiredSandboxes();
    } catch (cleanupError) {
      console.warn(`⚠️ Sandbox cleanup failed:`, cleanupError);
    }
  }
}

function createAdapter(model: any): any {
  // Use the same adapter system as real-benchmarks.ts
  const adapter = getAdapter(model.vendor as Provider);
  if (!adapter) {
    console.warn(`⚠️ No API key found for ${model.vendor}`);
    return null;
  }
  return adapter;
}


async function wasModelTaskRunRecently(modelId: number, taskSlug: string, thresholdHours: number): Promise<boolean> {
  const thresholdTime = new Date(Date.now() - thresholdHours * 3600_000);

  const recent = await db.select()
    .from(tool_sessions)
    .where(and(
      eq(tool_sessions.modelId, modelId),
      eq(tool_sessions.taskSlug, taskSlug)
    ))
    .orderBy(desc(tool_sessions.ts))
    .limit(1);

  if (!recent.length) return false;
  return new Date(recent[0].ts || '') >= thresholdTime;
}

async function calculateAggregateScores(results: any[]): Promise<void> {
  console.log('📊 Calculating aggregate scores...');
  
  const byModel = new Map<number, any[]>();
  for (const r of results) {
    if (!r) continue; // Skip null results
    if (!byModel.has(r.modelId)) byModel.set(r.modelId, []);
    byModel.get(r.modelId)!.push(r);
  }

  for (const [modelId, rows] of byModel) {
    if (!rows.length) continue; // Skip empty model results
    
    const metrics = calculateModelMetrics(rows);
    const stupidScore = calculateStupidScore(metrics);

    await db.insert(scores).values({
      modelId,
      stupidScore,
      axes: metrics,
      cusum: 0,
      suite: 'tooling',
      ts: new Date().toISOString(), // FIXED: Add proper timestamp for dashboard display
      note: `Tool calling benchmark: ${rows.length} tasks completed`
    });

    const name = rows[0]?.modelName ?? `Model ${modelId}`;
    console.log(`📈 ${name}: Stupid Score = ${stupidScore.toFixed(3)}`);
  }

  // AUTOMATIC ROUTER CACHE INVALIDATION: Invalidate router cache after tool benchmark completion
  try {
    const { invalidateRouterCache } = await import('../router/selector');
    invalidateRouterCache('tooling'); // Invalidate tooling suite cache
    console.log('🗑️ Router cache invalidated for tooling suite');
  } catch (routerCacheError) {
    console.warn('⚠️ Router cache invalidation failed:', String(routerCacheError).slice(0, 200));
    // Don't fail the entire benchmark if router cache invalidation fails
  }
}

function calculateModelMetrics(benchmarks: any[]): Record<string, number> {
  if (benchmarks.length === 0) {
    return {
      toolSelection: 0,
      parameterAccuracy: 0,
      errorHandling: 0,
      taskCompletion: 0,
      efficiency: 0,
      contextAwareness: 0,
      safetyCompliance: 0
    };
  }

  // Calculate averages across all tasks
  const metrics = {
    toolSelection: 0,
    parameterAccuracy: 0,
    errorHandling: 0,
    taskCompletion: 0,
    efficiency: 0,
    contextAwareness: 0,
    safetyCompliance: 0
  };

  for (const benchmark of benchmarks) {
    const result = benchmark.result;
    metrics.toolSelection += result.metrics.toolSelection;
    metrics.parameterAccuracy += result.metrics.parameterAccuracy;
    metrics.errorHandling += result.metrics.errorHandling;
    metrics.taskCompletion += result.metrics.taskCompletion;
    metrics.efficiency += result.metrics.efficiency;
    metrics.contextAwareness += result.metrics.contextAwareness;
    metrics.safetyCompliance += result.metrics.safetyCompliance;
  }

  // Average the metrics (preserve precision, don't round yet)
  const count = benchmarks.length;
  for (const key in metrics) {
    (metrics as any)[key] = (metrics as any)[key] / count;
  }

  return metrics;
}

function calculateStupidScore(metrics: Record<string, number>): number {
  // Weight the different metrics for overall score
  const weights = {
    taskCompletion: 0.3,      // Most important - did it work?
    toolSelection: 0.2,       // Did it choose the right tools?
    parameterAccuracy: 0.15,  // Did it use tools correctly?
    efficiency: 0.15,         // Did it do it efficiently?
    errorHandling: 0.1,       // Did it recover from errors?
    contextAwareness: 0.05,   // Did it use context well?
    safetyCompliance: 0.05    // Did it avoid dangerous operations?
  };

  let weightedSum = 0;
  let totalWeight = 0;

  for (const [metric, value] of Object.entries(metrics)) {
    const weight = (weights as any)[metric] || 0;
    weightedSum += value * weight;
    totalWeight += weight;
  }

  // FIXED: Return the raw normalized score (0.0-1.0) that matches the database format
  // The dashboard will convert this to 0-100 display format using the same logic as other suites
  const normalizedScore = totalWeight > 0 ? weightedSum / totalWeight : 0;
  
  // Convert to 0-100 scale for consistency with other benchmark suites
  // This matches the format expected by the dashboard's getToolingScores() function
  return Math.round(normalizedScore * 100);
}

async function updateModelToolCapabilities(): Promise<void> {
  console.log('🔄 Updating model tool calling capabilities...');

  // Models known to support tool calling
  const toolCapableModels = [
    // OpenAI
    'gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-4', 'gpt-3.5-turbo',
    // Anthropic
    'claude-3-5-sonnet', 'claude-3-5-haiku', 'claude-3-opus', 'claude-3-sonnet', 'claude-3-haiku',
    // Google
    'gemini-1.5-pro', 'gemini-1.5-flash', 'gemini-2.0-flash', 'gemini-2.5-pro', 'gemini-2.5-flash',
    // xAI
    'grok-2-latest', 'grok-code-fast-1'
  ];

  for (const modelName of toolCapableModels) {
    await db.update(models)
      .set({
        supportsToolCalling: true,
        maxToolsPerCall: 10,
        toolCallReliability: 0.8 // Default reliability score
      })
      .where(eq(models.name, modelName));
  }

  console.log(`✅ Updated tool calling capabilities for ${toolCapableModels.length} models`);
}

// Export for use in scheduler
export { runToolBenchmarks as default };

// CLI support
if (require.main === module) {
  runToolBenchmarks()
    .then(() => {
      console.log('🎉 Tool benchmarks completed successfully');
      process.exit(0);
    })
    .catch((error) => {
      console.error('💥 Tool benchmarks failed:', error);
      process.exit(1);
    });
}
