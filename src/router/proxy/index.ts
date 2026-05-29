import { FastifyRequest, FastifyReply } from 'fastify';
import { db, dbPool } from '../../db/connection-pool';
import { routerApiKeys, routerProviderKeys, routerRequests, routerUsage, routerUsers, routerBudgetAlerts } from '../../db/router-schema';
import { eq, and, sql } from 'drizzle-orm';
import { hashApiKey, decryptProviderKey, encryptPromptText } from '../keys/encryption';
import { selectModelsWithFallbacks } from '../selector';
import type { ModelSelection } from '../selector';
import { OpenAIAdapter, AnthropicAdapter, XAIAdapter, GoogleAdapter, GLMAdapter, DeepSeekAdapter, KimiAdapter } from '../../llm/adapters';
import type { ChatMessage, ChatResponse, LLMAdapter } from '../../llm/adapters';
import { analyzePrompt } from '../analyzer/prompt-analyzer';
import { scrubPromptText } from '../monitoring/prompt-scrubber';
import { models } from '../../db/schema';

/**
 * OpenAI 2026 Chat Completions request — expanded to forward all standard params.
 * Per-provider drop-lists strip unsupported params before forwarding.
 */
interface ChatCompletionRequest {
  model: string;
  messages: Array<{ role: string; content: string }>;
  temperature?: number;
  max_tokens?: number;
  max_completion_tokens?: number;  // Replaces max_tokens for reasoning models (GPT-5.x, o-series)
  stream?: boolean;
  stream_options?: { include_usage?: boolean };  // Final usage chunk in SSE
  tools?: any[];
  tool_choice?: any;
  parallel_tool_calls?: boolean;
  response_format?: any;           // { type: 'json_object' } or { type: 'json_schema', json_schema: {...} }
  reasoning_effort?: string;       // none | minimal | low | medium | high | xhigh
  top_p?: number;
  stop?: string | string[];
  frequency_penalty?: number;
  presence_penalty?: number;
  seed?: number;
  logprobs?: boolean;
  top_logprobs?: number;
  n?: number;
}

/**
 * Map model name prefix → provider for direct pin routing.
 * Used when user sends a real model ID instead of auto-*.
 */
const MODEL_PREFIX_TO_PROVIDER: Record<string, string> = {
  'gpt-': 'openai', 'o1-': 'openai', 'o3-': 'openai', 'o4-': 'openai',
  'claude-': 'anthropic',
  'grok-': 'xai',
  'gemini-': 'google',
  'deepseek-': 'deepseek',
  'kimi-': 'kimi',
  'glm-': 'glm',
};

/**
 * Authenticate request using universal API key
 */
async function authenticateRequest(apiKey: string): Promise<{ userId: number; apiKeyId: number } | null> {
  // Phase 4B: Accept sk-aism_* prefix — some tools enforce sk- prefix client-side
  let cleanKey = apiKey;
  if (cleanKey.startsWith('sk-')) cleanKey = cleanKey.slice(3);
  if (!cleanKey || !cleanKey.startsWith('aism_')) {
    return null;
  }
  const keyHash = hashApiKey(cleanKey);
  
  const result = await db
    .select({
      id: routerApiKeys.id,
      userId: routerApiKeys.user_id,
      revoked: routerApiKeys.revoked
    })
    .from(routerApiKeys)
    .where(eq(routerApiKeys.key_hash, keyHash))
    .limit(1);
  
  if (result.length === 0 || result[0].revoked) {
    return null;
  }
  
  // Update last_used_at
  await db
    .update(routerApiKeys)
    .set({ last_used_at: new Date().toISOString() })
    .where(eq(routerApiKeys.id, result[0].id));
  
  return {
    userId: result[0].userId,
    apiKeyId: result[0].id
  };
}

/**
 * Get provider API key for user
 */
async function getProviderKey(userId: number, provider: string): Promise<string> {
  const result = await db
    .select({ encrypted_key: routerProviderKeys.encrypted_key })
    .from(routerProviderKeys)
    .where(
      and(
        eq(routerProviderKeys.user_id, userId),
        eq(routerProviderKeys.provider, provider),
        eq(routerProviderKeys.is_active, true)
      )
    )
    .limit(1);
  
  if (result.length === 0) {
    throw new Error(`No active ${provider} API key found. Please add one in your dashboard.`);
  }
  
  return decryptProviderKey(result[0].encrypted_key);
}

/**
 * Create adapter for provider
 */
function createAdapter(provider: string, apiKey: string): LLMAdapter {
  switch (provider) {
    case 'openai':
      return new OpenAIAdapter(apiKey);
    case 'anthropic':
      return new AnthropicAdapter(apiKey);
    case 'xai':
      return new XAIAdapter(apiKey);
    case 'google':
      return new GoogleAdapter(apiKey);
    case 'glm':
      return new GLMAdapter(apiKey);
    case 'deepseek':
      return new DeepSeekAdapter(apiKey);
    case 'kimi':
      return new KimiAdapter(apiKey);
    default:
      throw new Error(`Unsupported provider: ${provider}`);
  }
}

/**
 * Rough estimate of max cost for a request BEFORE model selection.
 * Used by the hard-budget gate to reserve spend atomically.
 * Uses the most expensive model pricing as an upper bound.
 * Over-estimates are corrected by the hourly reconciliation job.
 */
function estimateMaxRequestCost(body: ChatCompletionRequest): number {
  // Estimate input tokens: ~4 chars per token for English text
  const inputChars = (body.messages || []).reduce((sum, m) => sum + (m.content?.length || 0), 0);
  const estimatedInputTokens = Math.max(Math.ceil(inputChars / 4), 100); // min 100
  // Use max_tokens from request or default cap
  const estimatedOutputTokens = body.max_tokens || 4096;
  // Use most expensive model pricing as upper bound (GPT-5.5: $0.005/$0.03 per 1k)
  const maxInputRate = 0.005;
  const maxOutputRate = 0.03;
  return (estimatedInputTokens / 1000) * maxInputRate + (estimatedOutputTokens / 1000) * maxOutputRate;
}

/**
 * Estimate cost per 1k tokens
 */
function estimateCost(provider: string, model: string, tokensIn: number, tokensOut: number): number {
  // OFFICIAL VERIFIED pricing per 1k tokens (May 26, 2026)
  // TODO: consolidate pricing into a single source (duplicated in selector/index.ts)
  const PRICING: Record<string, Record<string, { input: number; output: number }>> = {
    'openai': {
      'gpt-4o': { input: 0.0025, output: 0.01 },
      'gpt-4o-mini': { input: 0.00015, output: 0.0006 },
      'gpt-5': { input: 0.00125, output: 0.01 },
      'gpt-5.1': { input: 0.00125, output: 0.01 },
      'gpt-5.2': { input: 0.00175, output: 0.014 },
      'gpt-5.4': { input: 0.0025, output: 0.015 },
      'gpt-5.5': { input: 0.005, output: 0.03 },
      'gpt-5.5-pro': { input: 0.005, output: 0.03 },
      'gpt-5.5-2026-04-23': { input: 0.005, output: 0.03 },
      'gpt-5-codex': { input: 0.00125, output: 0.01 },
      'gpt-5.1-codex': { input: 0.00125, output: 0.01 },
    },
    'anthropic': {
      'claude-haiku-4-5': { input: 0.00025, output: 0.00125 },
      'claude-sonnet-4-5': { input: 0.003, output: 0.015 },
      'claude-sonnet-4-5-20250929': { input: 0.003, output: 0.015 },
      'claude-sonnet-4-6': { input: 0.003, output: 0.015 },
      'claude-opus-4-5-20251101': { input: 0.005, output: 0.025 },
      'claude-opus-4-6': { input: 0.005, output: 0.025 },
      'claude-opus-4-7': { input: 0.005, output: 0.025 },
      'claude-opus-4-8': { input: 0.005, output: 0.025 },
      'claude-3-5-haiku': { input: 0.00025, output: 0.00125 },
      // DEPRECATED — retiring June 15, 2026:
      // 'claude-sonnet-4-20250514', 'claude-opus-4-20250514'
    },
    'xai': {
      // May 2026: grok-4-0709, grok-code-fast-1, grok-2-latest retired May 15
      'grok-4.3': { input: 0.003, output: 0.015 },
      'grok-build-0.1': { input: 0.0002, output: 0.0015 },
    },
    'google': {
      'gemini-2.5-pro': { input: 0.00125, output: 0.01 },
      'gemini-2.5-flash': { input: 0.0003, output: 0.0025 },
      'gemini-2.5-flash-lite': { input: 0.0001, output: 0.0004 },
      'gemini-3.1-pro-preview': { input: 0.002, output: 0.012 },
      'gemini-3.1-flash-lite': { input: 0.00025, output: 0.0015 },
      'gemini-3.5-flash': { input: 0.00025, output: 0.002 },
      // REMOVED: gemini-1.5-pro, gemini-1.5-flash — retiring June 1, 2026
    },
    'glm': {
      'glm-4.6': { input: 0.0001, output: 0.0005 },
      'glm-4.7': { input: 0.00015, output: 0.00075 },
      'glm-5': { input: 0.0002, output: 0.001 },
      'glm-5.1': { input: 0.0002, output: 0.001 },
      // REMOVED: glm-4.7-flash, glm-4.7-flashx — not in Z.AI catalog
    },
    'deepseek': {
      'deepseek-v4-flash': { input: 0.0000028, output: 0.00028 },
      'deepseek-v4-pro': { input: 0.000003625, output: 0.00087 },
      // REMOVED: deepseek-chat, deepseek-reasoner — hard retire July 24, 2026
    },
    'kimi': {
      'kimi-k2.5': { input: 0.0003, output: 0.0015 },
      'kimi-k2.6': { input: 0.0003, output: 0.0015 },
    }
  };
  
  const pricing = PRICING[provider]?.[model] || { input: 0.001, output: 0.002 };
  return (tokensIn / 1000) * pricing.input + (tokensOut / 1000) * pricing.output;
}

/**
 * Log request for analytics + API Monitoring.
 * The `month` parameter should be captured at request-receipt time (not now)
 * to avoid month-boundary attribution errors when setImmediate fires late.
 * The `reservationRefund` parameter is the estimated cost pre-reserved by the
 * hard-limit gate. The atomic increment uses (actualCost - reservation) so the
 * net effect on the counter is +actualCost (not +estimated +actual).
 */
async function logRequest(
  userId: number,
  apiKeyId: number,
  provider: string,
  model: string,
  reasoning: string,
  tokensIn: number,
  tokensOut: number,
  latencyMs: number,
  success: boolean,
  errorMessage?: string,
  // API Monitoring fields
  promptText?: string | null,
  promptCategory?: string | null,
  promptLanguage?: string | null,
  promptComplexity?: string | null,
  // Month captured at request-receipt time (Fix #3: month boundary race)
  requestMonth?: string,
  // Pre-reserved cost from hard-limit gate (to be refunded as over-estimate)
  reservationRefund?: number,
) {
  try {
    const cost = estimateCost(provider, model, tokensIn, tokensOut);
    const month = requestMonth || new Date().toISOString().substring(0, 7);
    
    await db.insert(routerRequests).values({
      user_id: userId,
      api_key_id: apiKeyId,
      selected_provider: provider,
      selected_model: model,
      routing_reason: reasoning,
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      latency_ms: latencyMs,
      cost_estimate: cost,
      success: success,
      error_message: errorMessage || null,
      created_at: new Date().toISOString(),
      // API Monitoring columns
      prompt_text: promptText || null,
      prompt_category: promptCategory || null,
      prompt_language: promptLanguage || null,
      prompt_complexity: promptComplexity || null,
    });
    
    // Update monthly usage
    const existing = await db
      .select()
      .from(routerUsage)
      .where(
        and(
          eq(routerUsage.user_id, userId),
          eq(routerUsage.month, month)
        )
      )
      .limit(1);
    
    if (existing.length > 0) {
      const record = existing[0];
      await db
        .update(routerUsage)
        .set({
          total_requests: (record.total_requests || 0) + 1,
          total_tokens_in: (record.total_tokens_in || 0) + tokensIn,
          total_tokens_out: (record.total_tokens_out || 0) + tokensOut,
          total_cost_estimate: (record.total_cost_estimate || 0) + cost,
          updated_at: new Date().toISOString()
        })
        .where(eq(routerUsage.id, record.id));
    } else {
      await db.insert(routerUsage).values({
        user_id: userId,
        month,
        total_requests: 1,
        total_tokens_in: tokensIn,
        total_tokens_out: tokensOut,
        total_cost_estimate: cost,
        cost_saved_vs_gpt4: 0,
        updated_at: new Date().toISOString()
      });
    }

    // Fix #1: Atomic single-statement spend counter increment.
    // If a reservation was made by the hard-limit gate, the counter already has
    // +estimatedCost. We apply (actualCost - reservation) so the net is +actualCost.
    // If no reservation, adjustment = cost (normal case).
    const spendAdjustment = cost - (reservationRefund || 0);
    try {
      const sqlite = dbPool.getWriteConnection();
      const result = sqlite.prepare(`
        UPDATE router_api_keys
        SET
          current_month_spend = CASE
            WHEN current_month_key = ?1 THEN current_month_spend + ?2
            ELSE ?2
          END,
          current_month_key = ?1
        WHERE id = ?3
        RETURNING current_month_spend
      `).get(month, spendAdjustment, apiKeyId) as { current_month_spend: number } | undefined;

      // Use the RETURNING value to fire alerts off the true post-update spend
      if (result) {
        await checkBudgetAlerts(userId, apiKeyId, result.current_month_spend, month);
      }
    } catch (spendErr) {
      console.error('Failed to update spend counter:', spendErr);
    }
  } catch (logError) {
    // Never let logging errors break the response pipeline
    console.error('Failed to log request:', logError);
  }
}

/**
 * Check if prompt logging is enabled for a specific key + user combination.
 * Per-key override takes precedence over account-level setting.
 */
async function isPromptLoggingEnabled(userId: number, apiKeyId: number): Promise<boolean> {
  try {
    // Check per-key override first
    const keyRow = await db
      .select({ prompt_logging_override: routerApiKeys.prompt_logging_override })
      .from(routerApiKeys)
      .where(eq(routerApiKeys.id, apiKeyId))
      .limit(1);

    if (keyRow.length > 0 && keyRow[0].prompt_logging_override !== null) {
      return keyRow[0].prompt_logging_override === 1;
    }

    // Fall back to account-level setting
    const userRow = await db
      .select({ prompt_logging_enabled: routerUsers.prompt_logging_enabled })
      .from(routerUsers)
      .where(eq(routerUsers.id, userId))
      .limit(1);

    return userRow.length > 0 && userRow[0].prompt_logging_enabled === true;
  } catch {
    return false;
  }
}

/**
 * Check budget thresholds and fire alerts if needed.
 * Only fires once per month per alert type per key.
 *
 * When called from logRequest, `knownSpend` and `knownMonth` come from the
 * atomic RETURNING value — avoiding a second read and ensuring consistency.
 */
async function checkBudgetAlerts(userId: number, apiKeyId: number, knownSpend?: number, knownMonth?: string): Promise<void> {
  try {
    const keyRow = await db
      .select({
        budget_limit_monthly: routerApiKeys.budget_limit_monthly,
        budget_alert_threshold: routerApiKeys.budget_alert_threshold,
        current_month_spend: routerApiKeys.current_month_spend,
        current_month_key: routerApiKeys.current_month_key,
      })
      .from(routerApiKeys)
      .where(eq(routerApiKeys.id, apiKeyId))
      .limit(1);

    if (keyRow.length === 0) return;
    const key = keyRow[0];
    if (!key.budget_limit_monthly || key.budget_limit_monthly <= 0) return;

    const month = knownMonth || key.current_month_key || new Date().toISOString().substring(0, 7);
    const spend = knownSpend ?? key.current_month_spend ?? 0;
    const limit = key.budget_limit_monthly;
    const threshold = key.budget_alert_threshold || 0.8;
    const utilization = spend / limit;

    // Check if alert already exists for this month + type
    const existingAlerts = await db
      .select({ alert_type: routerBudgetAlerts.alert_type })
      .from(routerBudgetAlerts)
      .where(
        and(
          eq(routerBudgetAlerts.api_key_id, apiKeyId),
          eq(routerBudgetAlerts.month, month)
        )
      );

    const alertTypes = new Set(existingAlerts.map(a => a.alert_type));

    // Fire budget_exceeded alert
    if (utilization >= 1.0 && !alertTypes.has('budget_exceeded')) {
      await db.insert(routerBudgetAlerts).values({
        api_key_id: apiKeyId,
        user_id: userId,
        month,
        alert_type: 'budget_exceeded',
        threshold_pct: 1.0,
        amount_spent: spend,
        budget_limit: limit,
        created_at: new Date().toISOString(),
      });
    }
    // Fire threshold_warning alert
    else if (utilization >= threshold && !alertTypes.has('threshold_warning')) {
      await db.insert(routerBudgetAlerts).values({
        api_key_id: apiKeyId,
        user_id: userId,
        month,
        alert_type: 'threshold_warning',
        threshold_pct: threshold,
        amount_spent: spend,
        budget_limit: limit,
        created_at: new Date().toISOString(),
      });
    }
  } catch (err) {
    console.error('Budget alert check failed:', err);
  }
}

/**
 * Read budget info for a key (used for hard-limit gate).
 * Returns null if no budget is set.
 */
async function getKeyBudgetInfo(apiKeyId: number): Promise<{
  budgetLimit: number;
  hardLimit: boolean;
  currentSpend: number;
  currentMonthKey: string | null;
} | null> {
  try {
    const row = await db
      .select({
        budget_limit_monthly: routerApiKeys.budget_limit_monthly,
        budget_hard_limit: routerApiKeys.budget_hard_limit,
        current_month_spend: routerApiKeys.current_month_spend,
        current_month_key: routerApiKeys.current_month_key,
      })
      .from(routerApiKeys)
      .where(eq(routerApiKeys.id, apiKeyId))
      .limit(1);

    if (row.length === 0 || !row[0].budget_limit_monthly) return null;

    return {
      budgetLimit: row[0].budget_limit_monthly,
      hardLimit: row[0].budget_hard_limit === true,
      currentSpend: row[0].current_month_spend || 0,
      currentMonthKey: row[0].current_month_key || null,
    };
  } catch {
    return null;
  }
}

/**
 * Determine routing strategy from the `model` field in the request.
 * If model is "auto" (no suffix), use the user's saved preference.
 */
function resolveStrategy(
  modelField: string,
  userSavedStrategy: string
): 'best_overall' | 'best_coding' | 'best_reasoning' | 'best_creative' | 'cheapest' | 'fastest' {
  const strategyMap: Record<string, string> = {
    'auto-coding': 'best_coding',
    'auto-reasoning': 'best_reasoning',
    'auto-creative': 'best_creative',
    'auto-cheapest': 'cheapest',
    'auto-fastest': 'fastest',
    'auto-best': 'best_overall'
  };
  
  // If user explicitly requests a strategy via "auto-xxx", use that
  if (modelField.startsWith('auto-') && strategyMap[modelField]) {
    return strategyMap[modelField] as any;
  }
  
  // If model is just "auto", use the user's saved routing strategy
  if (modelField === 'auto') {
    const validStrategies = ['best_overall', 'best_coding', 'best_reasoning', 'best_creative', 'cheapest', 'fastest'];
    if (validStrategies.includes(userSavedStrategy)) {
      return userSavedStrategy as any;
    }
  }
  
  return 'best_overall';
}

/**
 * Try to execute a chat request against a specific model, with error handling
 */
async function tryModelChat(
  userId: number,
  selection: ModelSelection,
  messages: ChatMessage[],
  body: ChatCompletionRequest
): Promise<{ response: ChatResponse; adapter: LLMAdapter } | null> {
  try {
    const providerKey = await getProviderKey(userId, selection.provider);
    const adapter = createAdapter(selection.provider, providerKey);
    
    // Phase 2B: Forward all OpenAI 2026 params the adapter understands.
    // The ChatRequest interface in adapters.ts accepts these; per-provider
    // adapters ignore fields they don't support (no need to strip most params —
    // only strip those that cause hard 400 errors from specific providers).
    const chatReq: any = {
      model: selection.model,
      messages,
      temperature: body.temperature,
      maxTokens: body.max_completion_tokens || body.max_tokens,
      tools: body.tools,
      toolChoice: body.tool_choice,
    };
    // Forward optional params when present
    if (body.response_format?.type === 'json_schema' && body.response_format.json_schema) {
      chatReq.jsonSchema = body.response_format.json_schema.schema;
      chatReq.jsonSchemaName = body.response_format.json_schema.name;
    } else if (body.response_format?.type === 'json_object') {
      // json_object mode — adapters that support it use response_format directly
      chatReq.jsonSchema = true; // Signal to adapter to use json_object mode
    }
    if (body.reasoning_effort) chatReq.reasoning_effort = body.reasoning_effort;
    if (body.top_p !== undefined) chatReq.top_p = body.top_p;
    if (body.stop !== undefined) chatReq.stop = body.stop;
    if (body.seed !== undefined) chatReq.seed = body.seed;
    if (body.frequency_penalty !== undefined) chatReq.frequency_penalty = body.frequency_penalty;
    if (body.presence_penalty !== undefined) chatReq.presence_penalty = body.presence_penalty;

    const response = await adapter.chat(chatReq);
    
    return { response, adapter };
  } catch (error: any) {
    console.warn(`⚠️ Model ${selection.model} (${selection.provider}) failed: ${error.message?.slice(0, 150)}`);
    return null;
  }
}

/**
 * Infer provider from model name prefix for direct pin routing.
 * Returns null if prefix is unknown.
 */
function inferProviderFromModel(modelName: string): string | null {
  for (const [prefix, provider] of Object.entries(MODEL_PREFIX_TO_PROVIDER)) {
    if (modelName.startsWith(prefix)) return provider;
  }
  return null;
}

/**
 * Main chat completions handler
 * Supports fallback behavior: if primary model fails, tries alternatives
 */
export async function chatCompletionsHandler(
  request: FastifyRequest,
  reply: FastifyReply
) {
  const startTime = Date.now();
  
  try {
    // 1. Authenticate
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.code(401).send({
        error: {
          message: 'Missing or invalid Authorization header. Use: Authorization: Bearer aism_xxxxx',
          type: 'authentication_error',
          code: 'invalid_api_key'
        }
      });
    }
    
    const apiKey = authHeader.replace('Bearer ', '');
    const auth = await authenticateRequest(apiKey);
    
    if (!auth) {
      return reply.code(401).send({
        error: {
          message: 'Invalid API key. Generate a new key at https://aistupidlevel.info/router/keys',
          type: 'authentication_error',
          code: 'invalid_api_key'
        }
      });
    }
    
    // 2. Parse request body
    const body = request.body as ChatCompletionRequest;
    
    if (!body.messages || !Array.isArray(body.messages)) {
      return reply.code(400).send({
        error: {
          message: 'Invalid request: messages array is required',
          type: 'invalid_request_error'
        }
      });
    }
    
    // 2b. Phase 2C: Direct model pin routing — if model is NOT auto-*, bypass strategy router
    const requestedModel = body.model || 'auto';
    const isAutoModel = requestedModel === 'auto' || requestedModel.startsWith('auto-');
    
    if (!isAutoModel) {
      // Direct pin: user explicitly requested a specific model (e.g. "claude-opus-4-7")
      // Try DB lookup first, then prefix-based fallback
      let provider: string | null = null;
      try {
        const modelRow = await db
          .select({ vendor: models.vendor })
          .from(models)
          .where(eq(models.name, requestedModel))
          .limit(1);
        if (modelRow.length > 0) provider = modelRow[0].vendor;
      } catch { /* DB lookup failed, use prefix fallback */ }
      
      if (!provider) {
        provider = inferProviderFromModel(requestedModel);
      }
      
      if (!provider) {
        return reply.code(400).send({
          error: {
            message: `Unknown model: ${requestedModel}. Use "auto" for automatic routing or specify a known model ID.`,
            type: 'invalid_request_error',
            code: 'model_not_found'
          }
        });
      }
      
      // Build direct selection — skip strategy router entirely
      const directSelection: ModelSelection = {
        model: requestedModel,
        provider,
        score: 0,
        reasoning: `Direct pin: user requested ${requestedModel} via ${provider}`,
        estimatedCost: 0,
      };
      
      // Build messages
      const messages: ChatMessage[] = body.messages.map(m => ({
        role: m.role as 'system' | 'user' | 'assistant',
        content: m.content
      }));
      
      const chatResult = await tryModelChat(auth.userId, directSelection, messages, body);
      
      if (!chatResult) {
        return reply.code(502).send({
          error: {
            message: `Model ${requestedModel} (${provider}) failed. Check your ${provider} API key.`,
            type: 'server_error',
            code: 'model_unavailable'
          }
        });
      }
      
      const { response } = chatResult;
      const latency = Date.now() - startTime;
      const requestMonth = new Date().toISOString().substring(0, 7);
      
      // Async log (same pipeline as auto routing)
      setImmediate(async () => {
        try {
          const lastUserMsg = body.messages.filter(m => m.role === 'user').pop()?.content || '';
          const hasSubstantivePrompt = lastUserMsg.trim().length >= 2;
          let category: string | null = null, language: string | null = null, complexity: string | null = null;
          if (hasSubstantivePrompt) {
            try {
              const analysis = await Promise.race([
                Promise.resolve(analyzePrompt(lastUserMsg)),
                new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000))
              ]);
              category = analysis.taskType || null;
              language = analysis.language || null;
              complexity = analysis.complexity || null;
            } catch { /* timeout */ }
          }
          let encryptedPrompt: string | null = null;
          if (hasSubstantivePrompt) {
            const shouldLog = await isPromptLoggingEnabled(auth.userId, auth.apiKeyId);
            if (shouldLog) {
              const scrubbed = scrubPromptText(lastUserMsg);
              encryptedPrompt = encryptPromptText(scrubbed.text);
            }
          }
          await logRequest(
            auth.userId, auth.apiKeyId, provider!, requestedModel,
            directSelection.reasoning, response.tokensIn || 0, response.tokensOut || 0,
            latency, true, undefined, encryptedPrompt, category, language, complexity, requestMonth
          );
        } catch (err) { console.error('Post-response monitoring error (direct pin):', err); }
      });
      
      // Return response (inline — same format as auto-routing path below)
      const id = `chatcmpl-${Date.now()}`;
      const created = Math.floor(Date.now() / 1000);
      const usageBlock = {
        prompt_tokens: response.tokensIn || 0,
        completion_tokens: response.tokensOut || 0,
        total_tokens: (response.tokensIn || 0) + (response.tokensOut || 0),
        prompt_tokens_details: { cached_tokens: response.raw?.cachedInputTokens ?? 0 },
        completion_tokens_details: { reasoning_tokens: response.raw?.reasoningTokens ?? 0 },
      };
      reply.header('X-AISM-Provider', provider);
      reply.header('X-AISM-Model', requestedModel);
      reply.header('X-AISM-Latency', String(latency));
      
      if (body.stream) {
        reply.raw.setHeader('Content-Type', 'text/event-stream');
        reply.raw.setHeader('Cache-Control', 'no-cache');
        reply.raw.setHeader('Connection', 'keep-alive');
        reply.raw.setHeader('X-AISM-Streaming-Mode', 'simulated');
        const roleChunk = { id, object: 'chat.completion.chunk', created, model: requestedModel,
          choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] };
        reply.raw.write(`data: ${JSON.stringify(roleChunk)}\n\n`);
        const text = response.text || '';
        const sentences = text.match(/[^.!?\n]+[.!?\n]+|[^.!?\n]+$/g) || [text];
        for (const s of sentences) {
          if (!s) continue;
          reply.raw.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: requestedModel,
            choices: [{ index: 0, delta: { content: s }, finish_reason: null }] })}\n\n`);
        }
        // Stream tool calls if any
        if (response.toolCalls && response.toolCalls.length > 0) {
          for (let i = 0; i < response.toolCalls.length; i++) {
            const tc = response.toolCalls[i];
            reply.raw.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: requestedModel,
              choices: [{ index: 0, delta: { tool_calls: [{ index: i, id: `call_${Date.now()}_${i}`, type: 'function',
                function: { name: tc.name, arguments: JSON.stringify(tc.arguments) } }] }, finish_reason: null }] })}\n\n`);
          }
        }
        const directFinishReason = response.toolCalls?.length ? 'tool_calls' : 'stop';
        reply.raw.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: requestedModel,
          system_fingerprint: `aism_v1_${provider}`, choices: [{ index: 0, delta: {}, finish_reason: directFinishReason }] })}\n\n`);
        if (body.stream_options?.include_usage) {
          reply.raw.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: requestedModel,
            choices: [], usage: usageBlock })}\n\n`);
        }
        reply.raw.write('data: [DONE]\n\n');
        reply.raw.end();
        return;
      }
      
      const directResponseBody: any = {
        id, object: 'chat.completion', created, model: requestedModel,
        system_fingerprint: `aism_v1_${provider}`,
        service_tier: 'default',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: response.text || '', refusal: null, annotations: [] },
          finish_reason: response.toolCalls?.length ? 'tool_calls' : 'stop'
        }],
        usage: usageBlock,
      };
      // Include tool calls in message if present
      if (response.toolCalls && response.toolCalls.length > 0) {
        directResponseBody.choices[0].message.tool_calls = response.toolCalls.map((tc: any, i: number) => ({
          id: `call_${Date.now()}_${i}`, type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) }
        }));
      }
      return reply.send(directResponseBody);
    }
    
    // 3. Get user preferences to resolve strategy (auto-* models only)
    const { routerPreferences } = await import('../../db/router-schema');
    const userPrefsRow = await db
      .select({ routing_strategy: routerPreferences.routing_strategy })
      .from(routerPreferences)
      .where(eq(routerPreferences.user_id, auth.userId))
      .limit(1);
    const userSavedStrategy = userPrefsRow[0]?.routing_strategy || 'best_overall';
    
    // 4. Determine routing strategy from model parameter + saved preferences
    const strategy = resolveStrategy(body.model || 'auto', userSavedStrategy);
    
    // 4b. Budget hard-limit gate with atomic pre-flight reservation.
    // Instead of a SELECT-then-decide (vulnerable to N concurrent requests all passing),
    // we atomically reserve estimated cost BEFORE the LLM call. If the reservation would
    // exceed the budget, the UPDATE changes 0 rows and we reject. Over-estimates are
    // refunded to actuals in the post-response pipeline via reconciliation.
    const budgetInfo = await getKeyBudgetInfo(auth.apiKeyId);
    let reservedCost = 0; // Track reservation for refund
    if (budgetInfo && budgetInfo.hardLimit) {
      const requestMonth = new Date().toISOString().substring(0, 7);
      const estimatedCost = estimateMaxRequestCost(body);
      
      try {
        const sqlite = dbPool.getWriteConnection();
        // Atomic reservation: only succeeds if spend + estimate <= budget
        const reserveResult = sqlite.prepare(`
          UPDATE router_api_keys
          SET
            current_month_spend = CASE
              WHEN current_month_key = ?1 THEN current_month_spend + ?2
              ELSE ?2
            END,
            current_month_key = ?1
          WHERE id = ?3
            AND budget_hard_limit = 1
            AND budget_limit_monthly IS NOT NULL
            AND (
              CASE
                WHEN current_month_key = ?1 THEN current_month_spend + ?2
                ELSE ?2
              END
            ) <= budget_limit_monthly
          RETURNING current_month_spend
        `).get(requestMonth, estimatedCost, auth.apiKeyId) as { current_month_spend: number } | undefined;

        if (!reserveResult) {
          // Reservation failed — either budget exceeded or month rolled over and still over.
          // Read current spend for the error message
          const currentSpend = budgetInfo.currentMonthKey === requestMonth ? budgetInfo.currentSpend : 0;
          return reply.code(429).send({
            error: {
              message: `Monthly budget exceeded for this API key ($${currentSpend.toFixed(4)} / $${budgetInfo.budgetLimit.toFixed(2)} limit). Contact your administrator to increase the budget or wait until next month.`,
              type: 'rate_limit_error',
              code: 'insufficient_quota',
              budget_limit: budgetInfo.budgetLimit,
              current_spend: currentSpend,
            }
          });
        }
        reservedCost = estimatedCost; // Track for refund
      } catch (err) {
        // If reservation SQL fails, fall through — don't block the request
        console.error('Budget reservation failed, proceeding without gate:', err);
      }
    } else if (budgetInfo && !budgetInfo.hardLimit) {
      // Soft limit — just check and warn, don't block
      const currentMonth = new Date().toISOString().substring(0, 7);
      const effectiveSpend = budgetInfo.currentMonthKey === currentMonth ? budgetInfo.currentSpend : 0;
      // Soft limit alerts are handled in the post-response pipeline
    }
    
    // 5. Select best model with fallbacks
    const selectionResult = await selectModelsWithFallbacks({
      userId: auth.userId,
      strategy
    });
    
    const { primary, fallbacks, fallbackEnabled } = selectionResult;
    
    // 6. Build messages
    const messages: ChatMessage[] = body.messages.map(m => ({
      role: m.role as 'system' | 'user' | 'assistant',
      content: m.content
    }));
    
    // 7. Try primary model, then fallbacks if enabled
    let usedSelection = primary;
    let chatResult = await tryModelChat(auth.userId, primary, messages, body);
    
    // If primary failed and fallback is enabled, try alternatives
    if (!chatResult && fallbackEnabled && fallbacks.length > 0) {
      console.log(`🔄 Primary model ${primary.model} failed, trying ${fallbacks.length} fallback(s)...`);
      
      for (const fallback of fallbacks) {
        chatResult = await tryModelChat(auth.userId, fallback, messages, body);
        if (chatResult) {
          usedSelection = fallback;
          usedSelection.reasoning = `Fallback activated: ${primary.model} failed → routed to ${fallback.model}. ${fallback.reasoning}`;
          console.log(`✅ Fallback succeeded: ${fallback.model} (${fallback.provider})`);
          break;
        }
      }
    }
    
    // All attempts failed
    if (!chatResult) {
      const latency = Date.now() - startTime;
      const triedModels = [primary.model, ...fallbacks.map(f => f.model)].join(', ');
      
      await logRequest(
        auth.userId, auth.apiKeyId,
        primary.provider, primary.model,
        `All models failed: ${triedModels}`,
        0, 0, latency, false,
        `All ${1 + fallbacks.length} model(s) failed`
      );
      
      return reply.code(502).send({
        error: {
          message: fallbackEnabled
            ? `All models failed (tried: ${triedModels}). Please check your provider API keys.`
            : `Model ${primary.model} failed. Enable fallback in preferences for automatic retries.`,
          type: 'api_error',
          code: 'model_unavailable',
          tried_models: [primary.model, ...fallbacks.map(f => f.model)]
        }
      });
    }
    
    const { response } = chatResult;
    const latency = Date.now() - startTime;
    
    // 8. Extract last user message for classification (used async after response)
    // Fix #5: Guard empty/trivial messages — skip classification & logging for empty content
    const lastUserMsg = body.messages.filter(m => m.role === 'user').pop()?.content || '';
    const hasSubstantivePrompt = lastUserMsg.trim().length >= 2; // Skip empty, single-char, whitespace-only
    
    // Fix #3: Capture month string NOW at request-receipt time, not in the async callback.
    const requestMonth = new Date().toISOString().substring(0, 7); // YYYY-MM frozen at receipt
    
    // 9. Async post-response: classify prompt, scrub, encrypt, log, check budget
    // This runs AFTER the response is sent — zero added latency to the LLM call
    const asyncUserId = auth.userId;
    const asyncApiKeyId = auth.apiKeyId;
    const asyncProvider = usedSelection.provider;
    const asyncModel = usedSelection.model;
    const asyncReasoning = usedSelection.reasoning;
    const asyncTokensIn = response.tokensIn || 0;
    const asyncTokensOut = response.tokensOut || 0;
    const asyncLatency = latency;
    const asyncReservedCost = reservedCost; // Capture for refund

    setImmediate(async () => {
      try {
        // 9a. Classify prompt (2s timeout, failure = NULL)
        let category: string | null = null;
        let language: string | null = null;
        let complexity: string | null = null;
        if (hasSubstantivePrompt) {
          try {
            const analysis = await Promise.race([
              Promise.resolve(analyzePrompt(lastUserMsg)),
              new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000))
            ]);
            category = analysis.taskType || null;
            language = analysis.language || null;
            complexity = analysis.complexity || null;
          } catch { /* classification timeout or error — log NULL */ }
        }

        // 9b. Determine if prompt logging is enabled, then scrub + encrypt
        let encryptedPrompt: string | null = null;
        if (hasSubstantivePrompt) {
          const shouldLog = await isPromptLoggingEnabled(asyncUserId, asyncApiKeyId);
          if (shouldLog) {
            const scrubbed = scrubPromptText(lastUserMsg);
            encryptedPrompt = encryptPromptText(scrubbed.text);
          }
        }

        // 9c. Log request with monitoring data.
        // If we pre-reserved cost in the budget gate, the spend counter already has
        // the estimated amount. logRequest will add the actual cost. We need to refund
        // the reservation so the net effect is: +actualCost (not +estimated +actual).
        // The refund is: -(reservedCost) applied as an adjustment to the atomic increment.
        await logRequest(
          asyncUserId, asyncApiKeyId,
          asyncProvider, asyncModel, asyncReasoning,
          asyncTokensIn, asyncTokensOut, asyncLatency,
          true, undefined,
          encryptedPrompt, category, language, complexity,
          requestMonth,
          asyncReservedCost  // reservation to refund
        );
      } catch (asyncErr) {
        console.error('Post-response monitoring error:', asyncErr);
      }
    });
    
    // 10. Return response — Phase 3A/3B/3C/3D compliance
    const responseId = `chatcmpl-${Date.now()}`;
    const responseCreated = Math.floor(Date.now() / 1000);
    const usageBlock = {
      prompt_tokens: response.tokensIn || 0,
      completion_tokens: response.tokensOut || 0,
      total_tokens: (response.tokensIn || 0) + (response.tokensOut || 0),
      prompt_tokens_details: { cached_tokens: response.raw?.cachedInputTokens ?? 0 },
      completion_tokens_details: { reasoning_tokens: response.raw?.reasoningTokens ?? 0 },
    };
    
    // Phase 3D: x-ratelimit-* headers (basic implementation)
    reply.header('X-AISM-Provider', usedSelection.provider);
    reply.header('X-AISM-Model', usedSelection.model);
    reply.header('X-AISM-Latency', String(latency));
    
    if (body.stream) {
      // Streaming response — simulate SSE from completed response
      // NOTE: This is simulated streaming (full response split into chunks).
      reply.raw.setHeader('Content-Type', 'text/event-stream');
      reply.raw.setHeader('Cache-Control', 'no-cache');
      reply.raw.setHeader('Connection', 'keep-alive');
      reply.raw.setHeader('X-AISM-Provider', usedSelection.provider);
      reply.raw.setHeader('X-AISM-Model', usedSelection.model);
      reply.raw.setHeader('X-AISM-Reasoning', usedSelection.reasoning);
      reply.raw.setHeader('X-AISM-Latency', String(latency));
      // Phase 3C: Signal simulated streaming to tools like Aider
      reply.raw.setHeader('X-AISM-Streaming-Mode', 'simulated');
      
      // Send role chunk first
      const roleChunk = {
        id: responseId,
        object: 'chat.completion.chunk',
        created: responseCreated,
        model: usedSelection.model,
        system_fingerprint: `aism_v1_${usedSelection.provider}`,
        choices: [{
          index: 0,
          delta: { role: 'assistant', content: '' },
          finish_reason: null
        }]
      };
      reply.raw.write(`data: ${JSON.stringify(roleChunk)}\n\n`);
      
      // Split into sentence-level chunks for more natural streaming feel
      const text = response.text || '';
      const sentences = text.match(/[^.!?\n]+[.!?\n]+|[^.!?\n]+$/g) || [text];
      
      for (const sentence of sentences) {
        if (!sentence) continue;
        reply.raw.write(`data: ${JSON.stringify({
          id: responseId, object: 'chat.completion.chunk', created: responseCreated,
          model: usedSelection.model, system_fingerprint: `aism_v1_${usedSelection.provider}`,
          choices: [{ index: 0, delta: { content: sentence }, finish_reason: null }]
        })}\n\n`);
      }
      
      // Send tool calls if any
      if (response.toolCalls && response.toolCalls.length > 0) {
        for (let i = 0; i < response.toolCalls.length; i++) {
          const tc = response.toolCalls[i];
          reply.raw.write(`data: ${JSON.stringify({
            id: responseId, object: 'chat.completion.chunk', created: responseCreated,
            model: usedSelection.model,
            choices: [{ index: 0, delta: { tool_calls: [{
              index: i, id: `call_${Date.now()}_${i}`, type: 'function',
              function: { name: tc.name, arguments: JSON.stringify(tc.arguments) }
            }] }, finish_reason: null }]
          })}\n\n`);
        }
      }
      
      // Final stop chunk
      reply.raw.write(`data: ${JSON.stringify({
        id: responseId, object: 'chat.completion.chunk', created: responseCreated,
        model: usedSelection.model, system_fingerprint: `aism_v1_${usedSelection.provider}`,
        choices: [{ index: 0, delta: {}, finish_reason: response.toolCalls?.length ? 'tool_calls' : 'stop' }]
      })}\n\n`);
      
      // Phase 3C: stream_options.include_usage — emit final usage chunk with choices: []
      if (body.stream_options?.include_usage) {
        reply.raw.write(`data: ${JSON.stringify({
          id: responseId, object: 'chat.completion.chunk', created: responseCreated,
          model: usedSelection.model, choices: [], usage: usageBlock
        })}\n\n`);
      }
      
      reply.raw.write('data: [DONE]\n\n');
      reply.raw.end();
      
    } else {
      // Non-streaming response — Phase 3A: compliant response body
      const responseBody: any = {
        id: responseId,
        object: 'chat.completion',
        created: responseCreated,
        model: usedSelection.model,
        // Phase 3A: Standard fields required by strict Pydantic in openai-python ≥1.50
        system_fingerprint: `aism_v1_${usedSelection.provider}`,
        service_tier: 'default',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: response.text || '',
            refusal: null,      // Phase 3A: Required by strict Pydantic
            annotations: [],    // Phase 3A: Required by strict Pydantic
          },
          finish_reason: 'stop'
        }],
        // Phase 3B: Enriched usage block with token details
        usage: usageBlock,
      };
      
      // Include tool calls if present
      if (response.toolCalls && response.toolCalls.length > 0) {
        responseBody.choices[0].message.tool_calls = response.toolCalls.map((tc: any, i: number) => ({
          id: `call_${Date.now()}_${i}`,
          type: 'function',
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.arguments)
          }
        }));
        responseBody.choices[0].finish_reason = 'tool_calls';
      }
      
      // NOTE: x-aism-* metadata moved from body to headers only (Phase 3A)
      // Non-standard fields in the body break strict JSON parsers
      
      return reply.send(responseBody);
    }
    
  } catch (error: any) {
    const latency = Date.now() - startTime;
    
    console.error('Router proxy error:', error);
    
    // Try to log failed request if we have auth
    try {
      const authHeader = request.headers.authorization;
      if (authHeader) {
        const apiKey = authHeader.replace('Bearer ', '');
        const auth = await authenticateRequest(apiKey);
        if (auth) {
          await logRequest(
            auth.userId,
            auth.apiKeyId,
            'unknown',
            'unknown',
            'Error occurred before model selection',
            0,
            0,
            latency,
            false,
            error.message
          );
        }
      }
    } catch (logError) {
      console.error('Failed to log error:', logError);
    }
    
    // Return user-friendly error messages
    const statusCode = error.message?.includes('No active provider') ? 400
      : error.message?.includes('No models match') ? 400
      : error.message?.includes('No model rankings') ? 503
      : 500;
    
    return reply.code(statusCode).send({
      error: {
        message: error.message || 'Internal server error',
        type: statusCode === 503 ? 'server_error' : statusCode < 500 ? 'invalid_request_error' : 'server_error',
        code: statusCode === 503 ? 'model_unavailable' : statusCode < 500 ? 'configuration_error' : 'internal_error'
      }
    });
  }
}

/**
 * List models handler — Phase 2D: returns auto-* virtuals + real tested models from DB.
 * Auth required to prevent leaking tested-model lineup to scrapers.
 */
export async function listModelsHandler(
  request: FastifyRequest,
  reply: FastifyReply
) {
  try {
    // Authenticate (required — don't leak model lineup)
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.code(401).send({
        error: {
          message: 'Missing or invalid Authorization header',
          type: 'authentication_error',
          code: 'invalid_api_key'
        }
      });
    }
    
    const apiKey = authHeader.replace('Bearer ', '');
    const auth = await authenticateRequest(apiKey);
    
    if (!auth) {
      return reply.code(401).send({
        error: {
          message: 'Invalid API key',
          type: 'authentication_error',
          code: 'invalid_api_key'
        }
      });
    }
    
    const now = Math.floor(Date.now() / 1000);
    
    // 1. Auto-* virtual models (always first)
    const autoModels = [
      { id: 'auto', object: 'model' as const, created: now, owned_by: 'aistupidlevel' },
      { id: 'auto-coding', object: 'model' as const, created: now, owned_by: 'aistupidlevel' },
      { id: 'auto-reasoning', object: 'model' as const, created: now, owned_by: 'aistupidlevel' },
      { id: 'auto-creative', object: 'model' as const, created: now, owned_by: 'aistupidlevel' },
      { id: 'auto-cheapest', object: 'model' as const, created: now, owned_by: 'aistupidlevel' },
      { id: 'auto-fastest', object: 'model' as const, created: now, owned_by: 'aistupidlevel' },
    ];
    
    // 2. Phase 2D: Query real tested models (show_in_rankings = true)
    let realModels: Array<{ id: string; object: string; created: number; owned_by: string }> = [];
    try {
      const testedModels = await db
        .select({ name: models.name, vendor: models.vendor })
        .from(models)
        .where(eq(models.showInRankings, true));
      
      realModels = testedModels.map(m => ({
        id: m.name,
        object: 'model' as const,
        created: now,
        owned_by: m.vendor,
      }));
    } catch (err) {
      console.warn('Failed to load tested models for /v1/models:', err);
      // Continue with auto-* only — don't fail the endpoint
    }
    
    return reply.send({
      object: 'list',
      data: [...autoModels, ...realModels]
    });
    
  } catch (error: any) {
    console.error('List models error:', error);
    return reply.code(500).send({
      error: {
        message: error.message || 'Internal server error',
        type: 'server_error'
      }
    });
  }
}
