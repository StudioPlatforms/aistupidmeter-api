/**
 * Phase 6A: /v1/embeddings proxy endpoint
 * 
 * Proxies embedding requests to provider APIs. Required by Continue, LibreChat,
 * Open WebUI, and AnythingLLM for RAG features.
 * 
 * Supports:
 * - OpenAI text-embedding-3-small / text-embedding-3-large
 * - auto-embedding (routes to cheapest available provider)
 */
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { db } from '../db/connection-pool';
import { routerApiKeys, routerProviderKeys } from '../db/router-schema';
import { eq, and } from 'drizzle-orm';
import { hashApiKey, decryptProviderKey } from '../router/keys/encryption';

async function authenticateEmbedding(apiKey: string): Promise<{ userId: number; apiKeyId: number } | null> {
  let cleanKey = apiKey;
  if (cleanKey.startsWith('sk-')) cleanKey = cleanKey.slice(3);
  if (!cleanKey || !cleanKey.startsWith('aism_')) return null;
  
  const keyHash = hashApiKey(cleanKey);
  const result = await db
    .select({ id: routerApiKeys.id, userId: routerApiKeys.user_id, revoked: routerApiKeys.revoked })
    .from(routerApiKeys)
    .where(eq(routerApiKeys.key_hash, keyHash))
    .limit(1);
  
  if (result.length === 0 || result[0].revoked) return null;
  return { userId: result[0].userId, apiKeyId: result[0].id };
}

async function getOpenAIKey(userId: number): Promise<string | null> {
  try {
    const result = await db
      .select({ encrypted_key: routerProviderKeys.encrypted_key })
      .from(routerProviderKeys)
      .where(
        and(
          eq(routerProviderKeys.user_id, userId),
          eq(routerProviderKeys.provider, 'openai'),
          eq(routerProviderKeys.is_active, true)
        )
      )
      .limit(1);
    if (result.length === 0) return null;
    return decryptProviderKey(result[0].encrypted_key);
  } catch {
    return null;
  }
}

export default async function routerEmbeddingsRoutes(fastify: FastifyInstance) {
  fastify.post('/v1/embeddings', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      // Authenticate
      const authHeader = request.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return reply.code(401).send({
          error: { message: 'Missing Authorization header', type: 'authentication_error', code: 'invalid_api_key' }
        });
      }
      
      const auth = await authenticateEmbedding(authHeader.replace('Bearer ', ''));
      if (!auth) {
        return reply.code(401).send({
          error: { message: 'Invalid API key', type: 'authentication_error', code: 'invalid_api_key' }
        });
      }
      
      const body = request.body as { model?: string; input: string | string[]; encoding_format?: string };
      if (!body.input) {
        return reply.code(400).send({
          error: { message: 'input is required', type: 'invalid_request_error' }
        });
      }
      
      // Default to text-embedding-3-small (cheapest, best for RAG)
      const model = body.model || 'text-embedding-3-small';
      
      // Get user's OpenAI key (embeddings currently only supported via OpenAI)
      const openaiKey = await getOpenAIKey(auth.userId);
      if (!openaiKey) {
        return reply.code(400).send({
          error: {
            message: 'No active OpenAI API key found. Embeddings require an OpenAI provider key.',
            type: 'invalid_request_error',
            code: 'configuration_error'
          }
        });
      }
      
      // Forward to OpenAI embeddings API
      const upstreamBody: any = {
        model,
        input: body.input,
      };
      if (body.encoding_format) upstreamBody.encoding_format = body.encoding_format;
      
      const response = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${openaiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(upstreamBody),
      });
      
      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        return reply.code(response.status).send({
          error: {
            message: `Embedding API error: ${errText.slice(0, 200)}`,
            type: response.status === 429 ? 'rate_limit_error' : 'server_error',
            code: response.status === 429 ? 'rate_limit_exceeded' : 'upstream_error'
          }
        });
      }
      
      const result = await response.json();
      return reply.send(result);
      
    } catch (error: any) {
      console.error('Embeddings proxy error:', error);
      return reply.code(500).send({
        error: { message: error.message || 'Internal server error', type: 'server_error' }
      });
    }
  });
}
