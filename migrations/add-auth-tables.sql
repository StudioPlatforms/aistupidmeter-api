-- Authentication Tables Migration
-- NextAuth.js / Auth.js compatible schema

-- Users table
CREATE TABLE IF NOT EXISTS auth_users (
  id TEXT PRIMARY KEY,
  name TEXT,
  email TEXT UNIQUE NOT NULL,
  emailVerified INTEGER,
  image TEXT,
  createdAt INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  updatedAt INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- Accounts table (OAuth providers)
CREATE TABLE IF NOT EXISTS auth_accounts (
  id TEXT PRIMARY KEY,
  userId TEXT NOT NULL,
  type TEXT NOT NULL,
  provider TEXT NOT NULL,
  providerAccountId TEXT NOT NULL,
  refresh_token TEXT,
  access_token TEXT,
  expires_at INTEGER,
  token_type TEXT,
  scope TEXT,
  id_token TEXT,
  session_state TEXT,
  createdAt INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  FOREIGN KEY (userId) REFERENCES auth_users(id) ON DELETE CASCADE,
  UNIQUE(provider, providerAccountId)
);

-- Sessions table
CREATE TABLE IF NOT EXISTS auth_sessions (
  id TEXT PRIMARY KEY,
  sessionToken TEXT UNIQUE NOT NULL,
  userId TEXT NOT NULL,
  expires INTEGER NOT NULL,
  createdAt INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  FOREIGN KEY (userId) REFERENCES auth_users(id) ON DELETE CASCADE
);

-- Verification tokens
CREATE TABLE IF NOT EXISTS auth_verification_tokens (
  identifier TEXT NOT NULL,
  token TEXT UNIQUE NOT NULL,
  expires INTEGER NOT NULL,
  PRIMARY KEY (identifier, token)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_auth_accounts_userId ON auth_accounts(userId);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_userId ON auth_sessions(userId);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_sessionToken ON auth_sessions(sessionToken);
CREATE INDEX IF NOT EXISTS idx_auth_users_email ON auth_users(email);

-- Link existing router data to auth users
-- This will be done through a separate migration script after users sign in
