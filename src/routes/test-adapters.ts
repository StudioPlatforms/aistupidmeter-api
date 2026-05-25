import { FastifyInstance } from 'fastify';
import {
  OpenAIAdapter,
  AnthropicAdapter,
  XAIAdapter,
  GoogleAdapter,
  DeepSeekAdapter,
  KimiAdapter,
  GLMAdapter,
} from '../llm/adapters';
import { db } from '../db/index';
import { models, scores, runs } from '../db/schema';
import { eq, desc, and, gte } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { emitBenchmarkProgress } from './test-adapters-stream';

type Provider = 'openai' | 'anthropic' | 'xai' | 'google' | 'deepseek' | 'kimi' | 'glm';

const VALID_PROVIDERS: Provider[] = ['openai', 'anthropic', 'xai', 'google', 'deepseek', 'kimi', 'glm'];

function createUserAdapter(provider: Provider, apiKey: string) {
  if (!apiKey) throw new Error(`User API key is required for ${provider}`);
  switch (provider) {
    case 'openai':    return new OpenAIAdapter(apiKey);
    case 'anthropic': return new AnthropicAdapter(apiKey);
    case 'xai':       return new XAIAdapter(apiKey);
    case 'google':    return new GoogleAdapter(apiKey);
    case 'deepseek':  return new DeepSeekAdapter(apiKey);
    case 'kimi':      return new KimiAdapter(apiKey);
    case 'glm':       return new GLMAdapter(apiKey);
    default: throw new Error(`Unknown provider: ${provider}`);
  }
}

function getServerAdapter(provider: Provider) {
  const keys: Record<Provider, string | undefined> = {
    openai: process.env.OPENAI_API_KEY,
    xai: process.env.XAI_API_KEY,
    anthropic: process.env.ANTHROPIC_API_KEY,
    google: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY,
    glm: process.env.GLM_API_KEY,
    deepseek: process.env.DEEPSEEK_API_KEY,
    kimi: process.env.KIMI_API_KEY,
  };
  const key = keys[provider];
  if (!key) throw new Error(`API key not found for ${provider}. Please set ${provider.toUpperCase()}_API_KEY environment variable.`);
  return createUserAdapter(provider, key);
}

// Lazy cache refresh import to avoid circular issues
let refreshAllCache: (() => Promise<any>) | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const cacheModule = require('../cache/dashboard-cache');
  refreshAllCache = cacheModule.refreshAllCache;
} catch {
  // Cache system not available - dashboard may not auto-update
}

async function findOrCreateModel(modelName: string, provider: string): Promise<number> {
  try {
    const existing = await db.select().from(models).where(eq(models.name, modelName)).limit(1);
    if (existing.length > 0) return existing[0].id;

    const result = await db.insert(models).values({
      name: modelName,
      vendor: provider,
      version: 'user-tested',
      notes: 'Added via user API key testing',
    }).returning({ id: models.id });

    return result[0].id;
  } catch (error) {
    console.error(`Failed to find/create model ${modelName}:`, error);
    throw error;
  }
}

export default async function testAdaptersRoutes(fastify: FastifyInstance) {
  /**
   * GET /test-adapters/discovery?provider=openai
   * Discover available models for a provider using the user's API key.
   */
  fastify.get('/discovery', async (request: any, reply) => {
    const provider = (request.query as any).provider as Provider;
    const apiKey = (request.headers['x-user-api-key'] as string) || '';

    if (!provider || !VALID_PROVIDERS.includes(provider)) {
      return reply.code(400).send({
        error: 'Invalid provider',
        message: `Provider must be one of: ${VALID_PROVIDERS.join(', ')}`,
      });
    }

    if (!apiKey) {
      return reply.code(400).send({
        error: 'Missing API key',
        message: 'Provide your API key in the x-user-api-key header',
      });
    }

    try {
      const adapter = createUserAdapter(provider, apiKey);
      const models = await adapter.listModels();
      return {
        results: {
          [provider]: {
            success: true,
            models,
            count: models.length,
          },
        },
      };
    } catch (error: any) {
      return {
        results: {
          [provider]: {
            success: false,
            models: [],
            error: error?.message || 'Discovery failed',
          },
        },
      };
    }
  });

  /**
   * POST /test-adapters/chat-test
   * Run a simple chat test with the user's API key.
   */
  fastify.post('/chat-test', async (request: any, reply) => {
    const { provider, model } = request.body as { provider: Provider; model?: string };
    const apiKey = (request.headers['x-user-api-key'] as string) || '';

    if (!provider || !VALID_PROVIDERS.includes(provider)) {
      return reply.code(400).send({
        error: 'Invalid provider',
        message: `Provider must be one of: ${VALID_PROVIDERS.join(', ')}`,
      });
    }

    if (!apiKey) {
      return reply.code(400).send({
        error: 'Missing API key',
        message: 'Provide your API key in the x-user-api-key header',
      });
    }

    const startTime = Date.now();

    try {
      const adapter = createUserAdapter(provider, apiKey);

      let targetModel = model;
      if (!targetModel) {
        const models = await adapter.listModels();
        if (!models.length) {
          return reply.code(400).send({
            error: 'No models available',
            message: `No models found for provider: ${provider}`,
          });
        }
        targetModel = models[0];
      }

      const response = await adapter.chat({
        model: targetModel!,
        messages: [
          { role: 'user', content: 'Return ONLY valid JSON: {"test": "success", "provider": "' + provider + '"}' },
        ],
        temperature: 0.1,
        maxTokens: 100,
        ...(provider === 'openai' && targetModel && targetModel.startsWith('gpt-5')
          ? { reasoning_effort: 'minimal', verbosity: 'low' }
          : {}),
      } as any);

      const latency = Date.now() - startTime;

      return {
        success: true,
        provider,
        model: targetModel,
        latency,
        response: {
          text: response.text,
          tokensIn: response.tokensIn,
          tokensOut: response.tokensOut,
        },
        testPassed: (response.text || '').length > 0,
      };
    } catch (error: any) {
      console.error(`❌ Chat test failed for ${provider}:`, error?.message || error);
      return reply.code(500).send({
        success: false,
        provider,
        model: model || 'unknown',
        error: error?.message || 'Test failed',
        latency: Date.now() - startTime,
      });
    }
  });

  /**
   * POST /test-adapters/benchmark-test-stream
   * Kick off a streaming benchmark. Returns sessionId immediately, client connects
   * to /test-adapters/benchmark-stream/:sessionId for SSE progress events.
   */
  fastify.post('/benchmark-test-stream', async (request: any, reply) => {
    const body = request.body as { provider: Provider; model?: string };
    const { provider, model } = body || ({} as any);
    const userApiKey = (request.headers['x-user-api-key'] as string) || '';

    if (!provider || !VALID_PROVIDERS.includes(provider)) {
      return reply.code(400).send({
        error: 'Invalid provider',
        message: `Provider must be one of: ${VALID_PROVIDERS.join(', ')}`,
      });
    }

    if (!userApiKey || !userApiKey.trim()) {
      return reply.code(400).send({
        error: 'Missing API key',
        message: 'Provide your API key in the x-user-api-key header',
      });
    }

    const sessionId = randomUUID();

    // Respond immediately so the frontend can connect to the SSE stream
    reply.send({ sessionId, message: 'Connect to stream endpoint to watch progress' });

    // Run benchmark in background
    setTimeout(async () => {
      try {
        await runStreamingBenchmark(sessionId, provider, model, userApiKey);
      } catch (error: any) {
        emitBenchmarkProgress(sessionId, {
          type: 'error',
          message: `Benchmark failed: ${error?.message || String(error)}`,
        });
      }
    }, 100);
  });

  /**
   * POST /test-adapters/benchmark-test
   * Non-streaming fallback that runs the full production benchmark and returns the result.
   */
  fastify.post('/benchmark-test', async (request: any, reply) => {
    const body = request.body as { provider: Provider; model?: string };
    const { provider, model } = body || ({} as any);

    if (!provider || !VALID_PROVIDERS.includes(provider)) {
      return reply.code(400).send({
        error: 'Invalid provider',
        message: `Provider must be one of: ${VALID_PROVIDERS.join(', ')}`,
      });
    }

    const userApiKey = (request.headers['x-user-api-key'] as string) || '';
    if (!userApiKey || !userApiKey.trim()) {
      return reply.code(400).send({
        success: false,
        error: 'User API key is required. Please enter your API key to test your models.',
      });
    }

    try {
      // Resolve model name
      let testModel = model;
      if (!testModel) {
        try {
          const adapter = createUserAdapter(provider, userApiKey);
          const list = await adapter.listModels();
          if (!list.length) {
            return reply.code(400).send({ error: `No models available for ${provider}` });
          }
          testModel = list[0];
        } catch (error: any) {
          return reply.code(400).send({
            error: `Failed to list models: ${error?.message || String(error)}`,
          });
        }
      }

      if (!testModel) {
        return reply.code(400).send({ error: `No model specified and none available for ${provider}` });
      }

      const validModelName = testModel as string;
      console.log(`🎯 Running production-grade benchmark for ${provider} with model ${validModelName} (user key)`);

      const modelId = await findOrCreateModel(validModelName, provider);

      // Temporarily override environment variable to use user's API key
      const keyName = provider === 'google' ? 'GEMINI_API_KEY' : `${provider.toUpperCase()}_API_KEY`;
      const originalKey = process.env[keyName];
      process.env[keyName] = userApiKey;

      try {
        const modelObj = { id: modelId, name: validModelName, vendor: provider as any };
        const userTimestamp = new Date().toISOString();

        const { benchmarkModel } = await import('../jobs/real-benchmarks');
        await benchmarkModel(modelObj, userTimestamp);

        const scoreResults = await db
          .select()
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
          const errorMessages: Record<string, string> = {
            '-999': 'API key configuration error',
            '-777': 'Model adapter validation failed',
            '-888': 'All benchmark tasks failed',
          };
          const errorMsg = errorMessages[latestScore.stupidScore.toString()] || 'Unknown error';
          return reply.code(500).send({
            success: false,
            provider,
            model: testModel,
            error: `${errorMsg}: ${latestScore.note || 'No additional details'}`,
            timestamp: latestScore.ts,
          });
        }

        const axes: any = latestScore.axes || {};
        const performance = {
          displayScore: latestScore.stupidScore,
          stupidScore: Math.round((100 - latestScore.stupidScore) * 0.8),
          axes: {
            correctness: Math.round((axes.correctness || 0) * 100),
            spec: Math.round((axes.complexity || 0) * 100),
            codeQuality: Math.round((axes.codeQuality || 0) * 100),
            efficiency: Math.round((axes.efficiency || 0) * 100),
            stability: Math.round((axes.stability || 0) * 100),
            refusal: Math.round((axes.edgeCases || 0) * 100),
            recovery: Math.round((axes.debugging || 0) * 100),
          },
        };

        const recentRuns = await db
          .select()
          .from(runs)
          .where(and(eq(runs.modelId, modelId), gte(runs.ts, userTimestamp)))
          .limit(50);

        const totalLatency = recentRuns.reduce((sum: number, r: any) => sum + (r.latencyMs || 0), 0);
        const totalTokensIn = recentRuns.reduce((sum: number, r: any) => sum + (r.tokensIn || 0), 0);
        const totalTokensOut = recentRuns.reduce((sum: number, r: any) => sum + (r.tokensOut || 0), 0);
        const passedTasks = recentRuns.filter((r: any) => r.passed).length;

        const metrics = {
          totalLatency,
          avgLatency: recentRuns.length > 0 ? Math.round(totalLatency / recentRuns.length) : 0,
          totalTokensIn,
          totalTokensOut,
          testsRun: recentRuns.length,
          refusalRate: `${Math.round((axes.edgeCases || 0) * 100)}%`,
          recoveryRate: `${Math.round((axes.debugging || 0) * 100)}%`,
          tasksCompleted: `${passedTasks}/${recentRuns.length}`,
        };

        // Refresh frontend cache so user sees fresh data immediately
        if (refreshAllCache) {
          try {
            await refreshAllCache();
          } catch (cacheError) {
            console.warn('⚠️ Cache refresh failed after user benchmarks:', String(cacheError).slice(0, 200));
          }
        }

        return {
          success: true,
          provider,
          model: validModelName,
          timestamp: userTimestamp,
          performance,
          metrics,
          testDetails: [],
          database: {
            modelId,
            persisted: true,
            message: 'Results saved using production benchmark system - live rankings updated immediately',
            note: latestScore.note,
          },
        };
      } finally {
        if (originalKey) {
          process.env[keyName] = originalKey;
        } else {
          delete process.env[keyName];
        }
      }
    } catch (error: any) {
      const errorMessage = error?.message || String(error);
      console.error(`❌ Production benchmark test failed for ${provider}:`, errorMessage);
      return reply.code(500).send({
        success: false,
        provider,
        model: model || 'unknown',
        error: errorMessage,
      });
    }
  });

  /**
   * GET /test-adapters/health
   * Quick health check listing expected models per provider.
   */
  fastify.get('/health', async () => {
    const expectedModels: Record<string, string[]> = {
      openai: ['gpt-5', 'gpt-5-mini', 'gpt-5-nano', 'gpt-5-chat-latest', 'gpt-4o', 'gpt-4o-mini'],
      anthropic: ['claude-sonnet-4-20250514', 'claude-sonnet-4-5-20250929', 'claude-opus-4-20250514', 'claude-opus-4-1-20250805'],
      xai: ['grok-4', 'grok-code-fast-1'],
      google: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'],
    };

    const status: Record<string, any> = {};
    for (const [provider, expected] of Object.entries(expectedModels)) {
      const hasKey = !!process.env[`${provider.toUpperCase()}_API_KEY`] ||
        (provider === 'google' && !!process.env.GEMINI_API_KEY);
      status[provider] = {
        keyConfigured: hasKey,
        expectedModels: expected,
        expectedCount: expected.length,
      };
    }

    return {
      timestamp: new Date(),
      adaptersStatus: status,
      message:
        'Use GET /discovery to test model discovery, POST /chat-test to test functionality, POST /benchmark-test for full 7-axis performance analysis',
    };
  });
}

/**
 * Run the full production benchmark with streaming progress events.
 */
async function runStreamingBenchmark(
  sessionId: string,
  provider: Provider,
  requestedModel: string | undefined,
  userApiKey: string
): Promise<void> {
  try {
    emitBenchmarkProgress(sessionId, {
      type: 'info',
      message: `🚀 Starting streaming benchmark for ${provider}${requestedModel ? ` with model ${requestedModel}` : ''}`,
    });

    if (!userApiKey || !userApiKey.trim()) {
      throw new Error('User API key is required for streaming benchmarks');
    }

    // Validate user adapter and resolve a model
    const userAdapter = createUserAdapter(provider, userApiKey);
    let testModel = requestedModel;
    if (!testModel) {
      emitBenchmarkProgress(sessionId, {
        type: 'info',
        message: `🔍 Discovering available models for ${provider}...`,
      });
      const list = await userAdapter.listModels();
      if (!list.length) throw new Error(`No models available for ${provider}`);
      testModel = list[0];
    }

    if (!testModel) {
      throw new Error(`No model specified and no models available for ${provider}`);
    }

    const validModelName = testModel as string;
    emitBenchmarkProgress(sessionId, {
      type: 'info',
      message: `🎯 Using model: ${validModelName}`,
    });

    const modelId = await findOrCreateModel(validModelName, provider);

    // Override env so production benchmark adapter uses the user's key
    const keyName = provider === 'google' ? 'GEMINI_API_KEY' : `${provider.toUpperCase()}_API_KEY`;
    const originalKey = process.env[keyName];
    process.env[keyName] = userApiKey;

    try {
      const modelObj = { id: modelId, name: validModelName, vendor: provider as any };

      emitBenchmarkProgress(sessionId, {
        type: 'info',
        message: `📊 Starting production benchmark system...`,
      });

      const userTimestamp = new Date().toISOString();

      // Use the production benchmark system - it emits streaming events via the same sessionId
      const { benchmarkModel } = await import('../jobs/real-benchmarks');
      await benchmarkModel(modelObj, userTimestamp, sessionId);

      // Fetch persisted results
      const scoreResults = await db
        .select()
        .from(scores)
        .where(eq(scores.modelId, modelId))
        .orderBy(desc(scores.ts))
        .limit(1);

      if (scoreResults.length === 0) {
        throw new Error('Benchmark completed but no results found in database');
      }

      const latestScore = scoreResults[0];

      // Surface sentinel-value failures clearly
      if (latestScore.stupidScore < 0) {
        const errorMessages: Record<string, string> = {
          '-999': 'API key configuration error',
          '-777': 'Model adapter validation failed',
          '-888': 'All benchmark tasks failed',
        };
        const errorMsg = errorMessages[latestScore.stupidScore.toString()] || 'Unknown error';
        emitBenchmarkProgress(sessionId, {
          type: 'error',
          message: `❌ ${errorMsg}: ${latestScore.note || 'No additional details'}`,
        });
        return;
      }

      const axes: any = latestScore.axes || {};

      const recentRuns = await db
        .select()
        .from(runs)
        .where(and(eq(runs.modelId, modelId), gte(runs.ts, userTimestamp)))
        .limit(50);

      const totalLatency = recentRuns.reduce((sum: number, r: any) => sum + (r.latencyMs || 0), 0);
      const totalTokensIn = recentRuns.reduce((sum: number, r: any) => sum + (r.tokensIn || 0), 0);
      const totalTokensOut = recentRuns.reduce((sum: number, r: any) => sum + (r.tokensOut || 0), 0);
      const passedTasks = recentRuns.filter((r: any) => r.passed).length;

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
              recovery: Math.round((axes.debugging || 0) * 100),
            },
          },
          metrics: {
            totalLatency,
            avgLatency: recentRuns.length > 0 ? Math.round(totalLatency / recentRuns.length) : 0,
            totalTokensIn,
            totalTokensOut,
            testsRun: recentRuns.length,
            refusalRate: `${Math.round((axes.edgeCases || 0) * 100)}%`,
            recoveryRate: `${Math.round((axes.debugging || 0) * 100)}%`,
            tasksCompleted: `${passedTasks}/${recentRuns.length}`,
          },
          database: {
            modelId,
            persisted: true,
            message: 'Results saved to live rankings database',
          },
        },
      });

      // Refresh frontend cache so the dashboard reflects the new score
      if (refreshAllCache) {
        try {
          emitBenchmarkProgress(sessionId, {
            type: 'info',
            message: '🔄 Refreshing frontend cache with fresh benchmark data...',
          });
          const cacheResult = await refreshAllCache();
          emitBenchmarkProgress(sessionId, {
            type: 'success',
            message: `✅ Cache refreshed: ${cacheResult?.refreshed ?? 'ok'}`,
          });
        } catch (cacheError) {
          emitBenchmarkProgress(sessionId, {
            type: 'warning',
            message: '⚠️ Cache refresh failed - dashboard may not show updated scores immediately',
          });
          console.warn('⚠️ Cache refresh failed after user benchmark:', String(cacheError).slice(0, 200));
        }
      }
    } finally {
      if (originalKey) {
        process.env[keyName] = originalKey;
      } else {
        delete process.env[keyName];
      }
    }
  } catch (error: any) {
    const errorMessage = error?.message || String(error);
    console.error(`❌ Streaming benchmark failed: ${errorMessage}`);
    emitBenchmarkProgress(sessionId, {
      type: 'error',
      message: `❌ Benchmark failed: ${errorMessage}`,
    });
  }
}
