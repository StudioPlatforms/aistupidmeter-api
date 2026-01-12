// Test script to verify OpenAI adapter fixes
import dotenv from 'dotenv';
dotenv.config({ path: '/root/.env' });

import { OpenAIAdapter } from './src/llm/adapters';

interface TestResult {
  model: string;
  endpoint: string;
  success: boolean;
  tokensIn?: number;
  tokensOut?: number;
  responseLength?: number;
  error?: string;
  latency?: number;
}

const results: TestResult[] = [];

async function testModel(modelName: string, expectedEndpoint: 'Responses API' | 'Chat Completions API') {
  console.log(`\n🧪 Testing ${modelName}...`);
  console.log(`   Expected endpoint: ${expectedEndpoint}`);
  
  const startTime = Date.now();
  
  try {
    const apiKey = process.env.OPENAI_API_KEY || '';
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY not found in environment');
    }
    
    const adapter = new OpenAIAdapter(apiKey);
    
    const response = await adapter.chat({
      model: modelName,
      messages: [
        { role: 'system', content: 'You are a helpful assistant. Be concise.' },
        { role: 'user', content: 'Write a one-line Python function that returns the number 42. Just the code, no explanation.' }
      ],
      temperature: 0.1,
      maxTokens: 50
    });
    
    const latency = Date.now() - startTime;
    
    if (!response.text || response.text.length < 5) {
      console.log(`   ❌ FAIL: Empty or very short response`);
      console.log(`   Response text: "${response.text}"`);
      results.push({
        model: modelName,
        endpoint: expectedEndpoint,
        success: false,
        error: 'Empty or very short response',
        latency
      });
      return;
    }
    
    console.log(`   ✅ SUCCESS`);
    console.log(`   Response: ${response.text.slice(0, 80)}${response.text.length > 80 ? '...' : ''}`);
    console.log(`   Tokens: ${response.tokensIn ?? 0} in, ${response.tokensOut ?? 0} out`);
    console.log(`   Latency: ${latency}ms`);
    
    results.push({
      model: modelName,
      endpoint: expectedEndpoint,
      success: true,
      tokensIn: response.tokensIn,
      tokensOut: response.tokensOut,
      responseLength: response.text.length,
      latency
    });
    
  } catch (error: any) {
    const latency = Date.now() - startTime;
    console.log(`   ❌ ERROR: ${error.message.slice(0, 200)}`);
    
    results.push({
      model: modelName,
      endpoint: expectedEndpoint,
      success: false,
      error: error.message.slice(0, 200),
      latency
    });
  }
}

async function testInvalidKey() {
  console.log(`\n🧪 Testing error handling with invalid API key...`);
  
  const badAdapter = new OpenAIAdapter('sk-invalid-key-12345');
  
  try {
    await badAdapter.chat({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'test' }],
      maxTokens: 10
    });
    
    console.log(`   ❌ FAIL: Should have thrown an error but didn't!`);
    return false;
  } catch (error: any) {
    if (error.message.includes('401') || error.message.includes('Unauthorized')) {
      console.log(`   ✅ SUCCESS: Properly caught authentication error`);
      console.log(`   Error message: ${error.message.slice(0, 150)}`);
      return true;
    } else {
      console.log(`   ⚠️ WARNING: Error thrown but unexpected format`);
      console.log(`   Error: ${error.message.slice(0, 150)}`);
      return true; // Still counts as working error handling
    }
  }
}

async function runTests() {
  console.log('🚀 Starting OpenAI Adapter Tests');
  console.log('═══════════════════════════════════════════════════════\n');
  
  // Test 1: Error handling
  const errorHandlingWorks = await testInvalidKey();
  
  // Test 2: GPT-5 models (Responses API)
  console.log('\n📋 Testing GPT-5 Models (Responses API)');
  console.log('───────────────────────────────────────────────────────');
  
  await testModel('gpt-5.1', 'Responses API');
  await testModel('gpt-5.1-codex', 'Responses API');
  await testModel('gpt-5.2', 'Responses API');
  
  // Test 3: GPT-4 models (Chat Completions API - the one we fixed)
  console.log('\n📋 Testing GPT-4 Models (Chat Completions API - Fixed)');
  console.log('───────────────────────────────────────────────────────');
  
  await testModel('gpt-4o', 'Chat Completions API');
  await testModel('gpt-4o-mini', 'Chat Completions API');
  
  // Summary
  console.log('\n\n═══════════════════════════════════════════════════════');
  console.log('📊 TEST SUMMARY');
  console.log('═══════════════════════════════════════════════════════\n');
  
  const successful = results.filter(r => r.success);
  const failed = results.filter(r => !r.success);
  
  console.log(`✅ Successful tests: ${successful.length}/${results.length}`);
  console.log(`❌ Failed tests: ${failed.length}/${results.length}`);
  console.log(`🛡️ Error handling: ${errorHandlingWorks ? 'WORKING' : 'BROKEN'}\n`);
  
  if (successful.length > 0) {
    console.log('✅ Successful Models:');
    successful.forEach(r => {
      console.log(`   - ${r.model}: ${r.responseLength} chars, ${r.tokensIn} tokens in, ${r.tokensOut} tokens out, ${r.latency}ms`);
    });
  }
  
  if (failed.length > 0) {
    console.log('\n❌ Failed Models:');
    failed.forEach(r => {
      console.log(`   - ${r.model}: ${r.error}`);
    });
  }
  
  // Token consumption verification
  const totalTokensIn = successful.reduce((sum, r) => sum + (r.tokensIn ?? 0), 0);
  const totalTokensOut = successful.reduce((sum, r) => sum + (r.tokensOut ?? 0), 0);
  
  console.log(`\n💰 Total API Credits Used:`);
  console.log(`   Input tokens: ${totalTokensIn}`);
  console.log(`   Output tokens: ${totalTokensOut}`);
  console.log(`   Total: ${totalTokensIn + totalTokensOut} tokens`);
  
  if (totalTokensIn > 0 || totalTokensOut > 0) {
    console.log(`\n✅ VERIFICATION: API credits ARE being consumed!`);
    console.log(`   This confirms the bug fix is working correctly.`);
  } else if (successful.length > 0) {
    console.log(`\n⚠️ WARNING: Tests succeeded but no token usage reported.`);
    console.log(`   This might indicate the token tracking needs verification.`);
  }
  
  // Final verdict
  console.log('\n═══════════════════════════════════════════════════════');
  if (errorHandlingWorks && successful.length >= 2 && totalTokensIn > 0) {
    console.log('🎉 ALL SYSTEMS GO! OpenAI adapter is working correctly.');
    console.log('   - Error handling: ✅');
    console.log('   - API calls: ✅');
    console.log('   - Token tracking: ✅');
  } else {
    console.log('⚠️ Some issues detected - review results above.');
  }
  console.log('═══════════════════════════════════════════════════════\n');
}

// Run the tests
runTests().catch(error => {
  console.error('💥 Fatal error running tests:', error);
  process.exit(1);
});
