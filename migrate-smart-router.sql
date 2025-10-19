-- Smart Router Database Migration
-- Adds router_preferences and router_provider_keys tables
-- Safe to run multiple times (uses IF NOT EXISTS)

-- Router Preferences Table
-- Stores user routing preferences and constraints
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
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Router Provider Keys Table
-- Stores encrypted API keys for each provider per user
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
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_router_keys_user_provider 
    ON router_provider_keys(user_id, provider);
    
CREATE INDEX IF NOT EXISTS idx_router_prefs_user 
    ON router_preferences(user_id);

-- Insert default preference for user_id 1 (for testing)
INSERT OR IGNORE INTO router_preferences (user_id, routing_strategy)
VALUES (1, 'best_overall');

-- Verify tables were created
SELECT 'Migration completed successfully!' as status;
SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'router%';
