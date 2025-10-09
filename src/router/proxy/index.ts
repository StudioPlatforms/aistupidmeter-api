import { FastifyRequest, FastifyReply } from 'fastify';
import { db } from '../../db/connection-pool';
import { routerApiKeys, routerProviderKeys, routerRequests, routerUsage } from '../../db/router-schema';
import { eq, and } from 'drizzle-orm';
import { hashApiKey, decryptProviderKey } from '../keys/encryption';
import { selectBestModel } from '../selector';
import { OpenAIAdapter, AnthropicAdapter, XAIAdapter, GoogleAdapter } from '../../llm/adapters';
import type { ChatMessage } from '../../llm/adapters';

interface ChatCompletionRequest {
  model: string;
  messages: Array<{ role: string; content: string }>;
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  tools?: any[];
  tool_choice?: any;
}

/**
 * Authenticate request using universal API key
 */
async function authenticateRequest(apiKey: string): Promise<{ userId: number; apiKeyId: number } | null> {
  if (!apiKey || !apiKey.startsWith('aism_')) {
    return null;
  }
  
  const keyHash = hashApiKey(apiKey);
  
  const result = await db
    .select({
      id: routerApiKeys.id,
      userId: routerApiKeys.user_id,
      revoked: routerApiKeys.revoked
    })
    .from(routerApiKeys)
    .where(eq(routerApiKeys.key_hash, keyHash))
    .limit(1);
  
  if (result.length === 0 || result[0].revoked) {
    return null;
  }
  
  // Update last_used_at
  await db
    .update(routerApiKeys)
    .set({ last_used_at: new Date().toISOString() })
    .where(eq(routerApiKeys.id, result[0].id));
  
  return {
    userId: result[0].userId,
    apiKeyId: result[0].id
  };
}

/**
 * Get provider API key for user
 */
async function getProviderKey(userId: number, provider: string): Promise<string> {
  const result = await db
    .select({ encrypted_key: routerProviderKeys.encrypted_key })
    .from(routerProviderKeys)
    .where(
      and(
        eq(routerProviderKeys.user_id, userId),
        eq(routerProviderKeys.provider, provider),
        eq(routerProviderKeys.is_active, true)
      )
    )
    .limit(1);
  
  if (result.length === 0) {
    throw new Error(`No active ${provider} API key found. Please add one in your dashboard.`);
  }
  
  return decryptProviderKey(result[0].encrypted_key);
}

/**
 * Create adapter for provider
 */
function createAdapter(provider: string, apiKey: string) {
  switch (provider) {
    case 'openai':
      return new OpenAIAdapter(apiKey);
    case 'anthropic':
      return new AnthropicAdapter(apiKey);
    case 'xai':
      return new XAIAdapter(apiKey);
    case 'google':
      return new GoogleAdapter(apiKey);
    default:
      throw new Error(`Unsupported provider: ${provider}`);
  }
}

/**
 * Estimate cost per 1k tokens
 */
function estimateCost(provider: string, model: string, tokensIn: number, tokensOut: number): number {
  const PRICING: Record<string, Record<string, { input: number; output: number }>> = {
    'openai': {
      'gpt-4o': { input: 0.0025, output: 0.01 },
      'gpt-4o-mini': { input: 0.00015, output: 0.0006 },
      'gpt-5-codex': { input: 0.005, output: 0.015 },
    },
    'anthropic': {
      'claude-sonnet-4': { input: 0.003, output: 0.015 },
      'claude-opus-4': { input: 0.015, output: 0.075 },
    },
    'xai': {
      'grok-4-latest': { input: 0.002, output: 0.01 },
      'grok-2-latest': { input: 0.001, output: 0.005 },
    },
    'google': {
      'gemini-2.5-pro': { input: 0.00125, output: 0.005 },
      'gemini-2.5-flash': { input: 0.000075, output: 0.0003 },
    }
  };
  
  const pricing = PRICING[provider]?.[model] || { input: 0.001, output: 0.002 };
  return (tokensIn / 1000) * pricing.input + (tokensOut / 1000) * pricing.output;
}

/**
 * Log request for analytics
 */
async function logRequest(
  userId: number,
  apiKeyId: number,
  provider: string,
  model: string,
  reasoning: string,
  tokensIn: number,
  tokensOut: number,
  latencyMs: number,
  success: boolean,
  errorMessage?: string
) {
  const cost = estimateCost(provider, model, tokensIn, tokensOut);
  
  await db.insert(routerRequests).values({
    user_id: userId,
    api_key_id: apiKeyId,
    selected_provider: provider,
    selected_model: model,
    routing_reason: reasoning,
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    latency_ms: latencyMs,
    cost_estimate: cost,
    success: success,
    error_message: errorMessage || null,
    created_at: new Date().toISOString()
  });
  
  // Update monthly usage
  const month = new Date().toISOString().substring(0, 7); // YYYY-MM
  
  const existing = await db
    .select()
    .from(routerUsage)
    .where(
      and(
        eq(routerUsage.user_id, userId),
        eq(routerUsage.month, month)
      )
    )
    .limit(1);
  
  if (existing.length > 0) {
    const record = existing[0];
    await db
      .update(routerUsage)
      .set({
        total_requests: (record.total_requests || 0) + 1,
        total_tokens_in: (record.total_tokens_in || 0) + tokensIn,
        total_tokens_out: (record.total_tokens_out || 0) + tokensOut,
        total_cost_estimate: (record.total_cost_estimate || 0) + cost,
        updated_at: new Date().toISOString()
      })
      .where(eq(routerUsage.id, record.id));
  } else {
    await db.insert(routerUsage).values({
      user_id: userId,
      month,
      total_requests: 1,
      total_tokens_in: tokensIn,
      total_tokens_out: tokensOut,
      total_cost_estimate: cost,
      cost_saved_vs_gpt4: 0, // Will be calculated later
      updated_at: new Date().toISOString()
    });
  }
}

/**
 * Main chat completions handler
 */
export async function chatCompletionsHandler(
  request: FastifyRequest,
  reply: FastifyReply
) {
  const startTime = Date.now();
  
  try {
    // 1. Authenticate
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.code(401).send({
        error: {
          message: 'Missing or invalid Authorization header',
          type: 'invalid_request_error',
          code: 'invalid_api_key'
        }
      });
    }
    
    const apiKey = authHeader.replace('Bearer ', '');
    const auth = await authenticateRequest(apiKey);
    
    if (!auth) {
      return reply.code(401).send({
        error: {
          message: 'Invalid API key',
          type: 'invalid_request_error',
          code: 'invalid_api_key'
        }
      });
    }
    
    // 2. Parse request body
    const body = request.body as ChatCompletionRequest;
    
    if (!body.messages || !Array.isArray(body.messages)) {
      return reply.code(400).send({
        error: {
          message: 'Invalid request: messages array is required',
          type: 'invalid_request_error'
        }
      });
    }
    
    // 3. Determine routing strategy from model parameter
    let strategy: any = 'best_overall';
    if (body.model.startsWith('auto-')) {
      const strategyMap: Record<string, string> = {
        'auto-coding': 'best_coding',
        'auto-reasoning': 'best_reasoning',
        'auto-creative': 'best_creative',
        'auto-cheapest': 'cheapest',
        'auto-fastest': 'fastest'
      };
      strategy = strategyMap[body.model] || 'best_overall';
    }
    
    // 4. Select best model
    const selection = await selectBestModel({
      userId: auth.userId,
      strategy
    });
    
    // 5. Get provider API key
    const providerKey = await getProviderKey(auth.userId, selection.provider);
    
    // 6. Create adapter
    const adapter = createAdapter(selection.provider, providerKey);
    
    // 7. Make request
    const messages: ChatMessage[] = body.messages.map(m => ({
      role: m.role as 'system' | 'user' | 'assistant',
      content: m.content
    }));
    
    if (body.stream) {
      // Streaming response
      reply.raw.setHeader('Content-Type', 'text/event-stream');
      reply.raw.setHeader('Cache-Control', 'no-cache');
      reply.raw.setHeader('Connection', 'keep-alive');
      reply.raw.setHeader('X-AISM-Provider', selection.provider);
      reply.raw.setHeader('X-AISM-Model', selection.model);
      reply.raw.setHeader('X-AISM-Reasoning', selection.reasoning);
      
      // For now, we'll convert non-streaming to streaming format
      // TODO: Implement true streaming support in adapters
      const response = await adapter.chat({
        model: selection.model,
        messages,
        temperature: body.temperature,
        maxTokens: body.max_tokens,
        tools: body.tools,
        toolChoice: body.tool_choice
      });
      
      const latency = Date.now() - startTime;
      
      // Log request
      await logRequest(
        auth.userId,
        auth.apiKeyId,
        selection.provider,
        selection.model,
        selection.reasoning,
        response.tokensIn || 0,
        response.tokensOut || 0,
        latency,
        true
      );
      
      // Send as streaming chunks
      const id = `chatcmpl-${Date.now()}`;
      const created = Math.floor(Date.now() / 1000);
      
      // Split response into chunks
      const words = response.text.split(' ');
      for (let i = 0; i < words.length; i++) {
        const chunk = {
          id,
          object: 'chat.completion.chunk',
          created,
          model: selection.model,
          choices: [{
            index: 0,
            delta: i === 0 
              ? { role: 'assistant', content: words[i] + ' ' }
              : { content: words[i] + ' ' },
            finish_reason: null
          }]
        };
        reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
      
      // Final chunk
      const finalChunk = {
        id,
        object: 'chat.completion.chunk',
        created,
        model: selection.model,
        choices: [{
          index: 0,
          delta: {},
          finish_reason: 'stop'
        }]
      };
      reply.raw.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
      reply.raw.write('data: [DONE]\n\n');
      reply.raw.end();
      
    } else {
      // Non-streaming response
      const response = await adapter.chat({
        model: selection.model,
        messages,
        temperature: body.temperature,
        maxTokens: body.max_tokens,
        tools: body.tools,
        toolChoice: body.tool_choice
      });
      
      const latency = Date.now() - startTime;
      
      // Log request
      await logRequest(
        auth.userId,
        auth.apiKeyId,
        selection.provider,
        selection.model,
        selection.reasoning,
        response.tokensIn || 0,
        response.tokensOut || 0,
        latency,
        true
      );
      
      // Return OpenAI-compatible response
      return reply.send({
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: selection.model,
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: response.text
          },
          finish_reason: 'stop'
        }],
        usage: {
          prompt_tokens: response.tokensIn || 0,
          completion_tokens: response.tokensOut || 0,
          total_tokens: (response.tokensIn || 0) + (response.tokensOut || 0)
        },
        'x-aism-provider': selection.provider,
        'x-aism-model': selection.model,
        'x-aism-reasoning': selection.reasoning
      });
    }
    
  } catch (error: any) {
    const latency = Date.now() - startTime;
    
    console.error('Router proxy error:', error);
    
    // Try to log failed request if we have auth
    try {
      const authHeader = request.headers.authorization;
      if (authHeader) {
        const apiKey = authHeader.replace('Bearer ', '');
        const auth = await authenticateRequest(apiKey);
        if (auth) {
          await logRequest(
            auth.userId,
            auth.apiKeyId,
            'unknown',
            'unknown',
            'Error occurred',
            0,
            0,
            latency,
            false,
            error.message
          );
        }
      }
    } catch (logError) {
      console.error('Failed to log error:', logError);
    }
    
    return reply.code(500).send({
      error: {
        message: error.message || 'Internal server error',
        type: 'api_error',
        code: 'internal_error'
      }
    });
  }
}

/**
 * List models handler
 */
export async function listModelsHandler(
  request: FastifyRequest,
  reply: FastifyReply
) {
  try {
    // Authenticate
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.code(401).send({
        error: {
          message: 'Missing or invalid Authorization header',
          type: 'invalid_request_error',
          code: 'invalid_api_key'
        }
      });
    }
    
    const apiKey = authHeader.replace('Bearer ', '');
    const auth = await authenticateRequest(apiKey);
    
    if (!auth) {
      return reply.code(401).send({
        error: {
          message: 'Invalid API key',
          type: 'invalid_request_error',
          code: 'invalid_api_key'
        }
      });
    }
    
    // Return available "auto" models
    const models = [
      {
        id: 'auto',
        object: 'model',
        created: 1234567890,
        owned_by: 'aistupidlevel',
        permission: [],
        root: 'auto',
        parent: null
      },
      {
        id: 'auto-coding',
        object: 'model',
        created: 1234567890,
        owned_by: 'aistupidlevel',
        permission: [],
        root: 'auto-coding',
        parent: null
      },
      {
        id: 'auto-reasoning',
        object: 'model',
        created: 1234567890,
        owned_by: 'aistupidlevel',
        permission: [],
        root: 'auto-reasoning',
        parent: null
      },
      {
        id: 'auto-creative',
        object: 'model',
        created: 1234567890,
        owned_by: 'aistupidlevel',
        permission: [],
        root: 'auto-creative',
        parent: null
      },
      {
        id: 'auto-cheapest',
        object: 'model',
        created: 1234567890,
        owned_by: 'aistupidlevel',
        permission: [],
        root: 'auto-cheapest',
        parent: null
      },
      {
        id: 'auto-fastest',
        object: 'model',
        created: 1234567890,
        owned_by: 'aistupidlevel',
        permission: [],
        root: 'auto-fastest',
        parent: null
      }
    ];
    
    return reply.send({
      object: 'list',
      data: models
    });
    
  } catch (error: any) {
    console.error('List models error:', error);
    return reply.code(500).send({
      error: {
        message: error.message || 'Internal server error',
        type: 'api_error'
      }
    });
  }
}
