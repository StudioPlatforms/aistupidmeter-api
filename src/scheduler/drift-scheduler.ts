/**
 * PRODUCTION-READY: Drift Signature Pre-computation Scheduler
 * Runs hourly to warm cache and prevent cold-start delays
 */

import { cache } from '../cache/redis-cache';
import { db } from '../db';
import { models, change_points } from '../db/schema';
import { sql, eq, and, gte } from 'drizzle-orm';
import { computeDriftSignature } from '../lib/drift-detection';
import { detectVersionChanges } from '../lib/version-tracker';

let schedulerInterval: NodeJS.Timeout | null = null;
let isRunning = false;

/**
 * Record a detected version-change event as a change_point row.
 * Called only for models already showing WARNING/ALERT drift — avoids
 * running the expensive version-mining query for every stable model.
 */
async function recordVersionChangePoints(modelId: number, modelName: string): Promise<void> {
  try {
    const changes = await detectVersionChanges(modelId, 7);

    for (const change of changes) {
      if (change.significance < 2.5) continue;

      // Deduplicate: skip if we already recorded a change_point at this exact timestamp.
      const existing = await db
        .select({ id: change_points.id })
        .from(change_points)
        .where(
          and(
            eq(change_points.model_id, modelId),
            gte(change_points.detected_at, new Date(new Date(change.detectedAt).getTime() - 3600_000).toISOString()),
            sql`${change_points.detected_at} <= ${new Date(new Date(change.detectedAt).getTime() + 3600_000).toISOString()}`
          )
        )
        .limit(1);

      if (existing.length > 0) continue;

      const hasVersionSwap =
        change.oldVersion !== null &&
        change.newVersion !== 'unknown' &&
        change.oldVersion !== change.newVersion;

      await db.insert(change_points).values({
        model_id: modelId,
        detected_at: change.detectedAt || new Date().toISOString(),
        from_score: change.scoreBefore,
        to_score: change.scoreAfter,
        delta: change.scoreDelta,
        significance: change.significance,
        change_type: change.changeType === 'improvement' ? 'improvement'
          : change.changeType === 'degradation' ? 'degradation'
          : 'shift',
        suspected_cause: hasVersionSwap ? 'model_update' : 'unknown',
        notes: JSON.stringify({
          oldVersion: change.oldVersion,
          newVersion: change.newVersion,
          autoDetected: true,
          detectionSource: 'version_tracker'
        })
      });

      const versionNote = hasVersionSwap
        ? ` — version swap: ${change.oldVersion} → ${change.newVersion}`
        : '';
      console.log(`📍 change_point recorded for ${modelName}: ${change.changeType} ${change.significance.toFixed(1)}σ${versionNote}`);
    }
  } catch (err) {
    console.error(`❌ Version-change detection failed for ${modelName}:`, err);
  }
}

/**
 * Pre-compute drift signatures for all models
 * This prevents cold-cache performance issues
 */
async function precomputeAllDriftSignatures(): Promise<void> {
  if (isRunning) {
    console.log('⏸️ Drift pre-computation already running, skipping...');
    return;
  }
  
  isRunning = true;
  const startTime = Date.now();
  console.log('🔄 Starting drift signature pre-computation...');
  
  try {
    // Get all active models
    const allModels = await db
      .select()
      .from(models)
      .where(sql`show_in_rankings = 1`);
    
    let successCount = 0;
    let errorCount = 0;
    const errors: string[] = [];
    
    // Process models sequentially to avoid CPU overload
    for (const model of allModels) {
      try {
        const signature = await computeDriftSignature(model.id);
        
        // Cache with staggered TTL (3600-3900 seconds)
        const cacheKey = `drift:signature:${model.id}`;
        const ttl = 3600 + (model.id % 300);
        await cache.set(cacheKey, JSON.stringify(signature), ttl);

        // A4: When drift is elevated, check if a silent model version swap explains it.
        // Only runs on WARNING/ALERT models to avoid unnecessary DB work on stable ones.
        if (signature.driftStatus !== 'NORMAL') {
          await recordVersionChangePoints(model.id, model.name);
        }

        successCount++;

        // Small delay between computations to prevent CPU spike
        await new Promise(resolve => setTimeout(resolve, 150));
        
      } catch (error) {
        errorCount++;
        const errorMsg = `${model.name}: ${error instanceof Error ? error.message : 'Unknown'}`;
        errors.push(errorMsg);
        console.error(`❌ Drift computation failed for ${model.name}:`, error);
      }
    }
    
    // Store last run metadata
    await cache.set('drift:last_precompute', new Date().toISOString(), 86400);
    await cache.set('drift:last_stats', JSON.stringify({
      total: allModels.length,
      successful: successCount,
      failed: errorCount,
      duration: Date.now() - startTime,
      timestamp: new Date().toISOString()
    }), 86400);
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`✅ Drift pre-computation completed in ${duration}s: ${successCount}/${allModels.length} successful`);
    
    if (errorCount > 0) {
      console.warn(`⚠️ ${errorCount} models failed:`, errors.slice(0, 5));
    }
    
  } catch (error) {
    console.error('❌ Drift pre-computation failed:', error);
  } finally {
    isRunning = false;
  }
}

/**
 * Start the drift pre-computation scheduler
 * Runs at :05 past every hour (to avoid peak traffic times)
 */
export function startDriftScheduler(): void {
  if (schedulerInterval) {
    console.log('⚠️ Drift scheduler already running');
    return;
  }
  
  console.log('🔄 Starting drift pre-computation scheduler...');
  
  // Run immediately on startup (after 30 second delay)
  setTimeout(() => {
    console.log('🚀 Initial drift pre-computation starting...');
    precomputeAllDriftSignatures();
  }, 30000);
  
  // Schedule hourly runs at :05 past the hour
  const msUntilNextRun = getMillisecondsUntilNextHour();
  
  setTimeout(() => {
    // Run the first scheduled computation
    precomputeAllDriftSignatures();
    
    // Then set up hourly interval
    schedulerInterval = setInterval(() => {
      precomputeAllDriftSignatures();
    }, 60 * 60 * 1000); // Every hour
    
    console.log('✅ Drift scheduler activated (runs hourly at :05)');
  }, msUntilNextRun);
  
  console.log(`⏰ Next drift pre-computation in ${Math.round(msUntilNextRun / 1000 / 60)} minutes`);
}

/**
 * Stop the drift scheduler (for graceful shutdown)
 */
export function stopDriftScheduler(): void {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
    console.log('🛑 Drift scheduler stopped');
  }
}

/**
 * Get milliseconds until :05 past next hour
 */
function getMillisecondsUntilNextHour(): number {
  const now = new Date();
  const nextHour = new Date(now);
  nextHour.setHours(now.getHours() + 1);
  nextHour.setMinutes(5);
  nextHour.setSeconds(0);
  nextHour.setMilliseconds(0);
  
  return nextHour.getTime() - now.getTime();
}

/**
 * Manual trigger for immediate pre-computation (for testing/emergency)
 */
export async function triggerImmediatePrecomputation(): Promise<void> {
  await precomputeAllDriftSignatures();
}
