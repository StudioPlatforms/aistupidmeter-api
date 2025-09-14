#!/usr/bin/env npx tsx

import dotenv from 'dotenv';
dotenv.config({ path: '/root/.env' });

import { db } from './src/db/index';
import { models, deep_sessions, deep_alerts } from './src/db/schema';
import { eq, desc } from 'drizzle-orm';
import { runDeepBenchmarks, isDeepBenchmarkActive, getDeepBenchmarkProgress } from './src/deepbench/index';

async function testDeepBenchmarks() {
  console.log('🧪 Starting Deep Benchmark System Test');
  console.log('=' .repeat(50));
  
  try {
    // Check database connectivity
    console.log('📊 Checking database connectivity...');
    const modelCount = await db.select().from(models);
    console.log(`✅ Found ${modelCount.length} models in database`);
    
    // Check for API keys
    console.log('\n🔑 Checking API key availability...');
    const apiKeys = {
      openai: !!process.env.OPENAI_API_KEY && !process.env.OPENAI_API_KEY.startsWith('your_'),
      anthropic: !!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_API_KEY.startsWith('your_'),
      google: !!(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) && 
              !(process.env.GEMINI_API_KEY?.startsWith('your_') || process.env.GOOGLE_API_KEY?.startsWith('your_')),
      xai: !!process.env.XAI_API_KEY && !process.env.XAI_API_KEY.startsWith('your_')
    };
    
    Object.entries(apiKeys).forEach(([provider, hasKey]) => {
      console.log(`  ${hasKey ? '✅' : '❌'} ${provider.toUpperCase()}: ${hasKey ? 'Available' : 'Missing/Invalid'}`);
    });
    
    const availableProviders = Object.entries(apiKeys).filter(([_, hasKey]) => hasKey).map(([provider]) => provider);
    
    if (availableProviders.length === 0) {
      console.log('\n❌ No API keys available. Please configure at least one provider in .env file');
      return;
    }
    
    console.log(`\n✅ ${availableProviders.length} providers available: ${availableProviders.join(', ')}`);
    
    // Check existing deep benchmark data
    console.log('\n📈 Checking existing deep benchmark data...');
    
    try {
      const recentSessions = await db.select().from(deep_sessions)
        .orderBy(desc(deep_sessions.ts))
        .limit(5);
      
      console.log(`📊 Found ${recentSessions.length} recent deep sessions`);
      if (recentSessions.length > 0) {
        console.log('Most recent sessions:');
        recentSessions.forEach(session => {
          console.log(`  - ${session.taskSlug} (Model ID ${session.modelId}): ${session.finalScore}/100, ${session.turns} turns`);
        });
      }
      
      const recentAlerts = await db.select().from(deep_alerts)
        .orderBy(desc(deep_alerts.ts))
        .limit(3);
      
      console.log(`🚨 Found ${recentAlerts.length} recent alerts`);
      
    } catch (error) {
      console.log('⚠️ Could not query deep benchmark tables (expected if running for first time)');
      console.log(`   Error: ${String(error).slice(0, 100)}`);
    }
    
    // Check if deep benchmark is currently running
    console.log('\n🏗️ Checking deep benchmark status...');
    const isRunning = isDeepBenchmarkActive();
    console.log(`Status: ${isRunning ? '🟢 Running' : '⚪ Idle'}`);
    
    if (isRunning) {
      const progress = getDeepBenchmarkProgress();
      console.log(`Progress: ${progress.completedModels}/${progress.totalModels} models`);
      console.log(`Current model: ${progress.currentModel || 'None'}`);
      console.log(`Errors: ${progress.errors.length}`);
    }
    
    // Ask user if they want to run a test
    console.log('\n🎯 Deep Benchmark Test Options:');
    console.log('1. Skip test (just verify system setup)');
    console.log('2. Run full deep benchmark suite (may take 10-20 minutes)');
    console.log('3. Run single model test (faster, ~2-5 minutes)');
    
    // For automation, we'll just verify system setup
    const choice = process.argv[2] || '1';
    
    if (choice === '1') {
      console.log('\n✅ System verification complete!');
      console.log('🏗️ Deep benchmark system is ready to run');
      console.log('📅 Scheduled to run daily at 3:00 AM Berlin time');
      console.log('\nTo test manually:');
      console.log('  npx tsx test-deep-benchmarks.ts 2  # Full test');
      console.log('  npx tsx test-deep-benchmarks.ts 3  # Single model test');
      
    } else if (choice === '2') {
      console.log('\n🚀 Running full deep benchmark suite...');
      console.log('⚠️  This may take 10-20 minutes and consume API credits');
      
      const startTime = Date.now();
      await runDeepBenchmarks();
      const duration = Math.round((Date.now() - startTime) / 1000);
      
      console.log(`\n✅ Deep benchmark suite completed in ${duration} seconds`);
      
      // Show results
      const newSessions = await db.select().from(deep_sessions)
        .orderBy(desc(deep_sessions.ts))
        .limit(10);
      
      console.log('\n📊 Recent Results:');
      newSessions.forEach(session => {
        console.log(`  ${session.taskSlug}: Model ${session.modelId} scored ${session.finalScore}/100`);
      });
      
    } else if (choice === '3') {
      console.log('\n🎯 Running single model test...');
      
      // Get one model with available API key
      const testModels = modelCount.filter(m => 
        availableProviders.includes(m.vendor)
      ).slice(0, 1);
      
      if (testModels.length === 0) {
        console.log('❌ No models available for testing');
        return;
      }
      
      console.log(`Testing with: ${testModels[0].name} (${testModels[0].vendor})`);
      console.log('⚠️  This may take 2-5 minutes and consume API credits');
      
      // For single model test, we would need to modify runDeepBenchmarks 
      // to accept a model filter - for now just suggest full test
      console.log('\nℹ️  Single model test not implemented yet.');
      console.log('Use option 2 for full test, or wait for scheduled run at 3 AM.');
    }
    
    console.log('\n🎉 Deep benchmark test completed successfully!');
    
  } catch (error) {
    console.error('\n❌ Deep benchmark test failed:');
    console.error(error);
    process.exit(1);
  }
}

// Run the test
if (require.main === module) {
  testDeepBenchmarks().then(() => {
    console.log('\n👋 Test script finished');
    process.exit(0);
  }).catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

export { testDeepBenchmarks };
