#!/usr/bin/env node

const Database = require('better-sqlite3');
const path = require('path');

// Connect to the REAL database (same pattern as add-tool-tables.js)
const dbPath = path.join(__dirname, 'data/stupid_meter.db');
const db = new Database(dbPath);

console.log('🔧 Adding incidents table to production database...');

try {
  // Enable foreign keys
  db.exec('PRAGMA foreign_keys = ON;');

  // Create incidents table
  db.exec(`
    CREATE TABLE IF NOT EXISTS incidents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model_id INTEGER NOT NULL REFERENCES models(id),
      provider TEXT NOT NULL,
      incident_type TEXT NOT NULL,
      severity TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      detected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      resolved_at TEXT,
      duration_minutes INTEGER,
      failure_rate REAL,
      affected_requests INTEGER DEFAULT 0,
      recovery_time_minutes REAL,
      metadata TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
  console.log('✅ Created incidents table');

  // Create indexes for efficient queries
  db.exec('CREATE INDEX IF NOT EXISTS idx_incidents_provider ON incidents(provider);');
  db.exec('CREATE INDEX IF NOT EXISTS idx_incidents_detected_at ON incidents(detected_at);');
  db.exec('CREATE INDEX IF NOT EXISTS idx_incidents_model_id ON incidents(model_id);');
  db.exec('CREATE INDEX IF NOT EXISTS idx_incidents_type ON incidents(incident_type);');
  db.exec('CREATE INDEX IF NOT EXISTS idx_incidents_severity ON incidents(severity);');
  console.log('✅ Created incidents table indexes');

  // Test the table
  const testQuery = db.prepare('SELECT COUNT(*) as count FROM incidents');
  const result = testQuery.get();
  console.log(`✅ Incidents table is working. Current count: ${result.count}`);

  console.log('✅ Successfully added incidents table');
  console.log('✅ Database migration completed successfully');

} catch (error) {
  console.error('❌ Error adding incidents table:', error);
  process.exit(1);
} finally {
  db.close();
}

console.log('🎉 Incidents table setup complete!');
