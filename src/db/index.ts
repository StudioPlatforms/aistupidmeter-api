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
      notes TEXT
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
      note TEXT
    );
  `);
  console.log('✅ Database tables created/verified');
} catch (err) {
  console.error('❌ Database table creation failed:', err);
}

// Note: For production, switch back to PostgreSQL
// Migrations are handled by the drizzle migrate command in package.json
