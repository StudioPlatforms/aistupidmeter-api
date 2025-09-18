import { drizzle } from 'drizzle-orm/better-sqlite3';
import Database from 'better-sqlite3';
import * as schema from './schema';
import { mkdirSync } from 'fs';
import { dirname } from 'path';

// Database connection pool for high traffic
class DatabasePool {
  private connections: Database.Database[] = [];
  private readonly maxConnections: number;
  private readonly dbPath: string;
  private connectionIndex = 0;

  constructor(maxConnections: number = 10) {
    this.maxConnections = maxConnections;
    this.dbPath = './data/stupid_meter.db';
    
    // Ensure data directory exists
    const dbDir = dirname(this.dbPath);
    try {
      mkdirSync(dbDir, { recursive: true });
    } catch (err) {
      // Directory already exists
    }

    this.initializePool();
  }

  private initializePool() {
    console.log(`🔧 Initializing database connection pool with ${this.maxConnections} connections...`);
    
    for (let i = 0; i < this.maxConnections; i++) {
      const sqlite = new Database(this.dbPath, {
        // Performance optimizations for SQLite
        fileMustExist: false,
        timeout: 5000
      });

      // Performance pragmas for high concurrency
      sqlite.pragma('journal_mode = WAL');
      sqlite.pragma('synchronous = NORMAL');
      sqlite.pragma('cache_size = 64000'); // 64MB cache per connection
      sqlite.pragma('temp_store = MEMORY');
      sqlite.pragma('mmap_size = 268435456'); // 256MB memory map
      sqlite.pragma('page_size = 32768'); // Larger page size for better performance
      sqlite.pragma('wal_autocheckpoint = 1000');
      sqlite.pragma('optimize');

      this.connections.push(sqlite);
    }

    // Create tables on the first connection
    this.createTables(this.connections[0]);
    console.log(`✅ Database pool initialized with ${this.connections.length} connections`);
  }

  private createTables(sqlite: Database.Database) {
    try {
      sqlite.exec(`
        CREATE TABLE IF NOT EXISTS models (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          vendor TEXT NOT NULL,
          version TEXT,
          notes TEXT,
          display_name TEXT,
          show_in_rankings INTEGER DEFAULT 1
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

        -- Performance indexes
        CREATE INDEX IF NOT EXISTS idx_scores_model_suite_ts ON scores(model_id, suite, ts DESC);
        CREATE INDEX IF NOT EXISTS idx_scores_ts ON scores(ts DESC);
        CREATE INDEX IF NOT EXISTS idx_visitors_ip_date ON visitors(ip, date(timestamp));
        CREATE INDEX IF NOT EXISTS idx_visitors_timestamp ON visitors(timestamp DESC);
        CREATE INDEX IF NOT EXISTS idx_models_rankings ON models(show_in_rankings, vendor);
      `);

      // Add missing columns to existing tables
      try {
        sqlite.exec(`ALTER TABLE scores ADD COLUMN suite TEXT DEFAULT 'hourly'`);
      } catch (err) {
        // Column already exists
      }

      try {
        sqlite.exec(`ALTER TABLE models ADD COLUMN display_name TEXT`);
      } catch (err) {
        // Column already exists
      }

      try {
        sqlite.exec(`ALTER TABLE models ADD COLUMN show_in_rankings INTEGER DEFAULT 1`);
      } catch (err) {
        // Column already exists
      }

      console.log('✅ Database tables and indexes created/verified');
    } catch (err) {
      console.error('❌ Database table creation failed:', err);
    }
  }

  // Round-robin connection selection for read operations
  getReadConnection(): Database.Database {
    this.connectionIndex = (this.connectionIndex + 1) % this.connections.length;
    return this.connections[this.connectionIndex];
  }

  // Always use first connection for writes to avoid conflicts
  getWriteConnection(): Database.Database {
    return this.connections[0];
  }

  // Get drizzle instance with read connection
  getReadDb() {
    return drizzle(this.getReadConnection(), { schema });
  }

  // Get drizzle instance with write connection
  getWriteDb() {
    return drizzle(this.getWriteConnection(), { schema });
  }

  // Health check for all connections
  healthCheck(): { healthy: number; total: number; errors: string[] } {
    let healthy = 0;
    const errors: string[] = [];

    for (let i = 0; i < this.connections.length; i++) {
      try {
        this.connections[i].prepare('SELECT 1').get();
        healthy++;
      } catch (error) {
        errors.push(`Connection ${i}: ${String(error)}`);
      }
    }

    return { healthy, total: this.connections.length, errors };
  }

  // Graceful shutdown
  close() {
    console.log('🔄 Closing database connections...');
    this.connections.forEach((conn, i) => {
      try {
        conn.close();
        console.log(`✅ Closed database connection ${i}`);
      } catch (error) {
        console.error(`❌ Error closing connection ${i}:`, error);
      }
    });
  }
}

// Global database pool instance
export const dbPool = new DatabasePool(10); // 10 connections for high concurrency

// Export convenience functions
export const db = dbPool.getReadDb();
export const writeDb = dbPool.getWriteDb();
export const readDb = dbPool.getReadDb();

// Export health check
export const checkDatabaseHealth = () => dbPool.healthCheck();

// Graceful shutdown handler
process.on('SIGINT', () => {
  console.log('Received SIGINT, closing database connections...');
  dbPool.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('Received SIGTERM, closing database connections...');
  dbPool.close();
  process.exit(0);
});
