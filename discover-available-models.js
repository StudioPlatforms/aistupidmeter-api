#!/usr/bin/env node

// Script to discover available models from DeepSeek, Kimi, and GLM providers
const dotenv = require('dotenv');
dotenv.config({ path: '/root/.env' });

const { DeepSeekAdapter, KimiAdapter, GLMAdapter } = require('./src/llm/adapters');

async function discoverModels() {
  console.log('🔍 Discovering available models from the 3 new providers...\n');
  
  const providers = [
    {
      name: 'DeepSeek',
      adapter: new DeepSeekAdapter(process.env.DEEPSEEK_API_KEY),
      hasKey: !!process.env.DEEPSEEK_API_KEY
    },
    {
      name: 'Kimi',
      adapter: new KimiAdapter(process.env.KIMI_API_KEY),
      hasKey: !!process.env.KIMI_API_KEY
    },
    {
      name: 'GLM',
      adapter: new GLMAdapter(process.env.GLM_API_KEY),
      hasKey: !!process.env.GLM_API_KEY
    }
  ];
  
  for (const provider of providers) {
    console.log(`\n📡 ${provider.name} Provider:`);
    console.log(`🔑 API Key configured: ${provider.hasKey ? '✅ Yes' : '❌ No'}`);
    
    if (!provider.hasKey) {
      console.log(`⚠️ Skipping ${provider.name} - no API key found`);
      continue;
    }
    
    try {
      console.log(`🔍 Fetching available models...`);
      const models = await provider.adapter.listModels();
      
      console.log(`✅ Found ${models.length} models:`);
      models.forEach((model, index) => {
        console.log(`   ${index + 1}. ${model}`);
      });
      
      // Test a simple call with the first model to verify it works
      if (models.length > 0) {
        const testModel = models[0];
        console.log(`\n🧪 Testing ${testModel} with a simple call...`);
        
        try {
          const response = await provider.adapter.chat({
            model: testModel,
            messages: [
              { role: 'system', content: 'You are a helpful assistant.' },
              { role: 'user', content: 'Say "hello"' }
            ],
            temperature: 0.1,
            maxTokens: 50
          });
          
          if (response.text && response.text.trim()) {
            console.log(`✅ Test successful: "${response.text.trim()}"`);
            console.log(`📊 Tokens: ${response.tokensIn || 0} in, ${response.tokensOut || 0} out`);
          } else {
            console.log(`⚠️ Test returned empty response`);
          }
        } catch (testError) {
          console.log(`❌ Test failed: ${testError.message}`);
        }
      }
      
    } catch (error) {
      console.log(`❌ Failed to fetch models: ${error.message}`);
      console.log(`🔍 Error details: ${error.stack?.split('\n')[0] || 'No stack trace'}`);
    }
  }
  
  console.log('\n📋 Summary:');
  console.log('Now we can see which models are actually available and working.');
  console.log('We should only add the models that we want to benchmark to the database.');
}

discoverModels().catch(console.error);
