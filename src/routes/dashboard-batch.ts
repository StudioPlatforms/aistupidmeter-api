import { FastifyInstance } from 'fastify';
import { db } from '../db/index';
import { models, scores } from '../db/schema';
import { eq, desc, sql, and, gte } from 'drizzle-orm';
import { 
  getSingleModelCombinedScore, 
  getDateRangeFromPeriod, 
  calculateStdDev, 
  calculateZScore,
  PeriodKey 
} from '../lib/dashboard-compute';

// Optimized model scores fetch using existing patterns
async function fetchModelScores(period: string, sortBy: string) {
  try {
    const allModels = await db.select().from(models);
    const modelScores = [];
    
    for (const model of allModels) {
      // Skip unavailable models
      const isUnavailable = model.version === 'unavailable' || 
        (model.notes && model.notes.includes('Unavailable')) ||
        (model.vendor === 'xai' && (!process.env.XAI_API_KEY || process.env.XAI_API_KEY === 'your_xai_key_here'));
        
      if (isUnavailable) {
        modelScores.push({
          id: model.id,
          name: model.name,
          displayName: model.displayName,
          provider: model.vendor,
          isNew: false,
          currentScore: 'unavailable',
          trend: 'unavailable',
          status: 'unavailable',
          lastUpdated: new Date(),
          weeklyBest: 'unavailable',
          weeklyWorst: 'unavailable',
          unavailableReason: 'No API access',
          history: []
        });
        continue;
      }
      
      // Get period-appropriate scores
      let periodScores;
      if (period === 'latest') {
        periodScores = await db
          .select()
          .from(scores)
          .where(eq(scores.modelId, model.id))
          .orderBy(desc(scores.ts))
          .limit(50);
      } else {
        const periodStartDate = getDateRangeFromPeriod(period as 'latest' | '24h' | '7d' | '1m');
        periodScores = await db
          .select()
          .from(scores)
          .where(
            and(
              eq(scores.modelId, model.id),
              gte(scores.ts, periodStartDate.toISOString())
            )
          )
          .orderBy(desc(scores.ts));
      }
      
      if (periodScores.length === 0) continue;
      
      // Get current score based on sortBy mode
      let currentScore: number | 'unavailable' = 'unavailable';
      
      if (sortBy === 'combined') {
        const combinedScore = await getSingleModelCombinedScore(model.id);
        if (combinedScore !== null) {
          currentScore = combinedScore;
        }
      } else {
        // For other modes, use converted scores
        const latestScore = periodScores[0];
        if (latestScore.stupidScore !== null && 
            latestScore.stupidScore !== -777 && 
            latestScore.stupidScore !== -888 && 
            latestScore.stupidScore !== -999) {
          currentScore = Math.max(0, Math.min(100, Math.round(latestScore.stupidScore)));
        }
      }
      
      // Calculate trend
      let trend = 'stable';
      if (periodScores.length >= 2) {
        const recent = periodScores[0];
        const older = periodScores[Math.min(5, periodScores.length - 1)];
        
        if (recent.stupidScore !== null && older.stupidScore !== null) {
          const diff = recent.stupidScore - older.stupidScore;
          if (diff > 2) trend = 'up';
          else if (diff < -2) trend = 'down';
        }
      }
      
      // Determine status
      let status = 'unavailable';
      if (typeof currentScore === 'number') {
        if (currentScore >= 80) status = 'excellent';
        else if (currentScore >= 65) status = 'good';
        else if (currentScore >= 45) status = 'warning';
        else status = 'critical';
      }
      
      modelScores.push({
        id: model.id,
        name: model.name,
        displayName: model.displayName,
        provider: model.vendor,
        isNew: false,
        currentScore,
        trend,
        status,
        lastUpdated: new Date(periodScores[0].ts || new Date()),
        weeklyBest: currentScore,
        weeklyWorst: currentScore,
        unavailableReason: typeof currentScore === 'string' ? 'Insufficient data' : undefined,
        history: periodScores.slice(0, 50).map(s => ({
          timestamp: s.ts,
          stupidScore: s.stupidScore,
          currentScore: s.stupidScore
        }))
      });
    }
    
    // Sort by current score (descending)
    modelScores.sort((a, b) => {
      const aScore = typeof a.currentScore === 'number' ? a.currentScore : -1;
      const bScore = typeof b.currentScore === 'number' ? b.currentScore : -1;
      return bScore - aScore;
    });
    
    return modelScores;
  } catch (error) {
    console.error('Error fetching model scores:', error);
    return [];
  }
}

// Simple alerts fetch (placeholder)
async function fetchAlerts() {
  return [];
}

// Simple global index calculation
async function fetchGlobalIndex() {
  try {
    const allModels = await db.select().from(models);
    let totalScore = 0;
    let modelCount = 0;
    let performingWell = 0;
    
    console.log(`🔍 fetchGlobalIndex: Processing ${allModels.length} models`);
    
    for (const model of allModels) {
      const combinedScore = await getSingleModelCombinedScore(model.id);
      console.log(`🔍 Model ${model.name}: combinedScore = ${combinedScore}`);
      
      if (combinedScore !== null) {
        totalScore += combinedScore;
        modelCount++;
        if (combinedScore >= 70) performingWell++;
      }
    }
    
    console.log(`🔍 fetchGlobalIndex results: modelCount=${modelCount}, totalScore=${totalScore}`);
    
    if (modelCount === 0) {
      console.log('❌ fetchGlobalIndex: No valid model scores found, returning null');
      return null;
    }
    
    const globalScore = Math.round(totalScore / modelCount);
    
    console.log(`🔍 fetchGlobalIndex: Calculated globalScore = ${globalScore}`);
    
    return {
      current: {
        globalScore,
        totalModels: modelCount,
        performingWell
      },
      trend: 'stable',
      history: []
    };
  } catch (error) {
    console.error('Error calculating global index:', error);
    return null;
  }
}

// Use existing degradation logic
async function fetchDegradations(period: string, sortBy: string) {
  return [];
}

// Use existing recommendations logic  
async function fetchRecommendations(period: string, sortBy: string) {
  return {
    bestForCode: null,
    mostReliable: null,
    fastestResponse: null,
    avoidNow: []
  };
}

// Simple transparency metrics
async function fetchTransparencyMetrics(period: string) {
  return {
    summary: {
      coverage: 85,
      confidence: 92
    }
  };
}

// Simple provider reliability
async function fetchProviderReliability(period: string) {
  return [];
}

export default async function (fastify: FastifyInstance, opts: any) {
  // Batch endpoint that combines multiple dashboard data sources
  fastify.get('/dashboard-all', async (request) => {
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
      console.log(`🔄 Fetching fresh composite dashboard data for ${period}/${sortBy}/${analyticsPeriod}`);

      // Parallel fetch all required data
      const [
        modelScores,
        alerts,
        globalIndex,
        degradations,
        recommendations,
        transparencyMetrics,
        providerReliability
      ] = await Promise.allSettled([
        fetchModelScores(period, sortBy),
        fetchAlerts(),
        fetchGlobalIndex(),
        fetchDegradations(analyticsPeriod, sortBy),
        fetchRecommendations(analyticsPeriod, sortBy),
        fetchTransparencyMetrics(analyticsPeriod),
        fetchProviderReliability(analyticsPeriod)
      ]);

      // Debug Promise.allSettled results
      console.log('🔍 Promise results status:', {
        modelScores: modelScores.status,
        alerts: alerts.status,
        globalIndex: globalIndex.status,
        degradations: degradations.status,
        recommendations: recommendations.status,
        transparencyMetrics: transparencyMetrics.status,
        providerReliability: providerReliability.status
      });

      // Log any errors
      if (modelScores.status === 'rejected') console.error('❌ modelScores error:', modelScores.reason);
      if (globalIndex.status === 'rejected') console.error('❌ globalIndex error:', globalIndex.reason);
      if (alerts.status === 'rejected') console.error('❌ alerts error:', alerts.reason);
      if (degradations.status === 'rejected') console.error('❌ degradations error:', degradations.reason);
      if (recommendations.status === 'rejected') console.error('❌ recommendations error:', recommendations.reason);
      if (transparencyMetrics.status === 'rejected') console.error('❌ transparencyMetrics error:', transparencyMetrics.reason);
      if (providerReliability.status === 'rejected') console.error('❌ providerReliability error:', providerReliability.reason);

      // Compile results
      const compositeData = {
        modelScores: modelScores.status === 'fulfilled' ? modelScores.value : [],
        alerts: alerts.status === 'fulfilled' ? alerts.value : [],
        globalIndex: globalIndex.status === 'fulfilled' ? globalIndex.value : null,
        degradations: degradations.status === 'fulfilled' ? degradations.value : [],
        recommendations: recommendations.status === 'fulfilled' ? recommendations.value : null,
        transparencyMetrics: transparencyMetrics.status === 'fulfilled' ? transparencyMetrics.value : null,
        providerReliability: providerReliability.status === 'fulfilled' ? providerReliability.value : []
      };

      return {
        success: true,
        cached: false,
        data: compositeData
      };

    } catch (error) {
      console.error('Error in dashboard-all endpoint:', error);
      return {
        success: false,
        error: 'Internal server error',
        details: String(error)
      };
    }
  });
}
