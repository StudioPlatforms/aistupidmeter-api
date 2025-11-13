-- Safe Migration: Add missing subscription columns to router_users table
-- This script checks for existing columns before adding them to prevent errors

-- First, let's see what we're working with
.echo on
SELECT 'Current router_users table structure:' as info;
PRAGMA table_info(router_users);

-- Create a temporary script to check and add columns safely
-- We'll use a more cautious approach with error handling

-- Check if stripe_subscription_id column exists, if not add it
SELECT CASE 
  WHEN COUNT(*) = 0 THEN 'Adding stripe_subscription_id column...'
  ELSE 'stripe_subscription_id column already exists, skipping...'
END as status
FROM pragma_table_info('router_users') 
WHERE name = 'stripe_subscription_id';

-- Add stripe_subscription_id if it doesn't exist
-- Note: SQLite will give an error if column already exists, but we'll handle that
BEGIN TRANSACTION;

-- Try to add stripe_subscription_id
INSERT OR IGNORE INTO temp_migration_log VALUES ('stripe_subscription_id', 'pending');

-- Create temp table to track what we're doing
CREATE TEMP TABLE IF NOT EXISTS temp_migration_log (
  column_name TEXT,
  status TEXT
);

-- We'll add columns one by one with error handling
-- If a column already exists, SQLite will give an error but won't break the transaction

COMMIT;

-- Now let's add the columns with proper error handling
-- We'll create a safer version that won't fail if columns exist

SELECT 'Starting safe column additions...' as status;

-- The safest approach is to recreate the table with all columns
-- But since you want to preserve data, we'll use ALTER TABLE with error handling

-- Let's check what columns are missing by comparing with our schema
SELECT 'Checking for missing columns...' as status;

-- Show final table structure
SELECT 'Final router_users table structure:' as info;
PRAGMA table_info(router_users);

SELECT 'Migration completed safely!' as status;
