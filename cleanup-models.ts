import { db } from './src/db/index';
import { models, scores, runs, metrics } from './src/db/schema';
import { sql } from 'drizzle-orm';

async function cleanupModels() {
  console.log('🧹 Cleaning up duplicate models...\n');

  try {
    // Get all models
    const allModels = await db.select().from(models);
    console.log(`Found ${allModels.length} total models (including duplicates)`);
    
    // Track which models to keep (by name+vendor combination)
    const seen = new Map<string, number>();
    const toDelete: number[] = [];
    
    for (const model of allModels) {
      const key = `${model.name}|${model.vendor}`;
      if (seen.has(key)) {
        // Duplicate found, mark for deletion
        toDelete.push(model.id);
        console.log(`  🗑️  Marking duplicate for deletion: ${model.name} (${model.vendor}) [ID: ${model.id}]`);
      } else {
        seen.set(key, model.id);
        console.log(`  ✅ Keeping: ${model.name} (${model.vendor}) [ID: ${model.id}]`);
      }
    }
    
    if (toDelete.length > 0) {
      console.log(`\n🗑️  Deleting ${toDelete.length} duplicate models...`);
      
      // Delete associated data first (foreign key constraints)
      for (const modelId of toDelete) {
        // Delete scores
        await db.delete(scores).where(sql`model_id = ${modelId}`);
        // Delete runs (and their metrics will cascade)
        await db.delete(runs).where(sql`model_id = ${modelId}`);
        // Now delete the model
        await db.delete(models).where(sql`id = ${modelId}`);
        console.log(`  Deleted model ID: ${modelId}`);
      }
    }
    
    // Now remove fantasy models and only keep real, current ones
    console.log('\n🔧 Removing fantasy/future models...');
    const fantasyModels = [
      'gpt-5', 'gpt-5-mini', 'gpt-5-nano', 'gpt-5-chat-latest',
      'claude-opus-4-1-20250805', 'claude-opus-4-20250514', 'claude-sonnet-4-20250514',
      'grok-4', 'grok-code-fast-1',
      'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite',
      'o3', 'o4-mini'
    ];
    
    for (const fantasyName of fantasyModels) {
      const fantasyModel = await db.select().from(models).where(sql`name = ${fantasyName}`).limit(1);
      if (fantasyModel.length > 0) {
        const modelId = fantasyModel[0].id;
        try {
          // First check if there are any runs
          const existingRuns = await db.select().from(runs).where(sql`model_id = ${modelId}`).limit(1);
          if (existingRuns.length > 0) {
            // Delete metrics first (they reference runs)
            const runIds = await db.select().from(runs).where(sql`model_id = ${modelId}`);
            for (const run of runIds) {
              await db.delete(metrics).where(sql`run_id = ${run.id}`);
            }
            // Then delete runs
            await db.delete(runs).where(sql`model_id = ${modelId}`);
          }
          // Delete scores
          await db.delete(scores).where(sql`model_id = ${modelId}`);
          // Finally delete the model
          await db.delete(models).where(sql`id = ${modelId}`);
          console.log(`  Removed fantasy model: ${fantasyName}`);
        } catch (err) {
          console.log(`  ⚠️  Could not remove ${fantasyName}: ${err.message}`);
        }
      }
    }
    
    // List remaining models
    const remainingModels = await db.select().from(models);
    console.log(`\n✅ Cleanup complete! ${remainingModels.length} models remaining:`);
    for (const model of remainingModels) {
      console.log(`  - ${model.name} (${model.vendor})`);
    }
    
  } catch (error) {
    console.error('❌ Error during cleanup:', error);
  }
}

cleanupModels()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
