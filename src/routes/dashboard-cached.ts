import { FastifyInstance } from 'fastify';
import { getCachedData, getCacheStats, purgeAllCache } from '../cache/dashboard-cache';

export default async function (fastify: FastifyInstance, opts: any) {
  // Main cached dashboard endpoint - serves all data instantly
  fastify.get('/cached', async (request, reply) => {
    const { 
      period = 'latest', 
      sortBy = 'combined', 
      analyticsPeriod = 'latest' 
    } = request.query as { 
      period?: 'latest' | '24h' | '7d' | '1m';
      sortBy?: 'combined' | 'reasoning' | 'speed' | 'price' | '7axis';
      analyticsPeriod?: 'latest' | '24h' | '7d' | '1m';
    };

    try {
      const result = await getCachedData(period, sortBy, analyticsPeriod);
      
      // allow short CDN cache if you want; otherwise keep private
      reply.header('Cache-Control', 'public, max-age=60, stale-while-revalidate=120');
      
      return {
        success: true,
        cached: result.cached,
        data: {
          modelScores: result.data
        },
        meta: {
          period,
          sortBy,
          analyticsPeriod,
          cachedAt: new Date().toISOString(),
          cached: result.cached
        }
      };

    } catch (error) {
      console.error('Error in cached dashboard endpoint:', error);
      return {
        success: false,
        cached: false,
        error: 'Internal server error',
        details: String(error)
      };
    }
  });

  // Cached model scores only (for backward compatibility)
  fastify.get('/scores-cached', async (request) => {
    const { 
      period = 'latest', 
      sortBy = 'combined'
    } = request.query as { 
      period?: 'latest' | '24h' | '7d' | '1m';
      sortBy?: 'combined' | 'reasoning' | 'speed' | 'price';
    };

    try {
      console.log(`⚡ Cached scores request: ${period}/${sortBy}`);

      // Use latest analytics period for scores-only request
      const cachedResult = await getCachedData(period, sortBy, 'latest');
      
      if (cachedResult && cachedResult.data) {
        return {
          success: true,
          cached: true,
          data: Array.isArray(cachedResult.data) ? cachedResult.data : cachedResult.data.modelScores || cachedResult.data
        };
      }
      
      return {
        success: false,
        cached: false,
        error: 'Cache miss - scores not available',
        message: 'Requested scores are not cached. Please try again in a few minutes.'
      };

    } catch (error) {
      console.error('Error in cached scores endpoint:', error);
      return {
        success: false,
        cached: false,
        error: 'Internal server error',
        details: String(error)
      };
    }
  });

  // Cache statistics endpoint
  fastify.get('/cache-stats', async (request) => {
    try {
      const stats = getCacheStats();
      
      return {
        success: true,
        stats: {
          ...stats,
          timestamp: new Date().toISOString()
        }
      };
    } catch (error) {
      console.error('Error getting cache stats:', error);
      return {
        success: false,
        error: 'Failed to get cache statistics',
        details: String(error)
      };
    }
  });

  // Health check for cache system
  fastify.get('/cache-health', async (request) => {
    try {
      const stats = getCacheStats();
      const hasCache = stats.memoryEntries > 0;
      
      return {
        success: true,
        healthy: hasCache,
        cacheEntries: stats.memoryEntries,
        status: hasCache ? 'Cache active with data' : 'Cache empty - warming up',
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      console.error('Error checking cache health:', error);
      return {
        success: false,
        healthy: false,
        error: 'Cache health check failed',
        details: String(error)
      };
    }
  });

  // Admin: clear and prewarm
  fastify.post('/cache/purge', async () => { 
    await purgeAllCache(); 
    return { ok: true }; 
  });

  fastify.post('/cache/prewarm', async () => {
    const periods = ['latest','24h','7d','1m'];
    const sorts   = ['combined','reasoning','speed','7axis','price'];
    await Promise.all(periods.flatMap(p => sorts.map(s => getCachedData(p, s, 'latest'))));
    return { ok: true };
  });
}
