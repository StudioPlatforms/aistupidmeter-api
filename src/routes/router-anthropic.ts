/**
 * Phase 6B: Native Anthropic /v1/messages passthrough endpoint
 * 
 * Accepts Anthropic-format payloads with aism_ keys via either:
 * - x-api-key header (Claude Code, Cline Anthropic provider)
 * - Authorization: Bearer header (TypingMind, general clients)
 * 
 * Forwards anthropic-version header if present; injects 2023-06-01 default if absent.
 * Returns native Anthropic response format (no OpenAI translation).
 */
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { db } from '../db/connection-pool';
import { routerApiKeys, routerProviderKeys } from '../db/router-schema';
import { eq, and } from 'drizzle-orm';
import { hashApiKey, decryptProviderKey } from '../router/keys/encryption';

async function authenticateAnthropic(request: FastifyRequest): Promise<{ userId: number; apiKeyId: number } | null> {
  // Accept aism_ key from either x-api-key or Authorization: Bearer
  let rawKey = (request.headers['x-api-key'] as string) || '';
  if (!rawKey) {
    const authHeader = request.headers.authorization || '';
    if (authHeader.startsWith('Bearer ')) rawKey = authHeader.replace('Bearer ', '');
  }
  if (!rawKey) return null;
  
  // Strip sk- prefix alias
  let cleanKey = rawKey;
  if (cleanKey.startsWith('sk-')) cleanKey = cleanKey.slice(3);
  if (!cleanKey.startsWith('aism_')) return null;
  
  const keyHash = hashApiKey(cleanKey);
  const result = await db
    .select({ id: routerApiKeys.id, userId: routerApiKeys.user_id, revoked: routerApiKeys.revoked })
    .from(routerApiKeys)
    .where(eq(routerApiKeys.key_hash, keyHash))
    .limit(1);
  
  if (result.length === 0 || result[0].revoked) return null;
  return { userId: result[0].userId, apiKeyId: result[0].id };
}

async function getAnthropicKey(userId: number): Promise<string | null> {
  try {
    const result = await db
      .select({ encrypted_key: routerProviderKeys.encrypted_key })
      .from(routerProviderKeys)
      .where(
        and(
          eq(routerProviderKeys.user_id, userId),
          eq(routerProviderKeys.provider, 'anthropic'),
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

export default async function routerAnthropicRoutes(fastify: FastifyInstance) {
  /**
   * POST /v1/messages — Anthropic Messages API passthrough
   * Unlocks: Claude Code, Cline Anthropic provider, Roo Code Anthropic provider, TypingMind Anthropic preset
   */
  fastify.post('/v1/messages', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const auth = await authenticateAnthropic(request);
      if (!auth) {
        return reply.code(401).send({
          type: 'error',
          error: { type: 'authentication_error', message: 'Invalid or missing API key' }
        });
      }
      
      const anthropicKey = await getAnthropicKey(auth.userId);
      if (!anthropicKey) {
        return reply.code(400).send({
          type: 'error',
          error: {
            type: 'invalid_request_error',
            message: 'No active Anthropic API key found. Add one in your dashboard.'
          }
        });
      }
      
      // Forward anthropic-version header or inject default
      const anthropicVersion = (request.headers['anthropic-version'] as string) || '2023-06-01';
      
      // Forward the full request body to Anthropic's Messages API
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': anthropicKey,
          'anthropic-version': anthropicVersion,
          'content-type': 'application/json',
        },
        body: JSON.stringify(request.body),
      });
      
      // Check if streaming
      const contentType = response.headers.get('content-type') || '';
      
      if (contentType.includes('text/event-stream')) {
        // Stream SSE directly
        reply.raw.setHeader('Content-Type', 'text/event-stream');
        reply.raw.setHeader('Cache-Control', 'no-cache');
        reply.raw.setHeader('Connection', 'keep-alive');
        
        if (response.body) {
          const reader = (response.body as any).getReader();
          const pump = async () => {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              reply.raw.write(value);
            }
            reply.raw.end();
          };
          await pump();
        } else {
          reply.raw.end();
        }
        return;
      }
      
      // Non-streaming: forward status + body
      const result = await response.json();
      return reply.code(response.status).send(result);
      
    } catch (error: any) {
      console.error('Anthropic passthrough error:', error);
      return reply.code(500).send({
        type: 'error',
        error: { type: 'api_error', message: error.message || 'Internal server error' }
      });
    }
  });
}
