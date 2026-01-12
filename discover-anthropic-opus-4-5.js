#!/usr/bin/env node

// Script to discover the exact model name for Claude Opus 4.5 from Anthropic API
const dotenv = require('dotenv');
dotenv.config({ path: '/root/.env' });

async function discoverOpus45() {
  console.log('🔍 Discovering Claude Opus 4.5 model name from Anthropic API...\n');
  
  const apiKey = process.env.ANTHROPIC_API_KEY;
  
  if (!apiKey) {
    console.log('❌ ANTHROPIC_API_KEY not found in environment');
    console.log('💡 Please set ANTHROPIC_API_KEY in /root/.env');
    return;
  }
  
  console.log('✅ API key found');
  console.log('📡 Fetching available models from Anthropic...\n');
  
  try {
    const response = await fetch('https://api.anthropic.com/v1/models', {
      headers: { 
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      }
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.log(`❌ API request failed: ${response.status}`);
      console.log(`Error: ${errorText}`);
      return;
    }
    
    const data = await response.json();
    
    if (!data.data || !Array.isArray(data.data)) {
      console.log('⚠️ Unexpected API response format');
      console.log('Response:', JSON.stringify(data, null, 2));
      return;
    }
    
    console.log(`✅ Found ${data.data.length} models:\n`);
    
    // List all models
    data.data.forEach((model, index) => {
      console.log(`${index + 1}. ${model.id}`);
      if (model.display_name) console.log(`   Display name: ${model.display_name}`);
      if (model.created_at) console.log(`   Created: ${model.created_at}`);
    });
    
    // Look for Opus 4.5 specifically
    console.log('\n🔍 Searching for Opus 4.5 models...\n');
    
    const opus45Models = data.data.filter(m => 
      m.id.toLowerCase().includes('opus') && 
      (m.id.includes('4.5') || m.id.includes('4-5'))
    );
    
    if (opus45Models.length > 0) {
      console.log(`✅ Found ${opus45Models.length} Opus 4.5 model(s):\n`);
      opus45Models.forEach(model => {
        console.log(`📌 Model ID: ${model.id}`);
        if (model.display_name) console.log(`   Display name: ${model.display_name}`);
        if (model.created_at) console.log(`   Created: ${model.created_at}`);
        console.log('');
      });
      
      console.log('✅ Next steps:');
      console.log(`1. Update apps/api/src/llm/adapters.ts to include: '${opus45Models[0].id}'`);
      console.log(`2. Run: node apps/api/enable-opus-4-5.js`);
    } else {
      console.log('⚠️ No Opus 4.5 models found in the API response');
      console.log('💡 The model might not be available yet, or it might have a different naming pattern');
      console.log('\n📋 All Opus models found:');
      const allOpus = data.data.filter(m => m.id.toLowerCase().includes('opus'));
      if (allOpus.length > 0) {
        allOpus.forEach(model => console.log(`   - ${model.id}`));
      } else {
        console.log('   (none)');
      }
    }
    
  } catch (error) {
    console.log(`❌ Error: ${error.message}`);
    console.log('\n💡 Stack trace:', error.stack);
  }
}

discoverOpus45().catch(console.error);
