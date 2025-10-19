/**
 * Model Proxy
 * 
 * Proxies requests to the selected AI model provider
 * Handles provider-specific API formats and streaming
 */

import {
  OpenAIAdapter,
  AnthropicAdapter,
  GoogleAdapter,
  XAIAdapter,
  GLMAdapter,
  DeepSeekAdapter,
  KimiAdapter,
  type Provider,
  type ChatRequest
} from '../../llm/adapters';

interface ProxyRequest {
  provider: string;
  model: string;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  [key: string]: any;
}

/**
 * Get adapter for a provider using user's API key
 */
function getAdapter(provider: Provider, apiKey: string) {
  switch (provider) {
    case 'openai':
      return new OpenAIAdapter(apiKey);
    case 'anthropic':
      return new AnthropicAdapter(apiKey);
    case 'google':
      return new GoogleAdapter(apiKey);
    case 'xai':
      return new XAIAdapter(apiKey);
    case 'glm':
      return new GLMAdapter(apiKey);
    case 'deepseek':
      return new DeepSeekAdapter(apiKey);
    case 'kimi':
      return new KimiAdapter(apiKey);
    default:
      throw new Error(`Unsupported provider: ${provider}`);
  }
}

/**
 * Get user's API key for a provider from database
 */
async function getUserApiKey(userId: number, provider: string): Promise<string | null> {
  const { db } = await import('../../db/connection-pool');
  const { routerProviderKeys } = await import('../../db/router-schema');
  const { eq, and } = await import('drizzle-orm');
  
  const keys = await db
    .select({ encryptedKey: routerProviderKeys.encrypted_key })
    .from(routerProviderKeys)
    .where(
      and(
        eq(routerProviderKeys.user_id, userId),
        eq(routerProviderKeys.provider, provider),
        eq(routerProviderKeys.is_active, true)
      )
    )
    .limit(1);
  
  // TODO: Decrypt the key before returning
  // For now, return the encrypted key (needs decryption implementation)
  return keys.length > 0 ? keys[0].encryptedKey : null;
}

/**
 * Proxy a chat completion request to the selected model
 */
export async function proxyToModel(request: ProxyRequest): Promise<any> {
  const { provider, model, messages, temperature, max_tokens, stream, ...otherParams } = request;
  
  // For now, use environment variables for API keys
  // TODO: Get user's API key from database
  const apiKey = getApiKeyFromEnv(provider as Provider);
  
  if (!apiKey) {
    throw new Error(`No API key configured for provider: ${provider}`);
  }
  
  // Get adapter for provider
  const adapter = getAdapter(provider as Provider, apiKey);
  
  // Build chat request with proper type casting
  const chatRequest: ChatRequest = {
    model,
    messages: messages as Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    temperature: temperature ?? 0.7,
    maxTokens: max_tokens ?? 1500
  };
  
  // Make the API call
  const response = await adapter.chat(chatRequest);
  
  // Convert to OpenAI-compatible format
  return {
    id: `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: response.text || ''
        },
        finish_reason: 'stop'
      }
    ],
    usage: {
      prompt_tokens: response.tokensIn || 0,
      completion_tokens: response.tokensOut || 0,
      total_tokens: (response.tokensIn || 0) + (response.tokensOut || 0)
    }
  };
}

/**
 * Get API key from environment variables
 * TODO: Replace with database lookup per user
 */
function getApiKeyFromEnv(provider: Provider): string | null {
  const envKeys: Record<Provider, string> = {
    openai: process.env.OPENAI_API_KEY || '',
    anthropic: process.env.ANTHROPIC_API_KEY || '',
    google: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '',
    xai: process.env.XAI_API_KEY || '',
    glm: process.env.GLM_API_KEY || '',
    deepseek: process.env.DEEPSEEK_API_KEY || '',
    kimi: process.env.KIMI_API_KEY || ''
  };
  
  const key = envKeys[provider];
  return key && !key.startsWith('your_') ? key : null;
}

/**
 * Stream a chat completion request (future enhancement)
 */
export async function streamToModel(request: ProxyRequest): Promise<AsyncGenerator<any>> {
  // TODO: Implement streaming support
  throw new Error('Streaming not yet implemented');
}
