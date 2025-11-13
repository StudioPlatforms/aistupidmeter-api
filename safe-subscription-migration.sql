-- Safe Migration: Add subscription columns to router_users table
-- This migration safely adds missing subscription columns without affecting existing data
-- Uses a transaction to ensure atomicity

BEGIN TRANSACTION;

-- Create a temporary table with the full schema
CREATE TABLE IF NOT EXISTS router_users_new (
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
    stripe_subscription_id TEXT,
