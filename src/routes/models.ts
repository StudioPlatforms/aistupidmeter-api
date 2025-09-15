import { FastifyInstance } from 'fastify';
import { db } from '../db/index';
import { models, scores, runs, metrics, tasks } from '../db/schema';
import { eq, desc, and, gte, sql } from 'drizzle-orm';

export default async function (fastify: FastifyInstance, opts: any) {
  // Get all models
  fastify.get('/', async () => {
    try {
      const allModels = await db.select().from(models);
      
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
  fastify.get('/:id', async (req: any) => {
    const modelId = parseInt(req.params.id);
    const period = req.query?.period as string || 'latest';
    
    try {
      const model = await db.select().from(models).where(eq(models.id, modelId)).limit(1);
      if (model.length === 0) return null;

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
      return null;
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
    
    try {
      // Determine date filter based on period
      let whereClauseRuns, whereClauseScores;
      let dataPoints: number;
      
      if (period === 'latest') {
        // Get recent data for latest view
        whereClauseRuns = eq(runs.modelId, modelId);
        whereClauseScores = eq(scores.modelId, modelId);
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
          gte(scores.ts, sinceStr)
        );
        dataPoints = period === '24h' ? 48 : period === '7d' ? 336 : 1440;
      }

      // Get ALL scores within period (not just latest) - matching dashboard approach
      const allScoresInPeriod = await db
        .select()
        .from(scores)
        .where(whereClauseScores)
        .orderBy(desc(scores.ts))
        .limit(dataPoints);

      // Filter out null scores like dashboard does
      const validScores = allScoresInPeriod.filter(s => s.stupidScore !== null);

      // Calculate period average score (matching dashboard logic)
      let currentDisplayScore = 0;
      if (validScores.length > 0) {
        // Convert all scores to display format and average them
        const convertedScores = validScores.map(score => {
          const rawScore = score.stupidScore;
          
          // Use same robust detection logic as dashboard
          if (Math.abs(rawScore) < 1 || Math.abs(rawScore) > 100) {
            // Raw format (e.g., 0.123, -0.456)
            return Math.max(0, Math.min(100, Math.round(50 - rawScore * 100)));
          } else {
            // Already in percentage-like format
            return Math.max(0, Math.min(100, Math.round(rawScore)));
          }
        });

        // Calculate period average - this is what makes periods different!
        currentDisplayScore = Math.round(
          convertedScores.reduce((sum, score) => sum + score, 0) / convertedScores.length
        );
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
        currentScore: currentDisplayScore, // Now period-specific average!
        totalRuns: totalRunCount,
        successfulRuns: successCount,
        successRate: Math.round(successRate * 100),
        averageCorrectness: Number(recentMetrics[0]?.avgCorrectness || 0),
        averageLatency: Number(recentMetrics[0]?.avgLatency || 0),
        // Add debug info to understand the calculation
        debug: {
          period,
          validScoresCount: validScores.length,
          calculationMethod: 'period-average'
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
}
