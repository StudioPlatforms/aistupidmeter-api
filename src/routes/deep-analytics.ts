import { FastifyInstance } from 'fastify';
import { db } from '../db/index';
import { deep_sessions, deep_alerts, models, scores } from '../db/schema';
import { eq, desc, gte, and, sql } from 'drizzle-orm';

export default async function (fastify: FastifyInstance, opts: any) {
  // GET /api/deep-analytics/overview
  fastify.get('/overview', async (req: any, res: any) => {
    try {
      const period = req.query.period || '24h';
      
      // Calculate cutoff time
      const now = new Date();
      let cutoffTime: string;
      
      switch (period) {
        case '24h':
          cutoffTime = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
          break;
        case '7d':
          cutoffTime = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
          break;
        case '1m':
          cutoffTime = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
          break;
        default: // 'latest'
          cutoffTime = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
      }
      
      // Get recent deep sessions with model info
      const recentSessions = await db
        .select({
          id: deep_sessions.id,
          modelId: deep_sessions.modelId,
          modelName: models.name,
          vendor: models.vendor,
          taskSlug: deep_sessions.taskSlug,
          finalScore: deep_sessions.finalScore,
          turns: deep_sessions.turns,
          passed: deep_sessions.passed,
          ts: deep_sessions.ts
        })
        .from(deep_sessions)
        .innerJoin(models, eq(deep_sessions.modelId, models.id))
        .where(gte(deep_sessions.ts, cutoffTime))
        .orderBy(desc(deep_sessions.ts))
        .limit(50);
      
      // Get recent deep alerts
      const recentAlerts = await db
        .select({
          id: deep_alerts.id,
          modelId: deep_alerts.modelId,
          modelName: models.name,
          vendor: models.vendor,
          level: deep_alerts.level,
          message: deep_alerts.message,
          context: deep_alerts.context,
          ts: deep_alerts.ts
        })
        .from(deep_alerts)
        .innerJoin(models, eq(deep_alerts.modelId, models.id))
        .where(gte(deep_alerts.ts, cutoffTime))
        .orderBy(desc(deep_alerts.ts))
        .limit(10);
      
      // Calculate performance metrics
      const totalSessions = recentSessions.length;
      const passedSessions = recentSessions.filter(s => s.passed).length;
      const avgScore = totalSessions > 0 ? 
        Math.round(recentSessions.reduce((sum, s) => sum + s.finalScore, 0) / totalSessions) : 0;
      
      // Group by task type
      const taskPerformance = recentSessions.reduce((acc: any, session) => {
        if (!acc[session.taskSlug]) {
          acc[session.taskSlug] = {
            taskSlug: session.taskSlug,
            totalSessions: 0,
            passedSessions: 0,
            avgScore: 0,
            scores: []
          };
        }
        
        acc[session.taskSlug].totalSessions++;
        if (session.passed) {
          acc[session.taskSlug].passedSessions++;
        }
        acc[session.taskSlug].scores.push(session.finalScore);
        
        return acc;
      }, {});
      
      // Calculate averages for each task
      Object.values(taskPerformance).forEach((task: any) => {
        task.avgScore = task.scores.length > 0 ? 
          Math.round(task.scores.reduce((sum: number, score: number) => sum + score, 0) / task.scores.length) : 0;
        task.successRate = task.totalSessions > 0 ? 
          Math.round((task.passedSessions / task.totalSessions) * 100) : 0;
        delete task.scores; // Remove raw scores from response
      });
      
      // Group by model
      const modelPerformance = recentSessions.reduce((acc: any, session) => {
        if (!acc[session.modelId]) {
          acc[session.modelId] = {
            modelId: session.modelId,
            modelName: session.modelName,
            vendor: session.vendor,
            totalSessions: 0,
            passedSessions: 0,
            avgScore: 0,
            scores: []
          };
        }
        
        acc[session.modelId].totalSessions++;
        if (session.passed) {
          acc[session.modelId].passedSessions++;
        }
        acc[session.modelId].scores.push(session.finalScore);
        
        return acc;
      }, {});
      
      // Calculate averages for each model
      Object.values(modelPerformance).forEach((model: any) => {
        model.avgScore = model.scores.length > 0 ? 
          Math.round(model.scores.reduce((sum: number, score: number) => sum + score, 0) / model.scores.length) : 0;
        model.successRate = model.totalSessions > 0 ? 
          Math.round((model.passedSessions / model.totalSessions) * 100) : 0;
        delete model.scores; // Remove raw scores from response
      });
      
      return {
        success: true,
        data: {
          summary: {
            totalSessions,
            passedSessions,
            successRate: totalSessions > 0 ? Math.round((passedSessions / totalSessions) * 100) : 0,
            avgScore,
            period
          },
          taskPerformance: Object.values(taskPerformance),
          modelPerformance: Object.values(modelPerformance),
          recentAlerts: recentAlerts.map(alert => ({
            ...alert,
            context: alert.context ? (typeof alert.context === 'string' ? JSON.parse(alert.context) : alert.context) : null
          })),
          lastUpdated: new Date()
        }
      };
    } catch (error) {
      console.error('Error fetching deep analytics overview:', error);
      return {
        success: false,
        error: 'Failed to fetch deep analytics overview'
      };
    }
  });

  // GET /api/deep-analytics/task-breakdown
  fastify.get('/task-breakdown', async (req: any, res: any) => {
    try {
      const period = req.query.period || '24h';
      const taskSlug = req.query.taskSlug;
      
      // Calculate cutoff time
      const now = new Date();
      let cutoffTime: string;
      
      switch (period) {
        case '24h':
          cutoffTime = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
          break;
        case '7d':
          cutoffTime = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
          break;
        case '1m':
          cutoffTime = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
          break;
        default:
          cutoffTime = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
      }
      
      // Build where conditions
      const whereConditions = [gte(deep_sessions.ts, cutoffTime)];
      if (taskSlug) {
        whereConditions.push(eq(deep_sessions.taskSlug, taskSlug));
      }
      
      // Get detailed session data
      const sessions = await db
        .select({
          id: deep_sessions.id,
          modelId: deep_sessions.modelId,
          modelName: models.name,
          vendor: models.vendor,
          taskSlug: deep_sessions.taskSlug,
          finalScore: deep_sessions.finalScore,
          turns: deep_sessions.turns,
          passed: deep_sessions.passed,
          conversationData: deep_sessions.conversationData,
          stepResults: deep_sessions.stepResults,
          ts: deep_sessions.ts
        })
        .from(deep_sessions)
        .innerJoin(models, eq(deep_sessions.modelId, models.id))
        .where(and(...whereConditions))
        .orderBy(desc(deep_sessions.ts))
        .limit(100);
      
      return {
        success: true,
        data: {
          sessions: sessions.map(session => ({
            ...session,
            conversationData: session.conversationData ? (typeof session.conversationData === 'string' ? JSON.parse(session.conversationData) : session.conversationData) : null,
            stepResults: session.stepResults ? (typeof session.stepResults === 'string' ? JSON.parse(session.stepResults) : session.stepResults) : null
          })),
          period,
          taskSlug: taskSlug || 'all',
          lastUpdated: new Date()
        }
      };
    } catch (error) {
      console.error('Error fetching task breakdown:', error);
      return {
        success: false,
        error: 'Failed to fetch task breakdown'
      };
    }
  });
}
