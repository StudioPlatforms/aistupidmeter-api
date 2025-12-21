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
  toolCallReliability: real('tool_call_reliability').default(0.0), // 0.0-1.0 based on historical performance
  // Reasoning capabilities
  usesReasoningEffort: integer('uses_reasoning_effort', { mode: 'boolean' }).default(false) // Models that use extended thinking (GPT-5, o3, Gemini 2.5 Pro, DeepSeek Reasoner, etc.)
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
  artifacts: text('artifacts', { mode: 'json' }).$type<Record<string, any>>(),
  // API version tracking for correlating performance with model updates
  apiVersion: text('api_version'), // e.g., "gpt-4-0613", extracted from response headers
  responseHeaders: text('response_headers', { mode: 'json' }).$type<Record<string, string>>(), // Full response headers as JSON
  modelFingerprint: text('model_fingerprint') // Hash of response characteristics for version detection
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
  suite: text('suite').default('hourly'), // 'hourly' | 'deep' | 'tooling'
  // Statistical confidence interval fields
  confidenceLower: real('confidence_lower'), // Lower bound of 95% CI
  confidenceUpper: real('confidence_upper'), // Upper bound of 95% CI
  standardError: real('standard_error'), // Standard error of the mean
  sampleSize: integer('sample_size').default(5), // Number of trials
  modelVariance: real('model_variance') // Historical variance for drift detection
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

// Incidents tracking table for service disruptions and performance issues
export const incidents = sqliteTable('incidents', {
  id: integer('id', { mode: 'number' }).primaryKey({ autoIncrement: true }),
  modelId: integer('model_id').references(() => models.id).notNull(),
  provider: text('provider').notNull(),
  incidentType: text('incident_type').notNull(), // 'service_disruption', 'performance_degradation', 'availability_issue'
  severity: text('severity').notNull(), // 'minor', 'major', 'critical'
  title: text('title').notNull(),
  description: text('description').notNull(),
  detectedAt: text('detected_at').notNull().default('CURRENT_TIMESTAMP'),
  resolvedAt: text('resolved_at'), // NULL if still ongoing
  durationMinutes: integer('duration_minutes'), // Calculated when resolved
  failureRate: real('failure_rate'), // Percentage of failed requests
  affectedRequests: integer('affected_requests').default(0),
  recoveryTimeMinutes: real('recovery_time_minutes'), // Time to recover performance
  metadata: text('metadata'), // JSON for additional context
  createdAt: text('created_at').default('CURRENT_TIMESTAMP'),
  updatedAt: text('updated_at').default('CURRENT_TIMESTAMP')
});

// Raw outputs table - captures LLM responses before code extraction
// HIGH VALUE: Reveals failure modes, hallucinations, and extraction issues
export const raw_outputs = sqliteTable('raw_outputs', {
  id: integer('id', { mode: 'number' }).primaryKey({ autoIncrement: true }),
  runId: integer('run_id').references(() => runs.id).notNull(),
  rawText: text('raw_text').notNull(), // Full LLM response before extraction
  extractedCode: text('extracted_code'), // Code after extraction (may be null if extraction failed)
  extractionSuccess: integer('extraction_success', { mode: 'boolean' }).notNull(),
  extractionMethod: text('extraction_method'), // 'code_block', 'plain_text', 'failed'
  failureType: text('failure_type'), // 'syntax_error', 'logic_error', 'timeout', 'refusal', 'hallucination', 'empty_response'
  failureDetails: text('failure_details'), // Additional context about the failure
  ts: text('ts').default('CURRENT_TIMESTAMP')
});

// Test case results table - per-test-case granularity for failure analysis
// HIGH VALUE: Shows which specific test cases models fail on
export const test_case_results = sqliteTable('test_case_results', {
  id: integer('id', { mode: 'number' }).primaryKey({ autoIncrement: true }),
  runId: integer('run_id').references(() => runs.id).notNull(),
  testCaseIndex: integer('test_case_index').notNull(),
  testInput: text('test_input').notNull(),
  expectedOutput: text('expected_output').notNull(),
  actualOutput: text('actual_output'), // May be null if execution failed
  passed: integer('passed', { mode: 'boolean' }).notNull(),
  errorMessage: text('error_message'), // Python error message if test failed
  executionTimeMs: integer('execution_time_ms'), // Time to execute this specific test
  ts: text('ts').default('CURRENT_TIMESTAMP')
});

// Adversarial prompts library - systematic safety testing
// EXTREMELY HIGH VALUE: $300K-1M/year potential
export const adversarial_prompts = sqliteTable('adversarial_prompts', {
  id: integer('id', { mode: 'number' }).primaryKey({ autoIncrement: true }),
  promptText: text('prompt_text').notNull(),
  attackType: text('attack_type').notNull(), // 'jailbreak', 'injection', 'extraction', 'manipulation', 'harmful_content'
  severity: text('severity').notNull(), // 'low', 'medium', 'high', 'critical'
  expectedBehavior: text('expected_behavior').notNull(), // What a safe model should do
  category: text('category'), // 'code_injection', 'prompt_leak', 'safety_bypass', 'data_extraction'
  createdAt: text('created_at').default('CURRENT_TIMESTAMP'),
  active: integer('active', { mode: 'boolean' }).default(true)
});

// Adversarial test results - tracks which models are vulnerable
// EXTREMELY HIGH VALUE: Safety data is rare and critical
export const adversarial_results = sqliteTable('adversarial_results', {
  id: integer('id', { mode: 'number' }).primaryKey({ autoIncrement: true }),
  promptId: integer('prompt_id').references(() => adversarial_prompts.id).notNull(),
  modelId: integer('model_id').references(() => models.id).notNull(),
  responseText: text('response_text').notNull(),
  bypassSuccessful: integer('bypass_successful', { mode: 'boolean' }).notNull(), // Did the attack work?
  safetyScore: real('safety_score').notNull(), // 0.0-1.0, higher is safer
  refusalDetected: integer('refusal_detected', { mode: 'boolean' }).default(false), // Did model refuse?
  harmfulContentGenerated: integer('harmful_content_generated', { mode: 'boolean' }).default(false),
  notes: text('notes'), // Additional observations
  ts: text('ts').default('CURRENT_TIMESTAMP')
});

// PHASE 2: Change-point detection table
// Tracks significant behavioral changes over time for drift monitoring
export const change_points = sqliteTable('change_points', {
  id: integer('id', { mode: 'number' }).primaryKey({ autoIncrement: true }),
  model_id: integer('model_id').references(() => models.id).notNull(),
  detected_at: text('detected_at').default('CURRENT_TIMESTAMP').notNull(),
  
  // Change details
  from_score: real('from_score').notNull(),
  to_score: real('to_score').notNull(),
  delta: real('delta').notNull(),
  significance: real('significance').notNull(), // How many standard deviations
  
  // Classification
  change_type: text('change_type').notNull(), // 'improvement' | 'degradation' | 'shift'
  affected_axes: text('affected_axes'), // JSON array of affected axes
  suspected_cause: text('suspected_cause'), // 'model_update' | 'safety_tuning' | etc.
  
  // Attribution
  incident_id: integer('incident_id').references(() => incidents.id),
  confirmed: integer('confirmed', { mode: 'boolean' }).default(false),
  false_alarm: integer('false_alarm', { mode: 'boolean' }).default(false),
  
  // Context
  notes: text('notes')
});

// PHASE 2: Model drift signatures table
// Stores computed drift signatures for quick retrieval
export const model_drift_signatures = sqliteTable('model_drift_signatures', {
  id: integer('id', { mode: 'number' }).primaryKey({ autoIncrement: true }),
  model_id: integer('model_id').references(() => models.id).notNull(),
  ts: text('ts').default('CURRENT_TIMESTAMP').notNull(),
  
  // Current state
  baseline_score: real('baseline_score').notNull(),
  current_score: real('current_score').notNull(),
  ci_lower: real('ci_lower').notNull(),
  ci_upper: real('ci_upper').notNull(),
  
  // Stability metrics
  regime: text('regime').notNull(), // 'STABLE' | 'VOLATILE' | 'DEGRADED' | 'RECOVERING'
  variance_24h: real('variance_24h').notNull(),
  drift_status: text('drift_status').notNull(), // 'NORMAL' | 'WARNING' | 'ALERT'
  page_hinkley_cusum: real('page_hinkley_cusum').notNull(),
  
  // Temporal context
  last_change_timestamp: text('last_change_timestamp'),
  hours_since_change: real('hours_since_change'),
  
  // Dimensional breakdown (JSON for flexibility)
  axes_breakdown: text('axes_breakdown').notNull(),
  
  // Actionability
  primary_issue: text('primary_issue'),
  recommendation: text('recommendation'),
  
  // Full signature as JSON for extensibility
  signature_json: text('signature_json').notNull()
});

// PHASE 2: Failure classifications table
// Categorize individual test failures by type for drift analysis
export const failure_classifications = sqliteTable('failure_classifications', {
  id: integer('id', { mode: 'number' }).primaryKey({ autoIncrement: true }),
  run_id: integer('run_id').references(() => runs.id).notNull(),
  model_id: integer('model_id').references(() => models.id).notNull(),
  ts: text('ts').default('CURRENT_TIMESTAMP').notNull(),
  
  // Primary classification
  failure_mode: text('failure_mode').notNull(),
  failure_subtype: text('failure_subtype'),
  
  // Details
  task_slug: text('task_slug').notNull(),
  expected_behavior: text('expected_behavior'),
  actual_behavior: text('actual_behavior'),
  error_excerpt: text('error_excerpt'),
  
  // Severity
  severity: text('severity').notNull(), // 'minor' | 'major' | 'critical'
  
  // Analysis
  is_regression: integer('is_regression', { mode: 'boolean' }).default(false),
  first_seen: text('first_seen')
});
