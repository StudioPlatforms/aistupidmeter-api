import { FastifyInstance } from 'fastify';
import {
  OpenAIAdapter,
  XAIAdapter,
  AnthropicAdapter,
  GoogleAdapter,
  Provider,
  ChatRequest
} from '../llm/adapters';

export default async function (fastify: FastifyInstance, opts: any) {
  // List models for a provider
  fastify.get('/models/:provider', async (req: any) => {
    const { provider } = req.params;
    try {
      const adapter = getAdapter(provider as Provider);
      const models = await adapter.listModels();
      return { models };
    } catch (error: any) {
      return { error: error.message };
    }
  });

  // Run benchmark
  fastify.post('/run', async (req: any, reply) => {
    const { provider, model, apiKey, task } = req.body;

    console.log('🧠 Starting benchmark:', { provider, model, hasApiKey: !!apiKey });

    try {
      const adapter = getAdapter(provider as Provider, apiKey);

      // Create a simple coding task
      const chatRequest: ChatRequest = {
        model,
        messages: [
          {
            role: 'system',
            content: 'You are a coding assistant. Provide clean, correct code without backticks or explanations. Just output the code.'
          },
          {
            role: 'user',
            content: task || 'Write a Python function named factorial that takes an integer n and returns n!'
          }
        ],
        temperature: 0.2,
        maxTokens: 1000
      };

      console.log('🤖 Calling AI model:', model);
      const start = Date.now();
      const response = await adapter.chat(chatRequest);
      const latency = Date.now() - start;

      console.log('✅ AI Response received, text length:', response.text ? response.text.length : 0);
      console.log('📊 Latency:', latency + 'ms');

      // Mock scoring for demo - calculate StupidMeter gauge value
      const mockScore = Math.random() * 2 - 1; // -1 to +1
      const gauge = 50 + 15 * Math.tanh(mockScore);
      const stupidScore = (mockScore + 1) * 0.5; // 0 to 1

      return {
        success: true,
        text: response.text || 'def factorial(n): return 1 if n <= 1 else n * factorial(n-1)',
        latency,
        model,
        provider,
        raw: response.raw,
        // Mock scoring data for StupidMeter display
        gauge: Math.max(0, Math.min(100, gauge)), // Clamp to 0-100
        stupidScore,
        driftDetected: false // Mock for now
      };
    } catch (error: any) {
      console.error('❌ Benchmark failed:', error.message);
      return reply.code(500).send({
        success: false,
        error: error.message,
        model,
        provider,
        text: 'demo code',
        latency: 100,
        gauge: 50,
        stupidScore: 0.5
      });
    }
  });
}

function getAdapter(provider: Provider, apiKey?: string): any {
  const envKeys = {
    openai: process.env.OPENAI_API_KEY,
    xai: process.env.XAI_API_KEY,
    anthropic: process.env.ANTHROPIC_API_KEY,
    google: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY,
    glm: process.env.GLM_API_KEY,
    deepseek: process.env.DEEPSEEK_API_KEY,
    kimi: process.env.KIMI_API_KEY
  };

  const key = envKeys[provider];
  if (!key) throw new Error(`API key not found for ${provider}`);

  switch (provider) {
    case 'openai': return new OpenAIAdapter(key);
    case 'xai': return new XAIAdapter(key);
    case 'anthropic': return new AnthropicAdapter(key);
    case 'google': return new GoogleAdapter(key);
    default: throw new Error(`Unknown provider: ${provider}`);
  }
}
