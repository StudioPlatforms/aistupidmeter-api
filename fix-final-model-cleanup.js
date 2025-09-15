#!/usr/bin/env node

const { drizzle } = require('drizzle-orm/better-sqlite3');
const Database = require('better-sqlite3');
const path = require('path');

// Connect to the database
const dbPath = path.resolve('./data/stupid_meter.db');
console.log('Connecting to database:', dbPath);

const sqlite = new Database(dbPath);
const db = drizzle(sqlite);

async function finalModelCleanup() {
  try {
    console.log('🧹 Final model cleanup - fixing NEW badges and duplicates...');
    
    // Core models - CLEANED UP to remove duplicates
    const coreModels = [
      // OpenAI - only keep the LATEST/BEST versions
      'gpt-4o-2024-11-20', // Keep the latest GPT-4O, remove the old "gpt-4o"
      'gpt-5', 'gpt-5-mini', 'gpt-5-nano',
      'o3', // This should get a NEW badge
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
    
    // Models that should show NEW badges (truly new AI models released recently)
    const actuallyNewModels = [
      'gpt-5-2025-08-07',  // Recently discovered GPT-5 variant
      'gpt-5-chat-latest', // Recently discovered GPT-5 variant
      'o3',                // Recently released OpenAI reasoning model
      'o3-mini-2025-01-31' // If this exists, it's new too
    ];
    
    console.log('📝 Step 1: Updating core models for rankings...');
    
    // Reset all models to NOT show in rankings
    sqlite.prepare(`UPDATE models SET show_in_rankings = 0`).run();
    
    // Mark only core models for rankings
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
    
    console.log('📝 Step 2: Fixing NEW badge timestamps...');
    
    // Reset ALL timestamps to old date first
    const oldDate = new Date('2024-01-01T00:00:00Z').toISOString();
    sqlite.prepare(`UPDATE models SET created_at = ?`).run(oldDate);
    console.log('✅ Reset all model timestamps');
    
    // Set NEW badges ONLY for truly new models
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
    
    console.log('📊 Final Summary:');
    console.log(`   - ${coreCount} models in live rankings (removed duplicates)`);
    console.log(`   - ${newBadgeCount} models with NEW badges (only truly new models)`);
    
    // Final verification
    console.log('\n🔍 Final verification - Live ranking models:');
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
    
    console.log('   Live ranking models:');
    for (const model of liveModels) {
      const badge = model.badge_status === 'NEW' ? ' [NEW]' : '';
      console.log(`   - ${model.name}${badge}`);
    }
    
    console.log(`\n📈 Total: ${liveModels.length} models in live rankings`);
    
  } catch (error) {
    console.error('❌ Final cleanup failed:', error);
    process.exit(1);
  } finally {
    sqlite.close();
    console.log('🔒 Database connection closed');
  }
}

console.log('🚀 Starting final model cleanup...');
finalModelCleanup().then(() => {
  console.log('🎉 Final model cleanup completed successfully!');
  console.log('💡 Restart the API to see the changes.');
  process.exit(0);
});
