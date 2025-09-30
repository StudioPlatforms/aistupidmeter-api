import { FastifyInstance } from 'fastify';
import {
  OpenAIAdapter,
  XAIAdapter,
  AnthropicAdapter,
  GoogleAdapter,
  Provider
} from '../llm/adapters';
import { db } from '../db/index';
import { models, scores, runs, metrics, tasks as tasksTable } from '../db/schema';
import { eq, desc, and, gte } from 'drizzle-orm';
import { runRealBenchmarks } from '../jobs/real-benchmarks';
import { emitBenchmarkProgress } from './test-adapters-stream';
// Using crypto for UUID generation to avoid ESM issues
import { randomUUID } from 'crypto';
import { benchmarkModel, BENCHMARK_TASKS } from '../jobs/real-benchmarks';

// Import cache refresh function
let refreshAllCache: (() => Promise<any>) | null = null;
try {
  const cacheModule = require('../cache/dashboard-cache');
  refreshAllCache = cacheModule.refreshAllCache;
} catch {
  // Cache system not available - will be null
  console.warn('⚠️ Cache refresh not available for user key testing - dashboard may not update automatically');
}

// No longer need custom benchmark tasks - using production system only

export default async function (fastify: FastifyInstance, opts: any) {
  
  // Test model discovery for all providers
  fastify.get('/discovery', async (req, reply) => {
    const results: Record<string, any> = {};
    const providers: Provider[] = ['openai', 'xai', 'anthropic', 'google'];
    
    for (const provider of providers) {
      try {
        const adapter = getAdapter(provider);
        const models = await adapter.listModels();
        results[provider] = {
          success: true,
          models,
          count: models.length
        };
        console.log(`✅ ${provider}: Found ${models.length} models`);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        results[provider] = {
          success: false,
          error: errorMessage,
          models: [],
          count: 0
        };
        console.log(`❌ ${provider}: ${errorMessage}`);
      }
    }
    
    return {
      timestamp: new Date(),
      results,
      summary: {
        totalProviders: providers.length,
        successfulProviders: Object.values(results).filter(r => r.success).length,
        totalModelsFound: Object.values(results).reduce((sum, r) => sum + r.count, 0)
      }
    };
  });

  // Test basic chat functionality for each provider
  fastify.post('/chat-test', async (req, reply) => {
    const body = req.body as { provider: Provider; model?: string };
    const { provider, model } = body;
    
    if (!provider) {
      return reply.code(400).send({ error: 'Provider is required' });
    }
    
    try {
      const adapter = getAdapter(provider);
      
      // Use provided model or get first available model
      let testModel = model;
      if (!testModel) {
        const models = await adapter.listModels();
        if (models.length === 0) {
          return reply.code(400).send({ error: `No models available for ${provider}` });
        }
        testModel = models[0];
      }
      
      console.log(`🧪 Testing ${provider} with model ${testModel}`);
      
      const start = Date.now();
      const response = await adapter.chat({
        model: testModel,
        messages: [
          {
            role: 'user',
            content: 'Return ONLY valid JSON: {"test": "success", "provider": "' + provider + '"}'
          }
        ],
        temperature: 0.1,
        maxTokens: 100,
        ...(provider === 'openai' && testModel && testModel.startsWith('gpt-5') ? {
          reasoning_effort: 'minimal',
          verbosity: 'low'
        } : {})
      });
      
      const latency = Date.now() - start;
      
      return {
        success: true,
        provider,
        model: testModel,
        latency,
        response: {
          text: response.text,
          tokensIn: response.tokensIn,
          tokensOut: response.tokensOut
        },
        testPassed: response.text.includes('test') && response.text.includes('success')
      };
      
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`❌ Chat test failed for ${provider}:`, errorMessage);
      
      return reply.code(500).send({
        success: false,
        provider,
        model: model || 'unknown',
        error: errorMessage
      });
    }
  });

  // Test GPT-5 specific parameters
  fastify.post('/gpt5-test', async (req, reply) => {
    try {
      const adapter = getAdapter('openai');
      const models = await adapter.listModels();
      const gpt5Models = models.filter((m: string) => m.startsWith('gpt-5'));
      
      if (gpt5Models.length === 0) {
        return reply.code(400).send({ error: 'No GPT-5 models available' });
      }
      
      const testModel = gpt5Models[0]!; // We know it exists due to the length check
      console.log(`🧪 Testing GPT-5 parameters with model ${testModel}`);
      
      const start = Date.now();
      const response = await adapter.chat({
        model: testModel,
        messages: [
          {
            role: 'user',
            content: 'Write a simple Python function to add two numbers. Return only the code.'
          }
        ],
        temperature: 0.1,
        maxTokens: 200,
        reasoning_effort: 'low',
        verbosity: 'low'
      });
      
      const latency = Date.now() - start;
      
      return {
        success: true,
        model: testModel,
        latency,
        response: {
          text: response.text,
          tokensIn: response.tokensIn,
          tokensOut: response.tokensOut
        },
        parametersUsed: {
          reasoning_effort: 'low',
          verbosity: 'low'
        },
        testPassed: response.text.includes('def ') && response.text.includes('return')
      };
      
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error('❌ GPT-5 parameter test failed:', errorMessage);
      
      return reply.code(500).send({
        success: false,
        error: errorMessage
      });
    }
  });

  // Streaming benchmark test with real-time progress
  fastify.post('/benchmark-test-stream', async (req, reply) => {
    const body = req.body as { provider: Provider; model?: string };
    const { provider, model } = body;
    
    if (!provider) {
      return reply.code(400).send({ error: 'Provider is required' });
    }
    
    // Generate session ID for this test
    const sessionId = randomUUID();
    
    // Return session ID immediately for frontend to connect to stream
    reply.send({ sessionId, message: 'Connect to stream endpoint to watch progress' });
    
    // Start benchmark in background
    setTimeout(async () => {
      try {
        await runStreamingBenchmark(sessionId, provider, model, req.headers['x-user-api-key'] as string);
      } catch (error) {
        emitBenchmarkProgress(sessionId, {
          type: 'error',
          message: `Benchmark failed: ${error instanceof Error ? error.message : String(error)}`
        });
      }
    }, 100);
  });

async function runStreamingBenchmark(sessionId: string, provider: Provider, model: string | undefined, userApiKey: string) {
  try {
    emitBenchmarkProgress(sessionId, {
      type: 'info',
      message: `🚀 Starting streaming benchmark for ${provider}${model ? ` with model ${model}` : ''}`
    });

    // Validate user API key
    if (!userApiKey || userApiKey.trim() === '') {
      throw new Error('User API key is required for streaming benchmarks');
    }

    // Get adapter with user's API key to test model discovery
    const adapter = getUserAdapter(provider, userApiKey);
    
    // Get model if not provided
    let testModel = model;
    if (!testModel) {
      emitBenchmarkProgress(sessionId, {
        type: 'info',
        message: `🔍 Discovering available models for ${provider}...`
      });
      
      const models = await adapter.listModels();
      if (models.length === 0) {
        throw new Error(`No models available for ${provider}`);
      }
      testModel = models[0];
    }

    // Ensure testModel is defined and is a string
    if (!testModel) {
      throw new Error(`No model specified and no models available for ${provider}`);
    }

    // Type assertion to ensure TypeScript knows testModel is string
    const validModelName: string = testModel;

    emitBenchmarkProgress(sessionId, {
      type: 'info',
      message: `🎯 Using model: ${validModelName}`
    });

    // Find or create model in database
    const modelId = await findOrCreateModel(validModelName, provider);
    
    // Setup environment temporarily to use user's API key
    const originalKey = process.env[`${provider.toUpperCase()}_API_KEY`];
    const keyName = provider === 'google' ? 'GEMINI_API_KEY' : `${provider.toUpperCase()}_API_KEY`;
    process.env[keyName] = userApiKey;

    try {
      // Create model object for the production benchmark system
      const modelObj = { 
        id: modelId, 
        name: validModelName, 
        vendor: provider 
      };

      emitBenchmarkProgress(sessionId, {
        type: 'info',
        message: `📊 Starting production benchmark system...`
      });

      const userTimestamp = new Date().toISOString();
      
      // ONLY use the production benchmark system - no custom logic
      await benchmarkModel(modelObj, userTimestamp, sessionId);
      
      // Fetch persisted results
      const scoreResults = await db.select()
        .from(scores)
        .where(eq(scores.modelId, modelId))
        .orderBy(desc(scores.ts))
        .limit(1);
      
      if (scoreResults.length === 0) {
        throw new Error('Benchmark completed but no results found in database');
      }

      const latestScore = scoreResults[0];
      const axes = latestScore.axes as any;

      // Get run metrics for complete test summary
      const recentRuns = await db.select()
        .from(runs)
        .where(and(
          eq(runs.modelId, modelId),
          gte(runs.ts, userTimestamp)
        ))
        .limit(20);
      
      const totalLatency = recentRuns.reduce((sum, run) => sum + (run.latencyMs || 0), 0);
      const totalTokensIn = recentRuns.reduce((sum, run) => sum + (run.tokensIn || 0), 0);
      const totalTokensOut = recentRuns.reduce((sum, run) => sum + (run.tokensOut || 0), 0);
      const passedTasks = recentRuns.filter(run => run.passed).length;

      emitBenchmarkProgress(sessionId, {
        type: 'complete',
        message: `🎉 Benchmark complete! Final score: ${latestScore.stupidScore}`,
        data: {
          success: true,
          provider,
          model: validModelName,
          timestamp: userTimestamp,
          performance: {
            displayScore: latestScore.stupidScore,
            stupidScore: Math.round((100 - latestScore.stupidScore) * 0.8),
            axes: {
              correctness: Math.round((axes.correctness || 0) * 100),
              spec: Math.round((axes.complexity || 0) * 100),
              codeQuality: Math.round((axes.codeQuality || 0) * 100),
              efficiency: Math.round((axes.efficiency || 0) * 100),
              stability: Math.round((axes.stability || 0) * 100),
              refusal: Math.round((axes.edgeCases || 0) * 100),
              recovery: Math.round((axes.debugging || 0) * 100)
            }
          },
          metrics: {
            totalLatency,
            avgLatency: recentRuns.length > 0 ? Math.round(totalLatency / recentRuns.length) : 0,
            totalTokensIn,
            totalTokensOut,
            testsRun: recentRuns.length,
            refusalRate: `${Math.round((axes.edgeCases || 0) * 100)}%`,
            recoveryRate: `${Math.round((axes.debugging || 0) * 100)}%`,
            tasksCompleted: `${passedTasks}/${recentRuns.length}`
          },
          database: {
            modelId,
            persisted: true,
            message: 'Results saved to live rankings database'
          }
        }
      });

      // AUTOMATIC CACHE REFRESH: Refresh frontend cache after user benchmark completion
      if (refreshAllCache) {
        try {
          emitBenchmarkProgress(sessionId, {
            type: 'info',
            message: '🔄 Refreshing frontend cache with fresh user benchmark data...'
          });
          const cacheResult = await refreshAllCache();
          emitBenchmarkProgress(sessionId, {
            type: 'success',
            message: `✅ Cache refreshed successfully: ${cacheResult.refreshed || 0} combinations updated`
          });
        } catch (cacheError) {
          emitBenchmarkProgress(sessionId, {
            type: 'warning',
            message: '⚠️ Cache refresh failed - frontend may not show updated scores immediately'
          });
          console.warn('⚠️ Cache refresh failed after user benchmarks:', String(cacheError).slice(0, 200));
        }
      }

    } finally {
      // Restore environment
      if (originalKey) {
        process.env[keyName] = originalKey;
      } else {
        delete process.env[keyName];
      }
    }

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`❌ Streaming benchmark failed: ${errorMessage}`);
    
    emitBenchmarkProgress(sessionId, {
      type: 'error',
      message: `❌ Benchmark failed: ${errorMessage}`

    });
  }
}

async function runTaskWithTrialsStreaming(
  adapter: any,
  model: { id: number; name: string; vendor: Provider },
  task: typeof BENCHMARK_TASKS[0],
  N = TRIALS,
  sessionId: string
) {
  const trials: any[] = [];
  
  for (let i = 0; i < N; i++) {
    emitBenchmarkProgress(sessionId, {
      type: 'trial',
      message: `  🔄 Trial ${i + 1}/${N} for ${task.id}...`
    });
    
    const result = await runSingleBenchmark(adapter, model, task);
    if (result) {
      trials.push(result);
      emitBenchmarkProgress(sessionId, {
        type: 'trial_result',
        message: `  ✅ Trial ${i + 1}: ${(result.metrics.correctness * 100).toFixed(1)}% correct, ${result.latencyMs}ms`
      });
    } else {
      emitBenchmarkProgress(sessionId, {
        type: 'trial_result',
        message: `  ❌ Trial ${i + 1}: Failed`
      });
    }
    
    await sleep(jitter(SLEEP_MS_RANGE[0], SLEEP_MS_RANGE[1]));
  }

  if (trials.length === 0) return null;

  const ok = trials.filter(t => t.success);
  if (ok.length === 0) return null;

  const axes = ['correctness','complexity','codeQuality','efficiency','edgeCases','debugging'];
  const med: any = { 
    correctness:0, complexity:0, codeQuality:0, efficiency:0, 
    stability:0, edgeCases:0, debugging:0 
  };
  
  for (const k of axes) {
    med[k] = median(ok.map(t => t.metrics[k]));
  }

  // Stability from variance across trials
  const corrSeries = trials.map(t => t.metrics.correctness ?? 0);
  const sd = stdev(corrSeries);
  med.stability = Math.max(0, Math.min(1, 1 - sd / 0.3));

  const latencyMed = median(ok.map(t => t.latencyMs));
  const tokensInMed = median(ok.map(t => t.tokensIn ?? 0));
  const tokensOutMed = median(ok.map(t => t.tokensOut ?? 0));
  const codeSample = ok[0]?.code ?? '';

  return {
    collapsed: { 
      latencyMs: latencyMed, 
      tokensIn: tokensInMed, 
      tokensOut: tokensOutMed, 
      metrics: med, 
      code: codeSample 
    },
    trials
  };
}

  // Full benchmark test using the exact same system as production benchmarks
  fastify.post('/benchmark-test', async (req, reply) => {
    const body = req.body as { provider: Provider; model?: string };
    const { provider, model } = body;
    
    if (!provider) {
      return reply.code(400).send({ error: 'Provider is required' });
    }
    
    try {
      // Check for user-provided API key in header - REQUIRED for this endpoint
      const userApiKey = req.headers['x-user-api-key'] as string;
      
      if (!userApiKey || userApiKey.trim() === '') {
        return reply.code(400).send({ 
          success: false,
          error: 'User API key is required. Please enter your API key to test your models.'
        });
      }
      
      // Use provided model or try to get first available model
      let testModel = model;
      if (!testModel) {
        try {
          const adapter = getUserAdapter(provider, userApiKey);
          const models = await adapter.listModels();
          if (models.length === 0) {
            return reply.code(400).send({ error: `No models available for ${provider}` });
          }
          testModel = models[0];
        } catch (error) {
          return reply.code(400).send({ 
            error: `Failed to list models: ${error instanceof Error ? error.message : String(error)}` 
          });
        }
      }

      // Ensure testModel is defined and is a string
      if (!testModel) {
        return reply.code(400).send({ error: `No model specified and none available for ${provider}` });
      }

      // Type assertion to ensure TypeScript knows testModel is string
      const validModelName: string = testModel;
      
      console.log(`🎯 Running production-grade benchmark for ${provider} with model ${validModelName} (user key)`);
      
      // Find or create the model in database FIRST
      const modelId = await findOrCreateModel(validModelName, provider);
      
      // Temporarily override environment to use user's API key for this specific benchmark
      const originalKey = process.env[`${provider.toUpperCase()}_API_KEY`];
      const keyName = provider === 'google' ? 'GEMINI_API_KEY' : `${provider.toUpperCase()}_API_KEY`;
      process.env[keyName] = userApiKey;
      
      try {
        // Create model object for the production benchmark system
        const modelObj = { 
          id: modelId, 
          name: validModelName, 
          vendor: provider 
        };
        
        // Use the EXACT SAME benchmark system as production with user's timestamp
        const userTimestamp = new Date().toISOString();
        console.log(`📊 Running ${BENCHMARK_TASKS.length} comprehensive benchmark tasks with ${3} trials each...`);
        
        // Import and run the production benchmark function
        const { benchmarkModel } = await import('../jobs/real-benchmarks');
        await benchmarkModel(modelObj, userTimestamp);
        
        // Fetch the results that were just persisted
        const scoreResults = await db.select()
          .from(scores)
          .where(eq(scores.modelId, modelId))
          .orderBy(desc(scores.ts))
          .limit(1);
        
        if (scoreResults.length === 0) {
          throw new Error('Benchmark completed but no results found in database');
        }
        
        const latestScore = scoreResults[0];
        
        // Check for failure sentinel values
        if (latestScore.stupidScore < 0) {
          const errorMessages = {
            '-999': 'API key configuration error',
            '-777': 'Model adapter validation failed', 
            '-888': 'All benchmark tasks failed'
          };
          const errorMsg = errorMessages[latestScore.stupidScore.toString() as keyof typeof errorMessages] || 'Unknown error';
          
          return reply.code(500).send({
            success: false,
            provider,
            model: testModel,
            error: `${errorMsg}: ${latestScore.note || 'No additional details'}`,
            timestamp: latestScore.ts
          });
        }
        
        // Convert the database result to the expected frontend format
        const axes = latestScore.axes as any;
        const performance = {
          displayScore: latestScore.stupidScore,
          stupidScore: Math.round((100 - latestScore.stupidScore) * 0.8), // Inverse for display
          axes: {
            correctness: Math.round((axes.correctness || 0) * 100),
            spec: Math.round((axes.complexity || 0) * 100), // complexity -> spec for display
            codeQuality: Math.round((axes.codeQuality || 0) * 100),
            efficiency: Math.round((axes.efficiency || 0) * 100),
            stability: Math.round((axes.stability || 0) * 100),
            refusal: Math.round((axes.edgeCases || 0) * 100), // edgeCases -> refusal for display
            recovery: Math.round((axes.debugging || 0) * 100)  // debugging -> recovery for display
          },
          breakdown: {
            correctness: `${Math.round((axes.correctness || 0) * 100)}%${'█'.repeat(Math.floor((axes.correctness || 0) * 10))}${'░'.repeat(10-Math.floor((axes.correctness || 0) * 10))}`,
            spec: `${Math.round((axes.complexity || 0) * 100)}%${'█'.repeat(Math.floor((axes.complexity || 0) * 10))}${'░'.repeat(10-Math.floor((axes.complexity || 0) * 10))}`,
            codeQuality: `${Math.round((axes.codeQuality || 0) * 100)}%${'█'.repeat(Math.floor((axes.codeQuality || 0) * 10))}${'░'.repeat(10-Math.floor((axes.codeQuality || 0) * 10))}`,
            efficiency: `${Math.round((axes.efficiency || 0) * 100)}%${'█'.repeat(Math.floor((axes.efficiency || 0) * 10))}${'░'.repeat(10-Math.floor((axes.efficiency || 0) * 10))}`,
            stability: `${Math.round((axes.stability || 0) * 100)}%${'█'.repeat(Math.floor((axes.stability || 0) * 10))}${'░'.repeat(10-Math.floor((axes.stability || 0) * 10))}`,
            refusal: `${Math.round((axes.edgeCases || 0) * 100)}%${'█'.repeat(Math.floor((axes.edgeCases || 0) * 10))}${'░'.repeat(10-Math.floor((axes.edgeCases || 0) * 10))}`,
            recovery: `${Math.round((axes.debugging || 0) * 100)}%${'█'.repeat(Math.floor((axes.debugging || 0) * 10))}${'░'.repeat(10-Math.floor((axes.debugging || 0) * 10))}`
          }
        };
        
        // Get run metrics for summary
        const recentRuns = await db.select()
          .from(runs)
          .where(and(
            eq(runs.modelId, modelId),
            gte(runs.ts, userTimestamp)
          ))
          .limit(20);
        
        const totalLatency = recentRuns.reduce((sum, run) => sum + (run.latencyMs || 0), 0);
        const totalTokensIn = recentRuns.reduce((sum, run) => sum + (run.tokensIn || 0), 0);
        const totalTokensOut = recentRuns.reduce((sum, run) => sum + (run.tokensOut || 0), 0);
        const passedTasks = recentRuns.filter(run => run.passed).length;
        
        const metrics = {
          totalLatency,
          avgLatency: recentRuns.length > 0 ? Math.round(totalLatency / recentRuns.length) : 0,
          totalTokensIn,
          totalTokensOut,
          testsRun: recentRuns.length,
          refusalRate: `${Math.round((axes.edgeCases || 0) * 100)}%`,
          recoveryRate: `${Math.round((axes.debugging || 0) * 100)}%`,
          tasksCompleted: `${passedTasks}/${recentRuns.length}`
        };
        
        console.log(`✅ Production benchmark completed: Model ${testModel}, Score ${latestScore.stupidScore}`);
        
        // AUTOMATIC CACHE REFRESH: Refresh frontend cache after user benchmark completion
        if (refreshAllCache) {
          try {
            console.log('🔄 Refreshing frontend cache with fresh user benchmark data...');
            const cacheResult = await refreshAllCache();
            console.log(`✅ Cache refreshed successfully: ${cacheResult.refreshed || 0} combinations updated`);
          } catch (cacheError) {
            console.warn('⚠️ Cache refresh failed after user benchmarks:', String(cacheError).slice(0, 200));
            // Don't fail the entire benchmark if cache refresh fails
          }
        }
        
        return {
          success: true,
          provider,
          model: validModelName,
          timestamp: userTimestamp,
          performance,
          metrics,
          testDetails: [], // Production system doesn't return detailed test logs to frontend
          database: {
            modelId,
            persisted: true,
            message: 'Results saved using production benchmark system - live rankings updated immediately',
            note: latestScore.note
          }
        };
        
      } finally {
        // Restore original environment
        if (originalKey) {
          process.env[keyName] = originalKey;
        } else {
          delete process.env[keyName];
        }
      }
      
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`❌ Production benchmark test failed for ${provider}:`, errorMessage);
      
      return reply.code(500).send({
        success: false,
        provider,
        model: model || 'unknown',
        error: errorMessage
      });
    }
  });

  // Health check with model counts
  fastify.get('/health', async () => {
    const expectedModels = {
      openai: ['gpt-5', 'gpt-5-mini', 'gpt-5-nano', 'gpt-5-chat-latest', 'gpt-4o', 'gpt-4o-mini'],
      anthropic: ['claude-sonnet-4-20250514', 'claude-sonnet-4-5-20250929', 'claude-opus-4-20250514', 'claude-opus-4-1-20250805'],
      xai: ['grok-4', 'grok-code-fast-1'],
      google: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite']
    };
    
    const status: Record<string, any> = {};
    
    for (const [provider, expected] of Object.entries(expectedModels)) {
      const hasKey = process.env[`${provider.toUpperCase()}_API_KEY`];
      status[provider] = {
        keyConfigured: !!hasKey,
        expectedModels: expected,
        expectedCount: expected.length
      };
    }
    
    return {
      timestamp: new Date(),
      adaptersStatus: status,
      totalExpectedModels: Object.values(expectedModels).flat().length,
      message: 'Use GET /discovery to test model discovery, POST /chat-test to test functionality, POST /benchmark-test for full 7-axis performance analysis'
    };
  });
}

// Extract and evaluate Python code from AI responses
function extractPython(raw: string, expectedSymbol: string): string {
  if (!raw) return "";
  let s = raw.replace(/\r\n/g, "\n").trim();
  
  // Prefer longest ```python code block
  const codeBlockRegex = /```(?:python|py)?\s*([\s\S]*?)```/gi;
  let best: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = codeBlockRegex.exec(s)) !== null) {
    const body = m[1].trim();
    if (!best || body.length > best.length) best = body;
  }
  if (best) s = best;
  
  // Remove backticks and explanatory text
  s = s.replace(/^\s*```.*$/gm, "").trim();
  s = s.split("\n")
    .filter(line => !/^(here is|solution|function|code)\b/i.test(line.trim()))
    .join("\n")
    .trim();
    
  return s;
}

// Evaluate code using actual test runner
async function evaluateCode(code: string, task: typeof BENCHMARK_TASKS[0]): Promise<{
  correctness: number; complexity: number; codeQuality: number; edgeCases: number; debugging: number;
}> {
  const { exec } = require('child_process');
  const { promisify } = require('util');
  const fs = require('fs').promises;
  const path = require('path');
  const os = require('os');
  const execAsync = promisify(exec);

  // Clean code
  let clean = extractPython(code, task.expectedCode);

  // Test complexity - does it have the expected function/class?
  let complexity = 0;
  try {
    const checkScript = `
import ast, sys, json
p = sys.argv[1]
src = open(p).read()
ok = {"found":0,"syntax":0}
try:
    tree = ast.parse(src)
    ok["syntax"] = 1
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name == "${task.expectedCode}":
            ok["found"] = 1
            break
        elif isinstance(node, ast.ClassDef) and node.name == "${task.expectedCode}":
            ok["found"] = 1
            break
except Exception:
    pass
print(json.dumps(ok))
`.trim();

    const tmpDir = os.tmpdir();
    const solPath = path.join(tmpDir, `sol_${Date.now()}.py`);
    const checkPath = path.join(tmpDir, `chk_${Date.now()}.py`);
    await fs.writeFile(solPath, clean || "# empty");
    await fs.writeFile(checkPath, checkScript);
    const { stdout } = await execAsync(`python3 -I ${checkPath} ${solPath}`, { timeout: 2000 });
    const ok = JSON.parse(stdout.trim());
    if (ok.syntax && ok.found) {
      const complexityScores = { easy: 0.3, medium: 0.6, hard: 0.9 } as const;
      complexity = complexityScores[task.difficulty as keyof typeof complexityScores] ?? 0.5;
    }
    await fs.unlink(checkPath).catch(()=>{});
    await fs.unlink(solPath).catch(()=>{});
  } catch {
    // complexity stays 0
  }

  // Code quality assessment
  let codeQuality = 0;
  if (clean.length >= 20 && clean.length <= 2000) codeQuality += 0.20;
  if (!/exec|eval|__import__|os\.|subprocess\.|socket\.|urllib\.|requests\.|ftplib|smtplib/.test(clean)) codeQuality += 0.20;
  if (/(^|\n)\s*(def|class)\s+/.test(clean)) codeQuality += 0.10;
  if (/\b(if|for|while)\b/.test(clean)) codeQuality += 0.10;
  if (/^""".+?"""|^'''.+?'''/ms.test(clean)) codeQuality += 0.10;
  if (/->\s*[A-Za-z_][A-Za-z0-9_\[\], ]*/.test(clean)) codeQuality += 0.05;
  if (/\w+\s*:\s*[A-Za-z_][A-Za-z0-9_\[\], ]*/.test(clean)) codeQuality += 0.05;
  if (/#[^\n]{5,}/.test(clean)) codeQuality += 0.05;
  if (/return\s+/.test(clean)) codeQuality += 0.05;
  if (/(global\s|lambda\s)/.test(clean)) codeQuality -= 0.05;
  if (clean.length > 2500) codeQuality -= 0.05;
  codeQuality = Math.max(0, Math.min(0.75, codeQuality));

  // Test runner
  const runnerPath = path.join(os.tmpdir(), `run_${Date.now()}.py`);
  const runnerScript = `
import resource, signal, sys, builtins, ast
resource.setrlimit(resource.RLIMIT_CPU, (2,2))
resource.setrlimit(resource.RLIMIT_AS, (512*1024*1024,512*1024*1024))
def timeout_handler(sig,frame): sys.exit(124)
signal.signal(signal.SIGALRM, timeout_handler); signal.alarm(5)

orig_import = builtins.__import__
def safe_import(name, *args, **kwargs):
    banned = {'os','subprocess','socket','urllib','requests','http','ftplib','smtplib','shutil','pathlib'}
    if name in banned:
        raise ImportError(f"Import '{name}' blocked")
    return orig_import(name, *args, **kwargs)
builtins.__import__ = safe_import

sol_path = sys.argv[1]
src = open(sol_path).read().replace('\\r\\n','\\n')

ns = {}
ok_compile = 1
try:
    codeobj = compile(src, '<solution>', 'exec')
    exec(codeobj, ns, ns)
except Exception as e:
    ok_compile = 0

passed_count = 0
total_tests = 0

def call_fn(fn_name, args):
    fn = ns.get(fn_name)
    if not callable(fn):
        raise NameError('missing ' + fn_name)
    return fn(*args)
`;

  // Build tests
  let tests = "\n";
  for (const tc of task.testCases) {
    tests += `
total_tests += 1
try:
    args = ast.literal_eval("(" + ${JSON.stringify(tc.input)} + ",)")
    result = call_fn(${JSON.stringify(task.expectedCode)}, args)
    expected = ast.literal_eval(${JSON.stringify(tc.expected)})
    if result == expected:
        passed_count += 1
except Exception:
    pass
`;
  }
  tests += `\nprint(f"{passed_count}/{total_tests}")\n`;

  await fs.writeFile(runnerPath, runnerScript + tests);

  // Execute tests
  let correctness = 0;
  let edgeCases = 0;
  try {
    const solPath = path.join(os.tmpdir(), `sol_${Date.now()}.py`);
    await fs.writeFile(solPath, clean || "# empty");
    const { stdout } = await execAsync(`python3 -I ${runnerPath} ${solPath}`, { timeout: 6000 });
    const [p, t] = (stdout?.trim().split('/') ?? ["0","1"]).map(Number);
    correctness = Math.max(0, Math.min(1, (p || 0) / (t || 1)));
    edgeCases = correctness > 0.7 ? correctness : correctness * 0.5;
    await fs.unlink(solPath).catch(()=>{});
  } catch (e) {
    console.log(`Test execution failed: ${e}`);
    correctness = 0;
    edgeCases = 0;
  } finally {
    await fs.unlink(runnerPath).catch(()=>{});
  }

  const debugging = task.id.includes('debug') ? correctness : Math.min(correctness + 0.05, 1);
  return { correctness, complexity, codeQuality, edgeCases, debugging };
}

// Find or create model in database
async function findOrCreateModel(modelName: string, provider: Provider): Promise<number> {
  try {
    // Check if model exists
    const existing = await db.select()
      .from(models)
      .where(eq(models.name, modelName))
      .limit(1);
    
    if (existing.length > 0) {
      return existing[0].id;
    }
    
    // Create new model
    const result = await db.insert(models).values({
      name: modelName,
      vendor: provider,
      version: 'user-tested',
      notes: 'Added via user API key testing'
    }).returning({ id: models.id });
    
    console.log(`✅ Created new model entry: ${modelName} (${provider})`);
    return result[0].id;
  } catch (error) {
    console.error(`Failed to find/create model ${modelName}:`, error);
    throw error;
  }
}

// Persist benchmark results to database
async function persistUserBenchmarkResults(
  modelId: number,
  axes: any,
  metrics: any,
  testDetails: any[],
  provider: Provider
) {
  try {
    const timestamp = new Date().toISOString();
    
    // Calculate stupidScore from axes (same logic as main system)
    const AXIS_WEIGHTS = {
      correctness: 0.35,
      complexity: 0.20,
      codeQuality: 0.15,
      efficiency: 0.10,
      stability: 0.10,
      edgeCases: 0.05,
      debugging: 0.05
    };
    
    let weightedSum = 0;
    let totalWeight = 0;
    for (const [axis, weight] of Object.entries(AXIS_WEIGHTS)) {
      const performance = axes[axis as keyof typeof axes] || 0;
      weightedSum += performance * weight * 100;
      totalWeight += weight;
    }
    
    const displayScore = Math.round(weightedSum / totalWeight);
    // IMPORTANT: For consistency with system benchmarks, save display score directly
    // The real-benchmarks.ts saves finalScore (display score) as stupidScore
    // We must do the same for user tests to avoid confusion
    const stupidScoreForDisplay = displayScore; // Use display score directly, same as system benchmarks
    
    // Map axes to database schema format
    const dbAxes = {
      correctness: axes.correctness,
      complexity: axes.complexity,  // New axis name
      codeQuality: axes.codeQuality,
      efficiency: axes.efficiency,
      stability: axes.stability,
      edgeCases: axes.edgeCases,  // New axis name
      debugging: axes.debugging    // New axis name
    };
    
    // Insert score record - using display score as stupidScore for consistency
    await db.insert(scores).values({
      modelId,
      ts: timestamp,
      stupidScore: stupidScoreForDisplay, // Save display score directly like system benchmarks
      axes: dbAxes,
      cusum: 0.0,
      note: 'User API key test'
    });
    
    console.log(`✅ Persisted user test results for model ID ${modelId}: displayScore=${displayScore} saved as stupidScore=${stupidScoreForDisplay}`);
    
    // Also persist individual run details for each task
    for (const detail of testDetails) {
      if (!detail.error) {
        try {
          // Find task ID if it exists
          let taskId: number | null = null;
          const taskSlug = `py/${detail.taskId}`;
          const taskRecords = await db.select().from(tasksTable).where(eq(tasksTable.slug, taskSlug)).limit(1);
          if (taskRecords.length > 0) {
            taskId = taskRecords[0].id;
          }
          
          // Insert run record
          const runResult = await db.insert(runs).values({
            modelId,
            taskId,
            ts: timestamp,
            temp: 0.1,
            seed: 0,
            tokensIn: detail.tokensIn || 0,
            tokensOut: detail.tokensOut || 0,
            latencyMs: detail.latency || 0,
            attempts: 1,
            passed: (detail.metrics?.correctness || 0) >= 0.5,
            artifacts: null
          }).returning({ id: runs.id });
          
          if (runResult.length > 0) {
            // Insert metrics for the run
            await db.insert(metrics).values({
              runId: runResult[0].id,
              correctness: detail.metrics?.correctness || 0,
              spec: detail.metrics?.complexity || 0,  // Map to old column name
              codeQuality: detail.metrics?.codeQuality || 0,
              efficiency: detail.metrics?.efficiency || 0,
              stability: detail.metrics?.stability || 0,
              refusal: detail.metrics?.edgeCases || 0,  // Map to old column name
              recovery: detail.metrics?.debugging || 0   // Map to old column name
            });
          }
        } catch (runError) {
          console.warn(`Failed to persist run details for task ${detail.taskId}:`, runError);
        }
      }
    }
    
    return { displayScore, stupidScore: stupidScoreForDisplay };
  } catch (error) {
    console.error('Failed to persist user benchmark results:', error);
    throw error;
  }
}

// Use same constants as production system
const TRIALS = 3;
const SLEEP_MS_RANGE = [200, 400];
const EFF_REF_MS = 1000;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const jitter = (min: number, max: number) => Math.floor(min + Math.random() * (max - min));

function median(nums: number[]): number {
  if (!nums.length) return 0;
  const a = [...nums].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function stdev(nums: number[]): number {
  if (!nums.length) return 0;
  const m = nums.reduce((s, n) => s + n, 0) / nums.length;
  const v = nums.reduce((s, n) => s + (n - m) ** 2, 0) / nums.length;
  return Math.sqrt(v);
}

// Add missing functions from production system
async function runSingleBenchmark(
  adapter: any,
  model: { id: number; name: string; vendor: Provider },
  task: typeof BENCHMARK_TASKS[0]
): Promise<{
  success: boolean; latencyMs: number; code: string;
  tokensIn?: number; tokensOut?: number;
  metrics: any;
} | null> {
  try {
    // Enhanced token limits for different models
    let maxTokens = task.maxTokens;
    let reasoning_effort: string | undefined = undefined;
    
    if (model.vendor === 'openai') {
      if (/^gpt-5/.test(model.name)) {
        maxTokens = Math.max(8000, task.maxTokens * 6);
        reasoning_effort = 'low';
      } else if (/^o\d|^o-mini|^o-/.test(model.name)) {
        maxTokens = Math.max(2000, task.maxTokens * 3);
        reasoning_effort = 'medium';
      }
    }

    const chatRequest: any = {
      model: model.name,
      messages: [
        { role: 'system', content: 'You are an expert Python programmer. Provide clean, efficient, and correct Python code. Include only the requested function or class definition. No markdown formatting.' },
        { role: 'user', content: task.prompt }
      ],
      temperature: 0.1,
      maxTokens
    };
    
    if (reasoning_effort) {
      chatRequest.reasoning_effort = reasoning_effort;
    }

    const t0 = Date.now();
    const res = await adapter.chat(chatRequest);
    if (!res || !res.text) {
      console.warn(`[NO-TEXT] provider=${model.vendor} model=${model.name}`);
      return null;
    }
    
    const latencyMs = Date.now() - t0;
    const code = res.text || '';
    
    // Clean code
    const sanitized = extractPython(code, task.expectedCode);
    if (!sanitized || sanitized.length < 10) {
      console.warn(`[SANITIZE-EMPTY] provider=${model.vendor} model=${model.name}`);
      return null;
    }

    const evalRes = await evaluateCode(sanitized, task);
    const effRaw = Math.min(1, EFF_REF_MS / Math.max(1, latencyMs));
    const efficiency = Math.max(0, Math.min(0.92, Math.pow(effRaw, 0.85)));
    
    const m = {
      correctness: evalRes.correctness,
      complexity: evalRes.complexity,
      codeQuality: evalRes.codeQuality,
      efficiency,
      stability: 0, // Will be calculated after trials
      edgeCases: evalRes.edgeCases,
      debugging: evalRes.debugging
    };

    const tokensIn = res.tokensIn ?? res.usage?.prompt_tokens ?? res.usage?.input_tokens ?? 0;
    const tokensOut = res.tokensOut ?? res.usage?.completion_tokens ?? res.usage?.output_tokens ?? 0;
    
    return { success: true, latencyMs, code: sanitized, tokensIn, tokensOut, metrics: m };
  } catch (e) {
    console.log(`⚠️ Benchmark trial failed: ${e}`);
    return null;
  }
}

async function runTaskWithTrials(
  adapter: any,
  model: { id: number; name: string; vendor: Provider },
  task: typeof BENCHMARK_TASKS[0],
  N = TRIALS
) {
  const trials: any[] = [];
  for (let i = 0; i < N; i++) {
    console.log(`  Trial ${i + 1}/${N} for ${task.id}...`);
    const result = await runSingleBenchmark(adapter, model, task);
    if (result) trials.push(result);
    await sleep(jitter(SLEEP_MS_RANGE[0], SLEEP_MS_RANGE[1]));
  }

  if (trials.length === 0) return null;

  const ok = trials.filter(t => t.success);
  if (ok.length === 0) return null;

  const axes = ['correctness','complexity','codeQuality','efficiency','edgeCases','debugging'];
  const med: any = { 
    correctness:0, complexity:0, codeQuality:0, efficiency:0, 
    stability:0, edgeCases:0, debugging:0 
  };
  
  for (const k of axes) {
    med[k] = median(ok.map(t => t.metrics[k]));
  }

  // Stability from variance across trials
  const corrSeries = trials.map(t => t.metrics.correctness ?? 0);
  const sd = stdev(corrSeries);
  med.stability = Math.max(0, Math.min(1, 1 - sd / 0.3));

  const latencyMed = median(ok.map(t => t.latencyMs));
  const tokensInMed = median(ok.map(t => t.tokensIn ?? 0));
  const tokensOutMed = median(ok.map(t => t.tokensOut ?? 0));
  const codeSample = ok[0]?.code ?? '';

  return {
    collapsed: { 
      latencyMs: latencyMed, 
      tokensIn: tokensInMed, 
      tokensOut: tokensOutMed, 
      metrics: med, 
      code: codeSample 
    },
    trials
  };
}

async function runFullBenchmark(adapter: any, model: string, provider: Provider, persistToDb: boolean = false) {
  console.log(`🔬 Running comprehensive benchmark using SAME methodology as production system for ${model}`);
  
  // Use the same task selection as production system
  const taskCount = Math.min(7, BENCHMARK_TASKS.length);
  const selectedTasks = [...BENCHMARK_TASKS]
    .sort(() => Math.random() - 0.5)
    .slice(0, taskCount);
  
  console.log(`📊 Selected ${selectedTasks.length} tasks: ${selectedTasks.map(t => `${t.id} (${t.difficulty})`).join(', ')}`);
  
  // Use same constants and methodology as production system
  const perTaskAxes: any[] = [];
  let latencies: number[] = [];
  let refusalCount = 0;
  let failedTasks = 0;

  // Create temporary model object for production functions
  const tempModel = { id: -1, name: model, vendor: provider };

  for (const task of selectedTasks) {
    console.log(`🧪 Running ${TRIALS} trials for ${task.id} (${task.difficulty})...`);
    
    const result = await runTaskWithTrials(adapter, tempModel, task, TRIALS);
    if (!result) {
      console.log(`❌ Task ${task.id} failed completely`);
      failedTasks++;
      continue;
    }
    
    console.log(`✅ Task ${task.id}: ${(result.collapsed.metrics.correctness * 100).toFixed(1)}% correct, ${result.collapsed.latencyMs}ms avg`);
    
    perTaskAxes.push(result.collapsed.metrics);
    latencies.push(result.collapsed.latencyMs);
    
    // Count refusals from trial results
    const taskRefusals = result.trials.filter((trial: any) => {
      const code = trial.code || '';
      const responseText = code.toLowerCase();
      return responseText.includes("i cannot") || responseText.includes("i can't") || 
             responseText.includes("unable to") || responseText.includes("not allowed") ||
             responseText.includes("against my") || responseText.includes("inappropriate");
    });
    
    if (taskRefusals.length > 0) {
      refusalCount++;
    }
  }

  // If all tasks failed, return empty results
  if (perTaskAxes.length === 0) {
    console.log(`❌ All ${selectedTasks.length} tasks failed`);
    return {
      performance: {
        displayScore: 0,
        stupidScore: 80,
        axes: { correctness: 0, spec: 0, codeQuality: 0, efficiency: 0, stability: 0, refusal: 100, recovery: 0 }
      },
      metrics: { totalLatency: 0, avgLatency: 0, totalTokensIn: 0, totalTokensOut: 0, testsRun: selectedTasks.length, refusalRate: "100%", recoveryRate: "0%", tasksCompleted: "0/7" },
      testDetails: selectedTasks.map(task => ({ taskId: task.id, error: "Task execution failed", metrics: { correctness: 0, complexity: 0, codeQuality: 0, efficiency: 0, stability: 0, edgeCases: 0, debugging: 0 } }))
    };
  }

  // Aggregate metrics across successful tasks (same logic as production)
  const agg: any = { 
    correctness:0, complexity:0, codeQuality:0, efficiency:0,
    stability:0, edgeCases:0, debugging:0 
  };
  
  const axesKeys = ['correctness', 'complexity', 'codeQuality', 'efficiency', 'stability', 'edgeCases', 'debugging'];
  axesKeys.forEach(k => {
    agg[k] = perTaskAxes.length
      ? perTaskAxes.reduce((s, a) => s + (a[k] ?? 0), 0) / perTaskAxes.length
      : 0;
  });

  console.log(`📊 Aggregated results: correctness=${(agg.correctness*100).toFixed(1)}%, stability=${(agg.stability*100).toFixed(1)}%`);

  // Use the same axis weights as main system
  const AXIS_WEIGHTS = {
    correctness: 0.35,
    complexity: 0.20,
    codeQuality: 0.15,
    efficiency: 0.10,
    stability: 0.10,
    edgeCases: 0.05,
    debugging: 0.05
  };

  // Calculate weighted composite score using aggregated data
  let weightedSum = 0;
  let totalWeight = 0;
  for (const [axis, weight] of Object.entries(AXIS_WEIGHTS)) {
    const performance = agg[axis as keyof typeof agg] || 0;
    weightedSum += performance * weight * 100;
    totalWeight += weight;
  }
  
  const baseScore = weightedSum / totalWeight;
  const refusalPenalty = (refusalCount / selectedTasks.length) * 5; // Up to 5 points penalty
  const finalScore = Math.max(0, Math.min(100, baseScore - refusalPenalty));

  // Convert to percentages for display
  const axesPercentages = {
    correctness: Math.round(agg.correctness * 100),
    spec: Math.round(agg.complexity * 100), // Map complexity to spec for display
    codeQuality: Math.round(agg.codeQuality * 100),
    efficiency: Math.round(agg.efficiency * 100),
    stability: Math.round(agg.stability * 100),
    refusal: Math.round((refusalCount / selectedTasks.length) * 100),
    recovery: Math.round(agg.debugging * 100) // Map debugging to recovery for display
  };

  // Calculate stupidScore (inverse of display score, scaled)
  const stupidScore = (100 - finalScore) * 0.8; // Scale to match main system

  // Calculate totals from actual data
  const totalLatency = latencies.reduce((sum, lat) => sum + lat, 0);
  const totalTokensIn = perTaskAxes.length > 0 ? perTaskAxes.length * 100 : 0; // Estimated
  const totalTokensOut = perTaskAxes.length > 0 ? perTaskAxes.length * 200 : 0; // Estimated

  // Create test details for each task
  const testDetails = selectedTasks.map((task, i) => ({
    taskId: task.id,
    difficulty: task.difficulty,
    latency: latencies[i] || 0,
    tokensIn: Math.round(totalTokensIn / selectedTasks.length),
    tokensOut: Math.round(totalTokensOut / selectedTasks.length),
    metrics: perTaskAxes[i] || { 
      correctness: 0, complexity: 0, codeQuality: 0, efficiency: 0,
      stability: 0, edgeCases: 0, debugging: 0
    }
  }));

  return {
    performance: {
      displayScore: Math.round(finalScore),
      stupidScore: Math.round(stupidScore),
      axes: axesPercentages,
      breakdown: {
        correctness: `${axesPercentages.correctness}%${'█'.repeat(Math.floor(axesPercentages.correctness/10))}${'░'.repeat(10-Math.floor(axesPercentages.correctness/10))}`,
        spec: `${axesPercentages.spec}%${'█'.repeat(Math.floor(axesPercentages.spec/10))}${'░'.repeat(10-Math.floor(axesPercentages.spec/10))}`,
        codeQuality: `${axesPercentages.codeQuality}%${'█'.repeat(Math.floor(axesPercentages.codeQuality/10))}${'░'.repeat(10-Math.floor(axesPercentages.codeQuality/10))}`,
        efficiency: `${axesPercentages.efficiency}%${'█'.repeat(Math.floor(axesPercentages.efficiency/10))}${'░'.repeat(10-Math.floor(axesPercentages.efficiency/10))}`,
        stability: `${axesPercentages.stability}%${'█'.repeat(Math.floor(axesPercentages.stability/10))}${'░'.repeat(10-Math.floor(axesPercentages.stability/10))}`,
        refusal: `${axesPercentages.refusal}%${'█'.repeat(Math.floor(axesPercentages.refusal/10))}${'░'.repeat(10-Math.floor(axesPercentages.refusal/10))}`,
        recovery: `${axesPercentages.recovery}%${'█'.repeat(Math.floor(axesPercentages.recovery/10))}${'░'.repeat(10-Math.floor(axesPercentages.recovery/10))}`
      }
    },
    metrics: {
      totalLatency,
      avgLatency: Math.round(totalLatency / selectedTasks.length),
      totalTokensIn,
      totalTokensOut,
      testsRun: selectedTasks.length,
      refusalRate: `${Math.round((refusalCount / selectedTasks.length) * 100)}%`,
      recoveryRate: `${axesPercentages.recovery}%`,
      tasksCompleted: `${perTaskAxes.filter(m => m.correctness > 0).length}/${selectedTasks.length}`
    },
    testDetails
  };
}

function getUserAdapter(provider: Provider, userApiKey: string): any {
  if (!userApiKey) throw new Error(`User API key is required for ${provider}`);

  switch (provider) {
    case 'openai': return new OpenAIAdapter(userApiKey);
    case 'xai': return new XAIAdapter(userApiKey);
    case 'anthropic': return new AnthropicAdapter(userApiKey);
    case 'google': return new GoogleAdapter(userApiKey);
    default: throw new Error(`Unknown provider: ${provider}`);
  }
}

function getAdapter(provider: Provider): any {
  const keys = {
    openai: process.env.OPENAI_API_KEY,
    xai: process.env.XAI_API_KEY,
    anthropic: process.env.ANTHROPIC_API_KEY,
    google: process.env.GEMINI_API_KEY,  // Fixed: Use GEMINI_API_KEY instead of GOOGLE_API_KEY
  };

  const key = keys[provider];
  if (!key) throw new Error(`API key not found for ${provider}. Please set ${provider.toUpperCase()}_API_KEY environment variable.`);

  switch (provider) {
    case 'openai': return new OpenAIAdapter(key);
    case 'xai': return new XAIAdapter(key);
    case 'anthropic': return new AnthropicAdapter(key);
    case 'google': return new GoogleAdapter(key);
    default: throw new Error(`Unknown provider: ${provider}`);
  }
}
