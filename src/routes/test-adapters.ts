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

type Provider = 'openai' | 'anthropic' | 'xai' | 'google' | 'deepseek' | 'kimi' | 'glm';

function createAdapter(provider: Provider, apiKey: string) {
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

const VALID_PROVIDERS: Provider[] = ['openai', 'anthropic', 'xai', 'google', 'deepseek', 'kimi', 'glm'];

export default async function testAdaptersRoutes(fastify: FastifyInstance) {

  /**
   * GET /test-adapters/discovery?provider=openai
   * Discover available models for a provider using the user's API key.
   * API key passed via x-user-api-key header.
   */
  fastify.get('/discovery', async (request: any, reply) => {
    const provider = (request.query as any).provider as Provider;
    const apiKey = (request.headers['x-user-api-key'] as string) || '';

    if (!provider || !VALID_PROVIDERS.includes(provider)) {
      return reply.code(400).send({
        error: 'Invalid provider',
        message: `Provider must be one of: ${VALID_PROVIDERS.join(', ')}`
      });
    }

    if (!apiKey) {
      return reply.code(400).send({
        error: 'Missing API key',
        message: 'Provide your API key in the x-user-api-key header'
      });
    }

    try {
      const adapter = createAdapter(provider, apiKey);
      const models = await adapter.listModels();

      return {
        results: {
          [provider]: {
            success: true,
            models,
            count: models.length
          }
        }
      };
    } catch (error: any) {
      return {
        results: {
          [provider]: {
            success: false,
            models: [],
            error: error.message || 'Discovery failed'
          }
        }
      };
    }
  });

  /**
   * POST /test-adapters/chat-test
   * Run a simple chat test with the user's API key.
   * Body: { provider, model? }
   * API key passed via x-user-api-key header.
   */
  fastify.post('/chat-test', async (request: any, reply) => {
    const { provider, model } = request.body as { provider: Provider; model?: string };
    const apiKey = (request.headers['x-user-api-key'] as string) || '';

    if (!provider || !VALID_PROVIDERS.includes(provider)) {
      return reply.code(400).send({
        error: 'Invalid provider',
        message: `Provider must be one of: ${VALID_PROVIDERS.join(', ')}`
      });
    }

    if (!apiKey) {
      return reply.code(400).send({
        error: 'Missing API key',
        message: 'Provide your API key in the x-user-api-key header'
      });
    }

    const startTime = Date.now();

    try {
      const adapter = createAdapter(provider, apiKey);

      // Pick a model — use provided model or discover first available
      let targetModel = model;
      if (!targetModel) {
        const models = await adapter.listModels();
        if (!models.length) {
          return reply.code(400).send({
            error: 'No models available',
            message: `No models found for provider: ${provider}`
          });
        }
        targetModel = models[0];
      }

      // Run a simple ping test
      const response = await adapter.chat({
        model: targetModel!,
        messages: [
          { role: 'user', content: 'Say "OK" and nothing else.' }
        ],
        temperature: 0.1,
        maxTokens: 32
      });

      const latency = Date.now() - startTime;

      return {
        success: true,
        provider,
        model: targetModel,
        latency,
        response: {
          text: response.text,
          tokensIn: response.tokensIn,
          tokensOut: response.tokensOut
        },
        testPassed: response.text.trim().length > 0
      };

    } catch (error: any) {
      return reply.code(500).send({
        success: false,
        provider,
        model: model || 'unknown',
        error: error.message || 'Test failed',
        latency: Date.now() - startTime
      });
    }
  });
}
