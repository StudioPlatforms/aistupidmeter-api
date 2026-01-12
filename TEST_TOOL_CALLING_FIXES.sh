#!/bin/bash
# Test script for tool calling fixes
# Run this after rebuilding and restarting the backend

echo "=================================================="
echo "Testing Tool Calling Fixes"
echo "=================================================="
echo ""

echo "Test 1: GPT-5.1 with DEBUG_TOOLS enabled"
echo "--------------------------------------------------"
DEBUG_TOOLS=1 npx ts-node -e "
import { ToolBenchmarkSession } from './src/toolbench/session/benchmark-session';
import { EASY_TASKS } from './src/toolbench/tasks/definitions';
import { getAdapter } from './src/jobs/real-benchmarks';
import { db } from './src/db';
import { models } from './src/db/schema';
import { eq } from 'drizzle-orm';

(async () => {
  const modelData = await db.select().from(models).where(eq(models.name, 'gpt-5.1')).limit(1);
  if (!modelData.length) {
    console.error('❌ Model gpt-5.1 not found in database');
    process.exit(1);
  }
  
  const model = modelData[0];
  const task = EASY_TASKS[0];
  const adapter = getAdapter('openai');
  
  if (!adapter) {
    console.error('❌ No OpenAI adapter available');
    process.exit(1);
  }
  
  console.log('Testing', model.name, 'on', task.name);
  console.log('');
  
  const session = new ToolBenchmarkSession(model, task, adapter);
  const result = await session.run();
  
  console.log('');
  console.log('=== RESULTS ===');
  console.log('Result:', result.passed ? '✅ PASSED' : '❌ FAILED');
  console.log('Final Score:', result.finalScore);
  console.log('');
  console.log('Metrics:');
  console.log('  Tool Selection:', result.metrics.toolSelection);
  console.log('  Parameter Accuracy:', result.metrics.parameterAccuracy);
  console.log('  Task Completion:', result.metrics.taskCompletion);
  console.log('');
  console.log('Summary:');
  console.log('  Tool Calls:', result.summary.toolCallsCount);
  console.log('  Successful:', result.summary.successfulToolCalls);
  console.log('  Failed:', result.summary.failedToolCalls);
  console.log('  Unique Tools:', result.summary.uniqueToolsUsed.join(', '));
  
  if (result.summary.toolCallsCount === 0) {
    console.log('');
    console.log('⚠️  WARNING: No tool calls detected!');
    console.log('Check the DEBUG_TOOLS output above to see what was sent/received.');
  } else {
    console.log('');
    console.log('✅ Tool calls detected! Fix may be working.');
  }
  
  process.exit(0);
})().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
"

echo ""
echo ""
echo "Test 2: Claude model for comparison (should still work)"
echo "--------------------------------------------------"
npx ts-node -e "
import { ToolBenchmarkSession } from './src/toolbench/session/benchmark-session';
import { EASY_TASKS } from './src/toolbench/tasks/definitions';
import { getAdapter } from './src/jobs/real-benchmarks';
import { db } from './src/db';
import { models } from './src/db/schema';
import { like, eq } from 'drizzle-orm';

(async () => {
  const modelData = await db.select().from(models)
    .where(like(models.name, '%claude%'))
    .limit(1);
    
  if (!modelData.length) {
    console.log('⚠️  No Claude model found, skipping comparison test');
    process.exit(0);
  }
  
  const model = modelData[0];
  const task = EASY_TASKS[0];
  const adapter = getAdapter('anthropic');
  
  if (!adapter) {
    console.log('⚠️  No Anthropic adapter available, skipping');
    process.exit(0);
  }
  
  console.log('Testing', model.name, 'on', task.name);
  
  const session = new ToolBenchmarkSession(model, task, adapter);
  const result = await session.run();
  
  console.log('');
  console.log('Result:', result.passed ? '✅ PASSED' : '❌ FAILED');
  console.log('Tool Calls:', result.summary.toolCallsCount);
  console.log('Final Score:', result.finalScore);
  
  process.exit(0);
})().catch(err => {
  console.error('Comparison test failed:', err);
  process.exit(1);
});
"

echo ""
echo "=================================================="
echo "Tests Complete"
echo "=================================================="
echo ""
echo "Expected Results:"
echo "- GPT-5.1 should now show toolCallsCount > 0"
echo "- Debug output should show tools being sent and extracted"
echo "- Claude models should continue working as before"
echo ""
echo "If GPT-5.1 still shows 0 tool calls, check the DEBUG_TOOLS"
echo "output to see if:"
echo "  1. Tools are being formatted correctly"
echo "  2. Tools are being sent to the API"
echo "  3. Tool calls are in the API response"
echo "  4. Tool calls are being extracted correctly"
