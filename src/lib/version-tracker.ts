/**
 * Version Tracker & Analyzer
 * 
 * Extracts model version information from response headers and correlates
 * with performance changes. This is HIGH VALUE data for tracking regressions.
 * 
 * Strategy: Mine existing responseHeaders field in runs table (already captured!)
 */

import { db } from '../db';
import { runs, models, scores } from '../db/schema';
import { eq, desc, and, gte, sql } from 'drizzle-orm';

export interface ModelVersionInfo {
  modelId: number;
  modelName: string;
  provider: string;
  detectedVersion: string;
  versionSource: 'header' | 'fingerprint' | 'inferred';
  firstSeenAt: string;
  lastSeenAt: string;
  runCount: number;
  averageScore: number;
  confidence: number; // 0.0-1.0
}

export interface VersionChange {
  modelId: number;
  modelName: string;
  oldVersion: string | null;
  newVersion: string;
  detectedAt: string;
  scoreBefore: number;
  scoreAfter: number;
  scoreDelta: number;
  significance: number; // How many standard deviations
  changeType: 'improvement' | 'degradation' | 'neutral';
}

/**
 * Extract version info from response headers
 */
export function extractVersionFromHeaders(headers: Record<string, string> | null): {
  version: string | null;
  confidence: number;
  source: string;
} {
  if (!headers) return { version: null, confidence: 0, source: 'none' };
  
  // Normalize header keys to lowercase
  const normalizedHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    normalizedHeaders[key.toLowerCase()] = value;
  }
  
  // OpenAI version headers
  if (normalizedHeaders['openai-version']) {
    return {
      version: normalizedHeaders['openai-version'],
      confidence: 1.0,
      source: 'openai-version'
    };
  }
  
  // X-Request-ID can sometimes contain version info
  if (normalizedHeaders['x-request-id']) {
    const requestId = normalizedHeaders['x-request-id'];
    // Some providers include version in request ID format
    const versionMatch = requestId.match(/v(\d+\.\d+)/i);
    if (versionMatch) {
      return {
        version: versionMatch[1],
        confidence: 0.7,
        source: 'x-request-id'
      };
    }
  }
  
  // Anthropic version headers
  if (normalizedHeaders['anthropic-version'] || normalizedHeaders['x-anthropic-version']) {
    return {
      version: normalizedHeaders['anthropic-version'] || normalizedHeaders['x-anthropic-version'],
      confidence: 1.0,
      source: 'anthropic-version'
    };
  }
  
  // Google API version
  if (normalizedHeaders['x-goog-api-version']) {
    return {
      version: normalizedHeaders['x-goog-api-version'],
      confidence: 1.0,
      source: 'x-goog-api-version'
    };
  }
  
  // Server/API headers that might indicate version
  if (normalizedHeaders['server']) {
    const server = normalizedHeaders['server'];
    const versionMatch = server.match(/(\d+\.\d+\.\d+)/);
    if (versionMatch) {
      return {
        version: versionMatch[1],
        confidence: 0.5,
        source: 'server'
      };
    }
  }
  
  // Model fingerprint as fallback
  if (normalizedHeaders['x-model-fingerprint'] || normalizedHeaders['model-fingerprint']) {
    return {
      version: (normalizedHeaders['x-model-fingerprint'] || normalizedHeaders['model-fingerprint']).slice(0, 16),
      confidence: 0.8,
      source: 'fingerprint'
    };
  }
  
  return { version: null, confidence: 0, source: 'none' };
}

/**
 * Mine existing runs table for version information
 */
export async function mineVersionHistory(modelId: number, limit: number = 1000): Promise<ModelVersionInfo[]> {
  const runsData = await db
    .select({
      id: runs.id,
      ts: runs.ts,
      responseHeaders: runs.responseHeaders,
      modelFingerprint: runs.modelFingerprint
    })
    .from(runs)
    .where(eq(runs.modelId, modelId))
    .orderBy(desc(runs.ts))
    .limit(limit);
  
  // Group by detected version
  const versionMap = new Map<string, {
    firstSeen: string;
    lastSeen: string;
    runIds: number[];
    scores: number[];
    confidence: number;
    source: string;
  }>();
  
  for (const run of runsData) {
    const extracted = extractVersionFromHeaders(run.responseHeaders);
    
    let versionKey = extracted.version || run.modelFingerprint || 'unknown';
    if (!extracted.version && run.modelFingerprint) {
      versionKey = `fp:${run.modelFingerprint.slice(0, 12)}`;
    }
    
    if (!versionMap.has(versionKey)) {
      versionMap.set(versionKey, {
        firstSeen: run.ts || '',
        lastSeen: run.ts || '',
        runIds: [],
        scores: [],
        confidence: extracted.confidence,
        source: extracted.source
      });
    }
    
    const versionInfo = versionMap.get(versionKey)!;
    versionInfo.runIds.push(run.id);
    if (run.ts) {
      if (run.ts < versionInfo.firstSeen) versionInfo.firstSeen = run.ts;
      if (run.ts > versionInfo.lastSeen) versionInfo.lastSeen = run.ts;
    }
  }
  
  // Get model info
  const modelInfo = await db
    .select()
    .from(models)
    .where(eq(models.id, modelId))
    .limit(1);
  
  if (modelInfo.length === 0) return [];
  
  // Convert to ModelVersionInfo array
  const results: ModelVersionInfo[] = [];
  
  for (const [version, info] of versionMap.entries()) {
    // Get average score for this version
    const versionScores = await db
      .select({ score: scores.stupidScore })
      .from(scores)
      .where(
        and(
          eq(scores.modelId, modelId),
          gte(scores.ts, info.firstSeen),
          sql`${scores.ts} <= ${info.lastSeen}`
        )
      );
    
    const avgScore = versionScores.length > 0
      ? versionScores.reduce((sum, s) => sum + s.score, 0) / versionScores.length
      : 0;
    
    results.push({
      modelId,
      modelName: modelInfo[0].name,
      provider: modelInfo[0].vendor,
      detectedVersion: version,
      versionSource: info.source === 'fingerprint' ? 'fingerprint' : info.confidence === 1.0 ? 'header' : 'inferred',
      firstSeenAt: info.firstSeen,
      lastSeenAt: info.lastSeen,
      runCount: info.runIds.length,
      averageScore: avgScore,
      confidence: info.confidence
    });
  }
  
  return results.sort((a, b) => b.firstSeenAt.localeCompare(a.firstSeenAt));
}

/**
 * Detect version changes by analyzing timestamp gaps and score changes
 */
export async function detectVersionChanges(modelId: number, windowDays: number = 30): Promise<VersionChange[]> {
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - windowDays);
  const startTs = startDate.toISOString();
  
  // Get all scores in the window
  const scoreHistory = await db
    .select({
      ts: scores.ts,
      score: scores.stupidScore
    })
    .from(scores)
    .where(
      and(
        eq(scores.modelId, modelId),
        gte(scores.ts, startTs)
      )
    )
    .orderBy(scores.ts);
  
  if (scoreHistory.length < 10) return []; // Need enough data
  
  const changes: VersionChange[] = [];
  
  // Sliding window to detect significant changes
  const windowSize = 5;
  for (let i = windowSize; i < scoreHistory.length - windowSize; i++) {
    const beforeWindow = scoreHistory.slice(i - windowSize, i);
    const afterWindow = scoreHistory.slice(i, i + windowSize);
    
    const beforeAvg = beforeWindow.reduce((s, x) => s + x.score, 0) / beforeWindow.length;
    const afterAvg = afterWindow.reduce((s, x) => s + x.score, 0) / afterWindow.length;
    
    const beforeStd = Math.sqrt(
      beforeWindow.reduce((s, x) => s + Math.pow(x.score - beforeAvg, 2), 0) / beforeWindow.length
    );
    
    const delta = afterAvg - beforeAvg;
    const significance = beforeStd > 0 ? Math.abs(delta) / beforeStd : 0;
    
    // Flag if change is >2 standard deviations
    if (significance > 2.0) {
      // Try to get version info at this point
      const versionHistory = await mineVersionHistory(modelId, 100);
      const changeTime = scoreHistory[i].ts || '';
      
      // Find versions around this time
      const versionsBeforeChange = versionHistory.filter(v => v.lastSeenAt < changeTime);
      const versionsAfterChange = versionHistory.filter(v => v.firstSeenAt >= changeTime);
      
      const oldVersion = versionsBeforeChange.length > 0 ? versionsBeforeChange[0].detectedVersion : null;
      const newVersion = versionsAfterChange.length > 0 ? versionsAfterChange[0].detectedVersion : 'unknown';
      
      // Get model name
      const modelInfo = await db.select().from(models).where(eq(models.id, modelId)).limit(1);
      
      changes.push({
        modelId,
        modelName: modelInfo[0]?.name || 'Unknown',
        oldVersion,
        newVersion,
        detectedAt: changeTime,
        scoreBefore: beforeAvg,
        scoreAfter: afterAvg,
        scoreDelta: delta,
        significance,
        changeType: delta > 0 ? 'improvement' : delta < -1 ? 'degradation' : 'neutral'
      });
    }
  }
  
  return changes;
}

/**
 * Generate version change report for all models
 */
export async function generateVersionChangeReport(windowDays: number = 30): Promise<string> {
  const allModels = await db.select().from(models);
  
  let report = `=== MODEL VERSION CHANGE REPORT ===\n`;
  report += `Analysis Window: Last ${windowDays} days\n`;
  report += `Generated: ${new Date().toISOString()}\n\n`;
  
  for (const model of allModels) {
    const changes = await detectVersionChanges(model.id, windowDays);
    
    if (changes.length > 0) {
      report += `\n## ${model.name} (${model.vendor})\n`;
      report += `Version changes detected: ${changes.length}\n\n`;
      
      for (const change of changes) {
        report += `### Change at ${change.detectedAt}\n`;
        report += `- Old version: ${change.oldVersion || 'unknown'}\n`;
        report += `- New version: ${change.newVersion}\n`;
        report += `- Score change: ${change.scoreBefore.toFixed(1)} → ${change.scoreAfter.toFixed(1)} (${change.scoreDelta > 0 ? '+' : ''}${change.scoreDelta.toFixed(1)})\n`;
        report += `- Significance: ${change.significance.toFixed(2)}σ\n`;
        report += `- Type: ${change.changeType.toUpperCase()}\n\n`;
      }
    }
  }
  
  if (report === `=== MODEL VERSION CHANGE REPORT ===\nAnalysis Window: Last ${windowDays} days\nGenerated: ${new Date().toISOString()}\n\n`) {
    report += `No significant version changes detected in the analysis window.\n`;
  }
  
  return report;
}

/**
 * Build version genealogy (timeline of versions)
 */
export async function buildVersionGenealogy(modelId: number): Promise<{
  modelName: string;
  versions: Array<{
    version: string;
    period: { start: string; end: string };
    runCount: number;
    avgScore: number;
    confidence: number;
  }>;
}> {
  const versionHistory = await mineVersionHistory(modelId);
  
  const modelInfo = await db.select().from(models).where(eq(models.id, modelId)).limit(1);
  
  return {
    modelName: modelInfo[0]?.name || 'Unknown',
    versions: versionHistory.map(v => ({
      version: v.detectedVersion,
      period: { start: v.firstSeenAt, end: v.lastSeenAt },
      runCount: v.runCount,
      avgScore: v.averageScore,
      confidence: v.confidence
    }))
  };
}
