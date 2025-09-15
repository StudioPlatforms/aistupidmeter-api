#!/usr/bin/env node

const { drizzle } = require('drizzle-orm/better-sqlite3');
const Database = require('better-sqlite3');
const path = require('path');

// Connect to the database
const dbPath = path.resolve('./data/stupid_meter.db');
console.log('Connecting to database:', dbPath);

const sqlite = new Database(dbPath);
const db = drizzle(sqlite);

async function addCreatedAtColumn() {
  try {
    console.log('🔧 Adding created_at column to models table...');
    
    // Check if column already exists
    const tableInfo = sqlite.prepare("PRAGMA table_info(models)").all();
    const hasCreatedAt = tableInfo.some(col => col.name === 'created_at');
    
    if (hasCreatedAt) {
      console.log('✅ created_at column already exists, skipping migration');
      return;
    }
    
    // Add the created_at column with default timestamp
    sqlite.prepare(`
      ALTER TABLE models 
      ADD COLUMN created_at TEXT DEFAULT 'CURRENT_TIMESTAMP'
    `).run();
    
    // Update existing rows to have proper timestamps
    const updateExisting = sqlite.prepare(`
      UPDATE models 
      SET created_at = datetime('now') 
      WHERE created_at = 'CURRENT_TIMESTAMP' OR created_at IS NULL
    `).run();
    
    console.log('✅ Successfully added created_at column');
    console.log(`📊 Updated ${updateExisting.changes} existing models with timestamps`);
    
    // Verify the column was added
    const newTableInfo = sqlite.prepare("PRAGMA table_info(models)").all();
    const createdAtCol = newTableInfo.find(col => col.name === 'created_at');
    if (createdAtCol) {
      console.log('✅ Verification successful: created_at column exists');
      console.log(`   Column info: ${JSON.stringify(createdAtCol)}`);
    } else {
      console.error('❌ Verification failed: created_at column not found');
    }
    
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  } finally {
    sqlite.close();
    console.log('🔒 Database connection closed');
  }
}

console.log('🚀 Starting database migration...');
addCreatedAtColumn().then(() => {
  console.log('🎉 Migration completed successfully!');
  process.exit(0);
});
