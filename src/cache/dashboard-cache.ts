import fs from 'fs/promises';
import path from 'path';
import { db } from '../db/index';
import { models, scores } from '../db/schema';
import { eq, desc, sql, and, gte } from 'drizzle-orm';

// Cache storage - in-memory for speed with file backup for persistence
const memoryCache = new Map<string, any>();
const CACHE_DIR = '/tmp/stupidmeter-cache';

// Ensure cache directory exists
async function ensureCacheDir() {
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true });
  } catch (error) {
    console.error('Failed to create cache directory:', error);
  }
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
      return new Date(now - 7 * 24 * 60 * 60 * 1000);
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

// Get score for specific sortBy mode
async function getScoreForMode(modelId: number, sortBy: string): Promise<number | null> {
  if (sortBy === 'combined') {
    return await getCombinedScore(modelId);
  } else if (sortBy === 'reasoning') {
    // Use only deep reasoning scores
    const latestDeepScore = await db
      .select()
      .from(scores)
      .where(and(eq(scores.modelId, modelId), eq(scores.suite, 'deep')))
      .orderBy(desc(scores.ts))
      .limit(1);
      
    if (latestDeepScore[0] && latestDeepScore[0].stupidScore !== null && latestDeepScore[0].stupidScore >= 0) {
      return Math.max(0, Math.min(100, Math.round(latestDeepScore[0].stupidScore)));
    }
  } else if (sortBy === 'speed') {
    // Use only hourly (speed) scores
    const latestHourlyScore = await db
      .select()
      .from(scores)
      .where(and(eq(scores.modelId, modelId), eq(scores.suite, 'hourly')))
      .orderBy(desc(scores.ts))
      .limit(1);
      
    if (latestHourlyScore[0] && latestHourlyScore[0].stupidScore !== null && latestHourlyScore[0].stupidScore >= 0) {
      return Math.max(0, Math.min(100, Math.round(latestHourlyScore[0].stupidScore)));
    }
  } else if (sortBy === 'price') {
    // For price mode, use combined score (value calculation is done on frontend)
    return await getCombinedScore(modelId);
  }
  
  return null;
}

// Compute model scores for a specific period and sortBy combination
async function computeModelScores(period: string, sortBy: string) {
  try {
    console.log(`🔄 Computing model scores for ${period}/${sortBy}...`);
    // Only get models marked for live rankings (same as original API)
    const allModels = await db.select().from(models).where(sql`show_in_rankings = 1`);
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
      const currentScore = await getScoreForMode(model.id, sortBy);
      
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
        currentScore: currentScore ?? 'unavailable',
        trend,
        status,
        lastUpdated: new Date(periodScores[0].ts || new Date()),
        weeklyBest: currentScore ?? 'unavailable',
        weeklyWorst: currentScore ?? 'unavailable',
        unavailableReason: currentScore === null ? 'Insufficient data' : undefined,
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
    
    console.log(`✅ Computed ${modelScores.length} model scores for ${period}/${sortBy}`);
    return modelScores;
  } catch (error) {
    console.error(`Error computing model scores for ${period}/${sortBy}:`, error);
    return [];
  }
}

// Compute analytics data
async function computeAnalyticsData(analyticsPeriod: string, sortBy: string) {
  console.log(`🔄 Computing analytics data for ${analyticsPeriod}/${sortBy}...`);
  
  // For now, return simplified analytics data
  // In a full implementation, you'd compute degradations, recommendations, etc.
  return {
    degradations: [],
    recommendations: {
      bestForCode: null,
      mostReliable: null,
      fastestResponse: null,
      avoidNow: []
    },
    transparencyMetrics: {
      summary: {
        coverage: 85,
        confidence: 92
      }
    },
    providerReliability: []
  };
}

// Compute global index
async function computeGlobalIndex() {
  try {
    console.log(`🔄 Computing global index...`);
    // Only get models marked for live rankings (same as original API)
    const allModels = await db.select().from(models).where(sql`show_in_rankings = 1`);
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
    
    console.log(`✅ Computed global index: ${globalScore} (${performingWell}/${modelCount} performing well)`);
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
    console.error('Error computing global index:', error);
    return null;
  }
}

// Generate cache key
function getCacheKey(period: string, sortBy: string, analyticsPeriod?: string): string {
  return analyticsPeriod ? `${period}-${sortBy}-${analyticsPeriod}` : `${period}-${sortBy}`;
}

// Save cache to file
async function saveCacheToFile(key: string, data: any) {
  try {
    await ensureCacheDir();
    const filePath = path.join(CACHE_DIR, `${key}.json`);
    await fs.writeFile(filePath, JSON.stringify({
      data,
      timestamp: Date.now(),
      key
    }, null, 2));
  } catch (error) {
    console.error(`Error saving cache file ${key}:`, error);
  }
}

// Load cache from file
async function loadCacheFromFile(key: string): Promise<any> {
  try {
    const filePath = path.join(CACHE_DIR, `${key}.json`);
    const fileContent = await fs.readFile(filePath, 'utf-8');
    const cached = JSON.parse(fileContent);
    return cached.data;
  } catch (error) {
    // File doesn't exist or is corrupted, return null
    return null;
  }
}

// Refresh all cache combinations
export async function refreshAllCache() {
  console.log('🔄 Starting full cache refresh...');
  const startTime = Date.now();
  
  const periods = ['latest', '24h', '7d', '1m'];
  const sortBys = ['combined', 'reasoning', 'speed', 'price'];
  const analyticsPeriods = ['latest', '24h', '7d', '1m'];
  
  let refreshed = 0;
  let errors = 0;
  
  // Compute global index once (shared across all combinations)
  const globalIndex = await computeGlobalIndex();
  
  // Refresh all combinations in parallel batches to avoid overwhelming the database
  const batchSize = 4;
  const allCombinations = [];
  
  // Generate all combinations
  for (const period of periods) {
    for (const sortBy of sortBys) {
      for (const analyticsPeriod of analyticsPeriods) {
        allCombinations.push({ period, sortBy, analyticsPeriod });
      }
    }
  }
  
  // Process in batches
  for (let i = 0; i < allCombinations.length; i += batchSize) {
    const batch = allCombinations.slice(i, i + batchSize);
    
    await Promise.all(batch.map(async ({ period, sortBy, analyticsPeriod }) => {
      try {
        console.log(`🔄 Refreshing cache for ${period}/${sortBy}/${analyticsPeriod}...`);
        
        // Compute all required data
        const [modelScores, analyticsData] = await Promise.all([
          computeModelScores(period, sortBy),
          computeAnalyticsData(analyticsPeriod, sortBy)
        ]);
        
        // Combine into final cache data
        const cacheData = {
          modelScores,
          alerts: [], // Simplified for now
          globalIndex,
          ...analyticsData,
          meta: {
            period,
            sortBy,
            analyticsPeriod,
            cachedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() // 1 hour TTL
          }
        };
        
        // Store in memory and file
        const cacheKey = getCacheKey(period, sortBy, analyticsPeriod);
        memoryCache.set(cacheKey, cacheData);
        await saveCacheToFile(cacheKey, cacheData);
        
        refreshed++;
        console.log(`✅ Cached ${cacheKey} (${modelScores.length} models)`);
      } catch (error) {
        console.error(`❌ Failed to refresh cache for ${period}/${sortBy}/${analyticsPeriod}:`, error);
        errors++;
      }
    }));
  }
  
  const duration = Date.now() - startTime;
  console.log(`✅ Cache refresh completed: ${refreshed} refreshed, ${errors} errors, ${duration}ms`);
  
  return { refreshed, errors, duration };
}

// Get cached data
export async function getCachedData(period: string, sortBy: string, analyticsPeriod: string): Promise<any> {
  const cacheKey = getCacheKey(period, sortBy, analyticsPeriod);
  
  // Try memory first
  let cachedData = memoryCache.get(cacheKey);
  
  if (!cachedData) {
    // Try file cache
    cachedData = await loadCacheFromFile(cacheKey);
    if (cachedData) {
      // Load back into memory
      memoryCache.set(cacheKey, cachedData);
      console.log(`📥 Loaded cache from file: ${cacheKey}`);
    }
  }
  
  if (cachedData) {
    console.log(`⚡ Serving cached data: ${cacheKey}`);
    return {
      success: true,
      cached: true,
      data: cachedData,
      meta: cachedData.meta
    };
  }
  
  console.log(`❌ Cache miss: ${cacheKey}`);
  return null;
}

// Initialize cache on startup
export async function initializeCache() {
  console.log('🚀 Initializing dashboard cache system...');
  await ensureCacheDir();
  
  // Try to load existing cache files into memory
  const periods = ['latest', '24h', '7d', '1m'];
  const sortBys = ['combined', 'reasoning', 'speed', 'price'];
  const analyticsPeriods = ['latest', '24h', '7d', '1m'];
  
  let loaded = 0;
  
  for (const period of periods) {
    for (const sortBy of sortBys) {
      for (const analyticsPeriod of analyticsPeriods) {
        const cacheKey = getCacheKey(period, sortBy, analyticsPeriod);
        const cachedData = await loadCacheFromFile(cacheKey);
        if (cachedData) {
          memoryCache.set(cacheKey, cachedData);
          loaded++;
        }
      }
    }
  }
  
  console.log(`📥 Loaded ${loaded} cache entries from disk`);
  
  // If no cache exists, do initial refresh
  if (loaded === 0) {
    console.log('🔄 No existing cache found, performing initial refresh...');
    await refreshAllCache();
  }
  
  console.log('✅ Dashboard cache system initialized');
}

// Get cache statistics
export function getCacheStats() {
  const stats = {
    memoryEntries: memoryCache.size,
    memoryKeys: Array.from(memoryCache.keys()),
    cacheDir: CACHE_DIR
  };
  
  return stats;
}
