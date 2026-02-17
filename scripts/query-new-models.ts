import dotenv from 'dotenv';
import { GoogleAdapter, KimiAdapter, DeepSeekAdapter, GLMAdapter } from '../src/llm/adapters';
import { db } from '../src/db/index';
import { models } from '../src/db/schema';
import { eq, or, like } from 'drizzle-orm';

// Load environment variables
dotenv.config({ path: '/root/.env' });

interface ModelComparison {
  provider: string;
  apiModels: string[];
  dbModels: { id: number; name: string; showInRankings: number }[];
  newModels: string[];
}

async function queryProviderModels(): Promise<void> {
  console.log('🔍 Querying provider APIs for available models...\n');

  const results: ModelComparison[] = [];

  // 1. Query Google/Gemini models
  console.log('📡 Querying Google Gemini API...');
  try {
    const googleKey = process.env.GEMINI_API_KEY;
    if (!googleKey) {
      console.log('⚠️  GEMINI_API_KEY not found in .env');
    } else {
      const googleAdapter = new GoogleAdapter(googleKey);
      const geminiModels = await googleAdapter.listModels();
      
      // Get existing Gemini models from database
      const dbGemini = await db.select()
        .from(models)
        .where(or(
          like(models.name, 'gemini-%'),
          like(models.name, 'models/gemini-%')
        ));
      
      const dbModelNames = dbGemini.map(m => m.name.replace('models/', ''));
      const newGeminiModels = geminiModels.filter((m: string) =>
        !dbModelNames.includes(m) && !dbModelNames.includes(`models/${m}`)
      );
      
      results.push({
        provider: 'Google Gemini',
        apiModels: geminiModels,
        dbModels: dbGemini.map(m => ({
          id: m.id,
          name: m.name,
          showInRankings: m.showInRankings ? 1 : 0
        })),
        newModels: newGeminiModels
      });
      
      console.log(`✅ Found ${geminiModels.length} Gemini models from API`);
      console.log(`   Database has ${dbGemini.length} Gemini models`);
      console.log(`   🆕 NEW models: ${newGeminiModels.length}\n`);
    }
  } catch (err: any) {
    console.log(`❌ Error querying Google: ${err.message}\n`);
  }

  // 2. Query Kimi models
  console.log('📡 Querying Kimi (Moonshot AI) API...');
  try {
    const kimiKey = process.env.KIMI_API_KEY;
    if (!kimiKey) {
      console.log('⚠️  KIMI_API_KEY not found in .env');
    } else {
      const kimiAdapter = new KimiAdapter(kimiKey);
      const kimiModels = await kimiAdapter.listModels();
      
      // Get existing Kimi models from database
      const dbKimi = await db.select()
        .from(models)
        .where(like(models.name, 'kimi-%'));
      
      const dbModelNames = dbKimi.map(m => m.name);
      const newKimiModels = kimiModels.filter((m: string) => !dbModelNames.includes(m));
      
      results.push({
        provider: 'Kimi (Moonshot AI)',
        apiModels: kimiModels,
        dbModels: dbKimi.map(m => ({
          id: m.id,
          name: m.name,
          showInRankings: m.showInRankings ? 1 : 0
        })),
        newModels: newKimiModels
      });
      
      console.log(`✅ Found ${kimiModels.length} Kimi models from API`);
      console.log(`   Database has ${dbKimi.length} Kimi models`);
      console.log(`   🆕 NEW models: ${newKimiModels.length}\n`);
    }
  } catch (err: any) {
    console.log(`❌ Error querying Kimi: ${err.message}\n`);
  }

  // 3. DeepSeek models (no API, hardcoded)
  console.log('📋 Checking DeepSeek models (no API endpoint)...');
  try {
    const deepseekKey = process.env.DEEPSEEK_API_KEY;
    const deepseekAdapter = new DeepSeekAdapter(deepseekKey || '');
    const deepseekModels = await deepseekAdapter.listModels();
    
    // Get existing DeepSeek models from database
    const dbDeepseek = await db.select()
      .from(models)
      .where(like(models.name, 'deepseek-%'));
    
    const dbModelNames = dbDeepseek.map(m => m.name);
    const newDeepseekModels = deepseekModels.filter((m: string) => !dbModelNames.includes(m));
    
    results.push({
      provider: 'DeepSeek',
      apiModels: deepseekModels,
      dbModels: dbDeepseek.map(m => ({
        id: m.id,
        name: m.name,
        showInRankings: m.showInRankings ? 1 : 0
      })),
      newModels: newDeepseekModels
    });
    
    console.log(`✅ Known DeepSeek models: ${deepseekModels.join(', ')}`);
    console.log(`   Database has ${dbDeepseek.length} DeepSeek models`);
    console.log(`   🆕 NEW models: ${newDeepseekModels.length}\n`);
  } catch (err: any) {
    console.log(`❌ Error checking DeepSeek: ${err.message}\n`);
  }

  // 4. GLM models (no API, hardcoded)
  console.log('📋 Checking GLM models (no API endpoint)...');
  try {
    const glmKey = process.env.GLM_API_KEY;
    const glmAdapter = new GLMAdapter(glmKey || '');
    const glmModels = await glmAdapter.listModels();
    
    // Get existing GLM models from database
    const dbGlm = await db.select()
      .from(models)
      .where(like(models.name, 'glm-%'));
    
    const dbModelNames = dbGlm.map(m => m.name);
    const newGlmModels = glmModels.filter((m: string) => !dbModelNames.includes(m));
    
    results.push({
      provider: 'GLM (Z.AI)',
      apiModels: glmModels,
      dbModels: dbGlm.map(m => ({
        id: m.id,
        name: m.name,
        showInRankings: m.showInRankings ? 1 : 0
      })),
      newModels: newGlmModels
    });
    
    console.log(`✅ Known GLM models: ${glmModels.join(', ')}`);
    console.log(`   Database has ${dbGlm.length} GLM models`);
    console.log(`   🆕 NEW models: ${newGlmModels.length}\n`);
  } catch (err: any) {
    console.log(`❌ Error checking GLM: ${err.message}\n`);
  }

  // Print detailed summary
  console.log('\n' + '='.repeat(80));
  console.log('📊 DETAILED SUMMARY');
  console.log('='.repeat(80) + '\n');

  for (const result of results) {
    console.log(`\n🏢 ${result.provider}`);
    console.log('-'.repeat(80));
    
    console.log(`\n📡 Available from API (${result.apiModels.length} models):`);
    result.apiModels.forEach(m => console.log(`   • ${m}`));
    
    console.log(`\n💾 In Database (${result.dbModels.length} models):`);
    result.dbModels.forEach(m => {
      const status = m.showInRankings === 1 ? '✅ WHITELISTED' : '🚫 BLACKLISTED';
      console.log(`   • [ID ${m.id}] ${m.name} - ${status}`);
    });
    
    if (result.newModels.length > 0) {
      console.log(`\n🆕 NEW MODELS NOT IN DATABASE (${result.newModels.length}):`);
      result.newModels.forEach(m => console.log(`   ⭐ ${m}`));
    } else {
      console.log(`\n✓ No new models found`);
    }
  }

  // Special check: Find model to blacklist
  console.log('\n' + '='.repeat(80));
  console.log('🎯 REQUESTED ACTIONS');
  console.log('='.repeat(80) + '\n');

  const gemini25Preview = await db.select()
    .from(models)
    .where(like(models.name, '%gemini-2.5-pro-preview-03-25%'));
  
  if (gemini25Preview.length > 0) {
    const model = gemini25Preview[0];
    console.log(`🔍 Found model to BLACKLIST:`);
    console.log(`   • ID: ${model.id}`);
    console.log(`   • Name: ${model.name}`);
    console.log(`   • Current status: ${model.showInRankings ? '✅ WHITELISTED' : '🚫 BLACKLISTED'}`);
    console.log(`   • Action needed: ${model.showInRankings ? '⚠️  SET showInRankings=false' : '✓ Already blacklisted'}`);
  } else {
    console.log(`❌ Model 'gemini-2.5-pro-preview-03-25' not found in database`);
  }

  console.log('\n');
}

// Run the script
queryProviderModels()
  .then(() => {
    console.log('✅ Query complete');
    process.exit(0);
  })
  .catch((err) => {
    console.error('❌ Error:', err);
    process.exit(1);
  });
