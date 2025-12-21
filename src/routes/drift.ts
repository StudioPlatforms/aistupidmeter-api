/**
 * PHASE 2: Drift Detection API Endpoints
 * Provides access to drift signatures and change-point history
 */

import { FastifyInstance } from 'fastify';
import { computeDriftSignature, getChangePointHistory } from '../lib/drift-detection';
import { cache } from '../cache/redis-cache';

export default async function (fastify: FastifyInstance) {
  
  /**
   * GET /api/drift/signature/:modelId
   * Get current drift signature for a specific model
   * Returns: DriftSignature object with regime, status, axes, etc.
   * CACHED: 1 hour TTL with staggered expiry
   */
  fastify.get('/signature/:modelId', async (request, reply) => {
    const { modelId } = request.params as { modelId: string };
    const modelIdNum = parseInt(modelId);
    
    if (isNaN(modelIdNum)) {
      return reply.code(400).send({
        success: false,
        error: 'Invalid model ID'
      });
    }
    
    try {
      // Check cache first
      const cacheKey = `drift:signature:${modelIdNum}`;
      const cached = await cache.get(cacheKey);
      
      if (cached) {
        const data = JSON.parse(cached);
        reply.header('X-Cache', 'HIT');
        return { success: true, data, cached: true };
      }
      
      // Cache miss - compute signature
      reply.header('X-Cache', 'MISS');
      const signature = await computeDriftSignature(modelIdNum);
      
      // Cache with staggered TTL to prevent stampede
      // Base 1 hour + 0-5 minutes based on model ID
      const ttl = 3600 + (modelIdNum % 300);
      await cache.set(cacheKey, JSON.stringify(signature), ttl);
      
      return { success: true, data: signature, cached: false };
    } catch (error) {
      console.error(`Failed to compute drift signature for model ${modelId}:`, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  });
  
  /**
   * GET /api/drift/change-points/:modelId
   * Get change-point history for a specific model
   * Query params: limit (default: 10)
   * Returns: Array of ChangePoint objects
   */
  fastify.get('/change-points/:modelId', async (request, reply) => {
    const { modelId } = request.params as { modelId: string };
    const { limit = '10' } = request.query as { limit?: string };
    
    try {
      const changePoints = await getChangePointHistory(
        parseInt(modelId), 
        parseInt(limit)
      );
      
      return { success: true, data: changePoints };
    } catch (error) {
      console.error(`Failed to get change-points for model ${modelId}:`, error);
      return { 
        success: false, 
        error: error instanceof Error ? error.message : String(error)
      };
    }
  });
  
  /**
   * GET /api/drift/status
   * Get overall drift status across all models
   * Returns: Summary of models by drift status
   * CACHED: 5 minutes TTL
   */
  fastify.get('/status', async (request, reply) => {
    try {
      // Check cache first
      const cacheKey = 'drift:status:all';
      const cached = await cache.get(cacheKey);
      
      if (cached) {
        const data = JSON.parse(cached);
        reply.header('X-Cache', 'HIT');
        return { success: true, data, cached: true };
      }
      
      reply.header('X-Cache', 'MISS');
      
      const { db } = await import('../db');
      const { models } = await import('../db/schema');
      const { sql } = await import('drizzle-orm');
      
      const allModels = await db.select().from(models).where(sql`show_in_rankings = 1`);
      
      const statusSummary = {
        total: 0,
        stable: 0,
        volatile: 0,
        degraded: 0,
        recovering: 0,
        alerts: [],
        warnings: []
      };
      
      // Fetch all signatures from cache in parallel
      const signatures = await Promise.all(
        allModels.map(async (model) => {
          try {
            const cacheKey = `drift:signature:${model.id}`;
            const cached = await cache.get(cacheKey);
            if (cached) {
              return { model, signature: JSON.parse(cached) };
            }
            // If not cached, compute it
            const signature = await computeDriftSignature(model.id);
            const ttl = 3600 + (model.id % 300);
            await cache.set(cacheKey, JSON.stringify(signature), ttl);
            return { model, signature };
          } catch (error) {
            console.error(`Failed to get drift signature for ${model.name}:`, error);
            return null;
          }
        })
      );
      
      // Process signatures
      for (const item of signatures) {
        if (!item) continue;
        const { model, signature } = item;
        
        statusSummary.total++;
        
        // Count by regime
        if (signature.regime === 'STABLE') statusSummary.stable++;
        else if (signature.regime === 'VOLATILE') statusSummary.volatile++;
        else if (signature.regime === 'DEGRADED') statusSummary.degraded++;
        else if (signature.regime === 'RECOVERING') statusSummary.recovering++;
        
        // Collect alerts and warnings
        if (signature.driftStatus === 'ALERT') {
          (statusSummary.alerts as any[]).push({
            modelId: model.id,
            modelName: model.name,
            issue: signature.primaryIssue,
            recommendation: signature.recommendation
          });
        } else if (signature.driftStatus === 'WARNING') {
          (statusSummary.warnings as any[]).push({
            modelId: model.id,
            modelName: model.name,
            issue: signature.primaryIssue
          });
        }
      }
      
      // Cache for 5 minutes
      await cache.set(cacheKey, JSON.stringify(statusSummary), 300);
      
      return { success: true, data: statusSummary, cached: false };
    } catch (error) {
      console.error('Failed to get drift status:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  });
  
  /**
   * GET /api/drift/health
   * Health check for drift detection system
   * Returns: System health and cache status
   */
  fastify.get('/health', async (request, reply) => {
    try {
      // Check if cache is populated with sample keys
      const sampleKeys = ['drift:signature:42', 'drift:signature:44', 'drift:signature:45'];
      const cacheChecks = await Promise.all(
        sampleKeys.map(async (key) => {
          const cached = await cache.get(key);
          return cached !== null;
        })
      );
      
      const cachedCount = cacheChecks.filter(Boolean).length;
      const isHealthy = cachedCount >= 1;
      
      return {
        success: true,
        status: isHealthy ? 'healthy' : 'warming_up',
        message: isHealthy
          ? 'Drift detection system operational'
          : 'Cache warming up, may experience slower responses',
        details: {
          cachedSamples: `${cachedCount}/${sampleKeys.length}`,
          recommendation: !isHealthy ? 'Wait 1-2 minutes for background pre-computation' : null
        }
      };
    } catch (error) {
      return reply.code(503).send({
        success: false,
        status: 'unhealthy',
        error: String(error)
      });
    }
  });
  
  /**
   * GET /api/drift/metrics
   * Performance metrics for drift system
   * Returns: Cache statistics and performance data
   */
  fastify.get('/metrics', async (request, reply) => {
    try {
      const cacheStats = await cache.getStats();
      
      // Count cached signatures by checking samples
      const { db } = await import('../db');
      const { models } = await import('../db/schema');
      const { sql } = await import('drizzle-orm');
      
      const allModels = await db.select().from(models).where(sql`show_in_rankings = 1`);
      
      let cachedCount = 0;
      for (const model of allModels) {
        const cached = await cache.get(`drift:signature:${model.id}`);
        if (cached) cachedCount++;
      }
      
      // Get last computation time from cache
      const lastRun = await cache.get('drift:last_precompute');
      
      return {
        success: true,
        data: {
          cachedSignatures: `${cachedCount}/${allModels.length}`,
          cachePercentage: Math.round((cachedCount / allModels.length) * 100) + '%',
          lastPrecomputation: lastRun || 'Not yet run',
          nextScheduled: 'Every hour at :05 past the hour',
          cacheStats
        }
      };
    } catch (error) {
      return {
        success: false,
        error: String(error)
      };
    }
  });
}
