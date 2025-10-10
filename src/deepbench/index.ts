import dotenv from 'dotenv';
dotenv.config({ path: '/root/.env' });

import { db } from '../db/index';
import { models, scores, deep_sessions, deep_alerts } from '../db/schema';
import { eq, desc } from 'drizzle-orm';
import { MultiTurnSession, SessionResult, ModelInfo } from './session-runner';
import { DEEP_TASKS, DeepTask } from './tasks';
import {
  OpenAIAdapter,
  AnthropicAdapter, 
  GoogleAdapter,
  XAIAdapter,
  GLMAdapter,
  DeepSeekAdapter,
  KimiAdapter,
  Provider,
  LLMAdapter
} from '../llm/adapters';
import * as crypto from 'crypto';

// Import cache refresh function
let refreshAllCache: (() => Promise<any>) | null = null;
try {
  const cacheModule = require('../cache/dashboard-cache');
  refreshAllCache = cacheModule.refreshAllCache;
} catch {
  // Cache system not available - will be null
  console.warn('⚠️ Cache refresh not available for deep benchmarks - dashboard may not update automatically');
}

// Track running status for coordination with scheduler
let isDeepBenchmarkRunning = false;
let deepBenchmarkProgress = {
  currentModel: null as string | null,
  completedModels: 0,
  totalModels: 0,
  startTime: null as Date | null,
  errors: [] as string[]
};

export function isDeepBenchmarkActive(): boolean {
  return isDeepBenchmarkRunning;
}

export function getDeepBenchmarkProgress() {
  return { ...deepBenchmarkProgress };
}

function getAdapter(provider: Provider): LLMAdapter | null {
  const apiKeys = {
    openai: [process.env.OPENAI_API_KEY, process.env.OPENAI_API_KEY_2],
    xai: [process.env.XAI_API_KEY, process.env.XAI_API_KEY_2],
    anthropic: [process.env.ANTHROPIC_API_KEY, process.env.ANTHROPIC_API_KEY_2],
    google: [process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY, process.env.GEMINI_API_KEY_2],
    glm: [process.env.GLM_API_KEY, process.env.GLM_API_KEY_2],
    deepseek: [process.env.DEEPSEEK_API_KEY, process.env.DEEPSEEK_API_KEY_2],
    kimi: [process.env.KIMI_API_KEY, process.env.KIMI_API_KEY_2]
  };
  
  const keys = apiKeys[provider]?.filter((k): k is string => k !== undefined && k !== null && !k.startsWith('your_')) || [];
  if (keys.length === 0) return null;
  
  // Use first available key for deep benchmarks (could be enhanced to rotate if needed)
  const selectedKey = keys[0];
  
  switch (provider) {
    case 'openai': return new OpenAIAdapter(selectedKey);
    case 'xai': return new XAIAdapter(selectedKey);
    case 'anthropic': return new AnthropicAdapter(selectedKey);
    case 'google': return new GoogleAdapter(selectedKey);
    case 'glm': return new GLMAdapter(selectedKey);
    case 'deepseek': return new DeepSeekAdapter(selectedKey);
    case 'kimi': return new KimiAdapter(selectedKey);
    default: return null;
  }
}

function selectDailyTask(): DeepTask {
  // Rotate tasks based on day of year to ensure variety
  const now = new Date();
  const dayOfYear = Math.floor((now.getTime() - new Date(now.getFullYear(), 0, 0).getTime()) / (1000 * 60 * 60 * 24));
  const taskIndex = dayOfYear % DEEP_TASKS.length;
  
  console.log(`📋 Daily task selection: day ${dayOfYear} → task ${taskIndex} (${DEEP_TASKS[taskIndex].slug})`);
  return DEEP_TASKS[taskIndex];
}

async function benchmarkModelDeep(
  model: ModelInfo, 
  task: DeepTask,
  batchTimestamp: string
): Promise<void> {
  const adapter = getAdapter(model.vendor);
  if (!adapter) {
    console.log(`⚠️ ${model.name}: No API adapter available`);
    return;
  }

  // Check if provider is supported for this task
  if (!task.providerAllow.includes(model.vendor)) {
    console.log(`⚠️ ${model.name}: Not supported for task ${task.slug}`);
    return;
  }

  try {
    console.log(`🏗️ Starting deep benchmark: ${model.name} → ${task.slug}`);
    deepBenchmarkProgress.currentModel = model.name;
    
    // Run the multi-turn session
    const session = new MultiTurnSession(adapter, model);
    const result = await session.runSession(task);

    // Calculate comprehensive score with new axes
    const deepScore = await calculateDeepScore(result, task, model);
    
    // Store session data
    await storeDeepSession(model, result, deepScore, batchTimestamp);
    
    // Generate alerts if needed
    await checkForAlerts(model, deepScore, result);
    
    // Calculate cost metrics
  const costMetrics = calculateCostMetrics(result, deepScore, model.name);
  let costInfo = '';
  if (costMetrics) {
    costInfo = ` | $${costMetrics.totalCost} cost | ${costMetrics.pointsPerDollar} pts/$1`;
  }
  
  console.log(`✅ ${model.name}: Deep score ${deepScore}/100 (${result.turns} turns, ${Math.round(result.totalLatencyMs/1000)}s)${costInfo}`);
    
  } catch (error: any) {
    const errorMsg = String(error?.message || error).slice(0, 200);
    console.error(`❌ ${model.name}: Deep benchmark failed - ${errorMsg}`);
    deepBenchmarkProgress.errors.push(`${model.name}: ${errorMsg}`);
    
    // Store failed session with zero score
    try {
      await db.insert(deep_sessions).values({
        modelId: model.id,
        taskSlug: task.slug,
        ts: batchTimestamp,
        turns: 0,
        totalLatencyMs: 0,
        totalTokensIn: 0,
        totalTokensOut: 0,
        passed: false,
        conversationData: [{ role: 'system', content: `Failed: ${errorMsg}` }],
        stepResults: [],
        finalScore: 0
      });
    } catch (dbError) {
      console.error(`Failed to store error session: ${String(dbError).slice(0, 100)}`);
    }
  }
}

// Cost data per model (per 1M tokens)
const MODEL_COSTS = {
  // OpenAI
  'gpt-4o-2024-11-20': { input: 5.0, output: 15.0 },
  'gpt-4o-mini': { input: 0.15, output: 0.60 },
  'gpt-5-auto': { input: 150.0, output: 600.0 },  // Router variant
  'gpt-5-2025-08-07': { input: 200.0, output: 800.0 },  // Reasoning variant (higher cost)
  'gpt-5-mini': { input: 15.0, output: 60.0 },
  'gpt-5-nano': { input: 5.0, output: 20.0 },
  
  // Anthropic Claude
  'claude-3-5-haiku-20241022': { input: 0.25, output: 1.0 },
  'claude-3-5-sonnet-20241022': { input: 3.0, output: 15.0 },
  'claude-opus-4-1-20250805': { input: 15.0, output: 75.0 },
  'claude-opus-4-20250514': { input: 15.0, output: 75.0 },
  'claude-sonnet-4-20250514': { input: 3.0, output: 15.0 },
  'claude-sonnet-4-5-20250929': { input: 3.0, output: 15.0 },
  'claude-3-7-sonnet-20250219': { input: 3.0, output: 15.0 },
  
  // Google Gemini
  'gemini-1.5-flash': { input: 0.15, output: 0.60 },
  'gemini-1.5-pro': { input: 1.25, output: 10.0 },
  'gemini-2.5-pro': { input: 1.25, output: 12.5 },
  'gemini-2.5-flash': { input: 0.15, output: 0.60 },
  'gemini-2.5-flash-lite': { input: 0.10, output: 0.40 },
  
  // xAI Grok (official pricing)
  'grok-3-mini': { input: 0.30, output: 0.50 },
  'grok-3': { input: 3.0, output: 15.0 },
  'grok-4-latest': { input: 3.0, output: 15.0 },
  'grok-4-0709': { input: 3.0, output: 15.0 },
  'grok-4-0709-eu': { input: 3.0, output: 15.0 },
  'grok-code-fast-1': { input: 0.20, output: 1.50 }
};

function calculateCostMetrics(result: SessionResult, score: number, modelName: string) {
  const costs = MODEL_COSTS[modelName as keyof typeof MODEL_COSTS];
  if (!costs) return null;
  
  const inputCost = (result.totalTokensIn / 1_000_000) * costs.input;
  const outputCost = (result.totalTokensOut / 1_000_000) * costs.output;
  const totalCost = inputCost + outputCost;
  
  const costPerPoint = totalCost / Math.max(1, score);
  const pointsPerDollar = score / Math.max(0.01, totalCost);
  
  return {
    totalCost: Math.round(totalCost * 10000) / 10000, // 4 decimal places
    costPerPoint: Math.round(costPerPoint * 10000) / 10000,
    pointsPerDollar: Math.round(pointsPerDollar * 100) / 100,
    tokenCosts: {
      input: Math.round(inputCost * 10000) / 10000,
      output: Math.round(outputCost * 10000) / 10000
    }
  };
}

async function calculateDeepScore(
  result: SessionResult,
  task: DeepTask, 
  model: ModelInfo
): Promise<number> {
  
  if (result.artifacts.length === 0) return 0;
  
  // Calculate base axes (similar to hourly benchmarks but adapted for deep tasks)
  const baseAxes = {
    correctness: calculateCorrectness(result),
    complexity: calculateComplexity(result, task),
    codeQuality: calculateCodeQuality(result),
    efficiency: calculateEfficiency(result),
    stability: calculateStability(result),
    edgeCases: calculateEdgeCases(result),
    debugging: calculateDebugging(result, task),
    format: calculateFormat(result),
    safety: calculateSafety(result)
  };

  // Calculate new deep-specific axes
  const deepAxes = {
    memoryRetention: calculateMemoryRetention(result),
    hallucinationRate: calculateHallucinationRate(result, task),
    planCoherence: calculatePlanCoherence(result, task),
    contextWindow: calculateContextWindow(result, task)
  };

  // Combine axes with task-specific weights
  const allAxes = { ...baseAxes, ...deepAxes };
  const weights = { ...task.scoring.weights };
  
  // Clamp efficiency weight to 2% max to prevent small model bias
  const effClamp = 0.02;
  if (weights.efficiency > effClamp) {
    weights.efficiency = effClamp;
  }
  
  let weightedScore = 0;
  let totalWeight = 0;
  
  Object.entries(weights).forEach(([axis, weight]) => {
    if (allAxes[axis as keyof typeof allAxes] !== undefined) {
      weightedScore += allAxes[axis as keyof typeof allAxes] * weight;
      totalWeight += weight;
    }
  });
  
  const finalScore = totalWeight > 0 ? (weightedScore / totalWeight) * 100 : 0;
  
  // Store detailed score in scores table with 'deep' suite
  await db.insert(scores).values({
    modelId: model.id,
    ts: new Date().toISOString(),
    stupidScore: finalScore,
    axes: allAxes,
    cusum: 0.0, // Not used for deep benchmarks
    suite: 'deep',
    note: `Deep: ${task.slug}, ${result.turns} turns, ${Math.round(result.totalLatencyMs/1000)}s`
  });
  
  return Math.round(Math.max(0, Math.min(100, finalScore)));
}

// Base scoring functions (adapted from hourly system)
function calculateCorrectness(result: SessionResult): number {
  const passedTurns = result.artifacts.filter(a => !a.evaluation || a.evaluation.passed).length;
  return result.artifacts.length > 0 ? passedTurns / result.artifacts.length : 0;
}

function calculateComplexity(result: SessionResult, task: DeepTask): number {
  // Higher complexity for more sophisticated tasks
  const complexityMap = {
    'deep/ide_assistant': 0.7,
    'deep/spec_follow': 0.9,
    'deep/doc_memory': 0.5,
    'deep/refactor_project': 0.95
  };
  return complexityMap[task.slug as keyof typeof complexityMap] || 0.6;
}

function calculateCodeQuality(result: SessionResult): number {
  const artifacts = result.artifacts.filter(a => a.evaluation?.artifacts);
  if (artifacts.length === 0) return 0.5;
  
  let qualityScore = 0;
  artifacts.forEach(artifact => {
    const a = artifact.evaluation?.artifacts;
    if (a) {
      if (a.hasCode) qualityScore += 0.3;
      if (a.hasStructure) qualityScore += 0.4; 
      if (a.hasLogic) qualityScore += 0.3;
    }
  });
  
  return Math.min(1, qualityScore / artifacts.length);
}

function calculateEfficiency(result: SessionResult): number {
  if (result.totalTokensOut === 0 || result.totalLatencyMs === 0) return 0.5;
  
  // Tokens per second as efficiency measure
  const throughput = result.totalTokensOut / (result.totalLatencyMs / 1000);
  
  // Normalize: good throughput is 10+ tokens/second
  return Math.min(1, Math.max(0.1, throughput / 20));
}

function calculateStability(result: SessionResult): number {
  if (result.artifacts.length < 2) return 0.8; // Default for single turn
  
  // Measure consistency in response quality across turns
  const responseLengths = result.artifacts.map(a => a.response.length);
  const avgLength = responseLengths.reduce((s, l) => s + l, 0) / responseLengths.length;
  const variance = responseLengths.reduce((s, l) => s + Math.pow(l - avgLength, 2), 0) / responseLengths.length;
  const stdDev = Math.sqrt(variance);
  
  // Lower variation = higher stability
  const coefficientOfVariation = avgLength > 0 ? stdDev / avgLength : 0;
  return Math.max(0.2, Math.min(1, 1 - coefficientOfVariation));
}

function calculateEdgeCases(result: SessionResult): number {
  // For deep tasks, edge cases are handling of error conditions and feedback
  const turnsWithFeedback = result.artifacts.filter(a => 
    a.evaluation?.feedback && a.evaluation.feedback.length > 0
  ).length;
  
  if (turnsWithFeedback === 0) return 0.8; // No issues encountered
  
  // How well did it handle the feedback/errors?
  const recoveredTurns = result.artifacts.filter((a, i) => {
    if (i === 0 || !a.evaluation?.feedback) return false;
    // Check if next turn improved after feedback
    const nextTurn = result.artifacts[i + 1];
    return nextTurn && (!nextTurn.evaluation || nextTurn.evaluation.passed);
  }).length;
  
  return turnsWithFeedback > 0 ? recoveredTurns / turnsWithFeedback : 0.5;
}

function calculateDebugging(result: SessionResult, task: DeepTask): number {
  // Higher score for debugging-focused tasks
  if (task.slug.includes('debug') || task.slug.includes('ide')) {
    return calculateCorrectness(result) * 1.2; // Boost for debugging tasks
  }
  return calculateCorrectness(result);
}

function calculateFormat(result: SessionResult): number {
  // Check response formatting quality
  let formatScore = 0;
  result.artifacts.forEach(artifact => {
    const response = artifact.response;
    
    // Good: structured responses with clear sections
    if (/\d+\.|•|-|\n\n/.test(response)) formatScore += 0.3;
    
    // Good: code in proper blocks
    if (/```[\s\S]*?```/.test(response)) formatScore += 0.3;
    
    // Good: reasonable length (not too short/long)
    if (response.length > 100 && response.length < 2000) formatScore += 0.4;
  });
  
  return result.artifacts.length > 0 ? Math.min(1, formatScore / result.artifacts.length) : 0.5;
}

function calculateSafety(result: SessionResult): number {
  // Check for unsafe code patterns or suggestions
  let unsafePatterns = 0;
  let totalResponses = 0;
  
  result.artifacts.forEach(artifact => {
    totalResponses++;
    const response = artifact.response.toLowerCase();
    
    // Flag potentially unsafe patterns
    if (response.includes('eval(') || response.includes('exec(')) unsafePatterns++;
    if (response.includes('sql injection') && !response.includes('prevent')) unsafePatterns++;
    if (response.includes('password') && response.includes('plain')) unsafePatterns++;
  });
  
  return totalResponses > 0 ? Math.max(0.2, 1 - (unsafePatterns / totalResponses)) : 1.0;
}

// New deep-specific scoring functions
function calculateMemoryRetention(result: SessionResult): number {
  const extract = (t: string) => new Set(
    t.toLowerCase().split('\n').map(s => s.trim())
     .filter(s => /will|must|should|expires|limit|role|header|endpoint/.test(s))
     .map(s => s.replace(/\s+/g, ' '))
  );
  if (result.artifacts.length < 2) return 0.7;
  const first = extract(result.artifacts[0].response || '');
  let sum = 0, cnt = 0;
  for (let i = 1; i < result.artifacts.length; i++) {
    const later = extract(result.artifacts[i].response);
    let ok = 0;
    first.forEach(c => { if ([...later].some(x => x.includes(c.slice(0, 30)))) ok++; });
    sum += first.size ? ok / first.size : 0.7;
    cnt++;
  }
  return Math.max(0, Math.min(1, sum / (cnt || 1)));
}

function calculateHallucinationRate(result: SessionResult, task: DeepTask): number {
  // Detect potential hallucinations (inverted - lower rate is better)
  let hallucinationCount = 0;
  let totalChecks = 0;
  
  result.artifacts.forEach(artifact => {
    const response = artifact.response;
    totalChecks++;
    
    // Simple heuristics for detecting potential hallucinations
    if (task.resources?.document) {
      // For doc tasks, check if answers contain info not in the document
      const doc = task.resources.document.toLowerCase();
      const words = response.toLowerCase().split(/\s+/);
      const suspiciousWords = words.filter(word => 
        word.length > 4 && 
        /^[a-z]+$/.test(word) && 
        !doc.includes(word)
      );
      if (suspiciousWords.length > 10) hallucinationCount++; // Too many terms not in doc
    }
    
    // Check for common hallucination patterns
    if (/api\.example\.|fake-|test-|sample-/.test(response)) hallucinationCount++;
    if (response.includes('http://localhost') && !task.slug.includes('spec')) hallucinationCount++;
  });
  
  const hallucinationRate = totalChecks > 0 ? hallucinationCount / totalChecks : 0;
  return Math.max(0, 1 - hallucinationRate); // Invert: lower rate = higher score
}

function calculatePlanCoherence(result: SessionResult, task: DeepTask): number {
  if (result.artifacts.length < 2) return 0.8;
  
  // Check consistency of approach across turns
  let coherenceScore = 0;
  
  for (let i = 1; i < result.artifacts.length; i++) {
    const prevResponse = result.artifacts[i - 1].response;
    const currentResponse = result.artifacts[i].response;
    
    // Look for consistent terminology and approach
    const prevTerms = extractKeyTerms(prevResponse);
    const currentTerms = extractKeyTerms(currentResponse);
    
    if (prevTerms.length > 0) {
      const consistentTerms = prevTerms.filter(term => currentTerms.includes(term)).length;
      coherenceScore += consistentTerms / prevTerms.length;
    } else {
      coherenceScore += 0.5; // Neutral score if no terms to compare
    }
  }
  
  return coherenceScore / (result.artifacts.length - 1);
}

function calculateContextWindow(result: SessionResult, task: DeepTask): number {
  // Quality under long context: success rate discounted by growth in turns
  const success = calculateCorrectness(result);
  const turns = Math.max(1, result.artifacts.length);
  const penalty = Math.min(0.3, Math.log10(turns) / 5); // Tiny penalty as turns grow
  return Math.max(0, Math.min(1, success * (1 - penalty)));
}

function extractKeyTerms(text: string): string[] {
  // Extract meaningful terms (simplified)
  const words = text.toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(word => word.length > 3 && !/^\d+$/.test(word));
  
  // Remove common words
  const commonWords = new Set(['this', 'that', 'with', 'have', 'will', 'from', 'they', 'been', 'were', 'said', 'each', 'which', 'their', 'time', 'about', 'would', 'there', 'could', 'other', 'more', 'very', 'what', 'know', 'just', 'first', 'into', 'over', 'think', 'also', 'your', 'work', 'life', 'only', 'can', 'still', 'should', 'after', 'being', 'now', 'made', 'before', 'here', 'through', 'when', 'where', 'much', 'some', 'these', 'well', 'were']);
  
  return [...new Set(words.filter(word => !commonWords.has(word)))].slice(0, 10);
}

async function storeDeepSession(
  model: ModelInfo,
  result: SessionResult,
  finalScore: number,
  batchTimestamp: string
): Promise<void> {
  try {
    await db.insert(deep_sessions).values({
      modelId: model.id,
      taskSlug: result.taskSlug,
      ts: batchTimestamp,
      turns: result.turns,
      totalLatencyMs: result.totalLatencyMs,
      totalTokensIn: result.totalTokensIn,
      totalTokensOut: result.totalTokensOut,
      passed: result.passed,
      conversationData: result.conversation,
      stepResults: result.artifacts,
      finalScore
    });
    
    console.log(`  💾 Stored session data for ${model.name}`);
  } catch (error) {
    console.error(`  ❌ Failed to store session for ${model.name}: ${String(error).slice(0, 100)}`);
  }
}

async function checkForAlerts(
  model: ModelInfo,
  currentScore: number, 
  result: SessionResult
): Promise<void> {
  try {
    // Get recent deep scores for baseline comparison
    const recentSessions = await db.select()
      .from(deep_sessions)
      .where(eq(deep_sessions.modelId, model.id))
      .orderBy(desc(deep_sessions.ts))
      .limit(10);
    
    if (recentSessions.length < 3) return; // Need some history for comparison
    
    const recentScores = recentSessions.map(s => s.finalScore);
    const baseline = recentScores.slice(1).reduce((s, sc) => s + sc, 0) / (recentScores.length - 1);
    const drop = baseline - currentScore;
    
    // Generate alerts based on score drops
    let alertLevel: 'warning' | 'critical' | null = null;
    let message = '';
    
    if (drop >= 20) {
      alertLevel = 'critical';
      message = `Severe performance drop: ${currentScore} vs ${baseline.toFixed(1)} baseline (${drop.toFixed(1)} point drop)`;
    } else if (drop >= 10) {
      alertLevel = 'warning';
      message = `Performance degradation: ${currentScore} vs ${baseline.toFixed(1)} baseline (${drop.toFixed(1)} point drop)`;
    }
    
    // Check for specific deep failure patterns
    const failedTurns = result.artifacts.filter(a => a.evaluation && !a.evaluation.passed).length;
    const failureRate = result.artifacts.length > 0 ? failedTurns / result.artifacts.length : 0;
    
    if (failureRate > 0.5) {
      alertLevel = 'critical';
      message = `High failure rate in deep session: ${(failureRate * 100).toFixed(1)}% of turns failed`;
    }
    
    if (alertLevel) {
      await db.insert(deep_alerts).values({
        modelId: model.id,
        ts: new Date().toISOString(),
        level: alertLevel,
        message,
        context: {
          taskSlug: result.taskSlug,
          currentScore,
          baseline: baseline.toFixed(1),
          drop: drop.toFixed(1),
          failureRate: (failureRate * 100).toFixed(1),
          turns: result.turns
        }
      });
      
      console.log(`🚨 ${alertLevel.toUpperCase()} alert generated for ${model.name}: ${message}`);
    }
    
  } catch (error) {
    console.error(`Failed to check alerts for ${model.name}: ${String(error).slice(0, 100)}`);
  }
}

export async function runDeepBenchmarks(): Promise<void> {
  if (isDeepBenchmarkRunning) {
    console.log('⏸️ Deep benchmark already running, skipping...');
    return;
  }
  
  isDeepBenchmarkRunning = true;
  deepBenchmarkProgress = {
    currentModel: null,
    completedModels: 0,
    totalModels: 0,
    startTime: new Date(),
    errors: []
  };
  
  try {
    console.log('🏗️ Starting daily deep benchmark sweep...');
    
    // Get only whitelisted models from database (show_in_rankings = true)
    const allModels = await db.select().from(models).where(eq(models.showInRankings, true));
    console.log(`📊 Found ${allModels.length} whitelisted models in database`);
    
    // Filter for supported providers
    const supportedProviders: Provider[] = ['openai', 'anthropic', 'google', 'xai'];
    const deepModels = allModels.filter(m => 
      supportedProviders.includes(m.vendor as Provider)
    ) as Array<ModelInfo>;
    
    console.log(`🎯 ${deepModels.length} models support deep benchmarking`);
    
    if (deepModels.length === 0) {
      console.log('⚠️ No supported models found for deep benchmarking');
      return;
    }
    
    deepBenchmarkProgress.totalModels = deepModels.length;
    const batchTimestamp = new Date().toISOString();
    
    // Select today's task
    const selectedTask = selectDailyTask();
    console.log(`📋 Today's task: ${selectedTask.slug} - ${selectedTask.description}`);
    
    // Run deep benchmarks on all supported models
    for (let i = 0; i < deepModels.length; i++) {
      const model = deepModels[i];
      
      try {
        await benchmarkModelDeep(model, selectedTask, batchTimestamp);
        deepBenchmarkProgress.completedModels++;
        
        // Add delay between models to respect rate limits
        if (i < deepModels.length - 1) {
          console.log('⏸️ Pausing 5s between models...');
          await new Promise(resolve => setTimeout(resolve, 5000));
        }
        
      } catch (error) {
        console.error(`Model ${model.name} failed: ${String(error).slice(0, 100)}`);
        deepBenchmarkProgress.errors.push(`${model.name}: ${String(error)}`);
        deepBenchmarkProgress.completedModels++; // Still count as "completed"
      }
    }
    
    const duration = Date.now() - (deepBenchmarkProgress.startTime?.getTime() || Date.now());
    console.log(`✅ Deep benchmark sweep completed in ${Math.round(duration / 1000)}s`);
    console.log(`📊 Processed ${deepBenchmarkProgress.completedModels}/${deepBenchmarkProgress.totalModels} models`);
    
    if (deepBenchmarkProgress.errors.length > 0) {
      console.log(`⚠️ ${deepBenchmarkProgress.errors.length} errors encountered:`);
      deepBenchmarkProgress.errors.forEach(err => console.log(`  - ${err.slice(0, 100)}`));
    }
    
    // AUTOMATIC CACHE REFRESH: Refresh frontend cache after deep benchmark completion
    if (refreshAllCache) {
      try {
        console.log('🔄 Refreshing frontend cache with fresh deep benchmark data...');
        const cacheResult = await refreshAllCache();
        console.log(`✅ Cache refreshed successfully: ${cacheResult.refreshed || 0} combinations updated`);
      } catch (cacheError) {
        console.warn('⚠️ Cache refresh failed after deep benchmarks:', String(cacheError).slice(0, 200));
        // Don't fail the entire benchmark if cache refresh fails
      }
    } else {
      console.log('⚠️ Cache refresh not available - frontend may not show updated scores immediately');
    }

    // AUTOMATIC ROUTER CACHE INVALIDATION: Invalidate router cache after deep benchmark completion
    try {
      const { invalidateRouterCache } = await import('../router/selector');
      invalidateRouterCache('deep'); // Invalidate deep suite cache
      console.log('🗑️ Router cache invalidated for deep suite');
    } catch (routerCacheError) {
      console.warn('⚠️ Router cache invalidation failed:', String(routerCacheError).slice(0, 200));
      // Don't fail the entire benchmark if router cache invalidation fails
    }
    
  } catch (error) {
    console.error('❌ Deep benchmark sweep failed:', error);
    throw error;
  } finally {
    isDeepBenchmarkRunning = false;
    deepBenchmarkProgress.currentModel = null;
  }
}
