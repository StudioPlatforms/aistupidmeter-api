#!/usr/bin/env node

// Emergency script to restore all models that were accidentally disabled
const dotenv = require('dotenv');
dotenv.config({ path: '/root/.env' });

const { db } = require('./src/db/index');
const { models } = require('./src/db/schema');
const { eq } = require('drizzle-orm');

async function restoreAllModels() {
  console.log('🚨 EMERGENCY: Restoring all disabled models...\n');
  
  try {
    // Get all models
    const allModels = await db.select().from(models);
    console.log(`📊 Total models in database: ${allModels.length}`);
    
    const disabledModels = allModels.filter(m => !m.showInRankings);
    console.log(`❌ Currently disabled models: ${disabledModels.length}`);
    
    if (disabledModels.length === 0) {
      console.log('✅ No disabled models found - nothing to restore!');
      return;
    }
    
    console.log('\n🔄 Re-enabling all models...');
    
    // Re-enable ALL models
    await db.update(models)
      .set({ showInRankings: true })
      .where(eq(models.showInRankings, false));
    
    console.log(`✅ Successfully re-enabled ${disabledModels.length} models!`);
    
    // Verify
    const afterModels = await db.select().from(models);
    const stillDisabled = afterModels.filter(m => !m.showInRankings);
    console.log(`\n📊 Final status: ${stillDisabled.length} models still disabled`);
    
    if (stillDisabled.length === 0) {
      console.log('🎉 All models have been restored successfully!');
    }
    
  } catch (error) {
    console.error('❌ Error restoring models:', error);
    process.exit(1);
  }
}

restoreAllModels().then(() => {
  console.log('\n✅ Restoration complete!');
  process.exit(0);
}).catch((error) => {
  console.error('\n❌ Restoration failed:', error);
  process.exit(1);
});
