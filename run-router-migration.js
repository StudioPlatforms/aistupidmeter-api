const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

// Database path from environment variable
const dbPath = process.env.DATABASE_URL || path.join(__dirname, '../../data/stupid_meter.db');
const migrationPath = path.join(__dirname, 'migrations/create-router-tables.sql');

console.log('🔄 Running router tables migration...');
console.log(`Database: ${dbPath}`);
console.log(`Migration: ${migrationPath}`);

try {
  // Open database
  const db = new Database(dbPath);
  
  // Read migration SQL
  const sql = fs.readFileSync(migrationPath, 'utf8');
  
  // Execute migration
  db.exec(sql);
  
  console.log('✅ Router tables created successfully!');
  
  // Verify tables were created
  const tables = db.prepare(`
    SELECT name FROM sqlite_master 
    WHERE type='table' AND name LIKE 'router_%'
    ORDER BY name
  `).all();
  
  console.log('\n📋 Created tables:');
  tables.forEach(t => console.log(`  - ${t.name}`));
  
  db.close();
  console.log('\n✨ Migration complete!');
  
} catch (error) {
  console.error('❌ Migration failed:', error);
  process.exit(1);
}
