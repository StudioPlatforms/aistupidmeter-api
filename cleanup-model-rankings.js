#!/usr/bin/env node

const { drizzle } = require('drizzle-orm/better-sqlite3');
const Database = require('better-sqlite3');
const path = require('path');

// Connect to the database
const dbPath = path.resolve('./data/stupid_meter.db');
console.log('Connecting to database:', dbPath);

const sqlite = new Database(dbPath);
const db = drizzle(sqlite);

async function cleanupModelRankings() {
  try {
    console.log('🧹 Starting model rankings cleanup...');
    
    // Core models that should appear in live rankings and benchmarks
    const coreModels = [
      // OpenAI
      'gpt-4o', 'gpt-4o-2024-11-20',
      'gpt-5', 'gpt-5-mini', 'gpt-5-nano',
      'o3',
      'gpt-4o-mini',
      
      // Anthropic  
      'claude-3-5-sonnet-20241022',
      'claude-sonnet-4-20250514',
      'claude-opus-4-1-20250805',
      'claude-3-5-haiku-20241022',
      'claude-3-7-sonnet-20250219',
      
      // Google
      'gemini-2.5-pro-preview-03-25',
      'gemini-2.5-flash',
      'gemini-2.5-flash-lite',
      'gemini-1.5-pro'
    ];
    
    // Models that should show NEW badges (recently released AI models, not database additions)
    const actuallyNewModels = [
      'gpt-5-2025-08-07',  // Recently appeared OpenAI model
      'gpt-5-chat-latest'  // Recently appeared OpenAI model
    ];
    
    console.log('📝 Step 1: Adding show_in_rankings column...');
    
    // Add show_in_rankings column if it doesn't exist
    try {
      sqlite.prepare(`ALTER TABLE models ADD COLUMN show_in_rankings INTEGER DEFAULT 0`).run();
      console.log('✅ Added show_in_rankings column');
    } catch (error) {
      if (error.message.includes('duplicate column name')) {
        console.log('✅ show_in_rankings column already exists');
      } else {
        throw error;
      }
    }
    
    console.log('📝 Step 2: Marking core models for rankings...');
    
    // First, set all models to NOT show in rankings
    sqlite.prepare(`UPDATE models SET show_in_rankings = 0`).run();
    
    // Then mark core models to show in rankings
    let coreCount = 0;
    for (const modelName of coreModels) {
      const result = sqlite.prepare(`
        UPDATE models 
        SET show_in_rankings = 1 
        WHERE LOWER(name) = LOWER(?)
      `).run(modelName);
      
      if (result.changes > 0) {
        console.log(`✅ Marked ${modelName} for live rankings`);
        coreCount++;
      } else {
        console.log(`⚠️ Model ${modelName} not found in database`);
      }
    }
    
    console.log('📝 Step 3: Fixing NEW badge timestamps...');
    
    // Reset all created_at timestamps to old date (to remove NEW badges from old models)
    const oldDate = new Date('2024-01-01T00:00:00Z').toISOString();
    sqlite.prepare(`UPDATE models SET created_at = ?`).run(oldDate);
    console.log('✅ Reset all model timestamps to remove incorrect NEW badges');
    
    // Set recent timestamps only for actually new models
    const recentDate = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1 hour ago
    let newBadgeCount = 0;
    
    for (const modelName of actuallyNewModels) {
      const result = sqlite.prepare(`
        UPDATE models 
        SET created_at = ? 
        WHERE LOWER(name) = LOWER(?)
      `).run(recentDate, modelName);
      
      if (result.changes > 0) {
        console.log(`✅ Set NEW badge for ${modelName}`);
        newBadgeCount++;
      } else {
        console.log(`⚠️ Model ${modelName} not found for NEW badge`);
      }
    }
    
    console.log('📊 Summary:');
    console.log(`   - ${coreCount} models marked for live rankings`);
    console.log(`   - ${newBadgeCount} models marked with NEW badges`);
    
    // Verify the results
    console.log('\n🔍 Verification - Models in live rankings:');
    const liveModels = sqlite.prepare(`
      SELECT name, show_in_rankings, 
             CASE WHEN datetime(created_at) > datetime('now', '-7 days') 
                  THEN 'NEW' 
                  ELSE 'OLD' 
             END as badge_status
      FROM models 
      WHERE show_in_rankings = 1 
      ORDER BY name
    `).all();
    
    for (const model of liveModels) {
      console.log(`   ${model.name}: ${model.badge_status}`);
    }
    
    console.log('\n🔍 Verification - Models with NEW badges:');
    const newModels = sqlite.prepare(`
      SELECT name, created_at
      FROM models 
      WHERE datetime(created_at) > datetime('now', '-7 days')
      ORDER BY name
    `).all();
    
    for (const model of newModels) {
      console.log(`   ${model.name}: ${model.created_at}`);
    }
    
  } catch (error) {
    console.error('❌ Cleanup failed:', error);
    process.exit(1);
  } finally {
    sqlite.close();
    console.log('🔒 Database connection closed');
  }
}

console.log('🚀 Starting model rankings cleanup...');
cleanupModelRankings().then(() => {
  console.log('🎉 Model rankings cleanup completed successfully!');
  console.log('💡 You need to restart the API to see the changes.');
  process.exit(0);
});
