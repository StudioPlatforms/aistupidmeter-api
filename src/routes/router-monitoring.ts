/**
 * Router Monitoring Routes
 * 
 * Enterprise-grade API monitoring endpoints for tracking per-key usage,
 * prompt auditing, cost dashboards, budget alerts, and efficiency metrics.
 * All endpoints require authentication via x-user-id header.
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { db } from '../db/connection-pool';
import {
  routerApiKeys,
  routerRequests,
  routerUsers,
  routerBudgetAlerts,
  routerPromptAccessLog,
} from '../db/router-schema';
import { eq, and, desc, lt, sql } from 'drizzle-orm';
import { decryptPromptText } from '../router/keys/encryption';

// ============================================================================
// Auth helper (same pattern as router-keys.ts)
// ============================================================================

interface AuthRequest extends FastifyRequest {
  userId?: number;
}

async function requireAuth(request: AuthRequest, reply: FastifyReply) {
  const userId = request.headers['x-user-id'] as string;
  if (!userId) {
    return reply.code(401).send({ error: 'Authentication required' });
  }
  request.userId = parseInt(userId, 10);
  if (isNaN(request.userId)) {
    return reply.code(401).send({ error: 'Invalid user ID' });
  }
}

// ============================================================================
// Routes
// ============================================================================

export default async function routerMonitoringRoutes(fastify: FastifyInstance) {

  // ==========================================================================
  // Prompt Logging Control
  // ==========================================================================

  /**
   * GET /router/monitoring/prompt-logging
   * Get current prompt logging state for the account
   */
  fastify.get('/router/monitoring/prompt-logging', {
    preHandler: requireAuth
  }, async (request: AuthRequest) => {
    const user = await db
      .select({
        enabled: routerUsers.prompt_logging_enabled,
        retentionDays: routerUsers.prompt_retention_days,
      })
      .from(routerUsers)
      .where(eq(routerUsers.id, request.userId!))
      .limit(1);

    return {
      enabled: user[0]?.enabled || false,
      retentionDays: user[0]?.retentionDays ?? 90,
    };
  });

  /**
   * PUT /router/monitoring/prompt-logging
   * Toggle prompt logging on/off for account
   */
  fastify.put('/router/monitoring/prompt-logging', {
    preHandler: requireAuth
  }, async (request: AuthRequest) => {
    const body = request.body as { enabled: boolean; retentionDays?: number };
    const updates: Record<string, any> = {
      prompt_logging_enabled: body.enabled,
      updated_at: new Date().toISOString(),
    };
    if (body.retentionDays !== undefined) {
      updates.prompt_retention_days = body.retentionDays;
    }
    await db.update(routerUsers).set(updates).where(eq(routerUsers.id, request.userId!));
    return { success: true, enabled: body.enabled };
  });

  // ==========================================================================
  // Key Activity (cursor-based pagination)
  // ==========================================================================

  /**
   * GET /router/monitoring/keys/:id/activity
   * Paginated activity log for a specific key
   * Query: before (ISO timestamp), limit (default 50), category
   */
  fastify.get('/router/monitoring/keys/:id/activity', {
    preHandler: requireAuth
  }, async (request: AuthRequest) => {
    const keyId = parseInt((request.params as any).id);
    const query = request.query as { before?: string; limit?: string; category?: string };
    const limit = Math.min(parseInt(query.limit || '50'), 100);
    const before = query.before || new Date().toISOString();
    const category = query.category;

    // Verify ownership
    const keyCheck = await db
      .select({ id: routerApiKeys.id })
      .from(routerApiKeys)
      .where(and(eq(routerApiKeys.id, keyId), eq(routerApiKeys.user_id, request.userId!)))
      .limit(1);
    if (keyCheck.length === 0) {
      return { activity: [], nextCursor: null };
    }

    // Fix #2: Push category filter into SQL WHERE clause so pagination doesn't lie.
    // Previously filtered in JS which could return fewer than `limit` rows per page.
    let conditions = and(
      eq(routerRequests.api_key_id, keyId),
      eq(routerRequests.user_id, request.userId!),
      lt(routerRequests.created_at, before),
      category ? eq(routerRequests.prompt_category, category) : undefined
    );

    const rows = await db
      .select({
        id: routerRequests.id,
        model: routerRequests.selected_model,
        provider: routerRequests.selected_provider,
        category: routerRequests.prompt_category,
        language: routerRequests.prompt_language,
        complexity: routerRequests.prompt_complexity,
        hasPrompt: routerRequests.prompt_text,
        tokensIn: routerRequests.tokens_in,
        tokensOut: routerRequests.tokens_out,
        cost: routerRequests.cost_estimate,
        latency: routerRequests.latency_ms,
        success: routerRequests.success,
        timestamp: routerRequests.created_at,
      })
      .from(routerRequests)
      .where(conditions)
      .orderBy(desc(routerRequests.created_at))
      .limit(limit + 1); // fetch one extra to determine if there's more

    const hasMore = rows.length > limit;
    const filtered = rows.slice(0, limit);

    return {
      activity: filtered.map(r => ({
        id: r.id,
        model: r.model,
        provider: r.provider,
        category: r.category,
        language: r.language,
        complexity: r.complexity,
        promptPreview: null, // Don't send preview in activity list, only in prompt audit
        tokensIn: r.tokensIn || 0,
        tokensOut: r.tokensOut || 0,
        cost: ((r.cost || 0) as number).toFixed(6),
        latency: r.latency || 0,
        success: r.success,
        timestamp: r.timestamp,
      })),
      nextCursor: hasMore ? filtered[filtered.length - 1]?.timestamp : null,
    };
  });

  // ==========================================================================
  // Key Cost Dashboard
  // ==========================================================================

  /**
   * GET /router/monitoring/keys/:id/costs
   * Cost breakdown for a specific key
   */
  fastify.get('/router/monitoring/keys/:id/costs', {
    preHandler: requireAuth
  }, async (request: AuthRequest) => {
    const keyId = parseInt((request.params as any).id);
    const query = request.query as { period?: string };
    const days = query.period === '7d' ? 7 : query.period === '90d' ? 90 : 30;
    const since = new Date(Date.now() - days * 86400000).toISOString();

    // Verify ownership + get key metadata
    const keyRow = await db
      .select({
        id: routerApiKeys.id,
        name: routerApiKeys.name,
        department: routerApiKeys.department,
        assignedTo: routerApiKeys.assigned_to,
        budgetLimit: routerApiKeys.budget_limit_monthly,
        currentSpend: routerApiKeys.current_month_spend,
      })
      .from(routerApiKeys)
      .where(and(eq(routerApiKeys.id, keyId), eq(routerApiKeys.user_id, request.userId!)))
      .limit(1);

    if (keyRow.length === 0) {
      return { costs: null };
    }

    const key = keyRow[0];

    // Get all requests in the period for this key
    const requests = await db
      .select({
        model: routerRequests.selected_model,
        cost: routerRequests.cost_estimate,
        tokensIn: routerRequests.tokens_in,
        tokensOut: routerRequests.tokens_out,
        created: routerRequests.created_at,
      })
      .from(routerRequests)
      .where(
        and(
          eq(routerRequests.api_key_id, keyId),
          eq(routerRequests.user_id, request.userId!),
          sql`${routerRequests.created_at} >= ${since}`
        )
      )
      .orderBy(desc(routerRequests.created_at));

    // Aggregate daily costs
    const dailyMap: Record<string, { cost: number; requests: number }> = {};
    const modelMap: Record<string, { cost: number; requests: number }> = {};
    let totalCost = 0;
    let totalTokens = 0;

    for (const r of requests) {
      const date = (r.created || '').substring(0, 10);
      const cost = r.cost || 0;
      totalCost += cost;
      totalTokens += (r.tokensIn || 0) + (r.tokensOut || 0);

      if (!dailyMap[date]) dailyMap[date] = { cost: 0, requests: 0 };
      dailyMap[date].cost += cost;
      dailyMap[date].requests += 1;

      if (!modelMap[r.model]) modelMap[r.model] = { cost: 0, requests: 0 };
      modelMap[r.model].cost += cost;
      modelMap[r.model].requests += 1;
    }

    const dailyCosts = Object.entries(dailyMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, d]) => ({ date, cost: parseFloat(d.cost.toFixed(6)), requests: d.requests }));

    const modelBreakdown = Object.entries(modelMap)
      .sort(([, a], [, b]) => b.cost - a.cost)
      .map(([model, d]) => ({
        model,
        cost: d.cost.toFixed(6),
        requests: d.requests,
        percentage: totalCost > 0 ? ((d.cost / totalCost) * 100).toFixed(1) + '%' : '0%',
      }));

    // Forecast: project spending to end of month
    const daysInData = dailyCosts.length || 1;
    const avgDailyCost = totalCost / daysInData;
    const now = new Date();
    const daysRemaining = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate() - now.getDate();
    const projectedMonthEnd = (key.currentSpend || 0) + avgDailyCost * daysRemaining;
    const daysUntilBudget = key.budgetLimit && avgDailyCost > 0
      ? Math.max(0, Math.floor((key.budgetLimit - (key.currentSpend || 0)) / avgDailyCost))
      : null;

    return {
      costs: {
        keyId: key.id,
        keyName: key.name,
        department: key.department,
        assignedTo: key.assignedTo,
        period: `${days}d`,
        totalCost: totalCost.toFixed(6),
        totalRequests: requests.length,
        totalTokens,
        dailyCosts,
        modelBreakdown,
        forecast: {
          daysUntilBudget,
          projectedMonthEnd: parseFloat(projectedMonthEnd.toFixed(4)),
        },
      }
    };
  });

  /**
   * GET /router/monitoring/keys/summary
   * Overview of all keys with spend totals
   */
  fastify.get('/router/monitoring/keys/summary', {
    preHandler: requireAuth
  }, async (request: AuthRequest) => {
    const keys = await db
      .select({
        id: routerApiKeys.id,
        name: routerApiKeys.name,
        keyPrefix: routerApiKeys.key_prefix,
        department: routerApiKeys.department,
        assignedTo: routerApiKeys.assigned_to,
        tags: routerApiKeys.tags,
        budgetLimit: routerApiKeys.budget_limit_monthly,
        budgetHardLimit: routerApiKeys.budget_hard_limit,
        currentSpend: routerApiKeys.current_month_spend,
        currentMonthKey: routerApiKeys.current_month_key,
        lastUsed: routerApiKeys.last_used_at,
        revoked: routerApiKeys.revoked,
      })
      .from(routerApiKeys)
      .where(and(eq(routerApiKeys.user_id, request.userId!), eq(routerApiKeys.revoked, false)));

    const currentMonth = new Date().toISOString().substring(0, 7);

    // Get request count + top category per key
    const summaries = await Promise.all(keys.map(async (key) => {
      const spend = key.currentMonthKey === currentMonth ? (key.currentSpend || 0) : 0;
      const utilization = key.budgetLimit ? (spend / key.budgetLimit) * 100 : null;

      // Count requests this month
      const countResult = await db
        .select({ count: sql<number>`count(*)` })
        .from(routerRequests)
        .where(
          and(
            eq(routerRequests.api_key_id, key.id),
            sql`${routerRequests.created_at} >= ${currentMonth + '-01'}`
          )
        );

      // Top category
      const topCat = await db
        .select({
          category: routerRequests.prompt_category,
          count: sql<number>`count(*)`,
        })
        .from(routerRequests)
        .where(
          and(
            eq(routerRequests.api_key_id, key.id),
            sql`${routerRequests.prompt_category} IS NOT NULL`,
            sql`${routerRequests.created_at} >= ${currentMonth + '-01'}`
          )
        )
        .groupBy(routerRequests.prompt_category)
        .orderBy(sql`count(*) DESC`)
        .limit(1);

      return {
        id: key.id,
        name: key.name,
        keyPrefix: key.keyPrefix,
        department: key.department,
        assignedTo: key.assignedTo,
        tags: key.tags ? JSON.parse(key.tags) : [],
        budgetLimit: key.budgetLimit,
        budgetHardLimit: key.budgetHardLimit || false,
        currentSpend: parseFloat(spend.toFixed(6)),
        budgetUtilization: utilization !== null ? parseFloat(utilization.toFixed(1)) : null,
        requestCount: countResult[0]?.count || 0,
        lastUsed: key.lastUsed,
        topCategory: topCat[0]?.category || null,
      };
    }));

    return { keys: summaries };
  });

  // ==========================================================================
  // Prompt Audit
  // ==========================================================================

  /**
   * GET /router/monitoring/prompts
   * Prompt audit log with filters (cursor-based)
   */
  fastify.get('/router/monitoring/prompts', {
    preHandler: requireAuth
  }, async (request: AuthRequest) => {
    const query = request.query as {
      before?: string;
      limit?: string;
      keyId?: string;
      category?: string;
    };
    const limit = Math.min(parseInt(query.limit || '50'), 100);
    const before = query.before || new Date().toISOString();
    const keyId = query.keyId ? parseInt(query.keyId) : null;

    // Fix #2: Push category filter into SQL WHERE clause
    let conditions = and(
      eq(routerRequests.user_id, request.userId!),
      lt(routerRequests.created_at, before),
      sql`${routerRequests.prompt_text} IS NOT NULL`,
      keyId ? eq(routerRequests.api_key_id, keyId) : undefined,
      query.category ? eq(routerRequests.prompt_category, query.category) : undefined
    );

    const rows = await db
      .select({
        id: routerRequests.id,
        keyId: routerRequests.api_key_id,
        promptText: routerRequests.prompt_text,
        category: routerRequests.prompt_category,
        language: routerRequests.prompt_language,
        complexity: routerRequests.prompt_complexity,
        model: routerRequests.selected_model,
        provider: routerRequests.selected_provider,
        cost: routerRequests.cost_estimate,
        timestamp: routerRequests.created_at,
      })
      .from(routerRequests)
      .where(conditions)
      .orderBy(desc(routerRequests.created_at))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const filtered = rows.slice(0, limit);

    // Get key names for display
    const keyIds = [...new Set(filtered.map(r => r.keyId))];
    const keyNames: Record<number, { name: string; department: string | null }> = {};
    if (keyIds.length > 0) {
      const keyRows = await db
        .select({ id: routerApiKeys.id, name: routerApiKeys.name, department: routerApiKeys.department })
        .from(routerApiKeys)
        .where(eq(routerApiKeys.user_id, request.userId!));
      for (const k of keyRows) {
        keyNames[k.id] = { name: k.name || '', department: k.department };
      }
    }

    // Log prompt access for each viewed prompt
    for (const r of filtered) {
      try {
        await db.insert(routerPromptAccessLog).values({
          user_id: request.userId!,
          request_id: r.id,
          action: 'view',
          accessed_at: new Date().toISOString(),
        });
      } catch { /* non-critical */ }
    }

    return {
      prompts: filtered.map(r => {
        const decrypted = r.promptText ? decryptPromptText(r.promptText) : '';
        return {
          id: r.id,
          keyId: r.keyId,
          keyName: keyNames[r.keyId]?.name || 'Unknown',
          department: keyNames[r.keyId]?.department || null,
          promptPreview: decrypted.substring(0, 200) + (decrypted.length > 200 ? '...' : ''),
          category: r.category,
          language: r.language,
          complexity: r.complexity,
          model: r.model,
          provider: r.provider,
          cost: ((r.cost || 0) as number).toFixed(6),
          timestamp: r.timestamp,
        };
      }),
      nextCursor: hasMore ? filtered[filtered.length - 1]?.timestamp : null,
    };
  });

  /**
   * DELETE /router/monitoring/prompts/:id
   * Delete a single prompt (set prompt_text to NULL)
   */
  fastify.delete('/router/monitoring/prompts/:id', {
    preHandler: requireAuth
  }, async (request: AuthRequest) => {
    const requestId = parseInt((request.params as any).id);

    const result = await db
      .update(routerRequests)
      .set({ prompt_text: null })
      .where(
        and(
          eq(routerRequests.id, requestId),
          eq(routerRequests.user_id, request.userId!)
        )
      )
      .returning({ id: routerRequests.id });

    if (result.length > 0) {
      await db.insert(routerPromptAccessLog).values({
        user_id: request.userId!,
        request_id: requestId,
        action: 'delete',
        accessed_at: new Date().toISOString(),
      });
    }

    return { success: result.length > 0, deleted: result.length };
  });

  /**
   * DELETE /router/monitoring/prompts/purge
   * Bulk purge prompts by key and/or date range
   */
  fastify.delete('/router/monitoring/prompts/purge', {
    preHandler: requireAuth
  }, async (request: AuthRequest, reply: FastifyReply) => {
    const query = request.query as { keyId?: string; before?: string; confirm?: string };
    
    // Fix #10: Require explicit confirm=true to prevent accidental bulk deletes
    if (query.confirm !== 'true') {
      return reply.code(400).send({
        error: 'Bulk purge requires confirm=true query parameter',
        message: 'Add ?confirm=true to confirm this destructive operation'
      });
    }

    const keyId = query.keyId ? parseInt(query.keyId) : null;
    const before = query.before || new Date().toISOString();

    let conditions = and(
      eq(routerRequests.user_id, request.userId!),
      lt(routerRequests.created_at, before),
      sql`${routerRequests.prompt_text} IS NOT NULL`
    );

    if (keyId) {
      conditions = and(conditions, eq(routerRequests.api_key_id, keyId));
    }

    // Count before purge
    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(routerRequests)
      .where(conditions);

    const count = countResult[0]?.count || 0;

    // Purge (set to NULL, don't delete the row)
    if (count > 0) {
      await db
        .update(routerRequests)
        .set({ prompt_text: null })
        .where(conditions);

      // Log the bulk purge action with parameters
      try {
        await db.insert(routerPromptAccessLog).values({
          user_id: request.userId!,
          request_id: 0, // sentinel: bulk operation, not tied to single request
          action: 'delete',
          accessed_at: new Date().toISOString(),
        });
      } catch { /* non-critical */ }
    }

    return { success: true, purged: count };
  });

  // ==========================================================================
  // Prompt Categories
  // ==========================================================================

  /**
   * GET /router/monitoring/prompt-categories
   * Category distribution across all keys
   */
  fastify.get('/router/monitoring/prompt-categories', {
    preHandler: requireAuth
  }, async (request: AuthRequest) => {
    const currentMonth = new Date().toISOString().substring(0, 7);

    const rows = await db
      .select({
        category: routerRequests.prompt_category,
        count: sql<number>`count(*)`,
      })
      .from(routerRequests)
      .where(
        and(
          eq(routerRequests.user_id, request.userId!),
          sql`${routerRequests.prompt_category} IS NOT NULL`,
          sql`${routerRequests.created_at} >= ${currentMonth + '-01'}`
        )
      )
      .groupBy(routerRequests.prompt_category)
      .orderBy(sql`count(*) DESC`);

    const total = rows.reduce((sum, r) => sum + (r.count || 0), 0);

    return {
      categories: rows.map(r => ({
        category: r.category,
        count: r.count || 0,
        percentage: total > 0 ? (((r.count || 0) / total) * 100).toFixed(1) + '%' : '0%',
      }))
    };
  });

  // ==========================================================================
  // Budget Status & Alerts
  // ==========================================================================

  /**
   * GET /router/monitoring/budget-status
   * Budget status for all keys with limits
   */
  fastify.get('/router/monitoring/budget-status', {
    preHandler: requireAuth
  }, async (request: AuthRequest) => {
    const keys = await db
      .select({
        id: routerApiKeys.id,
        name: routerApiKeys.name,
        department: routerApiKeys.department,
        budgetLimit: routerApiKeys.budget_limit_monthly,
        budgetHardLimit: routerApiKeys.budget_hard_limit,
        budgetAlertThreshold: routerApiKeys.budget_alert_threshold,
        currentSpend: routerApiKeys.current_month_spend,
        currentMonthKey: routerApiKeys.current_month_key,
      })
      .from(routerApiKeys)
      .where(
        and(
          eq(routerApiKeys.user_id, request.userId!),
          eq(routerApiKeys.revoked, false)
        )
      );

    const currentMonth = new Date().toISOString().substring(0, 7);

    return {
      keys: keys.map(k => {
        const spend = k.currentMonthKey === currentMonth ? (k.currentSpend || 0) : 0;
        const utilization = k.budgetLimit ? (spend / k.budgetLimit) * 100 : null;
        return {
          id: k.id,
          name: k.name,
          department: k.department,
          budgetLimit: k.budgetLimit,
          budgetHardLimit: k.budgetHardLimit || false,
          budgetAlertThreshold: k.budgetAlertThreshold || 0.8,
          currentSpend: parseFloat(spend.toFixed(6)),
          utilization: utilization !== null ? parseFloat(utilization.toFixed(1)) : null,
        };
      })
    };
  });

  /**
   * GET /router/monitoring/budget-alerts
   * List budget alerts
   */
  fastify.get('/router/monitoring/budget-alerts', {
    preHandler: requireAuth
  }, async (request: AuthRequest) => {
    const query = request.query as { acknowledged?: string };
    const showAcknowledged = query.acknowledged === 'true';

    let conditions = eq(routerBudgetAlerts.user_id, request.userId!);
    if (!showAcknowledged) {
      conditions = and(conditions, eq(routerBudgetAlerts.acknowledged, false)) as any;
    }

    const alerts = await db
      .select({
        id: routerBudgetAlerts.id,
        keyId: routerBudgetAlerts.api_key_id,
        alertType: routerBudgetAlerts.alert_type,
        thresholdPct: routerBudgetAlerts.threshold_pct,
        amountSpent: routerBudgetAlerts.amount_spent,
        budgetLimit: routerBudgetAlerts.budget_limit,
        acknowledged: routerBudgetAlerts.acknowledged,
        createdAt: routerBudgetAlerts.created_at,
      })
      .from(routerBudgetAlerts)
      .where(conditions)
      .orderBy(desc(routerBudgetAlerts.created_at))
      .limit(100);

    // Enrich with key names
    const keyIds = [...new Set(alerts.map(a => a.keyId))];
    const keyNames: Record<number, string> = {};
    if (keyIds.length > 0) {
      const keyRows = await db
        .select({ id: routerApiKeys.id, name: routerApiKeys.name })
        .from(routerApiKeys)
        .where(eq(routerApiKeys.user_id, request.userId!));
      for (const k of keyRows) keyNames[k.id] = k.name || '';
    }

    return {
      alerts: alerts.map(a => ({
        id: a.id,
        keyId: a.keyId,
        keyName: keyNames[a.keyId] || 'Unknown',
        alertType: a.alertType,
        thresholdPct: a.thresholdPct,
        amountSpent: a.amountSpent,
        budgetLimit: a.budgetLimit,
        acknowledged: a.acknowledged,
        createdAt: a.createdAt,
      }))
    };
  });

  /**
   * POST /router/monitoring/budget-alerts/:id/acknowledge
   * Acknowledge a budget alert
   */
  fastify.post('/router/monitoring/budget-alerts/:id/acknowledge', {
    preHandler: requireAuth
  }, async (request: AuthRequest) => {
    const alertId = parseInt((request.params as any).id);

    const result = await db
      .update(routerBudgetAlerts)
      .set({ acknowledged: true })
      .where(
        and(
          eq(routerBudgetAlerts.id, alertId),
          eq(routerBudgetAlerts.user_id, request.userId!)
        )
      )
      .returning({ id: routerBudgetAlerts.id });

    return { success: result.length > 0 };
  });

  // ==========================================================================
  // Efficiency Metrics
  // ==========================================================================

  /**
   * GET /router/monitoring/efficiency
   * Per-key efficiency metrics
   */
  fastify.get('/router/monitoring/efficiency', {
    preHandler: requireAuth
  }, async (request: AuthRequest) => {
    const currentMonth = new Date().toISOString().substring(0, 7);

    const keys = await db
      .select({
        id: routerApiKeys.id,
        name: routerApiKeys.name,
        department: routerApiKeys.department,
      })
      .from(routerApiKeys)
      .where(
        and(
          eq(routerApiKeys.user_id, request.userId!),
          eq(routerApiKeys.revoked, false)
        )
      );

    const metrics = await Promise.all(keys.map(async (key) => {
      const rows = await db
        .select({
          tokensIn: routerRequests.tokens_in,
          tokensOut: routerRequests.tokens_out,
          cost: routerRequests.cost_estimate,
          latency: routerRequests.latency_ms,
          success: routerRequests.success,
          category: routerRequests.prompt_category,
        })
        .from(routerRequests)
        .where(
          and(
            eq(routerRequests.api_key_id, key.id),
            sql`${routerRequests.created_at} >= ${currentMonth + '-01'}`
          )
        );

      const total = rows.length;
      if (total === 0) {
        return {
          keyId: key.id,
          keyName: key.name,
          department: key.department,
          avgTokensPerRequest: 0,
          avgCostPerRequest: 0,
          errorRate: '0%',
          avgLatency: 0,
          requestCount: 0,
          topCategories: [],
        };
      }

      const totalTokens = rows.reduce((s, r) => s + (r.tokensIn || 0) + (r.tokensOut || 0), 0);
      const totalCost = rows.reduce((s, r) => s + (r.cost || 0), 0);
      const totalLatency = rows.reduce((s, r) => s + (r.latency || 0), 0);
      const errors = rows.filter(r => !r.success).length;

      // Category breakdown
      const catMap: Record<string, number> = {};
      for (const r of rows) {
        if (r.category) {
          catMap[r.category] = (catMap[r.category] || 0) + 1;
        }
      }
      const topCategories = Object.entries(catMap)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 5)
        .map(([category, count]) => ({
          category,
          percentage: ((count / total) * 100).toFixed(1) + '%',
        }));

      return {
        keyId: key.id,
        keyName: key.name,
        department: key.department,
        avgTokensPerRequest: Math.round(totalTokens / total),
        avgCostPerRequest: parseFloat((totalCost / total).toFixed(6)),
        errorRate: ((errors / total) * 100).toFixed(1) + '%',
        avgLatency: Math.round(totalLatency / total),
        requestCount: total,
        topCategories,
      };
    }));

    return { keys: metrics };
  });

  // ==========================================================================
  // Export
  // ==========================================================================

  /**
   * GET /router/monitoring/export/activity
   * Export activity data as CSV or JSON
   */
  fastify.get('/router/monitoring/export/activity', {
    preHandler: requireAuth
  }, async (request: AuthRequest, reply: FastifyReply) => {
    const query = request.query as { keyId?: string; format?: string; from?: string; to?: string };
    const format = query.format || 'json';
    const from = query.from || new Date(Date.now() - 30 * 86400000).toISOString();
    const to = query.to || new Date().toISOString();
    const keyId = query.keyId ? parseInt(query.keyId) : null;

    // Fix #11: Stream large exports instead of buffering in memory.
    // For CSV: write header + rows via reply.raw.write() to avoid OOM on large datasets.
    // For JSON: still use Drizzle query but with a hard cap of 50K rows.
    if (format === 'csv') {
      reply.raw.setHeader('Content-Type', 'text/csv');
      reply.raw.setHeader('Content-Disposition', `attachment; filename="activity-export-${new Date().toISOString().split('T')[0]}.csv"`);
      reply.raw.write('ID,Key ID,Model,Provider,Category,Tokens In,Tokens Out,Cost,Latency (ms),Success,Timestamp\n');

      // Stream in batches of 1000 using cursor pagination
      let cursor = to;
      let totalRows = 0;
      const MAX_EXPORT_ROWS = 100000;

      while (totalRows < MAX_EXPORT_ROWS) {
        let conditions = and(
          eq(routerRequests.user_id, request.userId!),
          sql`${routerRequests.created_at} >= ${from}`,
          sql`${routerRequests.created_at} < ${cursor}`,
          keyId ? eq(routerRequests.api_key_id, keyId) : undefined
        );

        const batch = await db
          .select({
            id: routerRequests.id,
            keyId: routerRequests.api_key_id,
            model: routerRequests.selected_model,
            provider: routerRequests.selected_provider,
            category: routerRequests.prompt_category,
            tokensIn: routerRequests.tokens_in,
            tokensOut: routerRequests.tokens_out,
            cost: routerRequests.cost_estimate,
            latency: routerRequests.latency_ms,
            success: routerRequests.success,
            timestamp: routerRequests.created_at,
          })
          .from(routerRequests)
          .where(conditions)
          .orderBy(desc(routerRequests.created_at))
          .limit(1000);

        if (batch.length === 0) break;

        for (const r of batch) {
          reply.raw.write(`${r.id},${r.keyId},${r.model},${r.provider},${r.category || ''},${r.tokensIn || 0},${r.tokensOut || 0},${r.cost || 0},${r.latency || 0},${r.success},${r.timestamp}\n`);
        }

        totalRows += batch.length;
        cursor = batch[batch.length - 1].timestamp || '';
        if (batch.length < 1000) break; // no more rows
      }

      // Signal truncation to the client if we hit the cap
      if (totalRows >= MAX_EXPORT_ROWS) {
        reply.raw.setHeader('X-Export-Truncated', 'true');
        reply.raw.setHeader('X-Export-Row-Limit', String(MAX_EXPORT_ROWS));
      }
      reply.raw.setHeader('X-Export-Row-Count', String(totalRows));

      reply.raw.end();
      return; // already sent via raw stream
    }

    // JSON format — capped at 10K rows
    let conditions = and(
      eq(routerRequests.user_id, request.userId!),
      sql`${routerRequests.created_at} >= ${from}`,
      sql`${routerRequests.created_at} <= ${to}`,
      keyId ? eq(routerRequests.api_key_id, keyId) : undefined
    );

    const rows = await db
      .select({
        id: routerRequests.id,
        keyId: routerRequests.api_key_id,
        model: routerRequests.selected_model,
        provider: routerRequests.selected_provider,
        category: routerRequests.prompt_category,
        tokensIn: routerRequests.tokens_in,
        tokensOut: routerRequests.tokens_out,
        cost: routerRequests.cost_estimate,
        latency: routerRequests.latency_ms,
        success: routerRequests.success,
        timestamp: routerRequests.created_at,
      })
      .from(routerRequests)
      .where(conditions)
      .orderBy(desc(routerRequests.created_at))
      .limit(10001); // fetch one extra to detect truncation

    const truncated = rows.length > 10000;
    const data = truncated ? rows.slice(0, 10000) : rows;

    return {
      data,
      count: data.length,
      truncated,
      ...(truncated ? { rowLimit: 10000, message: 'Results truncated. Use CSV format or narrow the date range for full export.' } : {}),
      exportedAt: new Date().toISOString(),
    };
  });
}
