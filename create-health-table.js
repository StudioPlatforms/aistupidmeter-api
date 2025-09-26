const Database = require('better-sqlite3');
const path = require('path');

// Connect to the database
const dbPath = path.join(__dirname, 'data', 'benchmarks.db');
const db = new Database(dbPath);

console.log('Creating provider_health_checks table...');

try {
  // Create the provider_health_checks table
  db.exec(`
    CREATE TABLE IF NOT EXISTS provider_health_checks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,           -- 'openai', 'anthropic', 'google', 'xai'
      status TEXT NOT NULL,             -- 'operational', 'degraded', 'down'
      response_time INTEGER,            -- milliseconds
      error_message TEXT,               -- if failed
      checked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      
      -- Indexes for performance
      UNIQUE(provider, checked_at)
    );
  `);

  // Create indexes
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_provider_checked ON provider_health_checks(provider, checked_at);
    CREATE INDEX IF NOT EXISTS idx_status_checked ON provider_health_checks(status, checked_at);
    CREATE INDEX IF NOT EXISTS idx_checked_at ON provider_health_checks(checked_at);
  `);

  console.log('✅ provider_health_checks table created successfully!');
  
  // Insert some initial test data
  const insertHealth = db.prepare(`
    INSERT OR REPLACE INTO provider_health_checks (provider, status, response_time, checked_at)
    VALUES (?, ?, ?, datetime('now'))
  `);

  // Add initial operational status for all providers
  insertHealth.run('openai', 'operational', 1200);
  insertHealth.run('anthropic', 'operational', 800);
  insertHealth.run('google', 'operational', 950);
  insertHealth.run('xai', 'operational', 1500);

  console.log('✅ Initial health data inserted!');

} catch (error) {
  console.error('❌ Error creating provider_health_checks table:', error);
  process.exit(1);
} finally {
  db.close();
}

console.log('Database setup complete!');
