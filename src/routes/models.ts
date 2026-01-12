import { FastifyInstance } from 'fastify';
import { db } from '../db/index';
import { models, scores, runs, metrics, tasks } from '../db/schema';
import { eq, desc, and, gte, sql } from 'drizzle-orm';

export default async function (fastify: FastifyInstance, opts: any) {
  // Get all models (only whitelisted ones shown in rankings)
  fastify.get('/', async () => {
    try {
      const allModels = await db.select().from(models).where(eq(models.showInRankings, true));
      
      // Add "new" badge logic - models are "new" for 7 days
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
      
      const modelsWithNewBadge = allModels.map(model => {
        const createdAt = model.createdAt ? new Date(model.createdAt) : null;
        const isNew = createdAt && createdAt > sevenDaysAgo;
        
        return {
          ...model,
          displayName: model.displayName || model.name, // Use displayName if available, fallback to name
          isNew: isNew || false
        };
      });
      
      return modelsWithNewBadge;
    } catch (error) {
      console.error('Error fetching models:', error);
      return [];
    }
  });

  // Get model details with period-specific score
  fastify.get('/:id', async (req: any, reply: any) => {
    const modelId = parseInt(req.params.id);
    
    // Validate modelId
    if (isNaN(modelId) || modelId <= 0) {
      reply.code(400);
      return { error: 'Invalid model ID' };
    }
    
    const period = req.query?.period as string || 'latest';
    
    try {
      const model = await db.select().from(models).where(eq(models.id, modelId)).limit(1);
      
      if (model.length === 0) {
        reply.code(404);
        return { error: 'Model not found' };
      }

      let latestScore;
      
      if (period === 'latest') {
        // Get absolute latest score
        latestScore = await db
          .select()
          .from(scores)
          .where(eq(scores.modelId, modelId))
          .orderBy(desc(scores.ts))
          .limit(1);
      } else {
        // Get latest score within the specified period
        const days = period === '24h' ? 1 : period === '7d' ? 7 : period === '1m' ? 30 : 1;
        const since = new Date();
        since.setDate(since.getDate() - days);
        const sinceStr = since.toISOString();
        
        latestScore = await db
          .select()
          .from(scores)
          .where(and(
            eq(scores.modelId, modelId),
            gte(scores.ts, sinceStr)
          ))
          .orderBy(desc(scores.ts))
          .limit(1);
      }

      // Add converted display score and fix axis mapping for frontend
      let latestScoreWithDisplay = null;
      if (latestScore[0]) {
        const rawScore = latestScore[0].stupidScore;
        let displayScore;
        
        // Use robust detection logic for score conversion
        if (Math.abs(rawScore) < 1 || Math.abs(rawScore) > 100) {
          // Raw format (e.g., 0.123, -0.456)
          displayScore = Math.max(0, Math.min(100, Math.round(50 - rawScore * 100)));
        } else {
          // Already in percentage-like format
          displayScore = Math.max(0, Math.min(100, Math.round(rawScore)));
        }
        
        // Fix axis mapping for frontend compatibility
        const axes = latestScore[0].axes as any;
        const mappedAxes = axes ? {
          correctness: axes.correctness || 0,
          spec: axes.complexity || axes.spec || 0,  // Map complexity to spec for frontend
          codeQuality: axes.codeQuality || 0,
          efficiency: axes.efficiency || 0,
          stability: axes.stability || 0,
          refusal: axes.edgeCases || axes.refusal || 0,  // Map edgeCases to refusal for frontend
          recovery: axes.debugging || axes.recovery || 0  // Map debugging to recovery for frontend
        } : {
          correctness: 0,
          spec: 0,
          codeQuality: 0,
          efficiency: 0,
          stability: 0,
          refusal: 0,
          recovery: 0
        };
        
        latestScoreWithDisplay = {
          ...latestScore[0],
          displayScore,
          axes: mappedAxes
        };
      }

      return {
        ...model[0],
        latestScore: latestScoreWithDisplay
      };
    } catch (error) {
      console.error('Error fetching model:', error);
      reply.code(500);
      return { 
        error: 'Internal server error while fetching model details',
        message: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  });

  // Get model historical scores (for charts) - ENHANCED with suite filtering
  fastify.get('/:id/history', async (req: any) => {
    const modelId = parseInt(req.params.id);
    const days = parseInt(req.query?.days as string) || 30;
    const period = req.query?.period || 'latest'; // Support period parameter
    const sortBy = req.query?.sortBy || 'combined'; // Support sortBy for mode filtering
    
    try {
      // Determine time threshold and data limit based on period
      let timeThreshold: Date;
      let dataLimit: number;
      let periodLabel: string;
      
      if (period === '24h' || days === 1) {
        timeThreshold = new Date(Date.now() - 24 * 60 * 60 * 1000);
        dataLimit = 48;
        periodLabel = '24 hours';
      } else if (period === '7d' || days === 7) {
        timeThreshold = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        dataLimit = 168;
        periodLabel = '7 days';
      } else if (period === '1m' || days === 30) {
        timeThreshold = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        dataLimit = 720;
        periodLabel = '30 days';
      } else if (period === 'latest') {
        if (sortBy === '7axis') {
          // For 7axis mode in latest, get ALL historical data
          timeThreshold = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
          dataLimit = 2000;
          periodLabel = 'all time';
        } else {
          // Default to 7 days for latest
          timeThreshold = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
          dataLimit = 168;
          periodLabel = 'latest (7 days)';
        }
      } else {
        // Fallback to days parameter
        timeThreshold = new Date();
        timeThreshold.setDate(timeThreshold.getDate() - days);
        dataLimit = days * 24; // Roughly hourly data
        periodLabel = `${days} days`;
      }
      
      // Build query based on sort mode (same logic as dashboard)
      let historyQuery;
      
      if (sortBy === 'reasoning') {
        // REASONING mode: Only deep benchmark scores
        console.log(`🧠 REASONING: Getting deep scores for model ${modelId}`);
        
        if (period === 'latest') {
          // For latest, get all available deep scores
          historyQuery = db
            .select({
              timestamp: scores.ts,
              stupidScore: scores.stupidScore,
              axes: scores.axes,
              note: scores.note,
              suite: scores.suite
            })
            .from(scores)
            .where(and(
              eq(scores.modelId, modelId),
              eq(scores.suite, 'deep')
            ))
            .orderBy(desc(scores.ts))
            .limit(100); // Deep benchmarks are rare
        } else {
          // For specific periods, filter by time
          historyQuery = db
            .select({
              timestamp: scores.ts,
              stupidScore: scores.stupidScore,
              axes: scores.axes,
              note: scores.note,
              suite: scores.suite
            })
            .from(scores)
            .where(and(
              eq(scores.modelId, modelId),
              eq(scores.suite, 'deep'),
              gte(scores.ts, timeThreshold.toISOString())
            ))
            .orderBy(desc(scores.ts))
            .limit(dataLimit);
        }
      } else if (sortBy === '7axis') {
        // 7AXIS mode: Only hourly/real-benchmark scores
        console.log(`📊 7AXIS: Getting hourly scores for model ${modelId}`);
        historyQuery = db
          .select({
            timestamp: scores.ts,
            stupidScore: scores.stupidScore,
            axes: scores.axes,
            note: scores.note,
            suite: scores.suite
          })
          .from(scores)
          .where(and(
            eq(scores.modelId, modelId),
            eq(scores.suite, 'hourly'),
            gte(scores.ts, timeThreshold.toISOString())
          ))
          .orderBy(desc(scores.ts))
          .limit(dataLimit);
      } else {
        // COMBINED/SPEED modes: Use hourly scores
        console.log(`⚡ ${sortBy.toUpperCase()}: Getting hourly scores for model ${modelId}`);
        historyQuery = db
          .select({
            timestamp: scores.ts,
            stupidScore: scores.stupidScore,
            axes: scores.axes,
            note: scores.note,
            suite: scores.suite
          })
          .from(scores)
          .where(and(
            eq(scores.modelId, modelId),
            eq(scores.suite, 'hourly'),
            gte(scores.ts, timeThreshold.toISOString())
          ))
          .orderBy(desc(scores.ts))
          .limit(dataLimit);
      }
      
      const historicalScores = await historyQuery;
      
      // Filter out invalid scores (same logic as dashboard)
      const filteredScores = historicalScores.filter(score => {
        return score.stupidScore !== null && 
               score.stupidScore !== -777 &&
               score.stupidScore !== -888 &&
               score.stupidScore !== -999 &&
               score.stupidScore >= 0;
      });
      
      // Convert scores to display format
      const formattedHistory = filteredScores.map(score => {
        const rawScore = score.stupidScore;
        let displayScore;
        
        // Use same conversion logic as dashboard
        const isUserTest = score.note && score.note.includes('User API key test');
        
        if (isUserTest) {
          displayScore = Math.max(0, Math.min(100, Math.round(100 - (rawScore / 0.8))));
        } else if (Math.abs(rawScore) < 1 && rawScore !== 0) {
          displayScore = Math.max(0, Math.min(100, Math.round(50 - rawScore * 100)));
        } else {
          displayScore = Math.max(0, Math.min(100, Math.round(rawScore)));
        }
        
        return {
          timestamp: score.timestamp,
          stupidScore: rawScore,
          displayScore,
          axes: score.axes,
          note: score.note,
          suite: score.suite
        };
      });
      
      console.log(`📊 History for model ${modelId} (${sortBy}, ${period}): ${formattedHistory.length} data points`);
      
      return {
        modelId,
        period: periodLabel,
        sortBy,
        dataPoints: formattedHistory.length,
        history: formattedHistory,
        timeRange: {
          from: timeThreshold.toISOString(),
          to: new Date().toISOString()
        }
      };
    } catch (error) {
      console.error('Error fetching model history:', error);
      return {
        modelId,
        period: `${days} days`,
        dataPoints: 0,
        history: []
      };
    }
  });

  // Get model performance breakdown by task with period filtering
  fastify.get('/:id/performance', async (req: any) => {
    const modelId = parseInt(req.params.id);
    const period = req.query?.period as string || 'latest';
    
    try {
      // Determine date filter based on period
      let whereClause;
      if (period === 'latest') {
        // Get all available data for latest view
        whereClause = eq(runs.modelId, modelId);
      } else {
        // Filter by period
        const days = period === '24h' ? 1 : period === '7d' ? 7 : period === '1m' ? 30 : 1;
        const since = new Date();
        since.setDate(since.getDate() - days);
        const sinceStr = since.toISOString();
        
        whereClause = and(
          eq(runs.modelId, modelId),
          gte(runs.ts, sinceStr)
        );
      }

      // Get runs with metrics within the specified period
      const recentRuns = await db
        .select({
          taskId: runs.taskId,
          taskSlug: tasks.slug,
          runId: runs.id,
          passed: runs.passed,
          latencyMs: runs.latencyMs,
          timestamp: runs.ts,
          correctness: metrics.correctness,
          spec: metrics.spec,
          codeQuality: metrics.codeQuality,
          efficiency: metrics.efficiency,
          stability: metrics.stability,
          refusal: metrics.refusal,
          recovery: metrics.recovery
        })
        .from(runs)
        .leftJoin(tasks, eq(runs.taskId, tasks.id))
        .leftJoin(metrics, eq(metrics.runId, runs.id))
        .where(whereClause)
        .orderBy(desc(runs.ts))
        .limit(period === 'latest' ? 50 : 100); // More data for period views

      // Group by task
      const taskPerformance = recentRuns.reduce((acc: any, run) => {
        const taskKey = run.taskSlug || `task-${run.taskId}`;
        
        if (!acc[taskKey]) {
          acc[taskKey] = {
            taskId: run.taskId,
            taskSlug: run.taskSlug,
            runs: [],
            averageMetrics: {
              correctness: 0,
              spec: 0,
              codeQuality: 0,
              efficiency: 0,
              stability: 0,
              refusal: 0,
              recovery: 0
            },
            successRate: 0
          };
        }
        
        acc[taskKey].runs.push(run);
        return acc;
      }, {});

      // Calculate averages
      Object.keys(taskPerformance).forEach(taskKey => {
        const task = taskPerformance[taskKey];
        const validRuns = task.runs.filter((r: any) => r.correctness !== null);
        
        if (validRuns.length > 0) {
          task.averageMetrics = {
            correctness: validRuns.reduce((sum: number, r: any) => sum + (r.correctness || 0), 0) / validRuns.length,
            spec: validRuns.reduce((sum: number, r: any) => sum + (r.spec || 0), 0) / validRuns.length,
            codeQuality: validRuns.reduce((sum: number, r: any) => sum + (r.codeQuality || 0), 0) / validRuns.length,
            efficiency: validRuns.reduce((sum: number, r: any) => sum + (r.efficiency || 0), 0) / validRuns.length,
            stability: validRuns.reduce((sum: number, r: any) => sum + (r.stability || 0), 0) / validRuns.length,
            refusal: validRuns.reduce((sum: number, r: any) => sum + (r.refusal || 0), 0) / validRuns.length,
            recovery: validRuns.reduce((sum: number, r: any) => sum + (r.recovery || 0), 0) / validRuns.length
          };
        }
        
        task.successRate = task.runs.filter((r: any) => r.passed).length / task.runs.length;
      });

      return {
        modelId,
        taskPerformance: Object.values(taskPerformance)
      };
    } catch (error) {
      console.error('Error fetching model performance:', error);
      return {
        modelId,
        taskPerformance: []
      };
    }
  });

  // Get model statistics summary with period filtering (matching dashboard logic)
  fastify.get('/:id/stats', async (req: any) => {
    const modelId = parseInt(req.params.id);
    const period = req.query?.period as string || 'latest';
    const sortBy = req.query?.sortBy as string || 'combined'; // FIXED: Respect scoring mode
    
    try {
      // FIXED: Use the SAME logic as dashboard to respect both period AND sortBy
      // Determine date filter and suite based on period and sortBy
      let whereClauseRuns, whereClauseScores;
      let dataPoints: number;
      let suiteFilter: string;
      
      // Determine suite based on sortBy (same as dashboard)
      if (sortBy === 'reasoning') {
        suiteFilter = 'deep';
      } else if (sortBy === 'tooling') {
        suiteFilter = 'tooling';
      } else if (sortBy === '7axis' || sortBy === 'speed') {
        suiteFilter = 'hourly';
      } else { // combined
        suiteFilter = 'hourly'; // For combined, we'll handle it specially below
      }
      
      if (period === 'latest') {
        // Get recent data for latest view
        whereClauseRuns = eq(runs.modelId, modelId);
        whereClauseScores = and(
          eq(scores.modelId, modelId),
          eq(scores.suite, suiteFilter)
        );
        dataPoints = 24; // Last 24 data points like dashboard
      } else {
        // Filter by period - use same logic as dashboard
        const days = period === '24h' ? 1 : period === '7d' ? 7 : period === '1m' ? 30 : 1;
        const since = new Date();
        since.setDate(since.getDate() - days);
        const sinceStr = since.toISOString();
        
        whereClauseRuns = and(
          eq(runs.modelId, modelId),
          gte(runs.ts, sinceStr)
        );
        whereClauseScores = and(
          eq(scores.modelId, modelId),
          eq(scores.suite, suiteFilter),
          gte(scores.ts, sinceStr)
        );
        dataPoints = period === '24h' ? 48 : period === '7d' ? 336 : 1440;
      }

      // FIXED: Use LATEST score logic to match dashboard (not period average)
      // Include tooling in combined score: 50% hourly + 25% deep + 25% tooling
      let currentDisplayScore = 0;
      
      if (sortBy === 'combined') {
        // Get LATEST hourly, deep, and tooling scores
        const latestHourlyScore = await db
          .select()
          .from(scores)
          .where(and(
            eq(scores.modelId, modelId),
            eq(scores.suite, 'hourly')
          ))
          .orderBy(desc(scores.ts))
          .limit(1);
        
        const latestDeepScore = await db
          .select()
          .from(scores)
          .where(and(
            eq(scores.modelId, modelId),
            eq(scores.suite, 'deep')
          ))
          .orderBy(desc(scores.ts))
          .limit(1);
        
        const latestToolingScore = await db
          .select()
          .from(scores)
          .where(and(
            eq(scores.modelId, modelId),
            eq(scores.suite, 'tooling')
          ))
          .orderBy(desc(scores.ts))
          .limit(1);
        
        const hourlyScore = latestHourlyScore[0];
        const deepScore = latestDeepScore[0];
        const toolingScore = latestToolingScore[0];
        
        // Check which scores are available
        const hasHourly = hourlyScore && hourlyScore.stupidScore !== null && hourlyScore.stupidScore >= 0;
        const hasDeep = deepScore && deepScore.stupidScore !== null && deepScore.stupidScore >= 0;
        const hasTooling = toolingScore && toolingScore.stupidScore !== null && toolingScore.stupidScore >= 0;
        
        if (hasHourly || hasDeep || hasTooling) {
          // Get display scores (0-100 range)
          const hourlyDisplay = hasHourly ? Math.max(0, Math.min(100, Math.round(hourlyScore.stupidScore))) : 50;
          const deepDisplay = hasDeep ? Math.max(0, Math.min(100, Math.round(deepScore.stupidScore))) : 50;
          const toolingDisplay = hasTooling ? Math.max(0, Math.min(100, Math.round(toolingScore.stupidScore))) : 50;
          
          // Combine LATEST scores with 50% hourly + 25% deep + 25% tooling weighting (matching dashboard)
          currentDisplayScore = Math.round(hourlyDisplay * 0.5 + deepDisplay * 0.25 + toolingDisplay * 0.25);
        }
      } else {
        // For non-combined modes, get LATEST score from the specific suite
        const latestScore = await db
          .select()
          .from(scores)
          .where(and(
            eq(scores.modelId, modelId),
            eq(scores.suite, suiteFilter)
          ))
          .orderBy(desc(scores.ts))
          .limit(1);

        if (latestScore.length > 0 && latestScore[0].stupidScore !== null && latestScore[0].stupidScore >= 0) {
          const rawScore = latestScore[0].stupidScore;
          
          // Use same robust detection logic as dashboard
          if (Math.abs(rawScore) < 1 || Math.abs(rawScore) > 100) {
            // Raw format (e.g., 0.123, -0.456)
            currentDisplayScore = Math.max(0, Math.min(100, Math.round(50 - rawScore * 100)));
          } else {
            // Already in percentage-like format
            currentDisplayScore = Math.max(0, Math.min(100, Math.round(rawScore)));
          }
        }
      }

      // Get total runs within period
      const totalRuns = await db
        .select({ count: sql`COUNT(*)` })
        .from(runs)
        .where(whereClauseRuns);

      // Get success rate within period
      const successfulRuns = await db
        .select({ count: sql`COUNT(*)` })
        .from(runs)
        .where(and(whereClauseRuns, eq(runs.passed, true)));

      // Get average metrics from runs within period
      const recentMetrics = await db
        .select({
          avgCorrectness: sql`AVG(${metrics.correctness})`,
          avgLatency: sql`AVG(${runs.latencyMs})`,
          totalRuns: sql`COUNT(*)`
        })
        .from(runs)
        .leftJoin(metrics, eq(metrics.runId, runs.id))
        .where(whereClauseRuns);

      const totalRunCount = Number(totalRuns[0]?.count || 0);
      const successCount = Number(successfulRuns[0]?.count || 0);
      const successRate = totalRunCount > 0 ? successCount / totalRunCount : 0;

      return {
        modelId,
        currentScore: currentDisplayScore, // Now period-specific AND mode-specific average!
        totalRuns: totalRunCount,
        successfulRuns: successCount,
        successRate: Math.round(successRate * 100),
        averageCorrectness: Number(recentMetrics[0]?.avgCorrectness || 0),
        averageLatency: Number(recentMetrics[0]?.avgLatency || 0),
        // Add debug info to understand the calculation
        debug: {
          period,
          sortBy,
          suite: suiteFilter,
          calculationMethod: sortBy === 'combined' ? 'combined-average' : 'period-average'
        }
      };
    } catch (error) {
      console.error('Error fetching model stats:', error);
      return {
        modelId,
        currentScore: 0,
        totalRuns: 0,
        successfulRuns: 0,
        successRate: 0,
        averageCorrectness: 0,
        averageLatency: 0
      };
    }
  });

  // Get hour-of-day performance analysis (Pro feature)
  fastify.get('/:id/hour-analysis', async (req: any, reply: any) => {
    const modelId = parseInt(req.params.id);
    const period = req.query?.period as string || '7d'; // 24h, 7d, 30d
    const suite = req.query?.suite as string || 'hourly'; // hourly, deep, tooling
    
    // Validate modelId
    if (isNaN(modelId) || modelId <= 0) {
      reply.code(400);
      return { error: 'Invalid model ID' };
    }
    
    // Validate suite
    const validSuites = ['hourly', 'deep', 'tooling'];
    if (!validSuites.includes(suite)) {
      reply.code(400);
      return { error: 'Invalid suite. Must be: hourly, deep, or tooling' };
    }
    
    try {
      // Determine time threshold based on period
      const now = new Date();
      const days = period === '24h' ? 1 : period === '7d' ? 7 : period === '30d' ? 30 : 7;
      const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
      const sinceStr = since.toISOString();
      
      console.log(`📊 Hour analysis for model ${modelId}, period ${period}, suite ${suite}`);
      
      // Score conversion helper
      const convertScore = (raw: number): number => {
        if (Math.abs(raw) < 1 && raw !== 0) {
          return Math.max(0, Math.min(100, Math.round(50 - raw * 100)));
        } else {
          return Math.max(0, Math.min(100, Math.round(raw)));
        }
      };
      
      // TIMELINE MODE for 24h: Last 24 hourly buckets (chronological)
      if (period === '24h') {
        console.log(`⏱️  Timeline mode: Fetching last 24 hours of data`);
        
        // Anchor to current UTC hour boundary
        const currentHourStart = new Date(Date.UTC(
          now.getUTCFullYear(),
          now.getUTCMonth(),
          now.getUTCDate(),
          now.getUTCHours(), 0, 0, 0
        ));
        
        // Calculate 24 hours ago from current hour start
        const startHourBoundary = new Date(currentHourStart.getTime() - 23 * 60 * 60 * 1000);
        
        console.log(`📍 Anchored to UTC hour boundaries: ${startHourBoundary.toISOString()} to ${currentHourStart.toISOString()}`);
        
        // Fetch raw rows from last 24 hours without hour-of-day grouping
        const rawRows = await db
          .select({
            ts: scores.ts,
            stupidScore: scores.stupidScore
          })
          .from(scores)
          .where(and(
            eq(scores.modelId, modelId),
            eq(scores.suite, suite),
            gte(scores.ts, startHourBoundary.toISOString()),
            sql`${scores.stupidScore} >= 0`,
            sql`${scores.stupidScore} IS NOT NULL`,
            sql`${scores.ts} IS NOT NULL`
          ))
          .orderBy(scores.ts);
        
        console.log(`📊 Found ${rawRows.length} raw data points in last 24 hours`);
        
        // Bucket by UTC hour timestamp
        const bucketMap = new Map<string, number[]>();
        
        for (const row of rawRows) {
          if (!row.ts) continue; // Skip null timestamps
          const d = new Date(row.ts);
          const hourStart = new Date(Date.UTC(
            d.getUTCFullYear(),
            d.getUTCMonth(),
            d.getUTCDate(),
            d.getUTCHours(), 0, 0, 0
          ));
          const key = hourStart.toISOString();
          const arr = bucketMap.get(key) ?? [];
          arr.push(row.stupidScore);
          bucketMap.set(key, arr);
        }
        
        console.log(`🗂️  Grouped into ${bucketMap.size} hour buckets`);
        
        // Build EXACTLY 24 hourly buckets (anchored to hour boundaries)
        // Start from 23 hours ago to current hour (inclusive)
        const hourBuckets = [];
        for (let i = 0; i < 24; i++) {
          const hourStart = new Date(startHourBoundary.getTime() + i * 60 * 60 * 1000);
          const key = hourStart.toISOString();
          const vals = bucketMap.get(key) ?? [];
          
          const avg = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
          const min = vals.length ? Math.min(...vals) : null;
          const max = vals.length ? Math.max(...vals) : null;
          
          hourBuckets.push({
            ts: key,
            label: `${String(hourStart.getUTCHours()).padStart(2, '0')}:00`,
            avg: avg !== null ? convertScore(avg) : null,
            min: min !== null ? convertScore(min) : null,
            max: max !== null ? convertScore(max) : null,
            count: vals.length
          });
        }
        
        console.log(`✅ Returning ${hourBuckets.length} buckets (${hourBuckets.filter(b => b.count > 0).length} with data, ${hourBuckets.filter(b => b.count === 0).length} empty)`);
        
        // Calculate insights for timeline mode
        const validBuckets = hourBuckets.filter(b => b.avg !== null);
        
        if (validBuckets.length === 0) {
          return {
            mode: 'timeline',
            modelId,
            period,
            suite,
            hours: hourBuckets,
            insights: {
              bestHour: null,
              bestScore: null,
              worstHour: null,
              worstScore: null,
              avgScore: null,
              coverage: 0,
              dataPoints: 0,
              variance: 0,
              recommendation: 'No data available for the last 24 hours. Benchmarks may not have run yet for this model and suite combination.'
            }
          };
        }
        
        const bestBucket = validBuckets.reduce((best, current) =>
          (current.avg! > best.avg!) ? current : best
        );
        
        const worstBucket = validBuckets.reduce((worst, current) =>
          (current.avg! < worst.avg!) ? current : worst
        );
        
        const totalAvg = validBuckets.reduce((sum, b) => sum + b.avg!, 0) / validBuckets.length;
        const totalDataPoints = validBuckets.reduce((sum, b) => sum + b.count, 0);
        const coverage = (validBuckets.length / 24) * 100;
        const variance = bestBucket.avg! - worstBucket.avg!;
        
        const suiteLabel = suite === 'hourly' ? 'speed tests' : suite === 'deep' ? 'reasoning tests' : 'tool calling tests';
        
        let recommendation: string;
        if (coverage < 50) {
          recommendation = `Limited data over the past 24 hours (${Math.round(coverage)}% coverage). For ${suiteLabel}, benchmarks may not have run during all hours yet. Wait for more data or check 7-day view.`;
        } else if (variance > 10) {
          recommendation = `Over the past 24 hours, performance peaked at ${bestBucket.label} UTC (score: ${bestBucket.avg!.toFixed(1)}) and dipped at ${worstBucket.label} UTC (score: ${worstBucket.avg!.toFixed(1)}). This ${variance.toFixed(1)}-point variance suggests time-of-day sensitivity. Monitor for pattern consistency.`;
        } else if (variance > 5) {
          recommendation = `Over the past 24 hours, performance shows moderate variation (${variance.toFixed(1)} points). Peak: ${bestBucket.label} UTC. This pattern needs more data to confirm consistency—check 7-day view.`;
        } else {
          recommendation = `Performance is remarkably consistent over the past 24 hours (variance: ${variance.toFixed(1)} points). Time-of-day has minimal impact on this model's ${suiteLabel} performance. Extend to 7-day view to confirm pattern stability.`;
        }
        
        return {
          mode: 'timeline',
          modelId,
          period,
          suite,
          hours: hourBuckets,
          insights: {
            bestHour: bestBucket.label,
            bestScore: bestBucket.avg,
            worstHour: worstBucket.label,
            worstScore: worstBucket.avg,
            avgScore: Math.round(totalAvg),
            coverage: Math.round(coverage),
            dataPoints: totalDataPoints,
            variance: Math.round(variance),
            recommendation
          }
        };
      }
      
      // HOUR-OF-DAY MODE for 7d/30d: Aggregated by hour (0-23)
      console.log(`📊 Hour-of-day mode: Aggregating across ${days} days`);
      
      const hourlyData = await db
        .select({
          hour: sql<number>`CAST(strftime('%H', ${scores.ts}) AS INTEGER)`,
          avgScore: sql<number>`AVG(${scores.stupidScore})`,
          minScore: sql<number>`MIN(${scores.stupidScore})`,
          maxScore: sql<number>`MAX(${scores.stupidScore})`,
          count: sql<number>`COUNT(*)`
        })
        .from(scores)
        .where(and(
          eq(scores.modelId, modelId),
          eq(scores.suite, suite),
          gte(scores.ts, sinceStr),
          sql`${scores.stupidScore} >= 0`,
          sql`${scores.stupidScore} IS NOT NULL`
        ))
        .groupBy(sql`CAST(strftime('%H', ${scores.ts}) AS INTEGER)`)
        .orderBy(sql`CAST(strftime('%H', ${scores.ts}) AS INTEGER)`);
      
      // Create array with all 24 hours (fill missing hours with nulls)
      const hourBuckets = Array.from({ length: 24 }, (_, hour) => {
        const data = hourlyData.find(d => d.hour === hour);
        
        if (!data || data.count === 0) {
          return {
            hour,
            avg: null,
            min: null,
            max: null,
            count: 0
          };
        }
        
        return {
          hour,
          avg: convertScore(data.avgScore),
          min: convertScore(data.minScore),
          max: convertScore(data.maxScore),
          count: data.count
        };
      });
      
      // Calculate insights
      const validBuckets = hourBuckets.filter(b => b.avg !== null);
      
      if (validBuckets.length === 0) {
        return {
          modelId,
          period,
          suite,
          hours: hourBuckets,
          insights: {
            bestHour: null,
            bestScore: null,
            worstHour: null,
            worstScore: null,
            avgScore: null,
            coverage: 0,
            dataPoints: 0,
            variance: 0,
            recommendation: 'No data available for this model and suite combination. Try selecting a different benchmark suite or time period.'
          }
        };
      }
      
      const bestHour = validBuckets.reduce((best, current) =>
        (current.avg! > best.avg!) ? current : best
      );
      
      const worstHour = validBuckets.reduce((worst, current) =>
        (current.avg! < worst.avg!) ? current : worst
      );
      
      const totalAvg = validBuckets.reduce((sum, b) => sum + b.avg!, 0) / validBuckets.length;
      const totalDataPoints = validBuckets.reduce((sum, b) => sum + b.count, 0);
      const coverage = (validBuckets.length / 24) * 100;
      const variance = bestHour.avg! - worstHour.avg!;
      
      // Generate period-aware recommendation
      const periodLabel = period === '24h' ? 'the past 24 hours' : period === '7d' ? 'the past 7 days' : 'the past 30 days';
      const suiteLabel = suite === 'hourly' ? 'speed tests' : suite === 'deep' ? 'reasoning tests' : 'tool calling tests';
      
      let recommendation: string;
      
      if (coverage < 50) {
        // Low data coverage
        if (period === '24h') {
          recommendation = `Limited data over ${periodLabel}. For ${suiteLabel}, hourly benchmarks may not have run during all hours yet. Try viewing 7-day or 30-day periods for better coverage.`;
        } else if (suite === 'deep') {
          recommendation = `Reasoning tests run daily at 3:00 AM UTC, providing limited hour-of-day coverage. For comprehensive hourly patterns, use the Speed Tests suite which runs every hour.`;
        } else if (suite === 'tooling') {
          recommendation = `Tool calling tests run daily at 4:00 AM UTC, providing limited hour-of-day coverage. For comprehensive hourly patterns, use the Speed Tests suite which runs every hour.`;
        } else {
          recommendation = `Insufficient data coverage (${Math.round(coverage)}%) over ${periodLabel}. Consider using the Speed Tests suite for hourly data collection.`;
        }
      } else if (variance > 10) {
        // Significant variance detected
        const scoreDir = bestHour.avg! > 75 ? 'peak' : 'optimal';
        if (period === '24h') {
          recommendation = `Over ${periodLabel}, performance peaked at ${bestHour.hour}:00 UTC (score: ${bestHour.avg!.toFixed(1)}) and dipped at ${worstHour.hour}:00 UTC (score: ${worstHour.avg!.toFixed(1)}). This ${variance.toFixed(1)}-point variance suggests time-of-day sensitivity. Monitor for pattern consistency.`;
        } else if (period === '7d') {
          recommendation = `Weekly analysis shows ${scoreDir} performance consistently around ${bestHour.hour}:00 UTC (avg: ${bestHour.avg!.toFixed(1)}) and lower performance around ${worstHour.hour}:00 UTC (avg: ${worstHour.avg!.toFixed(1)}). Consider scheduling critical workloads during peak hours for +${variance.toFixed(1)} points.`;
        } else { // 30d
          recommendation = `Monthly trend analysis reveals ${scoreDir} performance at ${bestHour.hour}:00 UTC (${bestHour.avg!.toFixed(1)}) vs ${worstHour.hour}:00 UTC (${worstHour.avg!.toFixed(1)}). This ${variance.toFixed(1)}-point pattern is stable over ${periodLabel}, indicating reliable time-based scheduling opportunities.`;
        }
      } else if (variance > 5) {
        // Moderate variance
        if (period === '24h') {
          recommendation = `Over ${periodLabel}, performance shows moderate variation (${variance.toFixed(1)} points). Peak: ${bestHour.hour}:00 UTC. This pattern needs more data to confirm consistency—check 7-day view.`;
        } else {
          recommendation = `Performance over ${periodLabel} shows moderate time-of-day variation (${variance.toFixed(1)} points). Best hour: ${bestHour.hour}:00 UTC (${bestHour.avg!.toFixed(1)}), worst: ${worstHour.hour}:00 UTC (${worstHour.avg!.toFixed(1)}). Pattern is noticeable but not critical for scheduling decisions.`;
        }
      } else {
        // Low variance - consistent performance
        if (period === '24h') {
          recommendation = `Performance is remarkably consistent over ${periodLabel} (variance: ${variance.toFixed(1)} points). Time-of-day has minimal impact on this model's ${suiteLabel} performance. Extend to 7-day view to confirm pattern stability.`;
        } else if (period === '7d') {
          recommendation = `Seven-day analysis shows consistent performance across all hours (variance: ${variance.toFixed(1)} points, avg: ${totalAvg.toFixed(1)}). This model's ${suiteLabel} performance is time-independent—schedule workloads anytime without performance concerns.`;
        } else { // 30d
          recommendation = `Monthly analysis confirms highly stable performance (variance: only ${variance.toFixed(1)} points over ${totalDataPoints} tests). This model delivers consistent ${suiteLabel} results regardless of time-of-day. Excellent for predictable workload scheduling.`;
        }
      }
      
      return {
        mode: 'hourOfDay',
        modelId,
        period,
        suite,
        hours: hourBuckets,
        insights: {
          bestHour: bestHour.hour,
          bestScore: bestHour.avg,
          worstHour: worstHour.hour,
          worstScore: worstHour.avg,
          avgScore: Math.round(totalAvg),
          coverage: Math.round(coverage),
          dataPoints: totalDataPoints,
          variance: Math.round(variance),
          recommendation
        }
      };
    } catch (error) {
      console.error('Error fetching hour analysis:', error);
      reply.code(500);
      return {
        error: 'Internal server error while fetching hour analysis',
        message: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  });
}
