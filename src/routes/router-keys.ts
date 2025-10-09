import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { db } from '../db/connection-pool';
import { routerApiKeys, routerProviderKeys, routerPreferences } from '../db/router-schema';
import { eq, and } from 'drizzle-orm';
import { 
  generateUniversalKey, 
  hashApiKey, 
  getKeyPrefix,
  encryptProviderKey,
  decryptProviderKey 
} from '../router/keys/encryption';

// Temporary auth - will be replaced with proper NextAuth
interface AuthRequest extends FastifyRequest {
  userId?: number;
}

// Middleware to extract userId and ensure router_users record exists
async function requireAuth(request: AuthRequest, reply: FastifyReply) {
  // Get userId from header (set by frontend from NextAuth session)
  const userIdHeader = request.headers['x-user-id'];
  
  if (!userIdHeader) {
    return reply.code(401).send({
      error: 'Unauthorized',
      message: 'User authentication required'
    });
  }
  
  const userId = parseInt(userIdHeader as string);
  
  // Check if user exists in router_users, create if not
  const { routerUsers } = await import('../db/router-schema');
  const existingUser = await db
    .select()
    .from(routerUsers)
    .where(eq(routerUsers.id, userId))
    .limit(1);
  
  if (existingUser.length === 0) {
    // User doesn't exist in router_users yet, create them
    // This happens on first router access after OAuth login
    try {
      await db.insert(routerUsers).values({
        id: userId,
        email: `user${userId}@oauth.local`, // Placeholder, will be updated from NextAuth
        oauth_provider: 'oauth',
        created_at: new Date().toISOString()
      });
    } catch (error: any) {
      // Ignore if already exists (race condition)
      if (!error.message?.includes('UNIQUE constraint failed')) {
        console.error('Failed to create router user:', error);
      }
    }
  }
  
  request.userId = userId;
}

export default async function routerKeysRoutes(fastify: FastifyInstance) {
  
  // ==================== UNIVERSAL API KEYS ====================
  
  /**
   * GET /router/keys
   * List all universal API keys for the user
   */
  fastify.get('/router/keys', {
    preHandler: requireAuth
  }, async (request: AuthRequest, reply) => {
    try {
      const keys = await db
        .select({
          id: routerApiKeys.id,
          name: routerApiKeys.name,
          keyPrefix: routerApiKeys.key_prefix,
          createdAt: routerApiKeys.created_at,
          lastUsedAt: routerApiKeys.last_used_at,
          revoked: routerApiKeys.revoked
        })
        .from(routerApiKeys)
        .where(eq(routerApiKeys.user_id, request.userId!))
        .orderBy(routerApiKeys.created_at);
      
      return {
        keys: keys.map(k => ({
          id: k.id,
          name: k.name,
          keyPrefix: k.keyPrefix,
          createdAt: k.createdAt,
          lastUsedAt: k.lastUsedAt,
          revoked: k.revoked,
          status: k.revoked ? 'revoked' : 'active'
        }))
      };
    } catch (error: any) {
      console.error('Failed to list keys:', error);
      return reply.code(500).send({
        error: 'Failed to list keys',
        message: error.message
      });
    }
  });
  
  /**
   * POST /router/keys
   * Create a new universal API key
   */
  fastify.post<{
    Body: { name: string }
  }>('/router/keys', {
    preHandler: requireAuth
  }, async (request: AuthRequest, reply) => {
    try {
      const { name } = request.body as { name: string };
      
      if (!name || name.trim().length === 0) {
        return reply.code(400).send({
          error: 'Invalid request',
          message: 'Key name is required'
        });
      }
      
      // Generate new universal key
      const universalKey = generateUniversalKey();
      const keyHash = hashApiKey(universalKey);
      const keyPrefix = getKeyPrefix(universalKey);
      
      // Insert into database
      const result = await db.insert(routerApiKeys).values({
        user_id: request.userId!,
        key_hash: keyHash,
        key_prefix: keyPrefix,
        name: name.trim(),
        created_at: new Date().toISOString(),
        revoked: false
      }).returning();
      
      return {
        key: universalKey, // Only time we return the full key!
        keyId: result[0].id,
        name: result[0].name,
        keyPrefix: result[0].key_prefix,
        createdAt: result[0].created_at,
        message: 'Save this key securely - it will not be shown again!'
      };
    } catch (error: any) {
      console.error('Failed to create key:', error);
      return reply.code(500).send({
        error: 'Failed to create key',
        message: error.message
      });
    }
  });
  
  /**
   * DELETE /router/keys/:id
   * Revoke a universal API key
   */
  fastify.delete<{
    Params: { id: string }
  }>('/router/keys/:id', {
    preHandler: requireAuth
  }, async (request: AuthRequest, reply) => {
    try {
      const keyId = parseInt((request.params as { id: string }).id);
      
      if (isNaN(keyId)) {
        return reply.code(400).send({
          error: 'Invalid request',
          message: 'Invalid key ID'
        });
      }
      
      // Verify ownership and revoke
      const result = await db
        .update(routerApiKeys)
        .set({ revoked: true })
        .where(
          and(
            eq(routerApiKeys.id, keyId),
            eq(routerApiKeys.user_id, request.userId!)
          )
        )
        .returning();
      
      if (result.length === 0) {
        return reply.code(404).send({
          error: 'Not found',
          message: 'Key not found or already revoked'
        });
      }
      
      return {
        success: true,
        message: 'Key revoked successfully',
        keyId: result[0].id
      };
    } catch (error: any) {
      console.error('Failed to revoke key:', error);
      return reply.code(500).send({
        error: 'Failed to revoke key',
        message: error.message
      });
    }
  });
  
  // ==================== PROVIDER API KEYS ====================
  
  /**
   * GET /router/provider-keys
   * List all provider API keys for the user
   */
  fastify.get('/router/provider-keys', {
    preHandler: requireAuth
  }, async (request: AuthRequest, reply) => {
    try {
      const keys = await db
        .select({
          id: routerProviderKeys.id,
          provider: routerProviderKeys.provider,
          isActive: routerProviderKeys.is_active,
          createdAt: routerProviderKeys.created_at,
          lastValidated: routerProviderKeys.last_validated_at
        })
        .from(routerProviderKeys)
        .where(eq(routerProviderKeys.user_id, request.userId!))
        .orderBy(routerProviderKeys.created_at);
      
      return {
        keys: keys.map(k => ({
          id: k.id,
          provider: k.provider,
          isActive: k.isActive,
          createdAt: k.createdAt,
          lastValidated: k.lastValidated,
          status: k.isActive ? 'active' : 'inactive'
        }))
      };
    } catch (error: any) {
      console.error('Failed to list provider keys:', error);
      return reply.code(500).send({
        error: 'Failed to list provider keys',
        message: error.message
      });
    }
  });
  
  /**
   * POST /router/provider-keys
   * Add a new provider API key
   */
  fastify.post<{
    Body: { provider: string; apiKey: string }
  }>('/router/provider-keys', {
    preHandler: requireAuth
  }, async (request: AuthRequest, reply) => {
    try {
      const { provider, apiKey } = request.body as { provider: string; apiKey: string };
      
      // Validate input
      if (!provider || !apiKey) {
        return reply.code(400).send({
          error: 'Invalid request',
          message: 'Provider and API key are required'
        });
      }
      
      const validProviders = ['openai', 'anthropic', 'xai', 'google'];
      if (!validProviders.includes(provider)) {
        return reply.code(400).send({
          error: 'Invalid request',
          message: `Provider must be one of: ${validProviders.join(', ')}`
        });
      }
      
      // Check if provider key already exists
      const existing = await db
        .select()
        .from(routerProviderKeys)
        .where(
          and(
            eq(routerProviderKeys.user_id, request.userId!),
            eq(routerProviderKeys.provider, provider)
          )
        )
        .limit(1);
      
      if (existing.length > 0) {
        return reply.code(409).send({
          error: 'Conflict',
          message: `You already have a ${provider} API key. Delete it first to add a new one.`
        });
      }
      
      // Encrypt the API key
      const encryptedKey = encryptProviderKey(apiKey);
      
      // Insert into database
      const result = await db.insert(routerProviderKeys).values({
        user_id: request.userId!,
        provider,
        encrypted_key: encryptedKey,
        is_active: true,
        created_at: new Date().toISOString()
      }).returning();
      
      return {
        success: true,
        message: `${provider} API key added successfully`,
        keyId: result[0].id,
        provider: result[0].provider
      };
    } catch (error: any) {
      console.error('Failed to add provider key:', error);
      return reply.code(500).send({
        error: 'Failed to add provider key',
        message: error.message
      });
    }
  });
  
  /**
   * PUT /router/provider-keys/:id
   * Update a provider API key
   */
  fastify.put<{
    Params: { id: string };
    Body: { apiKey: string }
  }>('/router/provider-keys/:id', {
    preHandler: requireAuth
  }, async (request: AuthRequest, reply) => {
    try {
      const keyId = parseInt((request.params as { id: string }).id);
      const { apiKey } = request.body as { apiKey: string };
      
      if (isNaN(keyId) || !apiKey) {
        return reply.code(400).send({
          error: 'Invalid request',
          message: 'Valid key ID and API key are required'
        });
      }
      
      // Encrypt the new API key
      const encryptedKey = encryptProviderKey(apiKey);
      
      // Update in database
      const result = await db
        .update(routerProviderKeys)
        .set({ 
          encrypted_key: encryptedKey,
          last_validated_at: null // Reset validation status
        })
        .where(
          and(
            eq(routerProviderKeys.id, keyId),
            eq(routerProviderKeys.user_id, request.userId!)
          )
        )
        .returning();
      
      if (result.length === 0) {
        return reply.code(404).send({
          error: 'Not found',
          message: 'Provider key not found'
        });
      }
      
      return {
        success: true,
        message: `${result[0].provider} API key updated successfully`,
        keyId: result[0].id
      };
    } catch (error: any) {
      console.error('Failed to update provider key:', error);
      return reply.code(500).send({
        error: 'Failed to update provider key',
        message: error.message
      });
    }
  });
  
  /**
   * DELETE /router/provider-keys/:id
   * Delete a provider API key
   */
  fastify.delete<{
    Params: { id: string }
  }>('/router/provider-keys/:id', {
    preHandler: requireAuth
  }, async (request: AuthRequest, reply) => {
    try {
      const keyId = parseInt((request.params as { id: string }).id);
      
      if (isNaN(keyId)) {
        return reply.code(400).send({
          error: 'Invalid request',
          message: 'Invalid key ID'
        });
      }
      
      // Delete from database
      const result = await db
        .delete(routerProviderKeys)
        .where(
          and(
            eq(routerProviderKeys.id, keyId),
            eq(routerProviderKeys.user_id, request.userId!)
          )
        )
        .returning();
      
      if (result.length === 0) {
        return reply.code(404).send({
          error: 'Not found',
          message: 'Provider key not found'
        });
      }
      
      return {
        success: true,
        message: `${result[0].provider} API key deleted successfully`,
        keyId: result[0].id
      };
    } catch (error: any) {
      console.error('Failed to delete provider key:', error);
      return reply.code(500).send({
        error: 'Failed to delete provider key',
        message: error.message
      });
    }
  });
  
  /**
   * POST /router/provider-keys/:id/validate
   * Validate a provider API key by making a test request
   */
  fastify.post<{
    Params: { id: string }
  }>('/router/provider-keys/:id/validate', {
    preHandler: requireAuth
  }, async (request: AuthRequest, reply) => {
    try {
      const keyId = parseInt((request.params as { id: string }).id);
      
      if (isNaN(keyId)) {
        return reply.code(400).send({
          error: 'Invalid request',
          message: 'Invalid key ID'
        });
      }
      
      // Get the provider key
      const keys = await db
        .select()
        .from(routerProviderKeys)
        .where(
          and(
            eq(routerProviderKeys.id, keyId),
            eq(routerProviderKeys.user_id, request.userId!)
          )
        )
        .limit(1);
      
      if (keys.length === 0) {
        return reply.code(404).send({
          error: 'Not found',
          message: 'Provider key not found'
        });
      }
      
      const providerKey = keys[0];
      const decryptedKey = decryptProviderKey(providerKey.encrypted_key);
      
      // Test the key with the provider
      const { OpenAIAdapter, AnthropicAdapter, XAIAdapter, GoogleAdapter } = await import('../llm/adapters');
      
      let adapter;
      switch (providerKey.provider) {
        case 'openai':
          adapter = new OpenAIAdapter(decryptedKey);
          break;
        case 'anthropic':
          adapter = new AnthropicAdapter(decryptedKey);
          break;
        case 'xai':
          adapter = new XAIAdapter(decryptedKey);
          break;
        case 'google':
          adapter = new GoogleAdapter(decryptedKey);
          break;
        default:
          return reply.code(400).send({
            error: 'Invalid provider',
            message: `Unsupported provider: ${providerKey.provider}`
          });
      }
      
      // Make a simple test request
      try {
        const models = await adapter.listModels();
        
        // Update last_validated_at timestamp
        await db
          .update(routerProviderKeys)
          .set({ 
            last_validated_at: new Date().toISOString(),
            is_active: true
          })
          .where(eq(routerProviderKeys.id, keyId));
        
        return {
          success: true,
          valid: true,
          message: `${providerKey.provider} API key is valid`,
          modelsAvailable: models.length,
          models: models.slice(0, 5) // Return first 5 models
        };
      } catch (error: any) {
        // Mark as inactive if validation fails
        await db
          .update(routerProviderKeys)
          .set({ 
            is_active: false,
            last_validated_at: new Date().toISOString()
          })
          .where(eq(routerProviderKeys.id, keyId));
        
        return {
          success: false,
          valid: false,
          message: `${providerKey.provider} API key is invalid`,
          error: error.message
        };
      }
    } catch (error: any) {
      console.error('Failed to validate provider key:', error);
      return reply.code(500).send({
        error: 'Failed to validate provider key',
        message: error.message
      });
    }
  });
  
  // ==================== USER PREFERENCES ====================
  
  /**
   * GET /router/preferences
   * Get user's routing preferences
   */
  fastify.get('/router/preferences', {
    preHandler: requireAuth
  }, async (request: AuthRequest, reply) => {
    try {
      const prefs = await db
        .select()
        .from(routerPreferences)
        .where(eq(routerPreferences.user_id, request.userId!))
        .limit(1);
      
      if (prefs.length === 0) {
        // Return defaults
        return {
          routingStrategy: 'best_overall',
          fallbackEnabled: true,
          maxCostPer1kTokens: null,
          maxLatencyMs: null,
          requireToolCalling: false,
          requireStreaming: false,
          excludedProviders: [],
          excludedModels: []
        };
      }
      
      const pref = prefs[0];
      return {
        routingStrategy: pref.routing_strategy,
        fallbackEnabled: pref.fallback_enabled,
        maxCostPer1kTokens: pref.max_cost_per_1k_tokens,
        maxLatencyMs: pref.max_latency_ms,
        requireToolCalling: pref.require_tool_calling,
        requireStreaming: pref.require_streaming,
        excludedProviders: pref.excluded_providers ? JSON.parse(pref.excluded_providers) : [],
        excludedModels: pref.excluded_models ? JSON.parse(pref.excluded_models) : []
      };
    } catch (error: any) {
      console.error('Failed to get preferences:', error);
      return reply.code(500).send({
        error: 'Failed to get preferences',
        message: error.message
      });
    }
  });
  
  /**
   * PUT /router/preferences
   * Update user's routing preferences
   */
  fastify.put<{
    Body: {
      routingStrategy?: string;
      fallbackEnabled?: boolean;
      maxCostPer1kTokens?: number | null;
      maxLatencyMs?: number | null;
      requireToolCalling?: boolean;
      requireStreaming?: boolean;
      excludedProviders?: string[];
      excludedModels?: string[];
    }
  }>('/router/preferences', {
    preHandler: requireAuth
  }, async (request: AuthRequest, reply) => {
    try {
      const {
        routingStrategy,
        fallbackEnabled,
        maxCostPer1kTokens,
        maxLatencyMs,
        requireToolCalling,
        requireStreaming,
        excludedProviders,
        excludedModels
      } = request.body as {
        routingStrategy?: string;
        fallbackEnabled?: boolean;
        maxCostPer1kTokens?: number | null;
        maxLatencyMs?: number | null;
        requireToolCalling?: boolean;
        requireStreaming?: boolean;
        excludedProviders?: string[];
        excludedModels?: string[];
      };
      
      // Check if preferences exist
      const existing = await db
        .select()
        .from(routerPreferences)
        .where(eq(routerPreferences.user_id, request.userId!))
        .limit(1);
      
      const updates: any = {};
      if (routingStrategy !== undefined) updates.routing_strategy = routingStrategy;
      if (fallbackEnabled !== undefined) updates.fallback_enabled = fallbackEnabled;
      if (maxCostPer1kTokens !== undefined) updates.max_cost_per_1k_tokens = maxCostPer1kTokens;
      if (maxLatencyMs !== undefined) updates.max_latency_ms = maxLatencyMs;
      if (requireToolCalling !== undefined) updates.require_tool_calling = requireToolCalling;
      if (requireStreaming !== undefined) updates.require_streaming = requireStreaming;
      if (excludedProviders !== undefined) updates.excluded_providers = JSON.stringify(excludedProviders);
      if (excludedModels !== undefined) updates.excluded_models = JSON.stringify(excludedModels);
      
      if (existing.length > 0) {
        // Update existing
        await db
          .update(routerPreferences)
          .set(updates)
          .where(eq(routerPreferences.user_id, request.userId!));
      } else {
        // Create new
        await db.insert(routerPreferences).values({
          user_id: request.userId!,
          ...updates
        });
      }
      
      return {
        success: true,
        message: 'Preferences updated successfully'
      };
    } catch (error: any) {
      console.error('Failed to update preferences:', error);
      return reply.code(500).send({
        error: 'Failed to update preferences',
        message: error.message
      });
    }
  });
}
