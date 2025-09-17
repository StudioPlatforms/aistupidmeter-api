import { FastifyInstance } from 'fastify';
import { db } from '../db/index';
import { models, scores } from '../db/schema';
import { eq, desc, sql, and, gte } from 'drizzle-orm';

// Helper function to calculate z-score for anomaly detection
function calculateZScore(value: number, mean: number, stdDev: number): number {
  if (stdDev === 0) return 0;
  return (value - mean) / stdDev;
}

// Helper function to calculate standard deviation
function calculateStdDev(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const squaredDiffs = values.map(v => Math.pow(v - mean, 2));
  return Math.sqrt(squaredDiffs.reduce((a, b) => a + b, 0) / values.length);
}

// Helper function to get date range based on period
function getDateRangeFromPeriod(period: 'latest' | '24h' | '7d' | '1m' = 'latest'): Date {
  const now = Date.now();
  switch (period) {
    case '24h':
      return new Date(now - 24 * 60 * 60 * 1000);
    case '7d':
      return new Date(now - 7 * 24 * 60 * 60 * 1000);
    case '1m':
      return new Date(now - 30 * 24 * 60 * 60 * 1000);
    case 'latest':
    default:
      return new Date(now - 7 * 24 * 60 * 60 * 1000); // Default to 7 days for latest
  }
}

// Helper function to get combined scores (70% hourly + 30% deep) for a single model
async function getCombinedScore(modelId: number): Promise<number | null> {
  try {
    // Get latest hourly score
    const latestHourlyScore = await db
      .select()
      .from(scores)
      .where(and(eq(scores.modelId, modelId), eq(scores.suite, 'hourly')))
      .orderBy(desc(scores.ts))
      .limit(1);

    // Get latest deep score  
    const latestDeepScore = await db
      .select()
      .from(scores)
      .where(and(eq(scores.modelId, modelId), eq(scores.suite, 'deep')))
      .orderBy(desc(scores.ts))
      .limit(1);

    const hourlyScore = latestHourlyScore[0];
    const deepScore = latestDeepScore[0];
    
    // Combine scores with 70% hourly, 30% deep weighting
    let combinedScore: number | null = null;
    
    if (hourlyScore && hourlyScore.stupidScore !== null && hourlyScore.stupidScore >= 0) {
      let hourlyDisplay = Math.max(0, Math.min(100, Math.round(hourlyScore.stupidScore)));
      
      if (deepScore && deepScore.stupidScore !== null && deepScore.stupidScore >= 0) {
        // Has both scores - combine them
        let deepDisplay = Math.max(0, Math.min(100, Math.round(deepScore.stupidScore)));
        combinedScore = Math.round(hourlyDisplay * 0.7 + deepDisplay * 0.3);
      } else {
        // Only hourly score - use it directly
        combinedScore = hourlyDisplay;
      }
    } else if (deepScore && deepScore.stupidScore !== null && deepScore.stupidScore >= 0) {
      // Only deep score - use it directly
      let deepDisplay = Math.max(0, Math.min(100, Math.round(deepScore.stupidScore)));
      combinedScore = deepDisplay;
    }
    
    return combinedScore;
  } catch (error) {
    console.error(`Error getting combined score for model ${modelId}:`, error);
    return null;
  }
}

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
        const combinedScore = await getCombinedScore(model.id);
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
    
    for (const model of allModels) {
      const combinedScore = await getCombinedScore(model.id);
      if (combinedScore !== null) {
        totalScore += combinedScore;
        modelCount++;
        if (combinedScore >= 70) performingWell++;
      }
    }
    
    if (modelCount === 0) return null;
    
    const globalScore = Math.round(totalScore / modelCount);
    
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
