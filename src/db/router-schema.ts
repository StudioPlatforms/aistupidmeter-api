import { sqliteTable, integer, text, real } from 'drizzle-orm/sqlite-core';

// Users & Authentication
export const routerUsers = sqliteTable('router_users', {
  id: integer('id', { mode: 'number' }).primaryKey({ autoIncrement: true }),
  email: text('email').unique().notNull(),
  password_hash: text('password_hash'), // NULL for OAuth users
  oauth_provider: text('oauth_provider'), // 'google' | 'apple' | 'twitter' | NULL for email
  oauth_id: text('oauth_id'), // Provider's user ID
  name: text('name'),
  avatar_url: text('avatar_url'),
  email_verified: integer('email_verified', { mode: 'boolean' }).default(false),
  subscription_status: text('subscription_status').default('trial'), // 'trial' | 'active' | 'cancelled' | 'expired'
  subscription_start: text('subscription_start'),
  subscription_end: text('subscription_end'),
  stripe_customer_id: text('stripe_customer_id'),
  created_at: text('created_at').default('CURRENT_TIMESTAMP'),
  updated_at: text('updated_at').default('CURRENT_TIMESTAMP')
});

// Universal API Keys (what users use in their tools)
export const routerApiKeys = sqliteTable('router_api_keys', {
  id: integer('id', { mode: 'number' }).primaryKey({ autoIncrement: true }),
  user_id: integer('user_id').references(() => routerUsers.id).notNull(),
  key_hash: text('key_hash').unique().notNull(), // Hashed version of "aism_xxxxx"
  key_prefix: text('key_prefix').notNull(), // First 12 chars for user identification "aism_abc123"
  name: text('name'), // User-friendly name like "My MacBook"
  last_used_at: text('last_used_at'),
  created_at: text('created_at').default('CURRENT_TIMESTAMP'),
  revoked: integer('revoked', { mode: 'boolean' }).default(false)
});

// Provider API Keys (encrypted user keys for OpenAI, Anthropic, etc.)
export const routerProviderKeys = sqliteTable('router_provider_keys', {
  id: integer('id', { mode: 'number' }).primaryKey({ autoIncrement: true }),
  user_id: integer('user_id').references(() => routerUsers.id).notNull(),
  provider: text('provider').notNull(), // 'openai' | 'anthropic' | 'xai' | 'google'
  encrypted_key: text('encrypted_key').notNull(), // AES-256 encrypted
  key_alias: text('key_alias'), // User-friendly name like "Work OpenAI"
  is_active: integer('is_active', { mode: 'boolean' }).default(true),
  last_validated_at: text('last_validated_at'),
  validation_error: text('validation_error'), // Last validation error if any
  created_at: text('created_at').default('CURRENT_TIMESTAMP'),
  updated_at: text('updated_at').default('CURRENT_TIMESTAMP')
});

// User Routing Preferences
export const routerPreferences = sqliteTable('router_preferences', {
  user_id: integer('user_id').primaryKey().references(() => routerUsers.id),
  routing_strategy: text('routing_strategy').default('best_overall'), // 'best_overall' | 'best_coding' | 'best_reasoning' | 'cheapest' | 'fastest'
  max_cost_per_1k_tokens: real('max_cost_per_1k_tokens'), // Optional cost limit
  max_latency_ms: integer('max_latency_ms'), // Optional latency requirement
  excluded_providers: text('excluded_providers'), // JSON array of excluded providers
  excluded_models: text('excluded_models'), // JSON array of excluded models
  require_tool_calling: integer('require_tool_calling', { mode: 'boolean' }).default(false),
  require_streaming: integer('require_streaming', { mode: 'boolean' }).default(false),
  fallback_enabled: integer('fallback_enabled', { mode: 'boolean' }).default(true),
  fallback_order: text('fallback_order'), // JSON array defining fallback chain
  updated_at: text('updated_at').default('CURRENT_TIMESTAMP')
});

// Usage Tracking & Analytics
export const routerRequests = sqliteTable('router_requests', {
  id: integer('id', { mode: 'number' }).primaryKey({ autoIncrement: true }),
  user_id: integer('user_id').references(() => routerUsers.id).notNull(),
  api_key_id: integer('api_key_id').references(() => routerApiKeys.id).notNull(),
  selected_provider: text('selected_provider').notNull(),
  selected_model: text('selected_model').notNull(),
  routing_reason: text('routing_reason'), // Why this model was selected
  tokens_in: integer('tokens_in'),
  tokens_out: integer('tokens_out'),
  latency_ms: integer('latency_ms'),
  cost_estimate: real('cost_estimate'),
  success: integer('success', { mode: 'boolean' }).default(true),
  error_message: text('error_message'),
  created_at: text('created_at').default('CURRENT_TIMESTAMP')
});

// Model Performance Cache (fast lookup for routing)
export const routerModelRankings = sqliteTable('router_model_rankings', {
  id: integer('id', { mode: 'number' }).primaryKey({ autoIncrement: true }),
  category: text('category').notNull(), // 'overall' | 'coding' | 'reasoning' | 'creative' | 'tool_calling'
  rank: integer('rank').notNull(),
  model_id: integer('model_id').references(() => models.id),
  provider: text('provider').notNull(),
  model_name: text('model_name').notNull(),
  stupid_score: real('stupid_score').notNull(),
  avg_cost_per_1k: real('avg_cost_per_1k'), // Estimated cost per 1k tokens
  avg_latency_ms: integer('avg_latency_ms'),
  supports_tool_calling: integer('supports_tool_calling', { mode: 'boolean' }).default(false),
  supports_streaming: integer('supports_streaming', { mode: 'boolean' }).default(true),
  last_updated: text('last_updated').default('CURRENT_TIMESTAMP')
});

// Subscription usage tracking
export const routerUsage = sqliteTable('router_usage', {
  id: integer('id', { mode: 'number' }).primaryKey({ autoIncrement: true }),
  user_id: integer('user_id').references(() => routerUsers.id).notNull(),
  month: text('month').notNull(), // YYYY-MM format
  total_requests: integer('total_requests').default(0),
  total_tokens_in: integer('total_tokens_in').default(0),
  total_tokens_out: integer('total_tokens_out').default(0),
  total_cost_estimate: real('total_cost_estimate').default(0),
  cost_saved_vs_gpt4: real('cost_saved_vs_gpt4').default(0),
  updated_at: text('updated_at').default('CURRENT_TIMESTAMP')
});

// Import existing models table for reference
import { models } from './schema';
