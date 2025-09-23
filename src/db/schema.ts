import { sqliteTable, integer, text, real } from 'drizzle-orm/sqlite-core';

export const models = sqliteTable('models', {
  id: integer('id', { mode: 'number' }).primaryKey({ autoIncrement: true }),
  name: text('name').notNull(), // e.g., "gpt-4.1-mini"
  vendor: text('vendor').notNull(), // openai | xai | etc
  version: text('version'), // provider-reported
  notes: text('notes'),
  createdAt: text('created_at').default('CURRENT_TIMESTAMP'), // Track when model was first discovered
  displayName: text('display_name'), // Optional friendly display name for confusing model names
  showInRankings: integer('show_in_rankings', { mode: 'boolean' }).default(false), // Whether to show in live rankings
  // Tool calling capabilities
  supportsToolCalling: integer('supports_tool_calling', { mode: 'boolean' }).default(false),
  maxToolsPerCall: integer('max_tools_per_call').default(10),
  toolCallReliability: real('tool_call_reliability').default(0.0) // 0.0-1.0 based on historical performance
});

export const tasks = sqliteTable('tasks', {
  id: integer('id', { mode: 'number' }).primaryKey({ autoIncrement: true }),
  slug: text('slug').notNull().unique(), // e.g., py/top_k_frequent
  lang: text('lang').notNull(), // py | ts
  type: text('type').notNull(), // impl | fix | refactor | schema
  difficulty: integer('difficulty').notNull(), // 1..5
  schemaUri: text('schema_uri'),
  hidden: integer('hidden', { mode: 'boolean' }).default(false)
});

export const runs = sqliteTable('runs', {
  id: integer('id', { mode: 'number' }).primaryKey({ autoIncrement: true }),
  modelId: integer('model_id').references(() => models.id).notNull(),
  taskId: integer('task_id').references(() => tasks.id), // Allow null for optional task linking
  ts: text('ts').default('CURRENT_TIMESTAMP'),
  temp: real('temp').notNull(),
  seed: integer('seed').notNull(),
  tokensIn: integer('tokens_in').notNull(),
  tokensOut: integer('tokens_out').notNull(),
  latencyMs: integer('latency_ms').notNull(),
  attempts: integer('attempts').notNull(),
  passed: integer('passed', { mode: 'boolean' }).notNull(),
  artifacts: text('artifacts', { mode: 'json' }).$type<Record<string, any>>()
});

export const metrics = sqliteTable('metrics', {
  runId: integer('run_id').references(() => runs.id).primaryKey(),
  correctness: real('correctness').notNull(),
  spec: real('spec').notNull(),
  codeQuality: real('code_quality').notNull(),
  efficiency: real('efficiency').notNull(),
  stability: real('stability').notNull(),
  refusal: real('refusal').notNull(),
  recovery: real('recovery').notNull()
});

export const baselines = sqliteTable('baselines', {
  id: integer('id', { mode: 'number' }).primaryKey({ autoIncrement: true }),
  modelId: integer('model_id').references(() => models.id).notNull(),
  taskType: text('task_type').notNull(),
  windowStart: text('window_start').notNull(),
  windowEnd: text('window_end').notNull(),
  means: text('means', { mode: 'json' }).$type<Record<string, number>>().notNull(),
  stds: text('stds', { mode: 'json' }).$type<Record<string, number>>().notNull()
});

export const benchConfigs = sqliteTable('bench_configs', {
  id: integer('id', { mode: 'number' }).primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),           // e.g., "v1-fixed"
  temp: real('temp').notNull(),
  seed: integer('seed').notNull(),
  maxTokens: integer('max_tokens').notNull(),
  systemPromptHash: text('system_prompt_hash').notNull(),
});

export const runBatches = sqliteTable('run_batches', {
  id: integer('id', { mode: 'number' }).primaryKey({ autoIncrement: true }),
  benchConfigId: integer('bench_config_id').references(()=>benchConfigs.id).notNull(),
  startedAt: text('started_at').default('CURRENT_TIMESTAMP'),
  note: text('note')
});

export const scores = sqliteTable('scores', {
  id: integer('id', { mode: 'number' }).primaryKey({ autoIncrement: true }),
  modelId: integer('model_id').references(() => models.id).notNull(),
  ts: text('ts').default('CURRENT_TIMESTAMP'),
  stupidScore: real('stupid_score').notNull(),
  axes: text('axes', { mode: 'json' }).$type<Record<string, number>>().notNull(),
  cusum: real('cusum').notNull(),
  note: text('note'),
  suite: text('suite').default('hourly') // 'hourly' | 'deep' | 'tooling'
});

// Deep session tracking
export const deep_sessions = sqliteTable('deep_sessions', {
  id: integer('id', { mode: 'number' }).primaryKey({ autoIncrement: true }),
  modelId: integer('model_id').references(() => models.id).notNull(),
  taskSlug: text('task_slug').notNull(),
  ts: text('ts').default('CURRENT_TIMESTAMP'),
  turns: integer('turns').notNull(),
  totalLatencyMs: integer('total_latency_ms').notNull(),
  totalTokensIn: integer('total_tokens_in').notNull(),
  totalTokensOut: integer('total_tokens_out').notNull(),
  passed: integer('passed', { mode: 'boolean' }).notNull(),
  conversationData: text('conversation_data', { mode: 'json' }).$type<any[]>(),
  stepResults: text('step_results', { mode: 'json' }).$type<any[]>(),
  finalScore: integer('final_score').notNull()
});

// Deep session alerts
export const deep_alerts = sqliteTable('deep_alerts', {
  id: integer('id', { mode: 'number' }).primaryKey({ autoIncrement: true }),
  modelId: integer('model_id').references(() => models.id).notNull(),
  ts: text('ts').default('CURRENT_TIMESTAMP'),
  level: text('level').notNull(), // 'warning' | 'critical'
  message: text('message').notNull(),
  context: text('context', { mode: 'json' }).$type<Record<string, any>>()
});

export const visitors = sqliteTable('visitors', {
  id: integer('id', { mode: 'number' }).primaryKey({ autoIncrement: true }),
  ip: text('ip').notNull(),
  userAgent: text('user_agent'),
  referer: text('referer'),
  path: text('path').notNull(),
  timestamp: text('timestamp').default('CURRENT_TIMESTAMP'),
  country: text('country'),
  city: text('city'),
  isUnique: integer('is_unique', { mode: 'boolean' }).default(false)
});

export const visitorStats = sqliteTable('visitor_stats', {
  id: integer('id', { mode: 'number' }).primaryKey({ autoIncrement: true }),
  date: text('date').notNull().unique(), // YYYY-MM-DD format
  totalVisits: integer('total_visits').notNull().default(0),
  uniqueVisitors: integer('unique_visitors').notNull().default(0),
  topPages: text('top_pages', { mode: 'json' }).$type<Record<string, number>>().notNull(),
  topCountries: text('top_countries', { mode: 'json' }).$type<Record<string, number>>().notNull()
});

// Tool calling benchmark tables
export const tool_tasks = sqliteTable('tool_tasks', {
  id: integer('id', { mode: 'number' }).primaryKey({ autoIncrement: true }),
  slug: text('slug').notNull().unique(), // e.g., "file_operations_easy"
  name: text('name').notNull(), // Human readable name
  description: text('description').notNull(),
  difficulty: text('difficulty').notNull(), // 'easy' | 'medium' | 'hard'
  category: text('category').notNull(), // 'file_ops' | 'code_analysis' | 'system_interaction' | 'web_scraping' | 'data_processing' | 'multi_step'
  systemPrompt: text('system_prompt').notNull(),
  initialMessage: text('initial_message').notNull(),
  successCriteria: text('success_criteria', { mode: 'json' }).$type<Record<string, any>>().notNull(),
  maxTurns: integer('max_turns').default(10),
  timeoutMs: integer('timeout_ms').default(300000), // 5 minutes default
  sandboxConfig: text('sandbox_config', { mode: 'json' }).$type<Record<string, any>>().notNull(),
  expectedTools: text('expected_tools', { mode: 'json' }).$type<string[]>().notNull(),
  createdAt: text('created_at').default('CURRENT_TIMESTAMP'),
  active: integer('active', { mode: 'boolean' }).default(true)
});

export const tool_sessions = sqliteTable('tool_sessions', {
  id: integer('id', { mode: 'number' }).primaryKey({ autoIncrement: true }),
  modelId: integer('model_id').references(() => models.id).notNull(),
  taskId: integer('task_id').references(() => tool_tasks.id).notNull(),
  taskSlug: text('task_slug').notNull(), // For efficient per-model+task querying
  ts: text('ts').default('CURRENT_TIMESTAMP'),
  status: text('status').notNull(), // 'running' | 'completed' | 'failed' | 'timeout'
  turns: integer('turns').notNull().default(0),
  totalLatencyMs: integer('total_latency_ms').notNull().default(0),
  totalTokensIn: integer('total_tokens_in').notNull().default(0),
  totalTokensOut: integer('total_tokens_out').notNull().default(0),
  toolCallsCount: integer('tool_calls_count').notNull().default(0),
  successfulToolCalls: integer('successful_tool_calls').notNull().default(0),
  failedToolCalls: integer('failed_tool_calls').notNull().default(0),
  passed: integer('passed', { mode: 'boolean' }).notNull().default(false),
  finalScore: real('final_score').notNull().default(0.0),
  conversationData: text('conversation_data', { mode: 'json' }).$type<any[]>(),
  toolCallHistory: text('tool_call_history', { mode: 'json' }).$type<any[]>(),
  errorLog: text('error_log', { mode: 'json' }).$type<string[]>(),
  sandboxId: text('sandbox_id'), // Docker container ID for cleanup
  completedAt: text('completed_at')
});

export const tool_metrics = sqliteTable('tool_metrics', {
  sessionId: integer('session_id').references(() => tool_sessions.id).primaryKey(),
  // Core tool calling metrics (0.0-1.0)
  toolSelection: real('tool_selection').notNull(), // How well model chooses appropriate tools
  parameterAccuracy: real('parameter_accuracy').notNull(), // Correctness of tool parameters
  errorHandling: real('error_handling').notNull(), // Recovery from tool failures
  taskCompletion: real('task_completion').notNull(), // Overall task success
  efficiency: real('efficiency').notNull(), // Minimal tool calls to achieve goal
  contextAwareness: real('context_awareness').notNull(), // Using previous tool results effectively
  safetyCompliance: real('safety_compliance').notNull(), // Avoiding dangerous operations
  // Derived metrics
  avgToolLatency: real('avg_tool_latency').notNull().default(0.0),
  toolDiversity: real('tool_diversity').notNull().default(0.0), // Variety of tools used
  conversationFlow: real('conversation_flow').notNull().default(0.0) // Natural interaction patterns
});

// Tool call execution logs for detailed analysis
export const tool_executions = sqliteTable('tool_executions', {
  id: integer('id', { mode: 'number' }).primaryKey({ autoIncrement: true }),
  sessionId: integer('session_id').references(() => tool_sessions.id).notNull(),
  turnNumber: integer('turn_number').notNull(),
  toolName: text('tool_name').notNull(),
  parameters: text('parameters', { mode: 'json' }).$type<Record<string, any>>().notNull(),
  result: text('result').notNull(),
  success: integer('success', { mode: 'boolean' }).notNull(),
  latencyMs: integer('latency_ms').notNull(),
  errorMessage: text('error_message'),
  ts: text('ts').default('CURRENT_TIMESTAMP')
});
