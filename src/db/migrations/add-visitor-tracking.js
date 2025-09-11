const { drizzle } = require('drizzle-orm/better-sqlite3');
const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, '../../../data.db');
const sqlite = new Database(dbPath);
const db = drizzle(sqlite);

async function up() {
  console.log('Creating visitor tracking tables...');
  
  // Create visitors table
  sqlite.exec(`
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
    )
  `);

  // Create visitor_stats table  
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS visitor_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL UNIQUE,
      total_visits INTEGER NOT NULL DEFAULT 0,
      unique_visitors INTEGER NOT NULL DEFAULT 0,
      top_pages TEXT NOT NULL,
      top_countries TEXT NOT NULL
    )
  `);

  // Create indexes for better performance
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_visitors_timestamp ON visitors(timestamp)`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_visitors_ip ON visitors(ip)`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_visitors_path ON visitors(path)`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_visitor_stats_date ON visitor_stats(date)`);

  console.log('✅ Visitor tracking tables created successfully');
}

async function down() {
  console.log('Dropping visitor tracking tables...');
  
  sqlite.exec(`DROP INDEX IF EXISTS idx_visitor_stats_date`);
  sqlite.exec(`DROP INDEX IF EXISTS idx_visitors_path`);
  sqlite.exec(`DROP INDEX IF EXISTS idx_visitors_ip`);
  sqlite.exec(`DROP INDEX IF EXISTS idx_visitors_timestamp`);
  sqlite.exec(`DROP TABLE IF EXISTS visitor_stats`);
  sqlite.exec(`DROP TABLE IF EXISTS visitors`);

  console.log('✅ Visitor tracking tables dropped successfully');
}

// Run migration
if (require.main === module) {
  const command = process.argv[2];
  if (command === 'down') {
    down().catch(console.error);
  } else {
    up().catch(console.error);
  }
}

module.exports = { up, down };
