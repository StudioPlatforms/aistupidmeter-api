/**
 * Smart Router Usage Examples
 * 
 * Demonstrates how to use the smart router system in various scenarios
 */

import { selectModelAutomatically, explainSelection, compareStrategies } from '../selector/smart-selector';
import { analyzePrompt } from '../analyzer/prompt-analyzer';
import { selectBestModel } from '../selector';

/**
 * Example 1: Basic automatic routing
 */
export async function example1_BasicAutoRouting() {
  console.log('\n=== Example 1: Basic Automatic Routing ===\n');
  
  const userId = 1;
  const prompt = "Create a React component for a todo list with add/delete functionality";
  
  const result = await selectModelAutomatically(prompt, userId);
  
  console.log('Selected Model:', result.model);
  console.log('Provider:', result.provider);
  console.log('Score:', result.score);
  console.log('Cost:', `$${result.estimatedCost.toFixed(4)}/1k tokens`);
  console.log('\nAnalysis:');
  console.log('  Language:', result.analysis.language);
  console.log('  Task Type:', result.analysis.taskType);
  console.log('  Framework:', result.analysis.framework);
  console.log('  Complexity:', result.analysis.complexity);
  console.log('  Confidence:', `${Math.round(result.analysis.confidence * 100)}%`);
  console.log('\nReasoning:', result.reasoning);
}

/**
 * Example 2: Automatic routing with alternatives
 */
export async function example2_WithAlternatives() {
  console.log('\n=== Example 2: Routing with Alternatives ===\n');
  
  const userId = 1;
  const prompt = "Implement binary search in Python";
  
  const result = await selectModelAutomatically(prompt, userId, {
    includeAlternatives: true,
    maxAlternatives: 3
  });
  
  console.log('Primary Selection:', result.model, `(${result.score.toFixed(1)} score)`);
  
  if (result.alternativeModels && result.alternativeModels.length > 0) {
    console.log('\nAlternatives:');
    result.alternativeModels.forEach((alt, i) => {
      console.log(`  ${i + 1}. ${alt.model} (${alt.provider})`);
      console.log(`     Score: ${alt.score.toFixed(1)}, Cost: $${alt.estimatedCost.toFixed(4)}/1k`);
      console.log(`     ${alt.reasoning}`);
    });
  }
}

/**
 * Example 3: Prompt analysis only (no selection)
 */
export async function example3_AnalysisOnly() {
  console.log('\n=== Example 3: Prompt Analysis Only ===\n');
  
  const prompts = [
    "Create a REST API in Express",
    "Debug this React component error",
    "Implement quicksort in Rust",
    "Refactor this TypeScript code"
  ];
  
  for (const prompt of prompts) {
    const analysis = analyzePrompt(prompt);
    console.log(`\nPrompt: "${prompt}"`);
    console.log(`  → ${analysis.language} / ${analysis.taskType} / ${analysis.complexity}`);
    if (analysis.framework) {
      console.log(`  → Framework: ${analysis.framework}`);
    }
    console.log(`  → Confidence: ${Math.round(analysis.confidence * 100)}%`);
  }
}

/**
 * Example 4: Explain selection without executing
 */
export async function example4_ExplainSelection() {
  console.log('\n=== Example 4: Explain Selection (Preview) ===\n');
  
  const userId = 1;
  const prompt = "Build a microservice with async processing and security";
  
  const explanation = await explainSelection(prompt, userId);
  
  console.log('Prompt Analysis:');
  console.log('  Language:', explanation.analysis.language);
  console.log('  Task Type:', explanation.analysis.taskType);
  console.log('  Complexity:', explanation.analysis.complexity);
  console.log('\nStrategy:', explanation.strategy);
  console.log('Available Models:', explanation.availableModels);
  console.log('\nWould Select:', explanation.reasoning);
}

/**
 * Example 5: Compare all strategies
 */
export async function example5_CompareStrategies() {
  console.log('\n=== Example 5: Compare All Strategies ===\n');
  
  const userId = 1;
  const prompt = "Create a user authentication system";
  
  const comparison = await compareStrategies(prompt, userId);
  
  console.log('Strategy Comparison:\n');
  comparison.forEach(result => {
    console.log(`${result.strategy}:`);
    console.log(`  Model: ${result.model} (${result.provider})`);
    console.log(`  Score: ${result.score.toFixed(1)}`);
    console.log(`  Cost: $${result.cost.toFixed(4)}/1k tokens`);
    console.log(`  ${result.reasoning}\n`);
  });
}

/**
 * Example 6: Manual strategy selection (existing system)
 */
export async function example6_ManualStrategy() {
  console.log('\n=== Example 6: Manual Strategy Selection ===\n');
  
  const userId = 1;
  
  // Best for coding
  const coding = await selectBestModel({
    userId,
    strategy: 'best_coding'
  });
  console.log('Best Coding:', coding.model, `($${coding.estimatedCost.toFixed(4)}/1k)`);
  
  // Cheapest option
  const cheapest = await selectBestModel({
    userId,
    strategy: 'cheapest'
  });
  console.log('Cheapest:', cheapest.model, `($${cheapest.estimatedCost.toFixed(4)}/1k)`);
  
  // Fastest response
  const fastest = await selectBestModel({
    userId,
    strategy: 'fastest'
  });
  console.log('Fastest:', fastest.model, `(${fastest.avgLatency}ms avg)`);
}

/**
 * Example 7: Language-specific routing
 */
export async function example7_LanguageSpecific() {
  console.log('\n=== Example 7: Language-Specific Routing ===\n');
  
  const userId = 1;
  
  const languages = [
    { lang: 'Python', prompt: 'Write a Python function for data processing' },
    { lang: 'JavaScript', prompt: 'Create a JavaScript async function' },
    { lang: 'TypeScript', prompt: 'Build a TypeScript interface for API' },
    { lang: 'Rust', prompt: 'Implement ownership in Rust' },
    { lang: 'Go', prompt: 'Create a Go goroutine worker pool' }
  ];
  
  for (const { lang, prompt } of languages) {
    const result = await selectModelAutomatically(prompt, userId);
    console.log(`${lang}:`);
    console.log(`  Detected: ${result.analysis.language}`);
    console.log(`  Selected: ${result.model}`);
    console.log(`  Confidence: ${Math.round(result.analysis.confidence * 100)}%\n`);
  }
}

/**
 * Example 8: Task-type routing
 */
export async function example8_TaskTypeRouting() {
  console.log('\n=== Example 8: Task-Type Routing ===\n');
  
  const userId = 1;
  
  const tasks = [
    { type: 'UI', prompt: 'Create a responsive navbar component' },
    { type: 'Algorithm', prompt: 'Implement A* pathfinding algorithm' },
    { type: 'Backend', prompt: 'Build a GraphQL API with authentication' },
    { type: 'Debug', prompt: 'Fix this memory leak in the application' },
    { type: 'Refactor', prompt: 'Refactor this code to use design patterns' }
  ];
  
  for (const { type, prompt } of tasks) {
    const result = await selectModelAutomatically(prompt, userId);
    console.log(`${type}:`);
    console.log(`  Detected: ${result.analysis.taskType}`);
    console.log(`  Strategy: ${result.analysis.complexity === 'complex' ? 'advanced' : 'standard'}`);
    console.log(`  Selected: ${result.model}\n`);
  }
}

/**
 * Example 9: Cost-constrained routing
 */
export async function example9_CostConstrained() {
  console.log('\n=== Example 9: Cost-Constrained Routing ===\n');
  
  const userId = 1;
  const prompt = "Create a simple hello world function";
  
  // Get best overall
  const best = await selectModelAutomatically(prompt, userId);
  console.log('Best Overall:');
  console.log(`  Model: ${best.model}`);
  console.log(`  Cost: $${best.estimatedCost.toFixed(4)}/1k tokens`);
  console.log(`  Score: ${best.score.toFixed(1)}`);
  
  // Get cheapest
  const cheap = await selectBestModel({
    userId,
    strategy: 'cheapest'
  });
  console.log('\nCheapest:');
  console.log(`  Model: ${cheap.model}`);
  console.log(`  Cost: $${cheap.estimatedCost.toFixed(4)}/1k tokens`);
  console.log(`  Score: ${cheap.score.toFixed(1)}`);
  
  const savings = ((best.estimatedCost - cheap.estimatedCost) / best.estimatedCost * 100);
  console.log(`\nPotential Savings: ${savings.toFixed(1)}%`);
}

/**
 * Example 10: Framework-aware routing
 */
export async function example10_FrameworkAware() {
  console.log('\n=== Example 10: Framework-Aware Routing ===\n');
  
  const userId = 1;
  
  const frameworks = [
    'Create a React component with hooks',
    'Build a Vue 3 composition API component',
    'Implement a Django REST framework view',
    'Create an Express middleware',
    'Build a Next.js API route'
  ];
  
  for (const prompt of frameworks) {
    const result = await selectModelAutomatically(prompt, userId);
    console.log(`Prompt: "${prompt}"`);
    console.log(`  Framework: ${result.analysis.framework || 'none'}`);
    console.log(`  Selected: ${result.model}\n`);
  }
}

/**
 * Run all examples
 */
export async function runAllExamples() {
  try {
    await example1_BasicAutoRouting();
    await example2_WithAlternatives();
    await example3_AnalysisOnly();
    await example4_ExplainSelection();
    await example5_CompareStrategies();
    await example6_ManualStrategy();
    await example7_LanguageSpecific();
    await example8_TaskTypeRouting();
    await example9_CostConstrained();
    await example10_FrameworkAware();
    
    console.log('\n=== All Examples Completed ===\n');
  } catch (error) {
    console.error('Error running examples:', error);
  }
}

// Run if executed directly
if (require.main === module) {
  runAllExamples().then(() => {
    console.log('✅ Examples completed successfully');
    process.exit(0);
  }).catch(error => {
    console.error('❌ Examples failed:', error);
    process.exit(1);
  });
}
