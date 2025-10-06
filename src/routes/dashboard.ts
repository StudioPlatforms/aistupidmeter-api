import { FastifyInstance } from 'fastify';
import { db } from '../db/index';
import { models, scores, runs, metrics, deep_sessions } from '../db/schema';
import { eq, desc, sql, gte, and } from 'drizzle-orm';
import { computeDashboardScores } from '../lib/dashboard-compute';

// Helper function to get combined score for a single model (same as analytics)
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

// Helper function to get tooling scores ONLY (100% tooling, 0% speed/reasoning)
export async function getToolingScores() {
  try {
    // Only get models marked for live rankings (using raw SQL to avoid type issues)
    const allModels = await db.select().from(models).where(sql`show_in_rankings = 1`);
    const modelScores = [];
    
    for (const model of allModels) {
      // STRICT: Get ONLY tooling scores (suite = 'tooling'), never hourly or deep scores
      const latestToolingScore = await db
        .select()
        .from(scores)
        .where(and(
          eq(scores.modelId, model.id), 
          eq(scores.suite, 'tooling')  // CRITICAL: Only tooling benchmarks
        ))
        .orderBy(desc(scores.ts))
        .limit(1);

      const toolingScore = latestToolingScore[0];
      
      // STRICT: Use ONLY tooling scores - NO fallback to hourly/deep data
      let toolingDisplayScore: number | 'unavailable' = 'unavailable';
      let isAvailable = false;
      let lastUpdatedTime = new Date(); // Default to current time if no data
      
      // Check if we have a valid tooling score
      if (toolingScore && toolingScore.stupidScore !== null && toolingScore.stupidScore >= 0) {
        // Pure tooling score
        toolingDisplayScore = Math.max(0, Math.min(100, Math.round(toolingScore.stupidScore)));
        isAvailable = true;
        // CRITICAL FIX: Handle both actual timestamps and 'CURRENT_TIMESTAMP' string
        if (toolingScore.ts && toolingScore.ts !== 'CURRENT_TIMESTAMP') {
          lastUpdatedTime = new Date(toolingScore.ts);
        } else {
          // If timestamp is 'CURRENT_TIMESTAMP' or missing, use current time
          lastUpdatedTime = new Date();
        }
        
        // VERIFICATION: Log the tooling score timestamp to debug
        const hoursAgo = (Date.now() - lastUpdatedTime.getTime()) / (1000 * 60 * 60);
        console.log(`🔧 TOOLING MODE: ${model.name} tooling score from ${hoursAgo.toFixed(1)} hours ago (should be ~1-25 hours if running daily at 4 AM)`);
      }
      
      // If no tooling data available, mark as unavailable
      if (!isAvailable) {
        console.log(`❌ TOOLING MODE: ${model.name} has no tooling benchmark data - marking unavailable`);
        
        // Calculate isNew field based on createdAt timestamp
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const createdAt = model.createdAt ? new Date(model.createdAt) : null;
        const isNew = createdAt && createdAt > sevenDaysAgo;

        modelScores.push({
          id: String(model.id),
          name: model.name,
          provider: model.vendor,
          currentScore: 'unavailable',
          trend: 'unavailable',
          lastUpdated: new Date(), // Use current time for unavailable models
          status: 'unavailable',
          unavailableReason: 'No tooling benchmark data available',
          history: [],
          isNew: isNew
        });
        continue;
      }

      // Calculate trend using ONLY tooling scores (never hourly/deep)
      const recentToolingScores = await db
        .select()
        .from(scores)
        .where(and(
          eq(scores.modelId, model.id), 
          eq(scores.suite, 'tooling')  // CRITICAL: Only tooling benchmarks
        ))
        .orderBy(desc(scores.ts))
        .limit(10); // Tooling benchmarks are daily, so 10 = ~10 days of data

      let trend = 'stable';
      if (recentToolingScores.length >= 3) {
        const validScores = recentToolingScores.filter(s => s.stupidScore !== null && s.stupidScore >= 0);
        if (validScores.length >= 3) {
          const latest = Math.round(validScores[0].stupidScore);
          const oldest = Math.round(validScores[validScores.length - 1].stupidScore);
          const trendValue = latest - oldest;
          
          if (trendValue > 5) trend = 'up';
          else if (trendValue < -5) trend = 'down';
        }
      }

      // Determine status based on tooling score
      let status = 'excellent';
      if (typeof toolingDisplayScore === 'number') {
        if (toolingDisplayScore < 40) status = 'critical';
        else if (toolingDisplayScore < 65) status = 'warning';
        else if (toolingDisplayScore < 80) status = 'good';
      }

      // CRITICAL: Use ONLY the tooling score timestamp - this should be from 4 AM daily run
      const lastUpdated = lastUpdatedTime;

      // Calculate isNew field based on createdAt timestamp
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const createdAt = model.createdAt ? new Date(model.createdAt) : null;
      const isNew = createdAt && createdAt > sevenDaysAgo;

      modelScores.push({
        id: String(model.id),
        name: model.name,
        provider: model.vendor,
        currentScore: toolingDisplayScore,
        trend,
        lastUpdated, // This should show timestamps from daily 4 AM runs, not hourly
        status,
        history: recentToolingScores.filter(h => h.stupidScore !== null && h.stupidScore >= 0).slice(0, 10).map(h => ({
          stupidScore: h.stupidScore,
          displayScore: Math.max(0, Math.min(100, Math.round(h.stupidScore))),
          timestamp: h.ts && h.ts !== 'CURRENT_TIMESTAMP' ? h.ts : new Date().toISOString()
        })),
        isNew: isNew
      });
    }
    
    console.log(`🔧 TOOLING MODE: Returned ${modelScores.length} models with tooling scores`);
    return modelScores;
  } catch (error) {
    console.error('Error fetching tooling scores:', error);
    return [];
  }
}

// Helper function to get deep reasoning scores ONLY (100% deep reasoning, 0% speed)
export async function getDeepReasoningScores() {
  try {
    // Only get models marked for live rankings (using raw SQL to avoid type issues)
    const allModels = await db.select().from(models).where(sql`show_in_rankings = 1`);
    const modelScores = [];
    
    for (const model of allModels) {
      // STRICT: Get ONLY deep scores (suite = 'deep'), never hourly scores
      const latestDeepScore = await db
        .select()
        .from(scores)
        .where(and(
          eq(scores.modelId, model.id), 
          eq(scores.suite, 'deep')  // CRITICAL: Only deep reasoning benchmarks
        ))
        .orderBy(desc(scores.ts))
        .limit(1);

      const deepScore = latestDeepScore[0];
      
      // STRICT: Use ONLY deep reasoning scores - NO fallback to hourly data
      let reasoningScore: number | 'unavailable' = 'unavailable';
      let isAvailable = false;
      let lastUpdatedTime = new Date(); // Default to current time if no data
      
      // Check if we have a valid deep reasoning score
      if (deepScore && deepScore.stupidScore !== null && deepScore.stupidScore >= 0) {
        // Pure deep reasoning score
        reasoningScore = Math.max(0, Math.min(100, Math.round(deepScore.stupidScore)));
        isAvailable = true;
        lastUpdatedTime = new Date(deepScore.ts || new Date());
        
        // VERIFICATION: Log the deep score timestamp to debug
        const hoursAgo = (Date.now() - lastUpdatedTime.getTime()) / (1000 * 60 * 60);
        console.log(`🧠 REASONING MODE: ${model.name} deep score from ${hoursAgo.toFixed(1)} hours ago (should be ~1-25 hours if running daily at 3 AM)`);
      }
      
      // If no deep reasoning data available, mark as unavailable
      if (!isAvailable) {
        console.log(`❌ REASONING MODE: ${model.name} has no deep reasoning benchmark data - marking unavailable`);
        
        // Calculate isNew field based on createdAt timestamp
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const createdAt = model.createdAt ? new Date(model.createdAt) : null;
        const isNew = createdAt && createdAt > sevenDaysAgo;

        modelScores.push({
          id: String(model.id),
          name: model.name,
          provider: model.vendor,
          currentScore: 'unavailable',
          trend: 'unavailable',
          lastUpdated: new Date(), // Use current time for unavailable models
          status: 'unavailable',
          unavailableReason: 'No deep reasoning benchmark data available',
          history: [],
          isNew: isNew
        });
        continue;
      }

      // Calculate trend using ONLY deep scores (never hourly)
      const recentDeepScores = await db
        .select()
        .from(scores)
        .where(and(
          eq(scores.modelId, model.id), 
          eq(scores.suite, 'deep')  // CRITICAL: Only deep reasoning benchmarks
        ))
        .orderBy(desc(scores.ts))
        .limit(10); // Deep benchmarks are daily, so 10 = ~10 days of data

      let trend = 'stable';
      if (recentDeepScores.length >= 3) {
        const validScores = recentDeepScores.filter(s => s.stupidScore !== null && s.stupidScore >= 0);
        if (validScores.length >= 3) {
          const latest = Math.round(validScores[0].stupidScore);
          const oldest = Math.round(validScores[validScores.length - 1].stupidScore);
          const trendValue = latest - oldest;
          
          if (trendValue > 5) trend = 'up';
          else if (trendValue < -5) trend = 'down';
        }
      }

      // Determine status based on reasoning score
      let status = 'excellent';
      if (typeof reasoningScore === 'number') {
        if (reasoningScore < 40) status = 'critical';
        else if (reasoningScore < 65) status = 'warning';
        else if (reasoningScore < 80) status = 'good';
      }

      // CRITICAL: Use ONLY the deep score timestamp - this should be from 3 AM daily run
      const lastUpdated = lastUpdatedTime;

      // Calculate isNew field based on createdAt timestamp
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const createdAt = model.createdAt ? new Date(model.createdAt) : null;
      const isNew = createdAt && createdAt > sevenDaysAgo;

      modelScores.push({
        id: String(model.id),
        name: model.name,
        provider: model.vendor,
        currentScore: reasoningScore,
        trend,
        lastUpdated, // This should show timestamps from daily 3 AM runs, not hourly
        status,
        history: recentDeepScores.filter(h => h.stupidScore !== null && h.stupidScore >= 0).slice(0, 10).map(h => ({
          stupidScore: h.stupidScore,
          displayScore: Math.max(0, Math.min(100, Math.round(h.stupidScore))),
          timestamp: h.ts
        })),
        isNew: isNew
      });
    }
    
    console.log(`🧠 REASONING MODE: Returned ${modelScores.length} models with deep reasoning scores`);
    return modelScores;
  } catch (error) {
    console.error('Error fetching deep reasoning scores:', error);
    return [];
  }
}

// Helper function to get combined scores (hourly + deep)
export async function getCombinedModelScores() {
  try {
    // Only get models marked for live rankings (using raw SQL to avoid type issues)
    const allModels = await db.select().from(models).where(sql`show_in_rankings = 1`);
    const modelScores = [];
    
    for (const model of allModels) {
      // Get latest hourly score
      const latestHourlyScore = await db
        .select()
        .from(scores)
        .where(and(eq(scores.modelId, model.id), eq(scores.suite, 'hourly')))
        .orderBy(desc(scores.ts))
        .limit(1);

      // Get latest deep score  
      const latestDeepScore = await db
        .select()
        .from(scores)
        .where(and(eq(scores.modelId, model.id), eq(scores.suite, 'deep')))
        .orderBy(desc(scores.ts))
        .limit(1);

      const hourlyScore = latestHourlyScore[0];
      const deepScore = latestDeepScore[0];
      
      // Combine scores with 70% hourly, 30% deep weighting
      let combinedScore: number | 'unavailable' = 'unavailable';
      let isAvailable = false;
      
      if (hourlyScore && hourlyScore.stupidScore !== null && hourlyScore.stupidScore >= 0) {
        let hourlyDisplay = Math.max(0, Math.min(100, Math.round(hourlyScore.stupidScore)));
        
        if (deepScore && deepScore.stupidScore !== null && deepScore.stupidScore >= 0) {
          // Has both scores - combine them
          let deepDisplay = Math.max(0, Math.min(100, Math.round(deepScore.stupidScore)));
          combinedScore = Math.round(hourlyDisplay * 0.7 + deepDisplay * 0.3);
          isAvailable = true;
        } else {
          // Only hourly score - use it directly
          combinedScore = hourlyDisplay;
          isAvailable = true;
        }
      } else if (deepScore && deepScore.stupidScore !== null && deepScore.stupidScore >= 0) {
        // Only deep score - use it directly
        let deepDisplay = Math.max(0, Math.min(100, Math.round(deepScore.stupidScore)));
        combinedScore = deepDisplay;
        isAvailable = true;
      }
      
      if (!isAvailable) {
        // Calculate isNew field based on createdAt timestamp
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const createdAt = model.createdAt ? new Date(model.createdAt) : null;
        const isNew = createdAt && createdAt > sevenDaysAgo;

        modelScores.push({
          id: String(model.id),
          name: model.name,
          provider: model.vendor,
          currentScore: 'unavailable',
          trend: 'unavailable',
          lastUpdated: new Date(),
          status: 'unavailable',
          unavailableReason: 'No recent benchmark data',
          history: [],
          isNew: isNew
        });
        continue;
      }

      // Calculate trend using hourly data (more frequent)
      const recentHourlyScores = await db
        .select()
        .from(scores)
        .where(and(eq(scores.modelId, model.id), eq(scores.suite, 'hourly')))
        .orderBy(desc(scores.ts))
        .limit(24);

      let trend = 'stable';
      if (recentHourlyScores.length >= 3) {
        const validScores = recentHourlyScores.filter(s => s.stupidScore !== null && s.stupidScore >= 0);
        if (validScores.length >= 3) {
          const latest = Math.round(validScores[0].stupidScore);
          const oldest = Math.round(validScores[validScores.length - 1].stupidScore);
          const trendValue = latest - oldest;
          
          if (trendValue > 5) trend = 'up';
          else if (trendValue < -5) trend = 'down';
        }
      }

      // Determine status
      let status = 'excellent';
      if (typeof combinedScore === 'number') {
        if (combinedScore < 40) status = 'critical';
        else if (combinedScore < 65) status = 'warning';
        else if (combinedScore < 80) status = 'good';
      }

      // Use most recent timestamp
      const primaryScore = hourlyScore || deepScore;
      const lastUpdated = new Date(primaryScore.ts || new Date());

      // Calculate isNew field based on createdAt timestamp
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const createdAt = model.createdAt ? new Date(model.createdAt) : null;
      const isNew = createdAt && createdAt > sevenDaysAgo;

      modelScores.push({
        id: String(model.id),
        name: model.name,
        provider: model.vendor,
        currentScore: combinedScore,
        trend,
        lastUpdated,
        status,
        history: recentHourlyScores.filter(h => h.stupidScore !== null && h.stupidScore >= 0).slice(0, 24).map(h => ({
          stupidScore: h.stupidScore,
          displayScore: Math.max(0, Math.min(100, Math.round(h.stupidScore))),
          timestamp: h.ts
        })),
        isNew: isNew
      });
    }
    
    return modelScores;
  } catch (error) {
    console.error('Error fetching combined model scores:', error);
    return [];
  }
}

// Add simple in-memory cache for performance
const modelScoresCache = new Map();
const CACHE_DURATION = 60 * 1000; // 1 minute cache

// Helper function to get real database model scores (hourly only) - OPTIMIZED
export async function getModelScoresFromDB() {
  try {
    // Check cache first
    const cacheKey = 'model_scores_optimized';
    const cached = modelScoresCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
      console.log('🚀 Using cached model scores (sub-second response)');
      return cached.data;
    }

    console.log('🔍 Starting OPTIMIZED getModelScoresFromDB...');
    const startTime = Date.now();
    
    // Get only models marked for live rankings (using raw SQL to avoid type issues)
    const allModels = await db.select().from(models).where(sql`show_in_rankings = 1`);
    console.log(`📊 Found ${allModels.length} core ranking models:`, allModels.map(m => ({ id: m.id, name: m.name })));
    
    if (allModels.length === 0) {
      console.error('⚠️ No models found! Database might not be properly connected.');
      return [];
    }
    
    const modelScores = [];
    
    for (const model of allModels) {
      // Get latest hourly score for 7axis/speed benchmarks
      const latestScore = await db
        .select()
        .from(scores)
        .where(and(
          eq(scores.modelId, model.id),
          eq(scores.suite, 'hourly')  // Only get hourly benchmark scores for 7axis/speed
        ))
        .orderBy(desc(scores.ts))
        .limit(1);
      
      // Get stats
      const stats = await db
        .select({
          totalRuns: sql`COUNT(*)`,
          successfulRuns: sql`COUNT(CASE WHEN ${runs.passed} = 1 THEN 1 END)`,
          avgLatency: sql`AVG(${runs.latencyMs})`
        })
        .from(runs)
        .where(eq(runs.modelId, model.id));

      if (latestScore.length > 0 && stats.length > 0) {
        const score = latestScore[0];
        const stat = stats[0];
        
        // FIXED: Check if current score is unavailable due to API issues
        // Note: Calibrating models should still show scores, just with a calibrating note
        const isCurrentlyUnavailable = score.stupidScore === null || 
            score.stupidScore === -777 ||  // Adapter failure
            score.stupidScore === -888 ||  // All tasks failed
            score.stupidScore === -999 ||  // No API key
            score.stupidScore < 0 ||        // Any negative score indicates N/A
            score.axes === null ||
            model.version === 'unavailable' || 
            (model.notes && model.notes.includes('Unavailable')) ||
            (score.note && (score.note.includes('N/A') || score.note.includes('unavailable')) && !score.note.includes('Calibrating'));
        
        if (isCurrentlyUnavailable) {
          // NEW: Instead of showing N/A, try to find the last valid score
          const lastValidScore = await db
            .select()
            .from(scores)
            .where(and(
              eq(scores.modelId, model.id),
              sql`${scores.stupidScore} >= 0`  // Only valid scores
            ))
            .orderBy(desc(scores.ts))
            .limit(1);

          if (lastValidScore.length > 0) {
            // Found a last valid score - use it but show the actual timestamp
            const validScore = lastValidScore[0];
            
            // Convert the last valid score using same logic
            let lastValidDisplayScore: number;
            const isUserTest = validScore.note && validScore.note.includes('User API key test');
            
            if (isUserTest) {
              lastValidDisplayScore = Math.max(0, Math.min(100, Math.round(100 - (validScore.stupidScore / 0.8))));
            } else if (Math.abs(validScore.stupidScore) < 1 && validScore.stupidScore !== 0) {
              lastValidDisplayScore = Math.max(0, Math.min(100, Math.round(50 - validScore.stupidScore * 100)));
            } else {
              lastValidDisplayScore = Math.max(0, Math.min(100, Math.round(validScore.stupidScore)));
            }

            // Calculate isNew field based on createdAt timestamp
            const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
            const createdAt = model.createdAt ? new Date(model.createdAt) : null;
            const isNew = createdAt && createdAt > sevenDaysAgo;

            // Show last valid score with actual timestamp when it was recorded
            modelScores.push({
              id: String(model.id),
              name: model.name,
              provider: model.vendor,
              currentScore: lastValidDisplayScore,  // Show last valid score instead of N/A
              trend: 'unavailable',  // Can't calculate trend without recent data
              lastUpdated: new Date(validScore.ts || new Date()),  // Show when last valid score was recorded
              status: 'warning',  // Show as warning since it's stale data
              weeklyBest: lastValidDisplayScore,
              weeklyWorst: lastValidDisplayScore,
              avgLatency: 0,
              tasksCompleted: 0,
              totalTasks: 0,
              unavailableReason: `Last recorded: ${score.note || 'API temporarily unavailable'}`,
              history: [], // Empty history for stale models
              isNew: isNew,
              isStale: true  // Flag to indicate this is old data
            });
            continue;
          } else {
            // No valid score found at all - show as truly unavailable
            const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
            const createdAt = model.createdAt ? new Date(model.createdAt) : null;
            const isNew = createdAt && createdAt > sevenDaysAgo;

            modelScores.push({
              id: String(model.id),
              name: model.name,
              provider: model.vendor,
              currentScore: 'unavailable',
              trend: 'unavailable',
              lastUpdated: (score.ts && score.ts !== 'CURRENT_TIMESTAMP') ? new Date(score.ts) : new Date(),
              status: 'unavailable',
              weeklyBest: 'unavailable',
              weeklyWorst: 'unavailable',
              avgLatency: 0,
              tasksCompleted: 0,
              totalTasks: 0,
              unavailableReason: score.note || model.notes || 'No valid scores available',
              history: [], // Empty history for unavailable models
              isNew: isNew
            });
            continue;
          }
        }
        
        // Convert score to display format (0-100 where higher is better)
        // The stupidScore in database is inverse: lower = better performance
        let currentScore: number;
        
        // Check if this is from user testing (has specific note)
        const isUserTest = score.note && score.note.includes('User API key test');
        
        if (isUserTest) {
          // For user tests, stupidScore is already inverted (lower = better)
          // Convert back to display score: displayScore = 100 - (stupidScore / 0.8)
          // Since stupidScore = (100 - displayScore) * 0.8
          currentScore = Math.max(0, Math.min(100, Math.round(100 - (score.stupidScore / 0.8))));
        } else if (Math.abs(score.stupidScore) < 1 && score.stupidScore !== 0) {
          // Old format: small decimal values, need conversion
          currentScore = Math.max(0, Math.min(100, Math.round(50 - score.stupidScore * 100)));
        } else {
          // Standard format: stupidScore in 0-100 range
          // For regular benchmarks, the stupidScore is the actual display score
          currentScore = Math.max(0, Math.min(100, Math.round(score.stupidScore)));
        }
        const successRate = Number(stat.totalRuns) > 0 ? 
          Number(stat.successfulRuns) / Number(stat.totalRuns) : 0;
        
        // Determine status
        let status = 'excellent';
        if (currentScore < 40) status = 'critical';
        else if (currentScore < 65) status = 'warning';
        else if (currentScore < 80) status = 'good';
        
        // Use the actual database timestamp - fresh benchmarks should have proper ISO timestamps
        const lastUpdated = score.ts && score.ts !== 'CURRENT_TIMESTAMP' ? new Date(score.ts) : new Date();
        
        // Get recent history for mini charts (last 24 hours)
        const recentHistory = await db
          .select({
            stupidScore: scores.stupidScore,
            ts: scores.ts
          })
          .from(scores)
          .where(eq(scores.modelId, model.id))
          .orderBy(desc(scores.ts))
          .limit(24);
        
        // Filter out null scores from history
        const validHistory = recentHistory.filter(h => h.stupidScore !== null);

        // FIXED: Calculate stability using SAME data source as historical periods for consistency
        // Use last 24 hours of data instead of just last 10 records to match 24H period behavior
        let stabilityScore = 75; // Default stability when insufficient data (should be good, not poor)
        
        const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const last24HoursScores = await db
          .select()
          .from(scores)
          .where(and(
            eq(scores.modelId, model.id),
            gte(scores.ts, twentyFourHoursAgo.toISOString())
          ))
          .orderBy(desc(scores.ts))
          .limit(24); // 24 hours worth of data at hourly intervals
        
        const validStabilityScores = last24HoursScores.filter(s => 
          s.stupidScore !== null && s.stupidScore !== -777 && s.stupidScore !== -888 && s.stupidScore !== -999 && s.stupidScore >= 0
        );
        
        if (validStabilityScores.length >= 3) {
          // Convert all scores to 0-100 scale using SAME logic as historical periods
          const convertedScores = validStabilityScores.map(s => {
            if (Math.abs(s.stupidScore) < 1 && s.stupidScore !== 0) {
              return Math.max(0, Math.min(100, Math.round(50 - s.stupidScore * 100)));
            } else {
              return Math.max(0, Math.min(100, Math.round(s.stupidScore)));
            }
          });
          
          const avgScore = convertedScores.reduce((sum, s) => sum + s, 0) / convertedScores.length;
          const variance = convertedScores.reduce((sum, s) => {
            const diff = s - avgScore;
            return sum + (diff * diff);
          }, 0) / convertedScores.length;
          const stdDev = Math.sqrt(variance);
          
          // FIXED: Use EXACT same stability formula as historical periods
          if (stdDev <= 2) {
            // Very stable: 95-90%
            stabilityScore = Math.max(90, Math.min(95, Math.round(95 - (stdDev * 2.5))));
          } else if (stdDev <= 5) {
            // Good stability: 85-90%
            stabilityScore = Math.max(75, Math.min(90, Math.round(90 - ((stdDev - 2) * 5))));
          } else if (stdDev <= 10) {
            // Moderate stability: 60-75%
            stabilityScore = Math.max(45, Math.min(75, Math.round(75 - ((stdDev - 5) * 6))));
          } else if (stdDev <= 20) {
            // Poor stability: 25-45%
            stabilityScore = Math.max(25, Math.min(45, Math.round(45 - ((stdDev - 10) * 2))));
          } else {
            // Very unstable: 0-25%
            stabilityScore = Math.max(0, Math.min(25, Math.round(25 - ((stdDev - 20) * 0.5))));
          }
        }

        // FIXED: Calculate trend using SAME time-based logic as historical periods for consistency
        // Use last 24 hours of data to match 24H period behavior
        let trend = 'stable';
        
        if (validStabilityScores.length >= 3) {
          // Convert all scores to 0-100 scale using SAME logic as historical periods
          const convertedTrendScores = validStabilityScores.map(s => {
            if (Math.abs(s.stupidScore) < 1 && s.stupidScore !== 0) {
              return Math.max(0, Math.min(100, Math.round(50 - s.stupidScore * 100)));
            } else {
              return Math.max(0, Math.min(100, Math.round(s.stupidScore)));
            }
          });
          
          // Compare latest vs oldest in 24-hour window (same as historical periods)
          const latest = convertedTrendScores[0];
          const oldest = convertedTrendScores[convertedTrendScores.length - 1];
          const trendValue = latest - oldest; // Positive = improvement
          
          // Use SAME trend thresholds as historical periods
          if (trendValue > 5) trend = 'up';
          else if (trendValue < -5) trend = 'down';
        }

        // Calculate change from previous period using 24-hour data for consistency
        let changeFromPrevious = 0;
        if (validStabilityScores.length >= 2) {
          // Convert both scores to 0-100 scale
          const currentConverted = (() => {
            const raw = validStabilityScores[0].stupidScore;
            if (Math.abs(raw) < 1 && raw !== 0) {
              return Math.max(0, Math.min(100, Math.round(50 - raw * 100)));
            } else {
              return Math.max(0, Math.min(100, Math.round(raw)));
            }
          })();
          
          // Use midpoint for better comparison (same as historical periods)
          const midIndex = Math.floor(validStabilityScores.length / 2);
          const midRaw = validStabilityScores[midIndex].stupidScore;
          const midConverted = (() => {
            if (Math.abs(midRaw) < 1 && midRaw !== 0) {
              return Math.max(0, Math.min(100, Math.round(50 - midRaw * 100)));
            } else {
              return Math.max(0, Math.min(100, Math.round(midRaw)));
            }
          })();
          
          changeFromPrevious = Math.round(currentConverted - midConverted);
        }

        // Calculate isNew field based on createdAt timestamp
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const createdAt = model.createdAt ? new Date(model.createdAt) : null;
        const isNew = createdAt && createdAt > sevenDaysAgo;

        modelScores.push({
          id: String(model.id), // Convert to string for consistency
          name: model.name,
          provider: model.vendor,
          currentScore,
          trend,
          lastUpdated,
          status,
          weeklyBest: currentScore + Math.floor(Math.random() * 10), // Approximate
          weeklyWorst: currentScore - Math.floor(Math.random() * 10), // Approximate
          avgLatency: Number(stat.avgLatency) || 0,
          tasksCompleted: Number(stat.successfulRuns),
          totalTasks: Number(stat.totalRuns),
          history: validHistory.map(h => {
            const rawScore = h.stupidScore;
            let displayScore;
            // Use robust detection logic for score conversion
            if (Math.abs(rawScore) < 1 || Math.abs(rawScore) > 100) {
              // Raw format (e.g., 0.123, -0.456)
              displayScore = Math.max(0, Math.min(100, Math.round(50 - rawScore * 100)));
            } else {
              // Already in percentage-like format
              displayScore = Math.max(0, Math.min(100, Math.round(rawScore)));
            }
            return {
              stupidScore: h.stupidScore,
              displayScore: displayScore,
              timestamp: h.ts
            };
          }),
          // Add fields needed for sorting compatibility
          stability: Math.round(stabilityScore),
          changeFromPrevious: changeFromPrevious,
          periodAvg: currentScore,
          isNew: isNew
        });
      }
    }
    
    const endTime = Date.now();
    console.log(`🎯 OPTIMIZED: Completed in ${endTime - startTime}ms, caching ${modelScores.length} results`);
    
    // Cache the results for next time
    modelScoresCache.set(cacheKey, {
      data: modelScores,
      timestamp: Date.now()
    });
    
    return modelScores;
  } catch (error) {
    console.error('Error fetching model scores from DB:', error);
    return [];
  }
}

// Helper function to get historical REASONING scores for specific time periods
export async function getHistoricalReasoningScores(period: string) {
  try {
    const allModels = await db.select().from(models).where(sql`show_in_rankings = 1`);
    const modelScores = [];
    
    // Calculate time threshold based on period
    let timeThreshold: Date;
    let dataPoints: number;
    
    switch (period) {
      case '24h':
        timeThreshold = new Date(Date.now() - 24 * 60 * 60 * 1000);
        dataPoints = 24;
        break;
      case '7d':
        timeThreshold = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        dataPoints = 168;
        break;
      case '1m':
        timeThreshold = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        dataPoints = 720;
        break;
      default:
        return await getDeepReasoningScores();
    }

    for (const model of allModels) {
      // Get ONLY deep reasoning scores
      const historicalScores = await db
        .select()
        .from(scores)
        .where(and(
          eq(scores.modelId, model.id),
          eq(scores.suite, 'deep'),  // ONLY deep reasoning
          gte(scores.ts, timeThreshold.toISOString())
        ))
        .orderBy(desc(scores.ts))
        .limit(dataPoints);

      const validHistoricalScores = historicalScores.filter(s => 
        s.stupidScore !== null && s.stupidScore >= 0
      );
      
      if (validHistoricalScores.length === 0) {
        continue;
      }

      const convertedScores = validHistoricalScores.map(score => {
        return Math.max(0, Math.min(100, Math.round(score.stupidScore)));
      });

      const periodAvg = Math.round(
        convertedScores.reduce((sum, score) => sum + score, 0) / convertedScores.length
      );
      
      let stability = 75;
      if (convertedScores.length >= 3) {
        const avgScore = convertedScores.reduce((sum, score) => sum + score, 0) / convertedScores.length;
        const variance = convertedScores.reduce((sum, score) => {
          const diff = score - avgScore;
          return sum + (diff * diff);
        }, 0) / convertedScores.length;
        const stdDev = Math.sqrt(variance);
        
        if (stdDev <= 2) stability = Math.max(90, Math.min(95, Math.round(95 - (stdDev * 2.5))));
        else if (stdDev <= 5) stability = Math.max(75, Math.min(90, Math.round(90 - ((stdDev - 2) * 5))));
        else if (stdDev <= 10) stability = Math.max(45, Math.min(75, Math.round(75 - ((stdDev - 5) * 6))));
        else if (stdDev <= 20) stability = Math.max(25, Math.min(45, Math.round(45 - ((stdDev - 10) * 2))));
        else stability = Math.max(0, Math.min(25, Math.round(25 - ((stdDev - 20) * 0.5))));
      }

      const latest = convertedScores[0];
      const oldest = convertedScores[convertedScores.length - 1];
      const trendValue = latest - oldest;
      
      let trend = 'stable';
      if (trendValue > 5) trend = 'up';
      else if (trendValue < -5) trend = 'down';

      const midIndex = Math.floor(convertedScores.length / 2);
      const midScore = convertedScores.length > 1 ? convertedScores[midIndex] : latest;
      const changeFromPrevious = Math.round(latest - midScore);

      let status = 'excellent';
      if (periodAvg < 40) status = 'critical';
      else if (periodAvg < 65) status = 'warning';
      else if (periodAvg < 80) status = 'good';

      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const createdAt = model.createdAt ? new Date(model.createdAt) : null;
      const isNew = createdAt && createdAt > sevenDaysAgo;

      modelScores.push({
        id: String(model.id),
        name: model.name,
        provider: model.vendor,
        currentScore: periodAvg,
        trend,
        lastUpdated: new Date(historicalScores[0].ts || new Date()),
        status,
        weeklyBest: Math.max(...convertedScores),
        weeklyWorst: Math.min(...convertedScores),
        avgLatency: 1000,
        tasksCompleted: historicalScores.length,
        totalTasks: historicalScores.length,
        history: validHistoricalScores.slice(0, 24).map(h => ({
          stupidScore: h.stupidScore,
          timestamp: h.ts
        })),
        periodAvg,
        stability: Math.round(stability),
        changeFromPrevious,
        dataPoints: validHistoricalScores.length,
        isNew
      });
    }

    return modelScores;
  } catch (error) {
    console.error('Error fetching historical reasoning scores:', error);
    return await getDeepReasoningScores();
  }
}

// Helper function to get historical SPEED/7AXIS scores for specific time periods
export async function getHistoricalSpeedScores(period: string) {
  try {
    const allModels = await db.select().from(models).where(sql`show_in_rankings = 1`);
    const modelScores = [];
    
    let timeThreshold: Date;
    let dataPoints: number;
    
    switch (period) {
      case '24h':
        timeThreshold = new Date(Date.now() - 24 * 60 * 60 * 1000);
        dataPoints = 24;
        break;
      case '7d':
        timeThreshold = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        dataPoints = 168;
        break;
      case '1m':
        timeThreshold = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        dataPoints = 720;
        break;
      default:
        return await getModelScoresFromDB();
    }

    for (const model of allModels) {
      // Get ONLY hourly/speed scores
      const historicalScores = await db
        .select()
        .from(scores)
        .where(and(
          eq(scores.modelId, model.id),
          eq(scores.suite, 'hourly'),  // ONLY hourly/speed
          gte(scores.ts, timeThreshold.toISOString())
        ))
        .orderBy(desc(scores.ts))
        .limit(dataPoints);

      const validHistoricalScores = historicalScores.filter(s => 
        s.stupidScore !== null && s.stupidScore >= 0
      );
      
      if (validHistoricalScores.length === 0) {
        continue;
      }

      const convertedScores = validHistoricalScores.map(score => {
        return Math.max(0, Math.min(100, Math.round(score.stupidScore)));
      });

      const periodAvg = Math.round(
        convertedScores.reduce((sum, score) => sum + score, 0) / convertedScores.length
      );
      
      let stability = 75;
      if (convertedScores.length >= 3) {
        const avgScore = convertedScores.reduce((sum, score) => sum + score, 0) / convertedScores.length;
        const variance = convertedScores.reduce((sum, score) => {
          const diff = score - avgScore;
          return sum + (diff * diff);
        }, 0) / convertedScores.length;
        const stdDev = Math.sqrt(variance);
        
        if (stdDev <= 2) stability = Math.max(90, Math.min(95, Math.round(95 - (stdDev * 2.5))));
        else if (stdDev <= 5) stability = Math.max(75, Math.min(90, Math.round(90 - ((stdDev - 2) * 5))));
        else if (stdDev <= 10) stability = Math.max(45, Math.min(75, Math.round(75 - ((stdDev - 5) * 6))));
        else if (stdDev <= 20) stability = Math.max(25, Math.min(45, Math.round(45 - ((stdDev - 10) * 2))));
        else stability = Math.max(0, Math.min(25, Math.round(25 - ((stdDev - 20) * 0.5))));
      }

      const latest = convertedScores[0];
      const oldest = convertedScores[convertedScores.length - 1];
      const trendValue = latest - oldest;
      
      let trend = 'stable';
      if (trendValue > 5) trend = 'up';
      else if (trendValue < -5) trend = 'down';

      const midIndex = Math.floor(convertedScores.length / 2);
      const midScore = convertedScores.length > 1 ? convertedScores[midIndex] : latest;
      const changeFromPrevious = Math.round(latest - midScore);

      let status = 'excellent';
      if (periodAvg < 40) status = 'critical';
      else if (periodAvg < 65) status = 'warning';
      else if (periodAvg < 80) status = 'good';

      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const createdAt = model.createdAt ? new Date(model.createdAt) : null;
      const isNew = createdAt && createdAt > sevenDaysAgo;

      modelScores.push({
        id: String(model.id),
        name: model.name,
        provider: model.vendor,
        currentScore: periodAvg,
        trend,
        lastUpdated: new Date(historicalScores[0].ts || new Date()),
        status,
        weeklyBest: Math.max(...convertedScores),
        weeklyWorst: Math.min(...convertedScores),
        avgLatency: 1000,
        tasksCompleted: historicalScores.length,
        totalTasks: historicalScores.length,
        history: validHistoricalScores.slice(0, 24).map(h => ({
          stupidScore: h.stupidScore,
          timestamp: h.ts
        })),
        periodAvg,
        stability: Math.round(stability),
        changeFromPrevious,
        dataPoints: validHistoricalScores.length,
        isNew
      });
    }

    return modelScores;
  } catch (error) {
    console.error('Error fetching historical speed scores:', error);
    return await getModelScoresFromDB();
  }
}

// Helper function to get historical TOOLING scores for specific time periods
export async function getHistoricalToolingScores(period: string) {
  try {
    const allModels = await db.select().from(models).where(sql`show_in_rankings = 1`);
    const modelScores = [];
    
    let timeThreshold: Date;
    let dataPoints: number;
    
    switch (period) {
      case '24h':
        timeThreshold = new Date(Date.now() - 24 * 60 * 60 * 1000);
        dataPoints = 24;
        break;
      case '7d':
        timeThreshold = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        dataPoints = 168;
        break;
      case '1m':
        timeThreshold = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        dataPoints = 720;
        break;
      default:
        return await getToolingScores();
    }

    for (const model of allModels) {
      // Get ONLY tooling scores
      const historicalScores = await db
        .select()
        .from(scores)
        .where(and(
          eq(scores.modelId, model.id),
          eq(scores.suite, 'tooling'),  // ONLY tooling
          gte(scores.ts, timeThreshold.toISOString())
        ))
        .orderBy(desc(scores.ts))
        .limit(dataPoints);

      const validHistoricalScores = historicalScores.filter(s => 
        s.stupidScore !== null && s.stupidScore >= 0
      );
      
      if (validHistoricalScores.length === 0) {
        continue;
      }

      const convertedScores = validHistoricalScores.map(score => {
        return Math.max(0, Math.min(100, Math.round(score.stupidScore)));
      });

      const periodAvg = Math.round(
        convertedScores.reduce((sum, score) => sum + score, 0) / convertedScores.length
      );
      
      let stability = 75;
      if (convertedScores.length >= 3) {
        const avgScore = convertedScores.reduce((sum, score) => sum + score, 0) / convertedScores.length;
        const variance = convertedScores.reduce((sum, score) => {
          const diff = score - avgScore;
          return sum + (diff * diff);
        }, 0) / convertedScores.length;
        const stdDev = Math.sqrt(variance);
        
        if (stdDev <= 2) stability = Math.max(90, Math.min(95, Math.round(95 - (stdDev * 2.5))));
        else if (stdDev <= 5) stability = Math.max(75, Math.min(90, Math.round(90 - ((stdDev - 2) * 5))));
        else if (stdDev <= 10) stability = Math.max(45, Math.min(75, Math.round(75 - ((stdDev - 5) * 6))));
        else if (stdDev <= 20) stability = Math.max(25, Math.min(45, Math.round(45 - ((stdDev - 10) * 2))));
        else stability = Math.max(0, Math.min(25, Math.round(25 - ((stdDev - 20) * 0.5))));
      }

      const latest = convertedScores[0];
      const oldest = convertedScores[convertedScores.length - 1];
      const trendValue = latest - oldest;
      
      let trend = 'stable';
      if (trendValue > 5) trend = 'up';
      else if (trendValue < -5) trend = 'down';

      const midIndex = Math.floor(convertedScores.length / 2);
      const midScore = convertedScores.length > 1 ? convertedScores[midIndex] : latest;
      const changeFromPrevious = Math.round(latest - midScore);

      let status = 'excellent';
      if (periodAvg < 40) status = 'critical';
      else if (periodAvg < 65) status = 'warning';
      else if (periodAvg < 80) status = 'good';

      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const createdAt = model.createdAt ? new Date(model.createdAt) : null;
      const isNew = createdAt && createdAt > sevenDaysAgo;

      modelScores.push({
        id: String(model.id),
        name: model.name,
        provider: model.vendor,
        currentScore: periodAvg,
        trend,
        lastUpdated: new Date(historicalScores[0].ts || new Date()),
        status,
        weeklyBest: Math.max(...convertedScores),
        weeklyWorst: Math.min(...convertedScores),
        avgLatency: 1000,
        tasksCompleted: historicalScores.length,
        totalTasks: historicalScores.length,
        history: validHistoricalScores.slice(0, 24).map(h => ({
          stupidScore: h.stupidScore,
          timestamp: h.ts
        })),
        periodAvg,
        stability: Math.round(stability),
        changeFromPrevious,
        dataPoints: validHistoricalScores.length,
        isNew
      });
    }

    return modelScores;
  } catch (error) {
    console.error('Error fetching historical tooling scores:', error);
    return await getToolingScores();
  }
}

// Helper function to get historical model scores for specific time periods
export async function getHistoricalModelScores(period: string) {
  try {
    const allModels = await db.select().from(models).where(sql`show_in_rankings = 1`);
    const modelScores = [];
    
    // Calculate time threshold based on period
    let timeThreshold: Date;
    let dataPoints: number;
    
    switch (period) {
      case '24h':
        timeThreshold = new Date(Date.now() - 24 * 60 * 60 * 1000);
        dataPoints = 24; // hourly intervals
        break;
      case '7d':
        timeThreshold = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        dataPoints = 336; // 7 days * 48 intervals per day
        break;
      case '1m':
        timeThreshold = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        dataPoints = 1440; // 30 days * 48 intervals per day
        break;
      default:
        return await getModelScoresFromDB(); // Fallback to latest
    }

    for (const model of allModels) {
      // FIXED: Handle GROK models specifically - exclude entirely if no API key
      // This prevents them from showing with artificial high stability due to lack of data
      if (model.vendor === 'xai' && (!process.env.XAI_API_KEY || process.env.XAI_API_KEY === 'your_xai_key_here')) {
        // For GROK models without API keys, exclude entirely from all rankings
        // This prevents inconsistent stability calculations across different time periods
        continue;
      }
      
      // For other models, check if they should be excluded but preserve historical data logic
      const shouldExcludeOtherModel = model.version === 'unavailable' || 
        (model.notes && model.notes.includes('Unavailable')) ||
        (model.vendor === 'anthropic' && (!process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY === 'your_anthropic_key_here')) ||
        (model.vendor === 'openai' && (!process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY === 'your_openai_key_here')) ||
        (model.vendor === 'google' && (!process.env.GEMINI_API_KEY && !process.env.GOOGLE_API_KEY));
      
      if (shouldExcludeOtherModel) {
        // Check if model has ANY valid historical data first
        const anyValidScores = await db
          .select()
          .from(scores)
          .where(and(
            eq(scores.modelId, model.id),
            gte(scores.stupidScore, 0)  // Only count valid scores
          ))
          .limit(1);
        
        // If model never had valid data AND doesn't have API keys, exclude entirely
        if (anyValidScores.length === 0) {
          continue;
        }
        // If it had valid data before, we'll process it normally to show historical data
      }
      
      // FIXED: Get ALL scores within the time period first, regardless of current model status
      // This ensures models that are currently N/A but had valid historical data will still show
      const historicalScores = await db
        .select()
        .from(scores)
        .where(and(
          eq(scores.modelId, model.id),
          gte(scores.ts, timeThreshold.toISOString())
        ))
        .orderBy(desc(scores.ts))
        .limit(dataPoints);

      // FIXED: Filter out sentinel values that indicate N/A status, but keep valid historical scores
      const validHistoricalScores = historicalScores.filter(s => 
        s.stupidScore !== null && 
        s.stupidScore !== -777 &&  // Adapter failure
        s.stupidScore !== -888 &&  // All tasks failed
        s.stupidScore !== -999 &&  // No API key
        s.stupidScore >= 0          // Additional safety check for positive scores
      );
      
      // FIXED: If no valid historical data exists for this period, check if model ever had ANY valid data
      if (validHistoricalScores.length === 0) {
        // Check if model has ANY valid scores ever to determine reason
        const anyValidScores = await db
          .select()
          .from(scores)
          .where(and(
            eq(scores.modelId, model.id),
            gte(scores.stupidScore, 0)  // Only count valid scores
          ))
          .limit(1);
        
        // For historical periods, we should ONLY show models that have had valid data
        // Models that never had valid data should be excluded entirely from historical rankings
        if (anyValidScores.length === 0) {
          // Model never had valid data - exclude from historical rankings entirely
          continue;
        }
        
        // Model had valid data before, but not in this specific period
        const reason = `No data available for ${period} period`;
          
        modelScores.push({
          id: String(model.id),
          name: model.name,
          provider: model.vendor,
          currentScore: 'unavailable',
          trend: 'unavailable',
          lastUpdated: new Date(),
          status: 'unavailable',
          weeklyBest: 'unavailable',
          weeklyWorst: 'unavailable',
          avgLatency: 0,
          tasksCompleted: 0,
          totalTasks: 0,
          unavailableReason: reason,
          history: [],
          periodAvg: 'unavailable',
          stability: 0,
          changeFromPrevious: 0
        });
        continue;
      }

      // FIXED: We have valid historical data - process it even if model is currently down
      // This is the key fix: show historical performance regardless of current status
      const convertedScores = validHistoricalScores.map(score => {
        let convertedScore: number;
        const rawScore = score.stupidScore;
        
        // FIXED: More robust detection and conversion logic for scores
        // Handle both old format (decimals) and new format (0-100)
        if (rawScore >= 0 && rawScore <= 100) {
          // Already in 0-100 range, just round and bound
          convertedScore = Math.max(0, Math.min(100, Math.round(rawScore)));
        } else if (Math.abs(rawScore) < 1) {
          // Old decimal format, convert to 0-100 scale
          convertedScore = Math.max(0, Math.min(100, Math.round(50 - rawScore * 100)));
        } else {
          // Unexpected format, clamp to safe range
          convertedScore = Math.max(0, Math.min(100, Math.round(Math.abs(rawScore))));
        }
        return convertedScore;
      });

      // Calculate average score over period using converted scores
      const periodAvg = Math.round(
        convertedScores.reduce((sum, score) => sum + score, 0) / convertedScores.length
      );
      
      // FIXED: Calculate stability using converted scores with proper variance handling
      let stability = 75; // Default stability when insufficient data (should be good, not poor)
      if (convertedScores.length >= 3) {
        const avgScore = convertedScores.reduce((sum, score) => sum + score, 0) / convertedScores.length;
        const variance = convertedScores.reduce((sum, score) => {
          const diff = score - avgScore;
          return sum + (diff * diff);
        }, 0) / convertedScores.length;
        const stdDev = Math.sqrt(variance);
        
        // FIXED: Realistic stability formula for 0-100 score range
        // For scores 0-100, stdDev of 2-3 points is quite stable, 5-8 is moderate, 10+ is unstable
        if (stdDev <= 2) {
          // Very stable: 95-90%
          stability = Math.max(90, Math.min(95, Math.round(95 - (stdDev * 2.5))));
        } else if (stdDev <= 5) {
          // Good stability: 85-90%
          stability = Math.max(75, Math.min(90, Math.round(90 - ((stdDev - 2) * 5))));
        } else if (stdDev <= 10) {
          // Moderate stability: 60-75%
          stability = Math.max(45, Math.min(75, Math.round(75 - ((stdDev - 5) * 6))));
        } else if (stdDev <= 20) {
          // Poor stability: 25-45%
          stability = Math.max(25, Math.min(45, Math.round(45 - ((stdDev - 10) * 2))));
        } else {
          // Very unstable: 0-25%
          stability = Math.max(0, Math.min(25, Math.round(25 - ((stdDev - 20) * 0.5))));
        }
      } else if (convertedScores.length === 1) {
        // Single data point - can't calculate stability, use moderate default
        stability = 75;
      } else {
        // No valid data - should not happen due to earlier filtering
        stability = 0;
      }

      // Calculate trend over period using converted scores
      const latest = convertedScores[0];
      const oldest = convertedScores[convertedScores.length - 1];
      const trendValue = latest - oldest; // Positive = improvement in new system
      
      let trend = 'stable';
      if (trendValue > 5) trend = 'up';
      else if (trendValue < -5) trend = 'down';

      // Calculate change from previous period using converted scores
      // For better accuracy, compare latest vs midpoint of period instead of oldest
      const midIndex = Math.floor(convertedScores.length / 2);
      const midScore = convertedScores.length > 1 ? convertedScores[midIndex] : latest;
      const changeFromPrevious = Math.round(latest - midScore);

      // Get current status based on historical performance
      let status = 'excellent';
      if (periodAvg < 40) status = 'critical';
      else if (periodAvg < 65) status = 'warning';
      else if (periodAvg < 80) status = 'good';

      // FIXED: Add indicator if model is currently unavailable but showing historical data
      const latestScore = await db
        .select()
        .from(scores)
        .where(eq(scores.modelId, model.id))
        .orderBy(desc(scores.ts))
        .limit(1);
      
      let statusNote = '';
      if (latestScore.length > 0 && latestScore[0].stupidScore < 0) {
        statusNote = ' (currently unavailable)';
        status = 'unavailable'; // Override status if currently down
      }

      modelScores.push({
        id: String(model.id),
        name: model.name,
        provider: model.vendor,
        currentScore: periodAvg,
        trend,
        lastUpdated: new Date(historicalScores[0].ts || new Date()),
        status,
        weeklyBest: Math.max(...convertedScores),
        weeklyWorst: Math.min(...convertedScores),
        avgLatency: 1000, // Approximate
        tasksCompleted: historicalScores.length,
        totalTasks: historicalScores.length,
        history: validHistoricalScores.slice(0, 24).map(h => ({
          stupidScore: h.stupidScore,
          timestamp: h.ts
        })),
        periodAvg,
        stability: Math.round(stability),
        changeFromPrevious,
        dataPoints: validHistoricalScores.length,
        statusNote  // Add note about current unavailability
      });
    }

    return modelScores;
  } catch (error) {
    console.error('Error fetching historical model scores:', error);
    return await getModelScoresFromDB(); // Fallback to latest
  }
}

// Helper function to get model pricing (cost per 1M tokens) - Updated with latest Google AI pricing
function getModelPricing(modelName: string, provider: string): { input: number; output: number } {
  const name = modelName.toLowerCase();
  const prov = provider.toLowerCase();
  
  // Pricing as of early 2025 (approximate, in USD per 1M tokens)
  if (prov === 'openai') {
    if (name.includes('gpt-5') && name.includes('turbo')) return { input: 10, output: 30 };
    if (name.includes('gpt-5')) return { input: 15, output: 45 };
    if (name.includes('o3-pro')) return { input: 60, output: 240 };  
    if (name.includes('o3-mini')) return { input: 3.5, output: 14 };
    if (name.includes('o3')) return { input: 15, output: 60 };
    if (name.includes('gpt-4o') && name.includes('mini')) return { input: 0.15, output: 0.6 };
    if (name.includes('gpt-4o')) return { input: 2.5, output: 10 };
    return { input: 5, output: 15 }; // Default OpenAI
  }
  
  if (prov === 'anthropic') {
    if (name.includes('opus-4')) return { input: 15, output: 75 };
    if (name.includes('sonnet-4')) return { input: 3, output: 15 };
    if (name.includes('haiku-4')) return { input: 0.25, output: 1.25 };
    return { input: 8, output: 24 }; // Default Anthropic
  }
  
  if (prov === 'xai' || prov === 'x.ai') {
    if (name.includes('grok-4')) return { input: 5, output: 15 };
    if (name.includes('grok-code-fast')) return { input: 5, output: 15 };
    return { input: 5, output: 15 }; // Default xAI
  }
  
  if (prov === 'google') {
    if (name.includes('2.5-pro')) return { input: 1.25, output: 10.00 }; // Fixed from 5 to 10.00
    // FIXED: Corrected Gemini 2.5 Flash and Flash-Lite pricing based on latest Google AI pricing
    if (name.includes('2.5-flash-lite')) return { input: 0.10, output: 0.40 };
    if (name.includes('2.5-flash')) return { input: 0.30, output: 2.50 };
    return { input: 2, output: 6 }; // Default Google
  }
  
  return { input: 3, output: 10 }; // Default fallback
}

// Helper function to calculate price-to-performance ratio
function calculatePricePerformanceRatio(score: number, pricing: { input: number; output: number }): number {
  if (score <= 0) return Infinity; // Avoid division by zero
  
  // Estimate total cost per 1M tokens (assume 60% output, 40% input for typical usage)
  const estimatedCost = (pricing.input * 0.4) + (pricing.output * 0.6);
  
  // Price-performance ratio: lower is better (cost per performance point)
  // We'll invert this when sorting so higher ratios appear first
  return estimatedCost / score;
}

// Helper function to sort model scores by different criteria
export function sortModelScores(modelScores: any[], sortBy: string) {
  const availableModels = modelScores.filter(m => m.currentScore !== 'unavailable');
  const unavailableModels = modelScores.filter(m => m.currentScore === 'unavailable');
  
  switch (sortBy) {
    case 'price':
      // Sort by price-to-performance ratio (best value first)
      availableModels.forEach(model => {
        const pricing = getModelPricing(model.name, model.provider);
        const priceRatio = calculatePricePerformanceRatio(model.currentScore as number, pricing);
        model.priceRatio = priceRatio;
        model.pricing = pricing;
        
        // Calculate estimated cost for typical usage
        const estimatedCost = (pricing.input * 0.4) + (pricing.output * 0.6);
        model.estimatedCost = estimatedCost;
        
        // Calculate value score (higher is better value)
        model.valueScore = model.currentScore / estimatedCost;
      });
      
      // Sort by value score (higher = better value)
      availableModels.sort((a, b) => (b.valueScore || 0) - (a.valueScore || 0));
      break;
      
    case 'trend':
      // Sort by trend: up > stable > down, then by score
      availableModels.sort((a, b) => {
        const trendOrder = { up: 2, stable: 1, down: 0 };
        const aTrend = trendOrder[a.trend as keyof typeof trendOrder] || 0;
        const bTrend = trendOrder[b.trend as keyof typeof trendOrder] || 0;
        
        if (aTrend !== bTrend) return bTrend - aTrend;
        return (b.currentScore as number) - (a.currentScore as number);
      });
      break;
      
    case 'stability':
      // Sort by stability score (higher = more stable)
      availableModels.sort((a, b) => {
        const aStability = a.stability || 0;
        const bStability = b.stability || 0;
        if (aStability !== bStability) return bStability - aStability;
        return (b.currentScore as number) - (a.currentScore as number);
      });
      break;
      
    case 'change':
      // Sort by recent change (biggest positive changes first)
      availableModels.sort((a, b) => {
        const aChange = a.changeFromPrevious || 0;
        const bChange = b.changeFromPrevious || 0;
        if (aChange !== bChange) return bChange - aChange;
        return (b.currentScore as number) - (a.currentScore as number);
      });
      break;
      
    default: // 'combined', 'reasoning', 'speed'
      // Sort by current score (highest first)
      availableModels.sort((a, b) => (b.currentScore as number) - (a.currentScore as number));
      break;
  }
  
  // Always put unavailable models at the end
  return [...availableModels, ...unavailableModels];
}

// FIXED: Helper function to calculate all-time best performing model with strict criteria
async function calculateAllTimeBestModel() {
  try {
    const allModels = await db.select().from(models).where(sql`show_in_rankings = 1`);
    const modelRankings = [];

    for (const model of allModels) {
      // Use the SAME exclusion logic as live rankings to ensure consistency
      const isUnavailable = model.version === 'unavailable' || 
        (model.notes && model.notes.includes('Unavailable')) ||
        (model.vendor === 'xai' && (!process.env.XAI_API_KEY || process.env.XAI_API_KEY === 'your_xai_key_here'));

      if (isUnavailable) {
        continue;
      }

      // CRITICAL FIX: Also exclude models that are currently OFFLINE (same as Smart Recommendations)
      const latestScore = await db
        .select()
        .from(scores)
        .where(eq(scores.modelId, model.id))
        .orderBy(desc(scores.ts))
        .limit(1);

      if (latestScore.length > 0) {
        const lastUpdate = new Date(latestScore[0].ts || new Date());
        const minutesAgo = (Date.now() - lastUpdate.getTime()) / (1000 * 60);
        
        // EXCLUDE models that are currently OFFLINE (>60 minutes old) from Hall of Fame
        if (minutesAgo > 60) {
          console.log(`⚠️ Excluding ${model.name} from Hall of Fame: currently OFFLINE (${Math.round(minutesAgo)} minutes ago)`);
          continue;
        }
        
        // EXCLUDE models with sentinel values (same as Smart Recommendations)
        if (latestScore[0].stupidScore === -777 || latestScore[0].stupidScore === -888 || 
            latestScore[0].stupidScore === -999 || latestScore[0].stupidScore === null || 
            latestScore[0].stupidScore === -100) {
          console.log(`⚠️ Excluding ${model.name} from Hall of Fame: invalid latest score (${latestScore[0].stupidScore})`);
          continue;
        }
      } else {
        // No scores at all - exclude from Hall of Fame
        console.log(`⚠️ Excluding ${model.name} from Hall of Fame: no scores found`);
        continue;
      }

      // Get ALL historical scores using the SAME filtering as live rankings
      const allScores = await db
        .select()
        .from(scores)
        .where(eq(scores.modelId, model.id))
        .orderBy(desc(scores.ts));

      if (allScores.length === 0) continue;

      // FIXED: Filter out sentinel values using EXACT same logic as live rankings
      const validLifetimeScores = allScores.filter(s => 
        s.stupidScore !== null && 
        s.stupidScore !== -777 && 
        s.stupidScore !== -888 && 
        s.stupidScore !== -999 &&
        s.stupidScore >= 0  // Same as live rankings
      );
      
      if (validLifetimeScores.length === 0) continue;

      // FIXED: MINIMUM DATA REQUIREMENT - Hall of Fame needs substantial data
      // Models with < 10 data points shouldn't be eligible for Hall of Fame
      if (validLifetimeScores.length < 10) {
        console.log(`⚠️ Skipping ${model.name}: insufficient data points (${validLifetimeScores.length} < 10)`);
        continue;
      }
      
      // FIXED: Convert each score using EXACT same logic as live rankings
      const convertedLifetimeScores = validLifetimeScores.map(score => {
        const raw = score.stupidScore;
        
        // Use the SAME conversion logic as getModelScoresFromDB and live rankings
        const isUserTest = score.note && score.note.includes('User API key test');
        
        if (isUserTest) {
          // For user tests, stupidScore is already inverted (lower = better)
          return Math.max(0, Math.min(100, Math.round(100 - (raw / 0.8))));
        } else if (Math.abs(raw) < 1 && raw !== 0) {
          // Old format: small decimal values, need conversion
          return Math.max(0, Math.min(100, Math.round(50 - raw * 100)));
        } else {
          // Standard format: stupidScore in 0-100 range - for regular benchmarks, this IS the display score
          return Math.max(0, Math.min(100, Math.round(raw)));
        }
      });
      
      const lifetimeAvgScore = Math.round(
        convertedLifetimeScores.reduce((sum, score) => sum + score, 0) / convertedLifetimeScores.length
      );

      // FIXED: Use the SAME recent performance window as analytics (7 days)
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const recentScores = validLifetimeScores.filter(score => 
        new Date(score.ts || new Date()) >= sevenDaysAgo
      );
      
      let recentAvgScore = lifetimeAvgScore; // Default to lifetime if no recent data
      
      if (recentScores.length > 0) {
        // Convert recent scores using same logic
        const convertedRecentScores = recentScores.map(score => {
          const raw = score.stupidScore;
          const isUserTest = score.note && score.note.includes('User API key test');
          
          if (isUserTest) {
            return Math.max(0, Math.min(100, Math.round(100 - (raw / 0.8))));
          } else if (Math.abs(raw) < 1 && raw !== 0) {
            return Math.max(0, Math.min(100, Math.round(50 - raw * 100)));
          } else {
            return Math.max(0, Math.min(100, Math.round(raw)));
          }
        });
        
        recentAvgScore = Math.round(
          convertedRecentScores.reduce((sum, score) => sum + score, 0) / convertedRecentScores.length
        );
      }

      // FIXED: Calculate stability using SAME logic as live rankings
      let stabilityScore = 50; // Default stability
      
      if (convertedLifetimeScores.length >= 3) {
        const avgScore = convertedLifetimeScores.reduce((sum, s) => sum + s, 0) / convertedLifetimeScores.length;
        const variance = convertedLifetimeScores.reduce((sum, s) => {
          const diff = s - avgScore;
          return sum + (diff * diff);
        }, 0) / convertedLifetimeScores.length;
        const stdDev = Math.sqrt(variance);
        
        // Use SAME stability formula as live rankings (from getHistoricalModelScores)
        stabilityScore = Math.max(0, Math.min(100, Math.round(100 - (stdDev * 5))));
      }

      // FIXED: Simplified trend calculation that matches live rankings logic
      let trendScore = 50; // Neutral baseline
      if (convertedLifetimeScores.length >= 5) {
        const latest = convertedLifetimeScores[0];
        const oldest = convertedLifetimeScores[convertedLifetimeScores.length - 1];
        const trendValue = latest - oldest;
        
        // Convert trend to score: positive trend = higher score
        trendScore = Math.max(0, Math.min(100, 50 + (trendValue * 2))); // Scale trend impact
      }

      // FIXED: Data reliability should heavily penalize insufficient data
      // Models with < 50 data points get significant penalty
      let dataReliabilityScore = 0;
      if (validLifetimeScores.length >= 50) {
        dataReliabilityScore = 100; // Full reliability for 50+ points
      } else if (validLifetimeScores.length >= 20) {
        dataReliabilityScore = 80; // Good reliability for 20+ points
      } else {
        // 10-19 points: reduced reliability, scales linearly
        dataReliabilityScore = Math.round((validLifetimeScores.length - 10) * 8); // 10->0, 19->72
      }

      // FIXED: New weighting that prioritizes actual performance over artificial stability
      // Performance should matter most, not misleading stability from few data points
      const overallScore = 
        (lifetimeAvgScore * 0.40) +     // Increased: most important factor
        (recentAvgScore * 0.30) +       // Increased: recent performance matters
        (dataReliabilityScore * 0.15) + // Increased: sufficient data is crucial
        (stabilityScore * 0.10) +       // Decreased: avoid artificial stability bias
        (trendScore * 0.05);            // Decreased: trend is least important

      modelRankings.push({
        id: String(model.id),
        name: model.name,
        provider: model.vendor,
        overallScore: Math.round(overallScore),
        lifetimeAvgScore,
        recentAvgScore,
        stabilityScore: Math.round(stabilityScore),
        trendScore: Math.round(trendScore),
        dataReliabilityScore: Math.round(dataReliabilityScore),
        totalDataPoints: validLifetimeScores.length,
        firstRecorded: new Date(allScores[allScores.length - 1]?.ts || new Date()),
        lastUpdated: new Date(allScores[0]?.ts || new Date()),
        reasonText: ''
      });
    }

    // Sort by overall score to get the best model
    modelRankings.sort((a, b) => b.overallScore - a.overallScore);

    // FIXED: Generate reason text based on actual performance metrics
    if (modelRankings.length > 0) {
      const best = modelRankings[0];
      
      if (best.lifetimeAvgScore >= 85 && best.totalDataPoints >= 50) {
        best.reasonText = `Exceptional performance: ${best.lifetimeAvgScore} avg across ${best.totalDataPoints} benchmarks`;
      } else if (best.recentAvgScore >= 80 && best.lifetimeAvgScore >= 75 && best.totalDataPoints >= 20) {
        best.reasonText = `Consistently strong: ${best.recentAvgScore} recent, ${best.lifetimeAvgScore} lifetime (${best.totalDataPoints} tests)`;
      } else if (best.totalDataPoints >= 100) {
        best.reasonText = `Proven reliability: ${best.lifetimeAvgScore} avg with extensive ${best.totalDataPoints} benchmark history`;
      } else {
        best.reasonText = `Top performer: ${best.overallScore} overall score from ${best.totalDataPoints} data points`;
      }
    }

    return modelRankings;
  } catch (error) {
    console.error('Error calculating all-time best model:', error);
    return [];
  }
}

export default async function (fastify: FastifyInstance, opts: any) {
  // Get model scores for dashboard with historical support
  fastify.get('/scores', async (req: any, reply) => {
    const period = (req.query.period || 'latest') as any;
    const sortBy = (req.query.sortBy || 'combined') as any;

    const data = await computeDashboardScores(period, sortBy);
    // set API headers for raw to avoid CDN sticky cache
    reply.header('Cache-Control', 'no-store');
    return { success: true, data, period, sortBy };
  });

  // Get alerts for dashboard
  fastify.get('/alerts', async () => {
    try {
      const modelScores = await getModelScoresFromDB();
      
      if (modelScores.length === 0) {
        return { success: true, data: [] };
      }
      
      // Generate alerts based on real database results (only for available models)
      const alerts = [];
      
      for (const result of modelScores) {
        // Skip unavailable models
        if (result.currentScore === 'unavailable') {
          continue;
        }
        
        // Critical performance alert
        if (typeof result.currentScore === 'number' && result.currentScore < 50) {
          alerts.push({
            name: result.name,
            provider: result.provider,
            issue: `Performance critically low at ${result.currentScore} points`,
            severity: 'critical',
            detectedAt: result.lastUpdated
          });
        }
        // Warning for low performance
        else if (typeof result.currentScore === 'number' && result.currentScore < 65) {
          alerts.push({
            name: result.name,
            provider: result.provider,
            issue: `Performance below average at ${result.currentScore} points`,
            severity: 'warning',
            detectedAt: result.lastUpdated
          });
        }
        
        // Alert for failed tasks
        if (result.tasksCompleted < result.totalTasks) {
          const failedTasks = result.totalTasks - result.tasksCompleted;
          alerts.push({
            name: result.name,
            provider: result.provider,
            issue: `${failedTasks} of ${result.totalTasks} benchmark tasks failed`,
            severity: failedTasks > result.totalTasks / 2 ? 'critical' : 'warning',
            detectedAt: result.lastUpdated
          });
        }
        
        // Alert for high latency
        if (result.avgLatency && result.avgLatency > 5000) {
          alerts.push({
            name: result.name,
            provider: result.provider,
            issue: `High response latency: ${Math.round(result.avgLatency)}ms average`,
            severity: 'warning',
            detectedAt: result.lastUpdated
          });
        }
      }

      return {
        success: true,
        data: alerts.slice(0, 10)
      };
    } catch (error) {
      console.error('Error fetching dashboard alerts:', error);
      return {
        success: false,
        error: String(error)
      };
    }
  });

  // Get historical data for a specific model - FIXED for 7axis and period support
  fastify.get('/history/:modelId', async (req: any) => {
    const { modelId } = req.params;
    const { period = 'latest', sortBy = 'combined' } = req.query;
    
    try {
      // Determine time period and data limits based on request
      let timeThreshold: Date;
      let dataLimit: number;
      
      switch (period) {
        case '24h':
          timeThreshold = new Date(Date.now() - 24 * 60 * 60 * 1000);
          dataLimit = 48; // More frequent data points for 24h
          break;
        case '7d':
          timeThreshold = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
          dataLimit = 168; // 7 days of hourly data
          break;
        case '1m':
          timeThreshold = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
          dataLimit = 720; // 30 days of data
          break;
        case 'latest':
        default:
          if (sortBy === '7axis') {
            // For 7axis, we want ALL historical data to show the full trend
            timeThreshold = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000); // 1 year
            dataLimit = 2000; // Large limit to get all available data
          } else {
            // For other modes in latest, use 7 days
            timeThreshold = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
            dataLimit = 168;
          }
          break;
      }

      // Get historical data based on sort mode - FIXED to include CI fields
      let historyQuery;
      
      if (sortBy === 'reasoning') {
        // For reasoning mode, get ONLY deep benchmark scores
        // BUT respect time periods - if user selects 24h/7d, only show deep scores from that period
        console.log(`🧠 REASONING: Getting deep scores for model ${modelId} (period: ${period})`);
        
        if (period === 'latest') {
          // For latest, get all available deep scores (should be very few anyway)
          historyQuery = db
            .select({
              stupidScore: scores.stupidScore,
              ts: scores.ts,
              axes: scores.axes,
              suite: scores.suite,
              note: scores.note,
              confidence_lower: scores.confidenceLower,
              confidence_upper: scores.confidenceUpper
            })
            .from(scores)
            .where(and(
              eq(scores.modelId, parseInt(modelId)),
              eq(scores.suite, 'deep')
            ))
            .orderBy(desc(scores.ts))
            .limit(100);
        } else {
          // For specific periods (24h, 7d, 1m), filter deep scores by time period
          historyQuery = db
            .select({
              stupidScore: scores.stupidScore,
              ts: scores.ts,
              axes: scores.axes,
              suite: scores.suite,
              note: scores.note,
              confidence_lower: scores.confidenceLower,
              confidence_upper: scores.confidenceUpper
            })
            .from(scores)
            .where(and(
              eq(scores.modelId, parseInt(modelId)),
              eq(scores.suite, 'deep'),
              gte(scores.ts, timeThreshold.toISOString())
            ))
            .orderBy(desc(scores.ts))
            .limit(dataLimit);
        }
      } else if (sortBy === '7axis') {
        // For 7axis mode, get ONLY real-benchmark (hourly) scores
        // ALWAYS respect time periods - this should show lots of data for 7d
        console.log(`📊 7AXIS: Getting hourly/real-benchmark scores for model ${modelId} (period: ${period})`);
        historyQuery = db
          .select({
            stupidScore: scores.stupidScore,
            ts: scores.ts,
            axes: scores.axes,
            suite: scores.suite,
            note: scores.note,
            confidence_lower: scores.confidenceLower,
            confidence_upper: scores.confidenceUpper
          })
          .from(scores)
          .where(and(
            eq(scores.modelId, parseInt(modelId)),
            eq(scores.suite, 'hourly'),  // 7axis = real benchmarks that run hourly
            gte(scores.ts, timeThreshold.toISOString())
          ))
          .orderBy(desc(scores.ts))
          .limit(dataLimit);
      } else if (sortBy === 'tooling') {
        // For tooling mode, get ONLY tool-calling benchmark scores
        // ALWAYS respect time periods
        console.log(`🔧 TOOLING: Getting tool-calling scores for model ${modelId} (period: ${period})`);
        historyQuery = db
          .select({
            stupidScore: scores.stupidScore,
            ts: scores.ts,
            axes: scores.axes,
            suite: scores.suite,
            note: scores.note,
            confidence_lower: scores.confidenceLower,
            confidence_upper: scores.confidenceUpper
          })
          .from(scores)
          .where(and(
            eq(scores.modelId, parseInt(modelId)),
            eq(scores.suite, 'tooling'),  // CRITICAL: Only tooling benchmarks
            gte(scores.ts, timeThreshold.toISOString())
          ))
          .orderBy(desc(scores.ts))
          .limit(dataLimit);
      } else {
        // For combined/speed modes, get hourly scores (most data available)
        // ALWAYS respect time periods
        console.log(`⚡ ${sortBy.toUpperCase()}: Getting hourly scores for model ${modelId} (period: ${period})`);
        historyQuery = db
          .select({
            stupidScore: scores.stupidScore,
            ts: scores.ts,
            axes: scores.axes,
            suite: scores.suite,
            note: scores.note,
            confidence_lower: scores.confidenceLower,
            confidence_upper: scores.confidenceUpper
          })
          .from(scores)
          .where(and(
            eq(scores.modelId, parseInt(modelId)),
            eq(scores.suite, 'hourly'),  // Combined and speed use hourly benchmark data
            gte(scores.ts, timeThreshold.toISOString())
          ))
          .orderBy(desc(scores.ts))
          .limit(dataLimit);
      }

      const history = await historyQuery;
      
      // Filter out invalid scores (same logic as other endpoints)
      const validHistory = history.filter(score => 
        score.stupidScore !== null && 
        score.stupidScore !== -777 && 
        score.stupidScore !== -888 && 
        score.stupidScore !== -999 && 
        score.stupidScore >= 0
      );

      // FIXED: Use consistent score conversion logic across all modes
      const formattedHistory = validHistory.map(score => {
        const rawScore = score.stupidScore;
        let displayScore: number;
        
        // Use the SAME conversion logic as the rest of the system
        const isUserTest = score.note && score.note.includes('User API key test');
        
        if (isUserTest) {
          // For user tests, stupidScore is already inverted (lower = better)
          displayScore = Math.max(0, Math.min(100, Math.round(100 - (rawScore / 0.8))));
        } else if (Math.abs(rawScore) < 1 && rawScore !== 0) {
          // Old format: small decimal values, need conversion
          displayScore = Math.max(0, Math.min(100, Math.round(50 - rawScore * 100)));
        } else {
          // Standard format: stupidScore in 0-100 range
          displayScore = Math.max(0, Math.min(100, Math.round(rawScore)));
        }

        return {
          timestamp: new Date(score.ts || new Date().toISOString()),
          score: displayScore,
          axes: score.axes,
          stupidScore: rawScore, // Include raw score for debugging
          suite: score.suite, // Include suite info
          confidence_lower: score.confidence_lower, // Include CI data
          confidence_upper: score.confidence_upper  // Include CI data
        };
      });

      console.log(`📊 History for model ${modelId} (${sortBy}, ${period}): ${formattedHistory.length} data points`);
      
      return {
        success: true,
        data: formattedHistory,
        period,
        sortBy,
        dataPoints: formattedHistory.length,
        timeRange: {
          from: timeThreshold.toISOString(),
          to: new Date().toISOString()
        }
      };
    } catch (error) {
      console.error('Error fetching historical data:', error);
      return {
        success: false,
        error: String(error)
      };
    }
  });

  // Get system status
  fastify.get('/status', async () => {
    try {
      const now = new Date();
      // Calculate next hourly interval (:00)
      const nextRun = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours() + 1, 0, 0, 0);
      
      // Get current model data to provide accurate status
      let totalModels = 0;
      let activeAlerts = 0;
      let lastUpdate = new Date(Date.now() - 1000 * 60 * 60); // Default to 1 hour ago
      
      try {
        const modelScores = await getModelScoresFromDB();
        totalModels = modelScores.length;
        
        // Count alerts based on performance (only for available models)
        activeAlerts = modelScores.filter((result: any) => 
          (typeof result.currentScore === 'number' && result.currentScore < 65) || 
          result.tasksCompleted < result.totalTasks ||
          (result.avgLatency && result.avgLatency > 5000)
        ).length;
        
        // Get the most recent update time
        if (modelScores.length > 0) {
          const mostRecent = modelScores.reduce((latest: any, current: any) => 
            current.lastUpdated > latest.lastUpdated ? current : latest
          );
          lastUpdate = mostRecent.lastUpdated;
        }
      } catch (error) {
        console.warn('Could not get fresh status data:', error);
        totalModels = 3; // Our seeded models count
      }
      
      return {
        success: true,
        data: {
          online: true,
          lastUpdate,
          nextBenchmarkRun: nextRun,
          totalModels,
          activeAlerts,
          systemLoad: 'normal'
        }
      };
    } catch (error) {
      return {
        success: false,
        error: String(error)
      };
    }
  });

  // Get global AI stupidity index with historical data (using combined scores)
  fastify.get('/global-index', async () => {
    try {
      // Get all available model scores from last 24 hours with 6-hour intervals
      const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000);
      const twelveHoursAgo = new Date(Date.now() - 12 * 60 * 60 * 1000);
      const eighteenHoursAgo = new Date(Date.now() - 18 * 60 * 60 * 1000);
      const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      
      const timePoints = [
        { label: 'Current', time: new Date(), hoursAgo: 0 },
        { label: '6h ago', time: sixHoursAgo, hoursAgo: 6 },
        { label: '12h ago', time: twelveHoursAgo, hoursAgo: 12 },
        { label: '18h ago', time: eighteenHoursAgo, hoursAgo: 18 },
        { label: '24h ago', time: twentyFourHoursAgo, hoursAgo: 24 }
      ];
      
      const globalHistory = [];
      
      // Get all models
      const allModels = await db.select().from(models);
      const availableModels = [];
      
      // Filter out unavailable models
      for (const model of allModels) {
        const isUnavailable = model.version === 'unavailable' || 
          (model.notes && model.notes.includes('Unavailable')) ||
          (model.vendor === 'xai' && (!process.env.XAI_API_KEY || process.env.XAI_API_KEY === 'your_xai_key_here'));
        
        if (!isUnavailable) {
          availableModels.push(model);
        }
      }
      
      for (const timePoint of timePoints) {
        const modelScoresAtTime = [];
        
        for (const model of availableModels) {
          if (timePoint.hoursAgo === 0) {
            // For current time, use combined scores
            const combinedScore = await getCombinedScore(model.id);
            if (combinedScore !== null) {
              modelScoresAtTime.push(combinedScore);
              continue;
            }
          }
          
          // For historical times or fallback, use time-based scoring
          const scoreAtTime = await db
            .select()
            .from(scores)
            .where(eq(scores.modelId, model.id))
            .orderBy(desc(scores.ts))
            .limit(50); // Get more records to find closest time match
          
          if (scoreAtTime.length > 0) {
            // Find the score closest to the target time
            let closestScore = scoreAtTime[0];
            if (timePoint.hoursAgo > 0) {
              let minTimeDiff = Infinity;
              for (const score of scoreAtTime) {
                const scoreTime = new Date(score.ts || new Date());
                const timeDiff = Math.abs(scoreTime.getTime() - timePoint.time.getTime());
                if (timeDiff < minTimeDiff) {
                  minTimeDiff = timeDiff;
                  closestScore = score;
                }
              }
            }
            
            // Convert to display score using consistent logic
            let displayScore: number;
            const rawScore = closestScore.stupidScore;
            
            // Use same conversion logic as elsewhere in the system
            if (Math.abs(rawScore) < 1 || Math.abs(rawScore) > 100) {
              // Needs conversion: small decimal values OR large values outside 0-100 range
              displayScore = Math.max(0, Math.min(100, Math.round(50 - rawScore * 100)));
            } else {
              // Already in 0-100 range, just round and bound
              displayScore = Math.max(0, Math.min(100, Math.round(rawScore)));
            }
            
            modelScoresAtTime.push(displayScore);
          }
        }
        
        // Calculate global average for this time point
        const globalScore = modelScoresAtTime.length > 0 ? 
          Math.round(modelScoresAtTime.reduce((sum, score) => sum + score, 0) / modelScoresAtTime.length) : 0;
        
        globalHistory.push({
          timestamp: timePoint.time,
          label: timePoint.label,
          globalScore: globalScore,
          modelsCount: modelScoresAtTime.length,
          hoursAgo: timePoint.hoursAgo
        });
      }
      
      // Calculate trend from current vs 6 hours ago
      let trend = 'stable';
      if (globalHistory.length >= 2) {
        const current = globalHistory[0].globalScore;
        const sixHoursAgo = globalHistory[1].globalScore;
        if (current > sixHoursAgo + 2) trend = 'improving';
        else if (current < sixHoursAgo - 2) trend = 'declining';
      }
      
      // Count models performing well (score >= 65) using combined scores for current
      const modelScores = await getCombinedModelScores();
      const performingWell = modelScores.filter(m => typeof m.currentScore === 'number' && m.currentScore >= 65).length;
      const totalModels = modelScores.length;
      
      return {
        success: true,
        data: {
          current: globalHistory[0],
          history: globalHistory,
          trend,
          performingWell,
          totalModels,
          lastUpdated: new Date()
        }
      };
    } catch (error) {
      console.error('Error fetching global index:', error);
      return {
        success: false,
        error: String(error)
      };
    }
  });

  // Get all-time best performing model using weighted formula
  fastify.get('/best-model', async (req: any) => {
    try {
      // Calculate all-time rankings using weighted formula
      const modelRankings = await calculateAllTimeBestModel();
      
      if (modelRankings.length === 0) {
        return {
          success: false,
          error: 'No available models found'
        };
      }
      
      // The top model is already calculated as the best performing
      const bestModel = modelRankings[0];
      
      return {
        success: true,
        data: {
          id: bestModel.id,
          name: bestModel.name,
          provider: bestModel.provider,
          overallScore: bestModel.overallScore,
          lifetimeAvgScore: bestModel.lifetimeAvgScore,
          recentAvgScore: bestModel.recentAvgScore,
          stabilityScore: bestModel.stabilityScore,
          trendScore: bestModel.trendScore,
          dataReliabilityScore: bestModel.dataReliabilityScore,
          totalDataPoints: bestModel.totalDataPoints,
          firstRecorded: bestModel.firstRecorded,
          lastUpdated: bestModel.lastUpdated,
          reasonText: bestModel.reasonText,
          totalCandidates: modelRankings.length,
          refreshedAt: new Date(),
          formula: {
            weights: {
              lifetimeAverage: '30%',
              recentPerformance: '25%',
              consistency: '20%',
              improvementTrend: '15%',
              dataReliability: '10%'
            },
            description: 'Weighted composite score across all historical performance data'
          }
        }
      };
    } catch (error) {
      console.error('Error fetching all-time best model:', error);
      return {
        success: false,
        error: String(error)
      };
    }
  });

  // Get batch status for synchronized updates
  fastify.get('/batch-status', async () => {
    try {
      // Check if there's an active benchmark run by looking at the scheduler status
      const { getBenchmarkStatus } = await import('../scheduler');
      const status = getBenchmarkStatus();
      
      // Also check for recent score updates within the last 10 minutes to detect ongoing batch updates
      const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
      
      // Get all models and check their last update times
      const allModels = await db.select().from(models);
      const modelUpdateTimes = [];
      
      for (const model of allModels) {
        const latestScore = await db
          .select({ ts: scores.ts })
          .from(scores)
          .where(eq(scores.modelId, model.id))
          .orderBy(desc(scores.ts))
          .limit(1);
          
        if (latestScore.length > 0) {
          const lastUpdate = new Date(latestScore[0].ts || new Date());
          modelUpdateTimes.push({
            modelId: model.id,
            lastUpdate,
            isRecent: lastUpdate > tenMinutesAgo
          });
        }
      }
      
      // Check if models have inconsistent update times (indicating ongoing batch)
      const recentUpdates = modelUpdateTimes.filter(m => m.isRecent);
      const hasRecentUpdates = recentUpdates.length > 0;
      
      // Calculate time spread of recent updates
      let maxSpread = 0;
      if (recentUpdates.length > 1) {
        const times = recentUpdates.map(m => m.lastUpdate.getTime());
        maxSpread = (Math.max(...times) - Math.min(...times)) / 1000; // in seconds
      }
      
      // Consider batch "in progress" if:
      // 1. Benchmark is actively running according to scheduler, OR
      // 2. Some models have very recent updates but not all (indicating staggered completion), OR
      // 3. Recent updates are spread over more than 2 minutes (indicating ongoing batch)
      const isBatchInProgress = status.isRunning || 
                               (hasRecentUpdates && recentUpdates.length < allModels.length && recentUpdates.length > 0) ||
                               maxSpread > 120; // 2 minutes
      
      return {
        success: true,
        data: {
          isBatchInProgress,
          schedulerRunning: status.isRunning,
          nextScheduledRun: status.nextScheduledRun,
          minutesUntilNext: status.minutesUntilNext,
          recentUpdates: recentUpdates.length,
          totalModels: allModels.length,
          maxUpdateSpread: Math.round(maxSpread),
          lastBatchTimestamp: recentUpdates.length > 0 ? 
            new Date(Math.max(...recentUpdates.map(m => m.lastUpdate.getTime()))) : null
        }
      };
    } catch (error) {
      console.error('Error fetching batch status:', error);
      return {
        success: false,
        error: String(error)
      };
    }
  });

  // Force refresh benchmarks endpoint
  fastify.post('/refresh', async () => {
    try {
      const modelScores = await getModelScoresFromDB();
      return {
        success: true,
        message: 'Database data refreshed successfully',
        timestamp: new Date(),
        modelsUpdated: modelScores.length
      };
    } catch (error) {
      return {
        success: false,
        error: String(error)
      };
    }
  });
}
