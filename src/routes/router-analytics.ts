import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { db } from '../db/connection-pool';
import { routerRequests, routerUsage, routerModelRankings } from '../db/router-schema';
import { eq, and, gte, lte, sql, desc } from 'drizzle-orm';

// Temporary auth - will be replaced with proper NextAuth
interface AuthRequest extends FastifyRequest {
  userId?: number;
}

// Middleware to extract userId (temporary - will use NextAuth session)
async function requireAuth(request: AuthRequest, reply: FastifyReply) {
  const userId = request.headers['x-user-id'];
  
  if (!userId) {
    return reply.code(401).send({
      error: 'Unauthorized',
      message: 'User authentication required'
    });
  }
  
  request.userId = parseInt(userId as string);
}

export default async function routerAnalyticsRoutes(fastify: FastifyInstance) {
  
  /**
   * GET /router/analytics/overview
   * Get overview statistics for the user
   */
  fastify.get('/router/analytics/overview', {
    preHandler: requireAuth
  }, async (request: AuthRequest, reply) => {
    try {
      // Get total requests
      const totalRequests = await db
        .select({ count: sql<number>`count(*)` })
        .from(routerRequests)
        .where(eq(routerRequests.user_id, request.userId!));
      
      // Get successful requests
      const successfulRequests = await db
        .select({ count: sql<number>`count(*)` })
        .from(routerRequests)
        .where(
          and(
            eq(routerRequests.user_id, request.userId!),
            eq(routerRequests.success, true)
          )
        );
      
      // Get total tokens
      const tokenStats = await db
        .select({
          totalIn: sql<number>`sum(${routerRequests.tokens_in})`,
          totalOut: sql<number>`sum(${routerRequests.tokens_out})`
        })
        .from(routerRequests)
        .where(eq(routerRequests.user_id, request.userId!));
      
      // Get total cost
      const costStats = await db
        .select({
          totalCost: sql<number>`sum(${routerRequests.cost_estimate})`
        })
        .from(routerRequests)
        .where(eq(routerRequests.user_id, request.userId!));
      
      // Get provider distribution
      const providerStats = await db
        .select({
          provider: routerRequests.selected_provider,
          count: sql<number>`count(*)`,
          totalCost: sql<number>`sum(${routerRequests.cost_estimate})`
        })
        .from(routerRequests)
        .where(eq(routerRequests.user_id, request.userId!))
        .groupBy(routerRequests.selected_provider);
      
      // Get model distribution
      const modelStats = await db
        .select({
          model: routerRequests.selected_model,
          count: sql<number>`count(*)`,
          totalCost: sql<number>`sum(${routerRequests.cost_estimate})`
        })
        .from(routerRequests)
        .where(eq(routerRequests.user_id, request.userId!))
        .groupBy(routerRequests.selected_model)
        .orderBy(desc(sql`count(*)`))
        .limit(10);
      
      // Note: routing_strategy not in schema, skip this for now
      const strategyStats: any[] = [];
      
      return {
        overview: {
          totalRequests: totalRequests[0]?.count || 0,
          successfulRequests: successfulRequests[0]?.count || 0,
          successRate: totalRequests[0]?.count 
            ? ((successfulRequests[0]?.count || 0) / totalRequests[0].count * 100).toFixed(2)
            : '0.00',
          totalTokensIn: tokenStats[0]?.totalIn || 0,
          totalTokensOut: tokenStats[0]?.totalOut || 0,
          totalTokens: (tokenStats[0]?.totalIn || 0) + (tokenStats[0]?.totalOut || 0),
          totalCost: (costStats[0]?.totalCost || 0).toFixed(4)
        },
        providers: providerStats.map(p => ({
          provider: p.provider,
          requests: p.count,
          totalCost: (p.totalCost || 0).toFixed(4),
          percentage: totalRequests[0]?.count 
            ? ((p.count / totalRequests[0].count) * 100).toFixed(2)
            : '0.00'
        })),
        topModels: modelStats.map(m => ({
          model: m.model,
          requests: m.count,
          totalCost: (m.totalCost || 0).toFixed(4),
          percentage: totalRequests[0]?.count 
            ? ((m.count / totalRequests[0].count) * 100).toFixed(2)
            : '0.00'
        })),
        strategies: strategyStats.map(s => ({
          strategy: s.strategy,
          requests: s.count,
          percentage: totalRequests[0]?.count 
            ? ((s.count / totalRequests[0].count) * 100).toFixed(2)
            : '0.00'
        }))
      };
    } catch (error: any) {
      console.error('Failed to get analytics overview:', error);
      return reply.code(500).send({
        error: 'Failed to get analytics overview',
        message: error.message
      });
    }
  });
  
  /**
   * GET /router/analytics/timeline
   * Get usage timeline (daily/hourly breakdown)
   */
  fastify.get<{
    Querystring: { period?: string; days?: string }
  }>('/router/analytics/timeline', {
    preHandler: requireAuth
  }, async (request: AuthRequest, reply) => {
    try {
      const query = request.query as { period?: string; days?: string };
      const period = query.period || 'daily'; // 'hourly' or 'daily'
      const days = parseInt(query.days || '30');
      
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - days);
      
      let timeFormat: string;
      if (period === 'hourly') {
        timeFormat = '%Y-%m-%d %H:00:00';
      } else {
        timeFormat = '%Y-%m-%d';
      }
      
      const timeline = await db
        .select({
          period: sql<string>`strftime(${timeFormat}, ${routerRequests.created_at})`,
          requests: sql<number>`count(*)`,
          successfulRequests: sql<number>`sum(case when ${routerRequests.success} = 1 then 1 else 0 end)`,
          tokensIn: sql<number>`sum(${routerRequests.tokens_in})`,
          tokensOut: sql<number>`sum(${routerRequests.tokens_out})`,
          cost: sql<number>`sum(${routerRequests.cost_estimate})`
        })
        .from(routerRequests)
        .where(
          and(
            eq(routerRequests.user_id, request.userId!),
            gte(routerRequests.created_at, startDate.toISOString())
          )
        )
        .groupBy(sql`strftime(${timeFormat}, ${routerRequests.created_at})`)
        .orderBy(sql`strftime(${timeFormat}, ${routerRequests.created_at})`);
      
      return {
        period,
        days,
        timeline: timeline.map(t => ({
          period: t.period,
          requests: t.requests,
          successfulRequests: t.successfulRequests,
          successRate: t.requests 
            ? ((t.successfulRequests / t.requests) * 100).toFixed(2)
            : '0.00',
          tokensIn: t.tokensIn || 0,
          tokensOut: t.tokensOut || 0,
          totalTokens: (t.tokensIn || 0) + (t.tokensOut || 0),
          cost: (t.cost || 0).toFixed(4)
        }))
      };
    } catch (error: any) {
      console.error('Failed to get timeline:', error);
      return reply.code(500).send({
        error: 'Failed to get timeline',
        message: error.message
      });
    }
  });
  
  /**
   * GET /router/analytics/cost-savings
   * Calculate cost savings compared to always using most expensive model
   */
  fastify.get('/router/analytics/cost-savings', {
    preHandler: requireAuth
  }, async (request: AuthRequest, reply) => {
    try {
      // Get all requests with token counts
      const requests = await db
        .select({
          tokensIn: routerRequests.tokens_in,
          tokensOut: routerRequests.tokens_out,
          actualCost: routerRequests.cost_estimate
        })
        .from(routerRequests)
        .where(
          and(
            eq(routerRequests.user_id, request.userId!),
            eq(routerRequests.success, true)
          )
        );
      
      if (requests.length === 0) {
        return {
          actualCost: 0,
          worstCaseCost: 0,
          savings: 0,
          savingsPercentage: 0,
          message: 'No requests yet'
        };
      }
      
      // Calculate actual cost
      const actualCost = requests.reduce((sum, r) => sum + (r.actualCost || 0), 0);
      
      // Calculate worst case cost (if always used GPT-4o at $0.005/1k input, $0.015/1k output)
      const worstCaseCost = requests.reduce((sum, r) => {
        const inputCost = (r.tokensIn || 0) / 1000 * 0.005;
        const outputCost = (r.tokensOut || 0) / 1000 * 0.015;
        return sum + inputCost + outputCost;
      }, 0);
      
      const savings = worstCaseCost - actualCost;
      const savingsPercentage = worstCaseCost > 0 
        ? (savings / worstCaseCost * 100)
        : 0;
      
      return {
        actualCost: actualCost.toFixed(4),
        worstCaseCost: worstCaseCost.toFixed(4),
        savings: savings.toFixed(4),
        savingsPercentage: savingsPercentage.toFixed(2),
        totalRequests: requests.length,
        averageCostPerRequest: (actualCost / requests.length).toFixed(6)
      };
    } catch (error: any) {
      console.error('Failed to calculate cost savings:', error);
      return reply.code(500).send({
        error: 'Failed to calculate cost savings',
        message: error.message
      });
    }
  });
  
  /**
   * GET /router/analytics/recent-requests
   * Get recent requests with details
   */
  fastify.get<{
    Querystring: { limit?: string; offset?: string }
  }>('/router/analytics/recent-requests', {
    preHandler: requireAuth
  }, async (request: AuthRequest, reply) => {
    try {
      const query = request.query as { limit?: string; offset?: string };
      const limit = parseInt(query.limit || '50');
      const offset = parseInt(query.offset || '0');
      
      const requests = await db
        .select({
          id: routerRequests.id,
          selectedProvider: routerRequests.selected_provider,
          selectedModel: routerRequests.selected_model,
          routingReason: routerRequests.routing_reason,
          tokensIn: routerRequests.tokens_in,
          tokensOut: routerRequests.tokens_out,
          costEstimate: routerRequests.cost_estimate,
          latencyMs: routerRequests.latency_ms,
          success: routerRequests.success,
          errorMessage: routerRequests.error_message,
          createdAt: routerRequests.created_at
        })
        .from(routerRequests)
        .where(eq(routerRequests.user_id, request.userId!))
        .orderBy(desc(routerRequests.created_at))
        .limit(limit)
        .offset(offset);
      
      // Get total count for pagination
      const totalCount = await db
        .select({ count: sql<number>`count(*)` })
        .from(routerRequests)
        .where(eq(routerRequests.user_id, request.userId!));
      
      return {
        requests: requests.map(r => ({
          id: r.id,
          provider: r.selectedProvider,
          model: r.selectedModel,
          reason: r.routingReason,
          tokensIn: r.tokensIn || 0,
          tokensOut: r.tokensOut || 0,
          totalTokens: (r.tokensIn || 0) + (r.tokensOut || 0),
          cost: (r.costEstimate || 0).toFixed(6),
          latency: r.latencyMs,
          success: r.success,
          error: r.errorMessage,
          timestamp: r.createdAt
        })),
        pagination: {
          total: totalCount[0]?.count || 0,
          limit,
          offset,
          hasMore: (offset + limit) < (totalCount[0]?.count || 0)
        }
      };
    } catch (error: any) {
      console.error('Failed to get recent requests:', error);
      return reply.code(500).send({
        error: 'Failed to get recent requests',
        message: error.message
      });
    }
  });
  
  /**
   * GET /router/analytics/monthly-usage
   * Get monthly usage summary
   */
  fastify.get<{
    Querystring: { year?: string; month?: string }
  }>('/router/analytics/monthly-usage', {
    preHandler: requireAuth
  }, async (request: AuthRequest, reply) => {
    try {
      const query = request.query as { year?: string; month?: string };
      const year = parseInt(query.year || new Date().getFullYear().toString());
      const month = parseInt(query.month || (new Date().getMonth() + 1).toString());
      
      const monthStr = `${year}-${month.toString().padStart(2, '0')}`;
      
      const usage = await db
        .select()
        .from(routerUsage)
        .where(
          and(
            eq(routerUsage.user_id, request.userId!),
            eq(routerUsage.month, monthStr)
          )
        )
        .limit(1);
      
      if (usage.length === 0) {
        return {
          year,
          month,
          totalRequests: 0,
          totalTokensIn: 0,
          totalTokensOut: 0,
          totalCost: 0,
          message: 'No usage data for this month'
        };
      }
      
      const u = usage[0];
      return {
        year,
        month,
        totalRequests: u.total_requests || 0,
        totalTokensIn: u.total_tokens_in || 0,
        totalTokensOut: u.total_tokens_out || 0,
        totalTokens: (u.total_tokens_in || 0) + (u.total_tokens_out || 0),
        totalCost: (u.total_cost_estimate || 0).toFixed(4),
        averageCostPerRequest: u.total_requests 
          ? ((u.total_cost_estimate || 0) / u.total_requests).toFixed(6)
          : '0.000000'
      };
    } catch (error: any) {
      console.error('Failed to get monthly usage:', error);
      return reply.code(500).send({
        error: 'Failed to get monthly usage',
        message: error.message
      });
    }
  });
  
  /**
   * GET /router/analytics/model-performance
   * Get performance metrics for each model
   */
  fastify.get('/router/analytics/model-performance', {
    preHandler: requireAuth
  }, async (request: AuthRequest, reply) => {
    try {
      const performance = await db
        .select({
          model: routerRequests.selected_model,
          provider: routerRequests.selected_provider,
          totalRequests: sql<number>`count(*)`,
          successfulRequests: sql<number>`sum(case when ${routerRequests.success} = 1 then 1 else 0 end)`,
          avgLatency: sql<number>`avg(${routerRequests.latency_ms})`,
          avgCost: sql<number>`avg(${routerRequests.cost_estimate})`,
          totalCost: sql<number>`sum(${routerRequests.cost_estimate})`
        })
        .from(routerRequests)
        .where(eq(routerRequests.user_id, request.userId!))
        .groupBy(routerRequests.selected_model, routerRequests.selected_provider)
        .orderBy(desc(sql`count(*)`));
      
      return {
        models: performance.map(p => ({
          model: p.model,
          provider: p.provider,
          totalRequests: p.totalRequests,
          successfulRequests: p.successfulRequests,
          successRate: p.totalRequests 
            ? ((p.successfulRequests / p.totalRequests) * 100).toFixed(2)
            : '0.00',
          avgLatency: p.avgLatency ? Math.round(p.avgLatency) : 0,
          avgCost: (p.avgCost || 0).toFixed(6),
          totalCost: (p.totalCost || 0).toFixed(4)
        }))
      };
    } catch (error: any) {
      console.error('Failed to get model performance:', error);
      return reply.code(500).send({
        error: 'Failed to get model performance',
        message: error.message
      });
    }
  });
  
  /**
   * GET /router/analytics/available-models
   * Get list of available models based on user's provider keys
   */
  fastify.get('/router/analytics/available-models', {
    preHandler: requireAuth
  }, async (request: AuthRequest, reply) => {
    try {
      // Get all rankings (these are the models available in the system)
      const rankings = await db
        .select({
          modelId: routerModelRankings.model_id,
          provider: routerModelRankings.provider,
          category: routerModelRankings.category,
          rank: routerModelRankings.rank,
          stupidScore: routerModelRankings.stupid_score,
          costPer1k: routerModelRankings.avg_cost_per_1k,
          avgLatencyMs: routerModelRankings.avg_latency_ms,
          supportsToolCalling: routerModelRankings.supports_tool_calling,
          supportsStreaming: routerModelRankings.supports_streaming
        })
        .from(routerModelRankings)
        .where(eq(routerModelRankings.category, 'overall'))
        .orderBy(routerModelRankings.rank);
      
      return {
        models: rankings.map(r => ({
          modelId: r.modelId,
          provider: r.provider,
          rank: r.rank,
          stupidScore: r.stupidScore,
          costPer1k: r.costPer1k,
          avgLatency: r.avgLatencyMs,
          supportsToolCalling: r.supportsToolCalling,
          supportsStreaming: r.supportsStreaming
        }))
      };
    } catch (error: any) {
      console.error('Failed to get available models:', error);
      return reply.code(500).send({
        error: 'Failed to get available models',
        message: error.message
      });
    }
  });
}
