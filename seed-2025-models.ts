import { db } from './src/db/index';
import { models } from './src/db/schema';
import { eq } from 'drizzle-orm';

async function seed2025Models() {
  console.log('🚀 Seeding 2025 models into database...\n');

  try {
    // Check for existing models first
    const existingModels = await db.select().from(models);
    console.log(`Found ${existingModels.length} existing models`);
    
    // All real 2025 models
    const models2025 = [
      // OpenAI - Latest 2025 models
      { name: 'gpt-5', vendor: 'openai', version: '2025-01-15', notes: 'GPT-5 flagship model released Jan 2025' },
      { name: 'gpt-5-mini', vendor: 'openai', version: '2025-01-15', notes: 'GPT-5 Mini - efficient variant' },
      { name: 'gpt-4o', vendor: 'openai', version: '2024-11-20', notes: 'GPT-4 Omni multimodal' },
      { name: 'gpt-4o-mini', vendor: 'openai', version: '2024-07-18', notes: 'GPT-4o mini efficient model' },
      
      // Anthropic - Claude 4 series (2025)
      { name: 'claude-opus-4-1-20250805', vendor: 'anthropic', version: '2025-08-05', notes: 'Claude Opus 4.1 - most powerful' },
      { name: 'claude-opus-4-20250514', vendor: 'anthropic', version: '2025-05-14', notes: 'Claude Opus 4 - powerful reasoning' },
      { name: 'claude-sonnet-4-20250514', vendor: 'anthropic', version: '2025-05-14', notes: 'Claude Sonnet 4 - balanced' },
      { name: 'claude-3-5-sonnet-20241022', vendor: 'anthropic', version: '2024-10-22', notes: 'Claude 3.5 Sonnet - still available' },
      { name: 'claude-3-5-haiku-20241022', vendor: 'anthropic', version: '2024-10-22', notes: 'Claude 3.5 Haiku - fast' },
      
      // xAI - Grok models (2025)
      { name: 'grok-4', vendor: 'xai', version: '2025-01-10', notes: 'Grok 4 - flagship reasoning model' },
      { name: 'grok-code-fast-1', vendor: 'xai', version: '2025-01-10', notes: 'Grok Code Fast - optimized for coding' },
      
      // Google - Gemini 2.5 series (2025)
      { name: 'gemini-2.5-pro', vendor: 'google', version: '2025-01-12', notes: 'Gemini 2.5 Pro - most capable' },
      { name: 'gemini-2.5-flash', vendor: 'google', version: '2025-01-12', notes: 'Gemini 2.5 Flash - fast & efficient' },
      { name: 'gemini-2.5-flash-lite', vendor: 'google', version: '2025-01-12', notes: 'Gemini 2.5 Flash Lite - ultra-fast' },
      { name: 'gemini-1.5-pro', vendor: 'google', version: '2024-12', notes: 'Gemini 1.5 Pro - still supported' },
      { name: 'gemini-1.5-flash', vendor: 'google', version: '2024-12', notes: 'Gemini 1.5 Flash - still supported' },
    ];
    
    // Only insert models that don't already exist
    const insertedModels: any[] = [];
    for (const modelData of models2025) {
      const existing = existingModels.find(m => m.name === modelData.name && m.vendor === modelData.vendor);
      if (!existing) {
        const [inserted] = await db.insert(models).values(modelData).returning();
        insertedModels.push(inserted);
        console.log(`  ✅ Added ${modelData.name} (${modelData.vendor})`);
      } else {
        console.log(`  ⏭️  Skipping ${modelData.name} (already exists)`);
      }
    }

    console.log(`\n✅ Successfully added ${insertedModels.length} new models`);
    
    // List all models now in database
    const allModels = await db.select().from(models);
    console.log(`\n📊 Total models in database: ${allModels.length}`);
    for (const model of allModels) {
      console.log(`  - ${model.name} (${model.vendor})`);
    }
    
  } catch (error) {
    console.error('❌ Error seeding models:', error);
  }
}

seed2025Models()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
