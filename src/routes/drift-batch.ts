/**
 * PRODUCTION-READY: Batch Drift Detection Endpoint
 * Efficiently fetches multiple drift signatures in a single request
 * with intelligent fallback and error handling
 */

import { FastifyInstance } from 'fastify';
import { computeDriftSignature } from '../lib/drift-detection';
import { cache } from '../cache/redis-cache';
import { db } from '../db';
import { models } from '../db/schema';
import { sql } from 'drizzle-orm';

export default async function (fastify: FastifyInstance) {
  
  /**
   * GET /api/drift/batch
   * Fetch drift signatures for all models efficiently
   * Returns: { success, data: DriftSignature[], errors, cached, partial }
   */
  fastify.get('/batch', async (request, reply) => {
    try {
      // Get all active models
      const allModels = await db
        .select()
        .from(models)
        .where(sql`show_in_rankings = 1`);
      
      const results: any[] = [];
      const errors: any[] = [];
      let cachedCount = 0;
      let computedCount = 0;
      let errorCount = 0;
      
      // Fetch all signatures in parallel with intelligent fallback
      const promises = allModels.map(async (model) => {
        try {
          // Try cache first
          const cacheKey = `drift:signature:${model.id}`;
          const cached = await cache.get(cacheKey);
          
          if (cached) {
            cachedCount++;
            return { 
              modelId: model.id, 
              modelName: model.name,
              data: JSON.parse(cached),
              source: 'cache'
            };
          }
          
          // Cache miss - compute with timeout protection
          const computePromise = computeDriftSignature(model.id);
          const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Timeout')), 5000)
          );
          
          const signature = await Promise.race([computePromise, timeoutPromise]) as any;
          
          // Cache the result with staggered TTL
          const ttl = 3600 + (model.id % 300);
          await cache.set(cacheKey, JSON.stringify(signature), ttl);
          
          computedCount++;
          return {
            modelId: model.id,
            modelName: model.name,
            data: signature,
            source: 'computed'
          };
          
        } catch (error) {
          errorCount++;
          errors.push({
            modelId: model.id,
            modelName: model.name,
            error: error instanceof Error ? error.message : 'Unknown error'
          });
          
          // Return fallback data
          return {
            modelId: model.id,
            modelName: model.name,
            data: {
              modelId: model.id,
              modelName: model.name,
              timestamp: new Date(),
              regime: 'UNKNOWN',
              driftStatus: 'UNKNOWN',
              currentScore: 0,
              baselineScore: 0,
              variance24h: 0,
              confidenceInterval: [0, 0],
              pageHinkleyCUSUM: 0,
              axes: {},
              error: 'Failed to compute signature'
            },
            source: 'fallback'
          };
        }
      });
      
      // Wait for all to complete
      const settled = await Promise.allSettled(promises);
      
      // Extract successful results
      settled.forEach((result) => {
        if (result.status === 'fulfilled' && result.value) {
          results.push(result.value);
        }
      });
      
      // Sort by model name for consistent ordering
      results.sort((a, b) => a.modelName.localeCompare(b.modelName));
      
      // Set cache status header
      if (cachedCount === allModels.length) {
        reply.header('X-Cache', 'HIT');
      } else if (cachedCount > 0) {
        reply.header('X-Cache', 'PARTIAL');
      } else {
        reply.header('X-Cache', 'MISS');
      }
      
      return {
        success: true,
        data: results,
        meta: {
          total: allModels.length,
          cached: cachedCount,
          computed: computedCount,
          errors: errorCount,
          partial: errorCount > 0,
          timestamp: new Date().toISOString()
        },
        errors: errors.length > 0 ? errors : undefined
      };
      
    } catch (error) {
      console.error('Batch drift fetch error:', error);
      return reply.code(500).send({
        success: false,
        error: 'Failed to fetch drift data',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });
  
  /**
   * POST /api/drift/precompute
   * Pre-compute drift signatures for all models (internal use)
   * Should be called hourly by scheduler
   */
  fastify.post('/precompute', async (request, reply) => {
    try {
      // Get all active models
      const allModels = await db
        .select()
        .from(models)
        .where(sql`show_in_rankings = 1`);
      
      let successCount = 0;
      let errorCount = 0;
      const errors: string[] = [];
      
      // Process models sequentially to avoid overload
      for (const model of allModels) {
        try {
          const signature = await computeDriftSignature(model.id);
          
          // Cache with staggered TTL
          const cacheKey = `drift:signature:${model.id}`;
          const ttl = 3600 + (model.id % 300);
          await cache.set(cacheKey, JSON.stringify(signature), ttl);
          
          successCount++;
          
          // Small delay to prevent CPU spike
          await new Promise(resolve => setTimeout(resolve, 100));
          
        } catch (error) {
          errorCount++;
          const errorMsg = `Model ${model.id} (${model.name}): ${error instanceof Error ? error.message : 'Unknown'}`;
          errors.push(errorMsg);
          console.error(`Precompute error for ${model.name}:`, error);
        }
      }
      
      // Store last run timestamp
      await cache.set('drift:last_precompute', new Date().toISOString(), 86400);
      
      return {
        success: true,
        message: 'Pre-computation completed',
        stats: {
          total: allModels.length,
          successful: successCount,
          failed: errorCount,
          timestamp: new Date().toISOString()
        },
        errors: errors.length > 0 ? errors : undefined
      };
      
    } catch (error) {
      console.error('Pre-computation error:', error);
      return reply.code(500).send({
        success: false,
        error: 'Pre-computation failed',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });
}
