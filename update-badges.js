#!/usr/bin/env node

// Update NEW badges - Add to Grok models, remove from OpenAI models
require('dotenv').config({ path: '/root/.env' });

async function updateNewBadges() {
  console.log('🏷️ Updating NEW badges...');
  
  try {
    const { db } = require('./dist/db/index.js');
    const { models } = require('./dist/db/schema.js');
    const { eq } = require('drizzle-orm');
    
    // Get current date and dates for badge logic
    const now = new Date();
    const yesterday = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000); // 1 day ago (NEW)
    const twoWeeksAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000); // 14 days ago (NOT NEW)
    
    console.log('📅 Date setup:');
    console.log(`  - Current time: ${now.toISOString()}`);
    console.log(`  - NEW badge threshold (< 7 days): ${yesterday.toISOString()}`);
    console.log(`  - Remove badge date (> 7 days): ${twoWeeksAgo.toISOString()}`);
    
    // Get all models to see what we're working with
    const allModels = await db.select().from(models);
    console.log(`\n📊 Found ${allModels.length} total models in database`);
    
    // Find Grok models (xAI) that should get NEW badges
    const grokModels = allModels.filter(m => m.vendor === 'xai');
    console.log(`\n🎯 Found ${grokModels.length} Grok models:`);
    grokModels.forEach(model => {
      const currentCreatedAt = model.createdAt ? new Date(model.createdAt) : null;
      const isCurrentlyNew = currentCreatedAt && currentCreatedAt > new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      console.log(`  - ${model.name} (${model.vendor}) - Currently NEW: ${isCurrentlyNew ? '✅' : '❌'}`);
    });
    
    // Find OpenAI models that should lose NEW badges
    const openAIModels = allModels.filter(m => m.vendor === 'openai');
    console.log(`\n🤖 Found ${openAIModels.length} OpenAI models:`);
    openAIModels.forEach(model => {
      const currentCreatedAt = model.createdAt ? new Date(model.createdAt) : null;
      const isCurrentlyNew = currentCreatedAt && currentCreatedAt > new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      console.log(`  - ${model.name} (${model.vendor}) - Currently NEW: ${isCurrentlyNew ? '✅' : '❌'}`);
    });
    
    console.log('\n🔄 Applying badge updates...');
    
    // Update Grok models to have NEW badges
    for (const grokModel of grokModels) {
      await db.update(models)
        .set({ createdAt: yesterday.toISOString() })
        .where(eq(models.id, grokModel.id));
      console.log(`  ✅ Added NEW badge to: ${grokModel.name}`);
    }
    
    // Update OpenAI models to remove NEW badges
    for (const openAIModel of openAIModels) {
      await db.update(models)
        .set({ createdAt: twoWeeksAgo.toISOString() })
        .where(eq(models.id, openAIModel.id));
      console.log(`  ❌ Removed NEW badge from: ${openAIModel.name}`);
    }
    
    console.log('\n🎉 Badge updates completed successfully!');
    console.log('📋 Summary:');
    console.log(`  - Added NEW badges to ${grokModels.length} Grok models`);
    console.log(`  - Removed NEW badges from ${openAIModels.length} OpenAI models`);
    console.log('\n⚠️ Note: Changes will be visible after the next cache refresh');
    
  } catch (error) {
    console.error('❌ Error updating badges:', error);
    process.exit(1);
  }
}

updateNewBadges().catch(console.error);
