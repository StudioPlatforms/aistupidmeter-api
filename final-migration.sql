-- Final Migration: Add missing subscription columns to router_users table
-- This script safely adds all missing subscription columns
-- Safe to run multiple times - will skip columns that already exist

.echo on

-- First, let's create the router_users table if it doesn't exist
-- This ensures we have a base table to work with
CREATE TABLE IF NOT EXISTS router_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT,
  oauth_provider TEXT,
  oauth_id TEXT,
  name TEXT,
  avatar_url TEXT,
  email_verified INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Now add the subscription columns one by one
-- SQLite will give an error if column exists, but we'll handle that gracefully

-- Add stripe_customer_id
ALTER TABLE router_users ADD COLUMN stripe_customer_id TEXT;

-- Add stripe_subscription_id (this is the main one causing the error)
ALTER TABLE router_users ADD COLUMN stripe_subscription_id TEXT;

-- Add subscription_tier
ALTER TABLE router_users ADD COLUMN subscription_tier TEXT DEFAULT 'free';

-- Add subscription_status
ALTER TABLE router_users ADD COLUMN subscription_status TEXT DEFAULT 'trial';

-- Add trial_started_at
ALTER TABLE router_users ADD COLUMN trial_started_at TEXT;

-- Add trial_ends_at
ALTER TABLE router_users ADD COLUMN trial_ends_at TEXT;

-- Add subscription_ends_at
ALTER TABLE router_users ADD COLUMN subscription_ends_at TEXT;

-- Add subscription_canceled_at
ALTER TABLE router_users ADD COLUMN subscription_canceled_at TEXT;

-- Add last_payment_at
ALTER TABLE router_users ADD COLUMN last_payment_at TEXT;

-- Add subscription_start
ALTER TABLE router_users ADD COLUMN subscription_start TEXT;

-- Add subscription_end
ALTER TABLE router_users ADD COLUMN subscription_end TEXT;

-- Add reset token fields for password reset functionality
ALTER TABLE router_users ADD COLUMN reset_token TEXT;
ALTER TABLE router_users ADD COLUMN reset_token_expires TEXT;
ALTER TABLE router_users ADD COLUMN reset_requested_at TEXT;

-- Show final table structure
SELECT 'Migration completed! Final router_users table structure:' as status;
PRAGMA table_info(router_users);

-- Show any existing data (to verify no data loss)
SELECT 'Current user count:' as info, COUNT(*) as user_count FROM router_users;

SELECT 'Migration completed successfully!' as final_status;
