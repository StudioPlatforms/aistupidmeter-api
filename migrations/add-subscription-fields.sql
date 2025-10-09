-- Subscription Fields Migration
-- Adds missing Stripe subscription management fields to router_users table

-- Add subscription-related columns (only if they don't exist)
-- stripe_customer_id already exists, so we skip it

-- Add stripe_subscription_id if it doesn't exist
ALTER TABLE router_users ADD COLUMN stripe_subscription_id TEXT;

-- Add subscription_tier if it doesn't exist
ALTER TABLE router_users ADD COLUMN subscription_tier TEXT DEFAULT 'free';

-- Add trial_started_at if it doesn't exist
ALTER TABLE router_users ADD COLUMN trial_started_at DATETIME;

-- Add trial_ends_at if it doesn't exist
ALTER TABLE router_users ADD COLUMN trial_ends_at DATETIME;

-- Add subscription_ends_at if it doesn't exist
ALTER TABLE router_users ADD COLUMN subscription_ends_at DATETIME;

-- Add subscription_canceled_at if it doesn't exist
ALTER TABLE router_users ADD COLUMN subscription_canceled_at DATETIME;

-- Add last_payment_at if it doesn't exist
ALTER TABLE router_users ADD COLUMN last_payment_at DATETIME;

-- Create indexes for subscription queries
CREATE INDEX IF NOT EXISTS idx_router_users_stripe_customer ON router_users(stripe_customer_id);
CREATE INDEX IF NOT EXISTS idx_router_users_stripe_subscription ON router_users(stripe_subscription_id);
CREATE INDEX IF NOT EXISTS idx_router_users_subscription_tier ON router_users(subscription_tier);
CREATE INDEX IF NOT EXISTS idx_router_users_trial_ends ON router_users(trial_ends_at);

-- Update existing users to have 'free' tier if subscription_status was 'trial'
UPDATE router_users 
SET subscription_tier = 'free' 
WHERE subscription_status = 'trial' OR subscription_status IS NULL;

-- Note: Keep subscription_status column for backward compatibility
-- subscription_tier will be the new authoritative field
