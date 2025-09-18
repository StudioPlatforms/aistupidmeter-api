import { drizzle } from 'drizzle-orm/better-sqlite3';
import Database from 'better-sqlite3';
import * as schema from './schema';
import { mkdirSync } from 'fs';
import { dirname } from 'path';

// Create SQLite connection for local development
const dbPath = './data/stupid_meter.db';
const dbDir = dirname(dbPath);

// Ensure data directory exists
try {
  mkdirSync(dbDir, { recursive: true });
} catch (err) {
  // Directory already exists
}

const sqlite = new Database(dbPath);
export const db = drizzle(sqlite, { schema });

// Auto-create tables for local development
try {
  // Create tables if they don't exist
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS models (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      vendor TEXT NOT NULL,
      version TEXT,
      notes TEXT,
      created_at TEXT DEFAULT 'CURRENT_TIMESTAMP',
      display_name TEXT,
      show_in_rankings INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE,
      lang TEXT NOT NULL,
      type TEXT NOT NULL,
      difficulty INTEGER NOT NULL,
      schema_uri TEXT,
      hidden INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model_id INTEGER NOT NULL REFERENCES models(id),
      task_id INTEGER NOT NULL REFERENCES tasks(id),
      ts TEXT DEFAULT CURRENT_TIMESTAMP,
      temp REAL NOT NULL,
      seed INTEGER NOT NULL,
      tokens_in INTEGER NOT NULL,
      tokens_out INTEGER NOT NULL,
      latency_ms INTEGER NOT NULL,
      attempts INTEGER NOT NULL,
      passed INTEGER NOT NULL,
      artifacts TEXT
    );

    CREATE TABLE IF NOT EXISTS metrics (
      run_id INTEGER PRIMARY KEY REFERENCES runs(id),
      correctness REAL NOT NULL,
      spec REAL NOT NULL,
      code_quality REAL NOT NULL,
      efficiency REAL NOT NULL,
      stability REAL NOT NULL,
      refusal REAL NOT NULL,
      recovery REAL NOT NULL
    );

    CREATE TABLE IF NOT EXISTS baselines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model_id INTEGER NOT NULL REFERENCES models(id),
      task_type TEXT NOT NULL,
      window_start TEXT NOT NULL,
      window_end TEXT NOT NULL,
      means TEXT NOT NULL,
      stds TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS bench_configs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      temp REAL NOT NULL,
      seed INTEGER NOT NULL,
      max_tokens INTEGER NOT NULL,
      system_prompt_hash TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS run_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bench_config_id INTEGER NOT NULL REFERENCES bench_configs(id),
      started_at TEXT DEFAULT CURRENT_TIMESTAMP,
      note TEXT
    );

    CREATE TABLE IF NOT EXISTS scores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model_id INTEGER NOT NULL REFERENCES models(id),
      ts TEXT DEFAULT CURRENT_TIMESTAMP,
      stupid_score REAL NOT NULL,
      axes TEXT NOT NULL,
      cusum REAL NOT NULL,
      note TEXT,
      suite TEXT DEFAULT 'hourly'
    );

    -- Deep benchmark tables
    CREATE TABLE IF NOT EXISTS deep_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model_id INTEGER NOT NULL REFERENCES models(id),
      task_slug TEXT NOT NULL,
      ts TEXT DEFAULT CURRENT_TIMESTAMP,
      turns INTEGER NOT NULL,
      total_latency_ms INTEGER NOT NULL,
      total_tokens_in INTEGER NOT NULL,
      total_tokens_out INTEGER NOT NULL,
      passed INTEGER NOT NULL,
      conversation_data TEXT,
      step_results TEXT,
      final_score INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS deep_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model_id INTEGER NOT NULL REFERENCES models(id),
      ts TEXT DEFAULT CURRENT_TIMESTAMP,
      level TEXT NOT NULL,
      message TEXT NOT NULL,
      context TEXT
    );

    -- Visitor tracking tables
    CREATE TABLE IF NOT EXISTS visitors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ip TEXT NOT NULL,
      user_agent TEXT,
      referer TEXT,
      path TEXT NOT NULL,
      timestamp TEXT DEFAULT CURRENT_TIMESTAMP,
      country TEXT,
      city TEXT,
      is_unique INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS visitor_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL UNIQUE,
      total_visits INTEGER NOT NULL DEFAULT 0,
      unique_visitors INTEGER NOT NULL DEFAULT 0,
      top_pages TEXT NOT NULL,
      top_countries TEXT NOT NULL
    );
  `);
  
  // Add missing columns to existing tables
  try {
    // Add suite column to existing scores table if it doesn't exist
    sqlite.exec(`ALTER TABLE scores ADD COLUMN suite TEXT DEFAULT 'hourly'`);
    console.log('✅ Added suite column to scores table');
  } catch (err) {
    // Column probably already exists, ignore error
    console.log('ℹ️ Suite column already exists in scores table');
  }
  
  try {
    // Add created_at column to existing models table if it doesn't exist
    sqlite.exec(`ALTER TABLE models ADD COLUMN created_at TEXT DEFAULT 'CURRENT_TIMESTAMP'`);
    console.log('✅ Added created_at column to models table');
  } catch (err) {
    // Column probably already exists, ignore error
    console.log('ℹ️ created_at column already exists in models table');
  }
  
  try {
    // Add display_name column to existing models table if it doesn't exist
    sqlite.exec(`ALTER TABLE models ADD COLUMN display_name TEXT`);
    console.log('✅ Added display_name column to models table');
  } catch (err) {
    // Column probably already exists, ignore error
    console.log('ℹ️ display_name column already exists in models table');
  }
  
  try {
    // Add show_in_rankings column to existing models table if it doesn't exist
    sqlite.exec(`ALTER TABLE models ADD COLUMN show_in_rankings INTEGER DEFAULT 0`);
    console.log('✅ Added show_in_rankings column to models table');
  } catch (err) {
    // Column probably already exists, ignore error
    console.log('ℹ️ show_in_rankings column already exists in models table');
  }
  
  console.log('✅ Database tables created/verified');
} catch (err) {
  console.error('❌ Database table creation failed:', err);
}

// Note: For production, switch back to PostgreSQL
// Migrations are handled by the drizzle migrate command in package.json
