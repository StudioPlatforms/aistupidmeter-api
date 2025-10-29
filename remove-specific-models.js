#!/usr/bin/env node

// Remove specific models: duplicate deepseek-chat, grok-4-0709-eu, gemini-2.5-flash-lite-preview-06-17, gpt-4o-mini
const Database = require('better-sqlite3');
const sqlite = new Database('./data/stupid_meter.db');

console.log('🔍 Removing specific models...\n');

try {
  // First, let's see all deepseek-chat entries
  const deepseekEntries = sqlite.prepare('SELECT id, name, vendor FROM models WHERE name = ?').all('deepseek-chat');
  console.log(`Found ${deepseekEntries.length} deepseek-chat entries:`);
  deepseekEntries.forEach(m => console.log(`  ID ${m.id}: ${m.vendor}/${m.name}`));
  
  // Keep the first one, disable the rest
  if (deepseekEntries.length > 1) {
    const idsToDisable = deepseekEntries.slice(1).map(m => m.id);
    console.log(`\n❌ Disabling duplicate deepseek-chat entries (IDs: ${idsToDisable.join(', ')})`);
    const placeholders = idsToDisable.map(() => '?').join(',');
    sqlite.prepare(`UPDATE models SET show_in_rankings = 0 WHERE id IN (${placeholders})`).run(...idsToDisable);
  }
  
  // Disable the other 3 models
  const modelsToDisable = [
    'grok-4-0709-eu',
    'gemini-2.5-flash-lite-preview-06-17',
    'gpt-4o-mini'
  ];
  
  console.log(`\n❌ Disabling additional models:`);
  for (const modelName of modelsToDisable) {
    const result = sqlite.prepare('UPDATE models SET show_in_rankings = 0 WHERE name = ? AND show_in_rankings = 1').run(modelName);
    if (result.changes > 0) {
      console.log(`  ✓ Disabled ${modelName}`);
    } else {
      console.log(`  ⚠ ${modelName} not found or already disabled`);
    }
  }
  
  // Verify final count
  const finalModels = sqlite.prepare('SELECT * FROM models').all();
  const enabledCount = finalModels.filter(m => m.show_in_rankings === 1).length;
  const disabledCount = finalModels.filter(m => m.show_in_rankings === 0).length;
  
  console.log(`\n📊 Final status:`);
  console.log(`  ✅ Enabled: ${enabledCount} models`);
  console.log(`  ❌ Disabled: ${disabledCount} models`);
  
  // Show enabled models
  console.log(`\n✅ Currently enabled models:`);
  const enabledModels = sqlite.prepare('SELECT name, vendor FROM models WHERE show_in_rankings = 1 ORDER BY name').all();
  enabledModels.forEach((m, i) => console.log(`  ${i+1}. ${m.vendor}/${m.name}`));
  
  console.log(`\n🎉 Done!`);
  
} catch (error) {
  console.error('❌ Error:', error);
  process.exit(1);
}

sqlite.close();
