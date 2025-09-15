#!/usr/bin/env node

const { drizzle } = require('drizzle-orm/better-sqlite3');
const Database = require('better-sqlite3');
const path = require('path');

// Connect to the database
const dbPath = path.resolve('./data/stupid_meter.db');
console.log('Connecting to database:', dbPath);

const sqlite = new Database(dbPath);
const db = drizzle(sqlite);

async function fixNewModelTimestamps() {
  try {
    console.log('🔧 Fixing timestamps for recently discovered GPT-5 models...');
    
    // Set timestamps for the new GPT-5 models to 1 hour ago so they show as "NEW"
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    
    // List of recently discovered models that should show "NEW" badges
    const newModels = [
      'gpt-5-2025-08-07',
      'gpt-5-chat-latest',
      'gpt-5-nano' // Also recently appeared
    ];
    
    let updatedCount = 0;
    
    for (const modelName of newModels) {
      const result = sqlite.prepare(`
        UPDATE models 
        SET created_at = ? 
        WHERE name = ?
      `).run(oneHourAgo, modelName);
      
      if (result.changes > 0) {
        console.log(`✅ Updated timestamp for ${modelName} to show as NEW`);
        updatedCount++;
      } else {
        console.log(`⚠️ Model ${modelName} not found in database`);
      }
    }
    
    console.log(`📊 Updated ${updatedCount} models with NEW timestamps`);
    
    // Verify the updates
    const newModelData = sqlite.prepare(`
      SELECT name, created_at, 
             CASE WHEN datetime(created_at) > datetime('now', '-7 days') 
                  THEN 'NEW' 
                  ELSE 'OLD' 
             END as badge_status
      FROM models 
      WHERE name IN (${newModels.map(() => '?').join(', ')})
    `).all(...newModels);
    
    console.log('\n🔍 Verification results:');
    for (const model of newModelData) {
      console.log(`   ${model.name}: ${model.created_at} (${model.badge_status})`);
    }
    
  } catch (error) {
    console.error('❌ Timestamp fix failed:', error);
    process.exit(1);
  } finally {
    sqlite.close();
    console.log('🔒 Database connection closed');
  }
}

console.log('🚀 Starting NEW badge timestamp fix...');
fixNewModelTimestamps().then(() => {
  console.log('🎉 Timestamp fix completed successfully!');
  console.log('💡 You may need to restart the API to see the NEW badges.');
  process.exit(0);
});
