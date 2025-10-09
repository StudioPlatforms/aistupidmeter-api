#!/usr/bin/env node

/**
 * Authentication Tables Migration Runner
 * 
 * Adds NextAuth.js compatible tables to the database
 */

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '../../benchmark.db');
const MIGRATION_PATH = path.join(__dirname, 'migrations', 'add-auth-tables.sql');

console.log('🔐 Running Authentication Tables Migration...\n');

try {
  // Check if database exists
  if (!fs.existsSync(DB_PATH)) {
    console.error('❌ Error: Database not found at', DB_PATH);
    console.log('Please run the router migration first: node run-router-migration.js');
    process.exit(1);
  }

  // Read migration SQL
  const migrationSQL = fs.readFileSync(MIGRATION_PATH, 'utf8');

  // Connect to database
  const db = new Database(DB_PATH);
  
  // Enable foreign keys
  db.pragma('foreign_keys = ON');

  console.log('📊 Database:', DB_PATH);
  console.log('📄 Migration:', MIGRATION_PATH);
  console.log('');

  // Execute migration
  console.log('⚙️  Creating authentication tables...');
  db.exec(migrationSQL);

  // Verify tables were created
  const tables = db.prepare(`
    SELECT name FROM sqlite_master 
    WHERE type='table' AND name LIKE 'auth_%'
    ORDER BY name
  `).all();

  console.log('✅ Migration completed successfully!\n');
  console.log('📋 Created tables:');
  tables.forEach(table => {
    console.log(`   - ${table.name}`);
  });

  // Show table counts
  console.log('\n📊 Table statistics:');
  tables.forEach(table => {
    const count = db.prepare(`SELECT COUNT(*) as count FROM ${table.name}`).get();
    console.log(`   - ${table.name}: ${count.count} rows`);
  });

  db.close();

  console.log('\n🎉 Authentication tables are ready!');
  console.log('\n📝 Next steps:');
  console.log('   1. Install NextAuth.js: cd apps/web && npm install next-auth@beta');
  console.log('   2. Configure OAuth providers (Google, GitHub)');
  console.log('   3. Set up environment variables');
  console.log('   4. Implement authentication pages');
  console.log('');

} catch (error) {
  console.error('\n❌ Migration failed:', error.message);
  console.error(error.stack);
  process.exit(1);
}
