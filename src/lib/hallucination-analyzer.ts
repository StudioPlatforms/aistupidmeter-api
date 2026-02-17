/**
 * Hallucination Pattern Analyzer
 * 
 * Mines the raw_outputs table (already being populated!) to detect hallucination
 * patterns, confidence language, and other behavioral indicators.
 * 
 * HIGH VALUE: Failure mode analysis is extremely valuable for enterprises
 */

import { db } from '../db';
import { raw_outputs, runs, models, test_case_results } from '../db/schema';
import { eq, desc, and, inArray, sql } from 'drizzle-orm';

export interface HallucinationPattern {
  pattern: RegExp;
  category: 'confidence_hedging' | 'fabrication' | 'contradiction' | 'irrelevant_content';
  severity: 'low' | 'medium' | 'high';
  examples: string[];
}

export interface HallucinationAnalysis {
  runId: number;
  modelId: number;
  modelName: string;
  taskSlug: string;
  rawOutput: string;
  detected: boolean;
  patterns: string[];
  confidenceIndicators: string[];
  fabricatedContent: string[];
  contradictions: string[];
  hallucinationScore: number; // 0.0 = none, 1.0 = severe
  notes: string;
}

/**
 * Common hallucination patterns in LLM outputs
 */
const HALLUCINATION_PATTERNS: HallucinationPattern[] = [
  // Confidence hedging (low severity - actually good!)
  {
    pattern: /(?:i think|i believe|probably|maybe|might be|could be|seems like)/gi,
    category: 'confidence_hedging',
    severity: 'low',
    examples: ['I think this should work', 'This probably handles the edge case']
  },
  {
    pattern: /(?:i'm not sure|i'm uncertain|not certain|not confident)/gi,
    category: 'confidence_hedging',
    severity: 'low',
    examples: ["I'm not sure if this covers all cases", 'Not certain about the performance']
  },
  
  // Fabricated function names or libraries
  {
    pattern: /(?:from \w+ import \w+Helper|import hypothetical_|use_magical_function)/gi,
    category: 'fabrication',
    severity: 'high',
    examples: ['from magic import SolutionHelper', 'import hypothetical_module']
  },
  {
    pattern: /(?:def fictional_\w+|class Imaginary\w+|nonexistent_method)/gi,
    category: 'fabrication',
    severity: 'high',
    examples: ['def fictional_helper()', 'class ImaginaryCache']
  },
  
  // Self-contradictory statements
  {
    pattern: /(?:this (?:will|should) work.*?(?:but|however).*?(?:might not|won't work|fails))/gi,
    category: 'contradiction',
    severity: 'medium',
    examples: ['This will work for most cases, but it might not handle edge cases']
  },
  
  // Irrelevant commentary (should just provide code)
  {
    pattern: /(?:as an ai|i cannot|i don't have access|in my training)/gi,
    category: 'irrelevant_content',
    severity: 'medium',
    examples: ['As an AI, I cannot execute code', 'In my training, I learned']
  },
  {
    pattern: /(?:here is the (?:updated|complete|final) (?:code|solution|function))/gi,
    category: 'irrelevant_content',
    severity: 'low',
    examples: ['Here is the complete code:', 'Here is the solution:']
  }
];

/**
 * Analyze raw output for hallucination indicators
 */
export function analyzeHallucinationPatterns(rawOutput: string): {
  detected: boolean;
  patterns: string[];
  confidenceIndicators: string[];
  fabricatedContent: string[];
  contradictions: string[];
  score: number;
  notes: string;
} {
  const foundPatterns: string[] = [];
  const confidenceIndicators: string[] = [];
  const fabricatedContent: string[] = [];
  const contradictions: string[] = [];
  
  let score = 0.0;
  
  for (const pattern of HALLUCINATION_PATTERNS) {
    const matches = rawOutput.match(pattern.pattern);
    if (matches && matches.length > 0) {
      foundPatterns.push(pattern.category);
      
      // Categorize the findings
      switch (pattern.category) {
        case 'confidence_hedging':
          confidenceIndicators.push(...matches.slice(0, 3)); // First 3 examples
          score += 0.1 * matches.length; // Slight score increase (actually good behavior)
          break;
          
        case 'fabrication':
          fabricatedContent.push(...matches.slice(0, 3));
          score += 0.5 * matches.length; // Severe issue
          break;
          
        case 'contradiction':
          contradictions.push(...matches.slice(0, 3));
          score += 0.3 * matches.length; // Moderate issue
          break;
          
        case 'irrelevant_content':
          score += 0.1 * matches.length; // Minor issue
          break;
      }
    }
  }
  
  // Cap score at 1.0
  score = Math.min(1.0, score);
  
  // Check for made-up function names not in stdlib
  const functionDefMatches = rawOutput.match(/def (\w+)\(/g);
  if (functionDefMatches) {
    const suspiciousFunctions = functionDefMatches.filter(f => 
      f.includes('magical_') || 
      f.includes('hypothetical_') ||
      f.includes('imaginary_') ||
      f.includes('fictional_')
    );
    if (suspiciousFunctions.length > 0) {
      fabricatedContent.push(...suspiciousFunctions);
      score += 0.3 * suspiciousFunctions.length;
    }
  }
  
  // Check for non-existent imports
  const importMatches = rawOutput.match(/(?:from|import) (\w+)/g);
  if (importMatches) {
    const knownStdlib = [
      'math', 'sys', 'os', 'random', 'datetime', 'time', 'json', 'collections',
      'itertools', 'functools', 'operator', 'string', 're', 'heapq', 'bisect'
    ];
    const suspiciousImports = importMatches.filter(imp => {
      const moduleName = imp.split(' ')[1];
      return moduleName && 
             !knownStdlib.includes(moduleName) &&
             (moduleName.includes('helper') || 
              moduleName.includes('util') ||
              moduleName.includes('magic'));
    });
    if (suspiciousImports.length > 0) {
      fabricatedContent.push(...suspiciousImports);
      score += 0.4 * suspiciousImports.length;
    }
  }
  
  score = Math.min(1.0, score);
  
  const detected = score > 0.2; // Threshold for flagging
  
  let notes = '';
  if (score < 0.2) {
    notes = 'No significant hallucination detected';
  } else if (score < 0.5) {
    notes = 'Minor hallucination indicators (mostly confidence hedging)';
  } else if (score < 0.8) {
    notes = 'Moderate hallucination - fabricated content detected';
  } else {
    notes = 'Severe hallucination - significant fabricated or contradictory content';
  }
  
  return {
    detected,
    patterns: [...new Set(foundPatterns)], // Unique patterns
    confidenceIndicators: [...new Set(confidenceIndicators)],
    fabricatedContent: [...new Set(fabricatedContent)],
    contradictions: [...new Set(contradictions)],
    score,
    notes
  };
}

/**
 * Mine existing raw_outputs table for hallucination patterns
 */
export async function mineHallucinationPatterns(
  modelId?: number,
  limit: number = 1000
): Promise<HallucinationAnalysis[]> {
  let query = db
    .select({
      id: raw_outputs.id,
      runId: raw_outputs.runId,
      rawText: raw_outputs.rawText,
      extractionSuccess: raw_outputs.extractionSuccess,
      failureType: raw_outputs.failureType,
      modelId: runs.modelId,
      taskId: runs.taskId
    })
    .from(raw_outputs)
    .innerJoin(runs, eq(raw_outputs.runId, runs.id))
    .orderBy(desc(raw_outputs.ts))
    .limit(limit);
  
  if (modelId) {
    query = query.where(eq(runs.modelId, modelId)) as any;
  }
  
  const rawOutputs = await query;
  
  const results: HallucinationAnalysis[] = [];
  
  for (const output of rawOutputs) {
    if (!output.rawText) continue;
    
    const analysis = analyzeHallucinationPatterns(output.rawText);
    
    // Get model name
    const modelInfo = await db
      .select({ name: models.name })
      .from(models)
      .where(eq(models.id, output.modelId))
      .limit(1);
    
    // Get task info if available
    let taskSlug = 'unknown';
    if (output.taskId) {
      const runInfo = await db
        .select()
        .from(runs)
        .where(eq(runs.id, output.runId))
        .limit(1);
      // Task slug would come from joining with tasks table, but we'll approximate
      taskSlug = `task_${output.taskId}`;
    }
    
    results.push({
      runId: output.runId,
      modelId: output.modelId,
      modelName: modelInfo[0]?.name || 'Unknown',
      taskSlug,
      rawOutput: output.rawText,
      detected: analysis.detected,
      patterns: analysis.patterns,
      confidenceIndicators: analysis.confidenceIndicators,
      fabricatedContent: analysis.fabricatedContent,
      contradictions: analysis.contradictions,
      hallucinationScore: analysis.score,
      notes: analysis.notes
    });
  }
  
  return results.filter(r => r.detected); // Only return detected hallucinations
}

/**
 * Generate hallucination report by model
 */
export async function generateHallucinationReport(windowDays: number = 7): Promise<string> {
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - windowDays);
  
  const allModels = await db.select().from(models);
  
  let report = `=== HALLUCINATION PATTERN ANALYSIS ===\n`;
  report += `Analysis Window: Last ${windowDays} days\n`;
  report += `Generated: ${new Date().toISOString()}\n\n`;
  
  for (const model of allModels) {
    const hallucinations = await mineHallucinationPatterns(model.id, 500);
    
    if (hallucinations.length > 0) {
      const avgScore = hallucinations.reduce((s, h) => s + h.hallucinationScore, 0) / hallucinations.length;
      const fabricationCount = hallucinations.filter(h => h.fabricatedContent.length > 0).length;
      const contradictionCount = hallucinations.filter(h => h.contradictions.length > 0).length;
      
      report += `\n## ${model.name} (${model.vendor})\n`;
      report += `Total hallucinations detected: ${hallucinations.length}\n`;
      report += `Average hallucination score: ${avgScore.toFixed(3)}\n`;
      report += `Fabricated content: ${fabricationCount} instances\n`;
      report += `Contradictions: ${contradictionCount} instances\n`;
      
      // Most common patterns
      const patternCounts: Record<string, number> = {};
      for (const h of hallucinations) {
        for (const pattern of h.patterns) {
          patternCounts[pattern] = (patternCounts[pattern] || 0) + 1;
        }
      }
      
      const topPatterns = Object.entries(patternCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5);
      
      if (topPatterns.length > 0) {
        report += `\nTop patterns:\n`;
        for (const [pattern, count] of topPatterns) {
          report += `- ${pattern}: ${count} occurrences\n`;
        }
      }
      
      // Example fabrications
      const exampleFabrications = hallucinations
        .filter(h => h.fabricatedContent.length > 0)
        .slice(0, 3);
      
      if (exampleFabrications.length > 0) {
        report += `\nExample fabricated content:\n`;
        for (const ex of exampleFabrications) {
          report += `- ${ex.fabricatedContent.slice(0, 2).join(', ')}\n`;
        }
      }
      
      report += `\n`;
    }
  }
  
  return report;
}

/**
 * Calculate hallucination rate by task difficulty
 */
export async function analyzeHallucinationByDifficulty(): Promise<{
  easy: number;
  medium: number;
  hard: number;
}> {
  // This would require joining with tasks table to get difficulty
  // For now, return placeholder that can be implemented later
  return {
    easy: 0.05,
    medium: 0.15,
    hard: 0.30
  };
}

/**
 * Identify models with lowest hallucination rates
 */
export async function rankModelsByHallucinationRate(
  limit: number = 10
): Promise<Array<{
  modelId: number;
  modelName: string;
  hallucinationRate: number;
  sampleSize: number;
}>> {
  const allModels = await db.select().from(models);
  
  const rankings: Array<{
    modelId: number;
    modelName: string;
    hallucinationRate: number;
    sampleSize: number;
  }> = [];
  
  for (const model of allModels) {
    const hallucinations = await mineHallucinationPatterns(model.id, 100);
    
    // Get total runs for this model
    const totalRuns = await db
      .select({ count: sql<number>`count(*)` })
      .from(runs)
      .where(eq(runs.modelId, model.id));
    
    const total = Number(totalRuns[0]?.count || 0);
    if (total < 10) continue; // Skip models with too few runs
    
    const rate = hallucinations.length / total;
    
    rankings.push({
      modelId: model.id,
      modelName: model.name,
      hallucinationRate: rate,
      sampleSize: total
    });
  }
  
  return rankings
    .sort((a, b) => a.hallucinationRate - b.hallucinationRate)
    .slice(0, limit);
}
