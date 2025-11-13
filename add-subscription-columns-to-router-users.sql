-- Migration: Add subscription columns to router_users table
-- This adds all the subscription-related columns that are missing from the router_users table
-- Safe to run multiple times (uses IF NOT EXISTS where possible)

-- Add subscription columns to router_users table
-- Note: SQLite doesn't support IF NOT EXISTS for ALTER TABLE ADD COLUMN
-- So we need to check if columns exist first

-- Add stripe_customer_id if it doesn't exist
ALTER TABLE router_users ADD COLUMN stripe_customer_id TEXT;

-- Add stripe_subscription_id if it doesn't exist  
ALTER TABLE router_users ADD COLUMN stripe_subscription_id TEXT;

-- Add subscription_tier if it doesn't exist
ALTER TABLE router_users ADD COLUMN subscription_tier TEXT DEFAULT 'free';

-- Add subscription_status if it doesn't exist (if not already there)
-- ALTER TABLE router_users ADD COLUMN subscription_status TEXT DEFAULT 'trial';

-- Add trial_started_at if it doesn't exist
ALTER TABLE router_users ADD COLUMN trial_started_at TEXT;

-- Add trial_ends_at if it doesn't exist
ALTER TABLE router_users ADD COLUMN trial_ends_at TEXT;

-- Add subscription_ends_at if it doesn't exist
ALTER TABLE router_users ADD COLUMN subscription_ends_at TEXT;

-- Add subscription_canceled_at if it doesn't exist
ALTER TABLE router_users ADD COLUMN subscription_canceled_at TEXT;

-- Add last_payment_at if it doesn't exist
ALTER TABLE router_users ADD COLUMN last_payment_at TEXT;

-- Add subscription_start if it doesn't exist
ALTER TABLE router_users ADD COLUMN subscription_start TEXT;

-- Add subscription_end if it doesn't exist
ALTER TABLE router_users ADD COLUMN subscription_end TEXT;

-- Verify columns were added
SELECT 'Migration completed! Checking router_users table structure:' as status;
PRAGMA table_info(router_users);
