import { sqliteTable, integer, text, real } from 'drizzle-orm/sqlite-core';

export const models = sqliteTable('models', {
  id: integer('id', { mode: 'number' }).primaryKey({ autoIncrement: true }),
  name: text('name').notNull(), // e.g., "gpt-4.1-mini"
  vendor: text('vendor').notNull(), // openai | xai | etc
  version: text('version'), // provider-reported
  notes: text('notes')
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
  suite: text('suite').default('hourly') // 'hourly' | 'deep'
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
