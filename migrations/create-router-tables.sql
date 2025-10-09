-- Router System Tables Migration
-- Creates all tables needed for the AI Router service

-- Users & Authentication
CREATE TABLE IF NOT EXISTS router_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT,
  oauth_provider TEXT,
  oauth_id TEXT,
  name TEXT,
  avatar_url TEXT,
  email_verified INTEGER DEFAULT 0,
  subscription_status TEXT DEFAULT 'trial',
  subscription_start TEXT,
  subscription_end TEXT,
  stripe_customer_id TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(oauth_provider, oauth_id)
);

-- Universal API Keys
CREATE TABLE IF NOT EXISTS router_api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  key_hash TEXT UNIQUE NOT NULL,
  key_prefix TEXT NOT NULL,
  name TEXT,
  last_used_at TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  revoked INTEGER DEFAULT 0,
  FOREIGN KEY (user_id) REFERENCES router_users(id)
);

-- Provider API Keys (encrypted)
CREATE TABLE IF NOT EXISTS router_provider_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  provider TEXT NOT NULL,
  encrypted_key TEXT NOT NULL,
  key_alias TEXT,
  is_active INTEGER DEFAULT 1,
  last_validated_at TEXT,
  validation_error TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES router_users(id)
);

-- User Routing Preferences
CREATE TABLE IF NOT EXISTS router_preferences (
  user_id INTEGER PRIMARY KEY,
  routing_strategy TEXT DEFAULT 'best_overall',
  max_cost_per_1k_tokens REAL,
  max_latency_ms INTEGER,
  excluded_providers TEXT,
  excluded_models TEXT,
  require_tool_calling INTEGER DEFAULT 0,
  require_streaming INTEGER DEFAULT 0,
  fallback_enabled INTEGER DEFAULT 1,
  fallback_order TEXT,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES router_users(id)
);

-- Usage Tracking & Analytics
CREATE TABLE IF NOT EXISTS router_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  api_key_id INTEGER NOT NULL,
  selected_provider TEXT NOT NULL,
  selected_model TEXT NOT NULL,
  routing_reason TEXT,
  tokens_in INTEGER,
  tokens_out INTEGER,
  latency_ms INTEGER,
  cost_estimate REAL,
  success INTEGER DEFAULT 1,
  error_message TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES router_users(id),
  FOREIGN KEY (api_key_id) REFERENCES router_api_keys(id)
);

-- Model Performance Cache
CREATE TABLE IF NOT EXISTS router_model_rankings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL,
  rank INTEGER NOT NULL,
  model_id INTEGER,
  provider TEXT NOT NULL,
  model_name TEXT NOT NULL,
  stupid_score REAL NOT NULL,
  avg_cost_per_1k REAL,
  avg_latency_ms INTEGER,
  supports_tool_calling INTEGER DEFAULT 0,
  supports_streaming INTEGER DEFAULT 1,
  last_updated TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (model_id) REFERENCES models(id),
  UNIQUE(category, rank)
);

-- Subscription Usage Tracking
CREATE TABLE IF NOT EXISTS router_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  month TEXT NOT NULL,
  total_requests INTEGER DEFAULT 0,
  total_tokens_in INTEGER DEFAULT 0,
  total_tokens_out INTEGER DEFAULT 0,
  total_cost_estimate REAL DEFAULT 0,
  cost_saved_vs_gpt4 REAL DEFAULT 0,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES router_users(id),
  UNIQUE(user_id, month)
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_router_api_keys_user ON router_api_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_router_api_keys_hash ON router_api_keys(key_hash);
CREATE INDEX IF NOT EXISTS idx_router_provider_keys_user ON router_provider_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_router_provider_keys_provider ON router_provider_keys(provider);
CREATE INDEX IF NOT EXISTS idx_router_requests_user ON router_requests(user_id);
CREATE INDEX IF NOT EXISTS idx_router_requests_created ON router_requests(created_at);
CREATE INDEX IF NOT EXISTS idx_router_rankings_category ON router_model_rankings(category);
CREATE INDEX IF NOT EXISTS idx_router_usage_user_month ON router_usage(user_id, month);
