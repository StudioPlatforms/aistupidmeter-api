import { FastifyInstance } from 'fastify';
import { getCachedData, getCacheStats, refreshAllCache } from '../cache/dashboard-cache';

export default async function (fastify: FastifyInstance, opts: any) {
  // Main cached dashboard endpoint - serves all data instantly
  fastify.get('/cached', async (request) => {
    const { 
      period = 'latest', 
      sortBy = 'combined', 
      analyticsPeriod = 'latest' 
    } = request.query as { 
      period?: 'latest' | '24h' | '7d' | '1m';
      sortBy?: 'combined' | 'reasoning' | 'speed' | 'price';
      analyticsPeriod?: 'latest' | '24h' | '7d' | '1m';
    };

    try {
      console.log(`⚡ Cached dashboard request: ${period}/${sortBy}/${analyticsPeriod}`);

      // Get cached data instantly
      const cachedResult = await getCachedData(period, sortBy, analyticsPeriod);
      
      if (cachedResult) {
        return cachedResult;
      }
      
      // Cache miss - return error instead of computing on-demand
      return {
        success: false,
        cached: false,
        error: 'Cache miss - data not available',
        message: 'Requested data combination is not cached. Please try again in a few minutes.',
        details: {
          period,
          sortBy,
          analyticsPeriod,
          requestedAt: new Date().toISOString()
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
      
      if (cachedResult && cachedResult.data && cachedResult.data.modelScores) {
        return {
          success: true,
          cached: true,
          data: cachedResult.data.modelScores,
          meta: cachedResult.meta
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

  // Force cache refresh endpoint
  fastify.post('/refresh-cache', async (request) => {
    try {
      console.log('🔄 Manual cache refresh triggered');
      const result = await refreshAllCache();
      
      return {
        success: true,
        message: 'Cache refreshed successfully',
        ...result,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      console.error('Error refreshing cache:', error);
      return {
        success: false,
        error: 'Failed to refresh cache',
        details: String(error)
      };
    }
  });
}
