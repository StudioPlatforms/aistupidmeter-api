import { FastifyInstance } from 'fastify';
import { getCachedData, getCacheStats, purgeAllCache } from '../cache/dashboard-cache';
import { computeModelScores } from '../lib/model-scoring';

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
      
      // CRITICAL FIX: Use Fastify's inject() to call analytics routes internally
      // This bypasses rate limiting since it's an internal call
      console.log('🔄 Fetching real-time analytics data for Intelligence Center...');
      
      let analyticsData = {
        degradations: [],
        recommendations: null,
        transparencyMetrics: null,
        providerReliability: [],
        driftIncidents: []
      };
      
      try {
        // Use Fastify's inject() to make internal requests (bypasses rate limiting)
        const [degradationsRes, recommendationsRes, reliabilityRes, transparencyRes, incidentsRes] = await Promise.all([
          fastify.inject({ method: 'GET', url: `/analytics/degradations?period=${analyticsPeriod}&sortBy=${sortBy}` }),
          fastify.inject({ method: 'GET', url: `/analytics/recommendations?period=${analyticsPeriod}&sortBy=${sortBy}` }),
          fastify.inject({ method: 'GET', url: `/analytics/provider-reliability?period=${analyticsPeriod}&sortBy=${sortBy}` }),
          fastify.inject({ method: 'GET', url: `/analytics/transparency?period=${analyticsPeriod}` }),
          fastify.inject({ method: 'GET', url: `/dashboard/incidents?period=7d&limit=50` })
        ]);
        
        // Parse responses
        const degradationsData = JSON.parse(degradationsRes.payload);
        const recommendationsData = JSON.parse(recommendationsRes.payload);
        const reliabilityData = JSON.parse(reliabilityRes.payload);
        const transparencyData = JSON.parse(transparencyRes.payload);
        const incidentsData = JSON.parse(incidentsRes.payload);
        
        // Extract successful data
        if (degradationsData?.success && degradationsData.data) {
          analyticsData.degradations = degradationsData.data;
        }
        if (recommendationsData?.success && recommendationsData.data) {
          analyticsData.recommendations = recommendationsData.data;
        }
        if (reliabilityData?.success && reliabilityData.data) {
          analyticsData.providerReliability = reliabilityData.data;
        }
        if (transparencyData?.success && transparencyData.data) {
          analyticsData.transparencyMetrics = transparencyData.data;
        }
        if (incidentsData?.success && incidentsData.data) {
          analyticsData.driftIncidents = incidentsData.data;
        }
        
        console.log(`✅ Analytics data fetched: ${analyticsData.degradations.length} degradations, ${analyticsData.providerReliability.length} providers`);
        
      } catch (analyticsError) {
        console.error('⚠️ Failed to fetch analytics data:', analyticsError);
        // Continue with empty analytics data rather than failing the whole request
      }
      
      // allow short CDN cache if you want; otherwise keep private
      reply.header('Cache-Control', 'public, max-age=60, stale-while-revalidate=120');
      
      // CRITICAL FIX: Ensure metadata accurately reflects the sortBy used for computation
      // The frontend expects the ACTUAL sortBy used, not the requested one
      const actualSortBy = sortBy; // This is what was passed to getCachedData and computeDashboardScores
      
      return {
        success: true,
        cached: result.cached,
        data: {
          // CRITICAL FIX: Extract modelScores array from nested structure
          // result.data contains { modelScores: [...], meta: {...} }
          // We need to pass the array directly, not the wrapper object
          modelScores: result.data.modelScores || result.data,
          alerts: [], // TODO: Add alerts if needed
          globalIndex: null, // TODO: Add global index if needed
          degradations: analyticsData.degradations,
          recommendations: analyticsData.recommendations,
          transparencyMetrics: analyticsData.transparencyMetrics,
          providerReliability: analyticsData.providerReliability,
          driftIncidents: analyticsData.driftIncidents || []
        },
        meta: {
          period,
          sortBy: actualSortBy, // Return the actual sortBy used for computation
          analyticsPeriod,
          cachedAt: new Date().toISOString(),
          cached: result.cached,
          analyticsRealTime: true
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
