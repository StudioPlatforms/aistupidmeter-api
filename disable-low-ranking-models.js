#!/usr/bin/env node

// Disable all models from rank #32 onwards, except new DeepSeek/Kimi/GLM models
const dotenv = require('dotenv');
dotenv.config({ path: '/root/.env' });

// Use the correct database path
const { drizzle } = require('drizzle-orm/better-sqlite3');
const Database = require('better-sqlite3');
const sqlite = new Database('./data/stupid_meter.db');
const db = drizzle(sqlite);
const { inArray, eq } = require('drizzle-orm');

// Define models table inline to avoid import issues
const models = {
  id: 'id',
  name: 'name',
  vendor: 'vendor',
  showInRankings: 'show_in_rankings'
};

async function disableLowRankingModels() {
  console.log('🔍 Disabling low-ranking models (keeping top 31 + new models)...\n');
  
  try {
    // Models to disable based on your list (excluding kimi, glm, deepseek)
    const modelsToDisable = [
      'gemini-1.5-flash-latest',
      'gemini-2.0-flash-exp',
      'gpt-4o',
      'gemini-1.5-flash-8b',
      'gemini-1.5-flash-8b-001',
      'gemini-1.5-flash-8b-latest',
      'gemini-1.5-pro',
      'claude-3-5-haiku-20241022',
      'gpt-5-auto',
      'claude-opus-4-20250514',
      'gemini-1.5-flash',
      'claude-3-5-sonnet-20240620',
      'claude-3-5-sonnet',
      'claude-3-5-haiku',
      'claude-3-7-sonnet',
      'embedding-gecko-001',
      'gemini-1.5-pro-latest',
      'gemini-2.0-flash-001',
      'gemini-2.0-flash-lite',
      'gemini-2.0-pro-exp',
      'gemini-2.0-pro-exp-02-05',
      'gemini-exp-1206',
      'gemini-2.0-flash-thinking-exp-01-21',
      'gemini-2.0-flash-thinking-exp',
      'gemini-2.0-flash-thinking-exp-1219',
      'gemini-2.5-flash-preview-tts',
      'gemini-2.5-pro-preview-tts',
      'learnlm-2.0-flash-experimental',
      'gemma-3-1b-it',
      'gemma-3-4b-it',
      'gemma-3-12b-it',
      'gemma-3-27b-it',
      'gemma-3n-e4b-it',
      'gemma-3n-e2b-it',
      'gemini-2.5-flash-image-preview',
      'embedding-001',
      'text-embedding-004',
      'gemini-embedding-exp-03-07',
      'gemini-embedding-exp',
      'gemini-embedding-001',
      'aqa',
      'imagen-3.0-generate-002',
      'imagen-4.0-generate-preview-06-06',
      'imagen-4.0-ultra-generate-preview-06-06',
      'gpt-5-chat-latest',
      'gpt-4o-2024-05-13',
      'gpt-4o-mini-2024-07-18',
      'gpt-4o-2024-08-06',
      'o1-mini-2024-09-12',
      'o1-mini',
      'gpt-4o-realtime-preview-2024-10-01',
      'gpt-4o-audio-preview-2024-10-01',
      'gpt-4o-audio-preview',
      'gpt-4o-realtime-preview',
      'gpt-4o-realtime-preview-2024-12-17',
      'gpt-4o-audio-preview-2024-12-17',
      'gpt-4o-mini-realtime-preview-2024-12-17',
      'gpt-4o-mini-audio-preview-2024-12-17',
      'o1',
      'gpt-4o-mini-realtime-preview',
      'gpt-4o-mini-audio-preview',
      'o3-mini',
      'o3-mini-2025-01-31',
      'gpt-4o-search-preview-2025-03-11',
      'gpt-4o-search-preview',
      'gpt-4o-mini-search-preview-2025-03-11',
      'gpt-4o-mini-search-preview',
      'gpt-4o-transcribe',
      'gpt-4o-mini-transcribe',
      'o1-pro-2025-03-19',
      'o1-pro',
      'gpt-4o-mini-tts',
      'o3-2025-04-16',
      'o4-mini-2025-04-16',
      'o4-mini',
      'gpt-4o-realtime-preview-2025-06-03',
      'gpt-4o-audio-preview-2025-06-03',
      'o4-mini-deep-research',
      'o4-mini-deep-research-2025-06-26',
      'gpt-5-nano-2025-08-07',
      'grok-2-1212',
      // Additional models to disable
      'gemini-2.0-flash',
      'gemini-1.5-flash-002',
      'gemini-2.5-flash-preview-05-20',
      'gemini-2.0-flash-lite-001',
      'o1-2024-12-17',
      'gpt-5-mini-2025-08-07',
      'gpt-5',
      'claude-opus-4-1',
      'gemini-2.5-pro-preview-06-05',
      'grok-4-fast-reasoning'
    ];
    
    // Get all models using raw SQL
    const allModels = sqlite.prepare('SELECT * FROM models').all();
    console.log(`📊 Total models in database: ${allModels.length}`);
    
    // Find models to disable
    const modelsToDisableObjs = allModels.filter(m => 
      modelsToDisable.includes(m.name) && m.show_in_rankings === 1
    );
    
    console.log(`❌ Models to disable: ${modelsToDisableObjs.length}`);
    modelsToDisableObjs.forEach(m => {
      console.log(`  ❌ ${m.vendor}/${m.name}`);
    });
    
    // Disable them using raw SQL
    if (modelsToDisableObjs.length > 0) {
      const idsToDisable = modelsToDisableObjs.map(m => m.id);
      const placeholders = idsToDisable.map(() => '?').join(',');
      sqlite.prepare(`UPDATE models SET show_in_rankings = 0 WHERE id IN (${placeholders})`).run(...idsToDisable);
    }
    
    // Verify
    const finalModels = sqlite.prepare('SELECT * FROM models').all();
    const enabledCount = finalModels.filter(m => m.show_in_rankings === 1).length;
    const disabledCount = finalModels.filter(m => m.show_in_rankings === 0).length;
    
    console.log(`\n📊 Final status:`);
    console.log(`  ✅ Enabled: ${enabledCount} models`);
    console.log(`  ❌ Disabled: ${disabledCount} models`);
    console.log(`\n🎉 Done! Keeping only top-ranked models + new DeepSeek/Kimi/GLM models.`);
    
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

disableLowRankingModels().then(() => {
  console.log('\n✅ Script completed successfully!');
  process.exit(0);
}).catch((error) => {
  console.error('\n❌ Script failed:', error);
  process.exit(1);
});
