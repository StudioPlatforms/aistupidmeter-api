#!/usr/bin/env node

const { drizzle } = require('drizzle-orm/better-sqlite3');
const Database = require('better-sqlite3');
const path = require('path');

// Connect to the database
const dbPath = path.resolve('./data/stupid_meter.db');
console.log('Connecting to database:', dbPath);

const sqlite = new Database(dbPath);
const db = drizzle(sqlite);

async function addDisplayNameColumn() {
  try {
    console.log('🔧 Adding display_name column to models table...');
    
    // Check if column already exists
    const tableInfo = sqlite.prepare("PRAGMA table_info(models)").all();
    const hasDisplayName = tableInfo.some(col => col.name === 'display_name');
    
    if (hasDisplayName) {
      console.log('✅ display_name column already exists, skipping migration');
      return;
    }
    
    // Add the display_name column as optional text
    sqlite.prepare(`
      ALTER TABLE models 
      ADD COLUMN display_name TEXT DEFAULT NULL
    `).run();
    
    console.log('✅ Successfully added display_name column');
    
    // Verify the column was added
    const newTableInfo = sqlite.prepare("PRAGMA table_info(models)").all();
    const displayNameCol = newTableInfo.find(col => col.name === 'display_name');
    if (displayNameCol) {
      console.log('✅ Verification successful: display_name column exists');
      console.log(`   Column info: ${JSON.stringify(displayNameCol)}`);
    } else {
      console.error('❌ Verification failed: display_name column not found');
    }
    
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  } finally {
    sqlite.close();
    console.log('🔒 Database connection closed');
  }
}

console.log('🚀 Starting display_name column migration...');
addDisplayNameColumn().then(() => {
  console.log('🎉 Migration completed successfully!');
  process.exit(0);
});
