import { db } from './src/db/index';
import { models } from './src/db/schema';
import { eq } from 'drizzle-orm';

async function seedModels() {
  console.log('🌱 Seeding models into database...');

  try {
    // Check for existing models first
    const existingModels = await db.select().from(models);
    console.log(`Found ${existingModels.length} existing models`);
    
    // Models to insert
    const modelsToInsert = [
      // OpenAI
      { name: 'gpt-4o-mini', vendor: 'openai', version: '2024-07-18', notes: 'GPT-4o mini efficient model' },
      { name: 'gpt-4o', vendor: 'openai', version: '2024-11-20', notes: 'GPT-4 Omni multimodal' },
      
      // Anthropic
      { name: 'claude-3-5-haiku-20241022', vendor: 'anthropic', version: '2024-10-22', notes: 'Claude 3.5 Haiku - fast and efficient' },
      { name: 'claude-3-5-sonnet-20241022', vendor: 'anthropic', version: '2024-10-22', notes: 'Claude 3.5 Sonnet - balanced performance' },
      
      // Google
      { name: 'gemini-1.5-flash', vendor: 'google', version: '2024-12', notes: 'Gemini 1.5 Flash - fast responses' },
      { name: 'gemini-1.5-pro', vendor: 'google', version: '2024-12', notes: 'Gemini 1.5 Pro - advanced reasoning' },
    ];
    
    // Only insert models that don't already exist
    const insertedModels: any[] = [];
    for (const modelData of modelsToInsert) {
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

seedModels()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
