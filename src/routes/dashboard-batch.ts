import { FastifyInstance } from 'fastify';
import { getModelHistory } from '../lib/model-scoring';

/**
 * PERFORMANCE OPTIMIZATION: Batch History API
 * Replaces N+1 individual history requests with a single batched endpoint
 * 
 * Impact: Reduces 16+ HTTP requests to 1 request
 * Expected: 50-70% reduction in load time
 */
export default async function (fastify: FastifyInstance) {
  
  /**
   * Batch endpoint for fetching multiple model histories at once
   * GET /api/dashboard/history/batch?modelIds=1,2,3,4&period=latest&sortBy=combined
   */
  fastify.get('/history/batch', async (request, reply) => {
    const startTime = Date.now();
    
    const { 
      modelIds, 
      period = 'latest', 
      sortBy = 'combined' 
    } = request.query as { 
      modelIds?: string;
      period?: 'latest' | '24h' | '7d' | '1m';
      sortBy?: 'combined' | 'reasoning' | 'speed' | '7axis' | 'tooling' | 'price';
    };
    
    // Validate modelIds parameter
    if (!modelIds || typeof modelIds !== 'string') {
      return reply.code(400).send({
        success: false,
        error: 'Missing or invalid modelIds parameter. Expected comma-separated list of model IDs.',
        example: '/api/dashboard/history/batch?modelIds=1,2,3&period=latest&sortBy=combined'
      });
    }
    
    try {
      // Parse model IDs
      const ids = modelIds.split(',')
        .map(id => parseInt(id.trim(), 10))
        .filter(id => !isNaN(id) && id > 0);
      
      if (ids.length === 0) {
        return reply.code(400).send({
          success: false,
          error: 'No valid model IDs provided',
          received: modelIds
        });
      }
      
      // Limit to prevent abuse
      if (ids.length > 100) {
        return reply.code(400).send({
          success: false,
          error: 'Too many model IDs requested. Maximum: 100',
          requested: ids.length
        });
      }
      
      console.log(`📦 Batch history request: ${ids.length} models (${period}/${sortBy})`);
      
      // PARALLEL fetch all histories
      const historyPromises = ids.map(async (id) => {
        try {
          const history = await getModelHistory(id, period, sortBy);
          return { id, history, success: true };
        } catch (error) {
          console.error(`❌ Failed to fetch history for model ${id}:`, error);
          return { id, history: [], success: false, error: String(error) };
        }
      });
      
      const results = await Promise.all(historyPromises);
      
      // Build response map: { "1": [...history], "2": [...history], ... }
      const historyMap: Record<string, any[]> = {};
      const errors: Record<string, string> = {};
      
      results.forEach(result => {
        if (result.success) {
          historyMap[result.id] = result.history;
        } else {
          historyMap[result.id] = [];
          errors[result.id] = result.error || 'Unknown error';
        }
      });
      
      const duration = Date.now() - startTime;
      const successCount = results.filter(r => r.success).length;
      const successRate = (successCount / results.length) * 100;
      
      console.log(`✅ Batch history complete: ${successCount}/${results.length} succeeded (${Math.round(successRate)}%) in ${duration}ms`);
      
      // Set cache headers for CDN/browser caching
      reply.header('Cache-Control', 'public, max-age=30, stale-while-revalidate=60');
      reply.header('X-Response-Time', `${duration}ms`);
      reply.header('X-Success-Rate', `${successRate.toFixed(1)}%`);
      
      return {
        success: true,
        data: historyMap,
        meta: {
          requestedModels: ids.length,
          successfulModels: successCount,
          failedModels: results.length - successCount,
          successRate: Math.round(successRate),
          period,
          sortBy,
          duration,
          errors: Object.keys(errors).length > 0 ? errors : undefined
        }
      };
      
    } catch (error) {
      console.error('❌ Batch history endpoint error:', error);
      return reply.code(500).send({
        success: false,
        error: 'Internal server error',
        details: String(error)
      });
    }
  });
  
  /**
   * Health check for batch endpoint
   */
  fastify.get('/history/batch/health', async () => {
    return {
      success: true,
      endpoint: '/api/dashboard/history/batch',
      status: 'operational',
      features: {
        batchFetching: true,
        parallelProcessing: true,
        errorRecovery: true,
        caching: true
      },
      limits: {
        maxModelsPerRequest: 100,
        cacheMaxAge: 30,
        staleWhileRevalidate: 60
      }
    };
  });
}
