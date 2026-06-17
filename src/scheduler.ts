import cron from 'node-cron';
import { runRealBenchmarks } from './jobs/real-benchmarks';
import { runDeepBenchmarks, isDeepBenchmarkActive } from './deepbench/index';
import { runToolBenchmarks } from './jobs/tool-benchmarks';
import { runCanaryBenchmarks } from './jobs/canary-benchmarks';
import { refreshAllCache, refreshHotCache } from './cache/dashboard-cache';
import { runHealthChecks, cleanupOldHealthData } from './jobs/health-monitor';

let isRunning = false;
let isDeepRunning = false;
let isToolRunning = false;
let isHealthRunning = false;
let lastRunTime: Date | null = null;
let lastDeepRunTime: Date | null = null;
let lastToolRunTime: Date | null = null;
let lastHealthRunTime: Date | null = null;

// Safety timeout tracking - automatically release stuck flags
let runningStartTime: number = 0;
let deepRunningStartTime: number = 0;
let toolRunningStartTime: number = 0;

const MAX_BENCHMARK_DURATION_MS = 3 * 60 * 60 * 1000; // 3 hours max for regular benchmarks
const MAX_DEEP_DURATION_MS = 4 * 60 * 60 * 1000;      // 4 hours max for deep benchmarks
const MAX_TOOL_DURATION_MS = 4 * 60 * 60 * 1000;      // 4 hours max for tool benchmarks

function checkAndResetStuckFlags() {
  const now = Date.now();
  if (isRunning && runningStartTime > 0 && (now - runningStartTime) > MAX_BENCHMARK_DURATION_MS) {
    console.error(`🚨 SAFETY: isRunning stuck for ${Math.round((now - runningStartTime) / 60000)}min — force-releasing!`);
    isRunning = false;
    runningStartTime = 0;
  }
  if (isDeepRunning && deepRunningStartTime > 0 && (now - deepRunningStartTime) > MAX_DEEP_DURATION_MS) {
    console.error(`🚨 SAFETY: isDeepRunning stuck for ${Math.round((now - deepRunningStartTime) / 60000)}min — force-releasing!`);
    isDeepRunning = false;
    deepRunningStartTime = 0;
  }
  if (isToolRunning && toolRunningStartTime > 0 && (now - toolRunningStartTime) > MAX_TOOL_DURATION_MS) {
    console.error(`🚨 SAFETY: isToolRunning stuck for ${Math.round((now - toolRunningStartTime) / 60000)}min — force-releasing!`);
    isToolRunning = false;
    toolRunningStartTime = 0;
  }
}
let hourlyScheduledTask: any = null;
let dailyScheduledTask: any = null;
let toolScheduledTask: any = null;
let healthScheduledTask: any = null;

export function startBenchmarkScheduler() {
  console.log(`🚀 Starting benchmark scheduler at ${new Date().toISOString()}`);
  
  // Validate cron expressions
  const fourHourlyValid = cron.validate('0 */4 * * *');
  const dailyValid = cron.validate('0 3 * * *');
  const healthValid = cron.validate('*/10 * * * *');
  console.log(`📋 4-hourly cron expression validation: ${fourHourlyValid ? '✅ Valid' : '❌ Invalid'}`);
  console.log(`📋 Daily cron expression validation: ${dailyValid ? '✅ Valid' : '❌ Invalid'}`);
  console.log(`📋 Health check cron expression validation: ${healthValid ? '✅ Valid' : '❌ Invalid'}`);

  // REGULAR (Speed) BENCHMARKS: Run every 4 hours at the top of the hour (:00)
  hourlyScheduledTask = cron.schedule('0 */4 * * *', async () => {
    const now = new Date();
    console.log(`🔔 4-hourly benchmark cron triggered at ${now.toISOString()}`);
    
    // Safety: check and reset stuck flags before deciding to skip
    checkAndResetStuckFlags();
    
    if (isRunning) {
      console.log('⏸️ Hourly benchmark already running, skipping this cycle...');
      return;
    }

    try {
      isRunning = true;
      runningStartTime = Date.now();
      lastRunTime = now;
      console.log(`🕐 ${now.toISOString()} - Starting scheduled 4-hourly benchmark run...`);
      console.log(`📊 Previous run was: ${lastRunTime ? lastRunTime.toISOString() : 'Never'}`);
      
      // Run regular benchmarks in a separate process to avoid blocking
      console.log(`📊 Running regular (speed) benchmarks in non-blocking mode...`);
      
      // Use setImmediate to prevent blocking the event loop
      setImmediate(async () => {
        try {
          await runRealBenchmarks();
          console.log(`✅ Regular benchmarks completed`);
          
          // OPTIMIZED: Use hot cache refresh for regular 4-hourly updates (90% faster)
          console.log(`🔥 Refreshing HOT cache after benchmark completion (popular combinations only)...`);
          const cacheResult = await refreshHotCache();
          console.log(`✅ HOT cache refresh completed: ${cacheResult.refreshed} entries refreshed in ${cacheResult.duration}ms (${cacheResult.type})`);
          
          // Double-check cache was updated properly - log first model timestamp
          try {
            const { getCachedData } = await import('./cache/dashboard-cache');
            const testCache = await getCachedData('latest', 'combined', 'latest');
            if (testCache?.data?.modelScores?.[0]) {
              const firstModel = testCache.data.modelScores[0];
              const timeAgo = Math.round((Date.now() - new Date(firstModel.lastUpdated).getTime()) / 60000);
              console.log(`📊 Cache verification: ${firstModel.name} updated ${timeAgo}m ago (should be ~1-5m ago)`);
              
              if (timeAgo > 10) {
                console.warn(`⚠️ Cache may not have updated properly - timestamps still old!`);
                // Force another refresh if timestamps are still old
                console.log(`🔄 Forcing additional cache refresh due to stale timestamps...`);
                await refreshAllCache();
              }
            }
          } catch (error) {
            console.warn('Cache verification failed:', error);
          }
          
          // Invalidate router cache so the smart router picks up fresh benchmark scores
          try {
            const { invalidateRouterCache } = await import('./router/selector');
            invalidateRouterCache('hourly');
            console.log('🗑️ Router cache invalidated for hourly suite after 4-hourly benchmarks');
          } catch (error) {
            console.warn('⚠️ Router cache invalidation failed:', error);
          }
          
          console.log(`✅ ${new Date().toISOString()} - 4-hourly benchmark run completed successfully`);
        } catch (error) {
          console.error(`❌ ${new Date().toISOString()} - 4-hourly benchmark run failed:`, error);
        } finally {
          isRunning = false;
          runningStartTime = 0;
        }
      });
      
      // NOTE: Do NOT release isRunning here — the setImmediate callback
      // owns the lock and releases it in its finally block.
      // Releasing here caused race conditions allowing overlapping runs.
      
    } catch (error) {
      console.error(`❌ ${new Date().toISOString()} - 4-hourly benchmark setup failed:`, error);
      isRunning = false;
      runningStartTime = 0;
    }
  }, {
    timezone: 'Europe/Berlin'
  });

  // DEEP (Reasoning) BENCHMARKS: Run daily at 3:00 AM Berlin time
  dailyScheduledTask = cron.schedule('0 3 * * *', async () => {
    const now = new Date();
    const berlinTime = now.toLocaleString('en-US', { timeZone: 'Europe/Berlin' });
    console.log(`🔔 Daily deep benchmark cron triggered at ${now.toISOString()} (Berlin: ${berlinTime})`);
    console.log(`🏗️ This should create scores with suite='deep' for REASONING mode display`);
    
    // Safety: check and reset stuck flags
    checkAndResetStuckFlags();
    
    if (isDeepRunning || isDeepBenchmarkActive()) {
      console.log('⏸️ Deep benchmark already running, skipping this cycle...');
      return;
    }

    try {
      isDeepRunning = true;
      deepRunningStartTime = Date.now();
      lastDeepRunTime = now;
      console.log(`🕐 ${now.toISOString()} - Starting scheduled daily deep benchmark run...`);
      console.log(`🏗️ Previous deep run was: ${lastDeepRunTime ? lastDeepRunTime.toISOString() : 'Never'}`);
      console.log(`📊 REASONING mode timestamps will update after this completes`);
      
      // Run deep benchmarks in non-blocking mode
      setImmediate(async () => {
        try {
          console.log(`🏗️ Running deep (reasoning) benchmarks...`);
          await runDeepBenchmarks();
          console.log(`✅ Deep benchmarks completed - REASONING mode should now show ~1-2 hours ago`);
          
          // Refresh cache after deep benchmark completion
          console.log(`🔄 Refreshing dashboard cache after deep benchmark completion...`);
          const cacheResult = await refreshAllCache();
          console.log(`✅ Cache refresh completed: ${cacheResult.refreshed} entries refreshed in ${cacheResult.duration}ms`);
          
          console.log(`✅ ${new Date().toISOString()} - Daily deep benchmark run completed successfully`);
        } catch (error) {
          console.error(`❌ ${new Date().toISOString()} - Daily deep benchmark run failed:`, error);
          console.error(`🚨 This will affect REASONING mode display until next successful run`);
        } finally {
          isDeepRunning = false;
          deepRunningStartTime = 0;
        }
      });
      
      // NOTE: Do NOT release isDeepRunning here — the setImmediate callback
      // owns the lock and releases it in its finally block.
      
    } catch (error) {
      console.error(`❌ ${new Date().toISOString()} - Daily deep benchmark setup failed:`, error);
      isDeepRunning = false;
      deepRunningStartTime = 0;
    }
  }, {
    timezone: 'Europe/Berlin'
  });

  // TOOL (Tooling) BENCHMARKS: Run daily at 4:00 AM Berlin time (after deep benchmarks)
  toolScheduledTask = cron.schedule('0 4 * * *', async () => {
    const now = new Date();
    const berlinTime = now.toLocaleString('en-US', { timeZone: 'Europe/Berlin' });
    console.log(`🔔 Daily tool benchmark cron triggered at ${now.toISOString()} (Berlin: ${berlinTime})`);
    console.log(`🔧 This should create scores with suite='tooling' for TOOLING mode display`);
    
    // Safety: check and reset stuck flags
    checkAndResetStuckFlags();
    
    if (isToolRunning) {
      console.log('⏸️ Tool benchmark already running, skipping this cycle...');
      return;
    }

    try {
      isToolRunning = true;
      toolRunningStartTime = Date.now();
      lastToolRunTime = now;
      console.log(`🕐 ${now.toISOString()} - Starting scheduled daily tool benchmark run...`);
      console.log(`🔧 Previous tool run was: ${lastToolRunTime ? lastToolRunTime.toISOString() : 'Never'}`);
      console.log(`📊 TOOLING mode timestamps will update after this completes`);

      // DEFER, don't collide: if the deep benchmark overran into this slot, wait
      // for it to finish before starting. Deep and tool share provider API keys;
      // running them concurrently (as happened 2026-06-17) starves the tool run
      // and it writes zero scores. We claim isToolRunning above so nothing else
      // starts meanwhile; the 4h stuck-flag watchdog still covers a true hang.
      if (isDeepRunning || isDeepBenchmarkActive()) {
        const maxWaitMs = 90 * 60 * 1000; // wait up to 90 min for deep to finish
        const startWait = Date.now();
        console.log('⏳ Deep benchmark still active — deferring tool benchmark until it finishes (max 90 min)...');
        while ((isDeepRunning || isDeepBenchmarkActive()) && Date.now() - startWait < maxWaitMs) {
          await new Promise(resolve => setTimeout(resolve, 60 * 1000));
        }
        if (isDeepRunning || isDeepBenchmarkActive()) {
          console.warn('⚠️ Deep benchmark still active after 90 min — proceeding with tool benchmark anyway');
        } else {
          console.log(`✅ Deep benchmark finished after ${Math.round((Date.now() - startWait) / 1000)}s wait — starting tool benchmark`);
          await new Promise(resolve => setTimeout(resolve, 30 * 1000)); // let connections settle
        }
      }

      // Run tool benchmarks in non-blocking mode
      setImmediate(async () => {
        try {
          console.log(`🔧 Running tool calling benchmarks...`);
          await runToolBenchmarks();
          console.log(`✅ Tool benchmarks completed - TOOLING mode should now show ~1-2 hours ago`);
          
          // Refresh cache after tool benchmark completion
          console.log(`🔄 Refreshing dashboard cache after tool benchmark completion...`);
          const cacheResult = await refreshAllCache();
          console.log(`✅ Cache refresh completed: ${cacheResult.refreshed} entries refreshed in ${cacheResult.duration}ms`);
          
          // Invalidate router cache so the smart router picks up fresh tooling scores
          try {
            const { invalidateRouterCache } = await import('./router/selector');
            invalidateRouterCache('tooling');
            console.log('🗑️ Router cache invalidated for tooling suite after tool benchmarks');
          } catch (error) {
            console.warn('⚠️ Router cache invalidation failed:', error);
          }
          
          console.log(`✅ ${new Date().toISOString()} - Daily tool benchmark run completed successfully`);
        } catch (error) {
          console.error(`❌ ${new Date().toISOString()} - Daily tool benchmark run failed:`, error);
          console.error(`🚨 This will affect TOOLING mode display until next successful run`);
        } finally {
          isToolRunning = false;
          toolRunningStartTime = 0;
        }
      });
      
      // NOTE: Do NOT release isToolRunning here — the setImmediate callback
      // owns the lock and releases it in its finally block.
      
    } catch (error) {
      console.error(`❌ ${new Date().toISOString()} - Daily tool benchmark setup failed:`, error);
      isToolRunning = false;
      toolRunningStartTime = 0;
    }
  }, {
    timezone: 'Europe/Berlin'
  });

  // CANARY BENCHMARKS: Run every hour for fast drift detection
  let isCanaryRunning = false;
  let lastCanaryRunTime: Date | null = null;
  const canaryScheduledTask = cron.schedule('0 * * * *', async () => {
    const now = new Date();
    console.log(`🐤 Hourly canary benchmark cron triggered at ${now.toISOString()}`);
    
    if (isCanaryRunning) {
      console.log('⏸️ Canary benchmark already running, skipping this cycle...');
      return;
    }

    try {
      isCanaryRunning = true;
      lastCanaryRunTime = now;
      console.log(`🕐 ${now.toISOString()} - Starting scheduled hourly canary benchmark run...`);
      console.log(`🐤 Previous canary run was: ${lastCanaryRunTime ? lastCanaryRunTime.toISOString() : 'Never'}`);
      
      // Run canary benchmarks in non-blocking mode
      setImmediate(async () => {
        try {
          console.log(`🐤 Running canary benchmarks (12 tasks, 2 trials each)...`);
          await runCanaryBenchmarks();
          console.log(`✅ Canary benchmarks completed`);
          
          // PHASE 2: Compute drift signatures after benchmarks
          console.log(`🔍 Computing drift signatures for all models...`);
          try {
            const { computeAllDriftSignatures, detectChangePoints, recordChangePoint } = await import('./lib/drift-detection');
            const driftResult = await computeAllDriftSignatures();
            console.log(`✅ Drift computation: ${driftResult.success} success, ${driftResult.alerts} alerts, ${driftResult.warnings} warnings`);
          } catch (error) {
            console.error(`❌ Drift computation failed:`, error);
          }
          
          // PHASE 3: Provider correlation analysis
          console.log(`🔗 Analyzing cross-provider correlations...`);
          try {
            const { analyzeProviderCorrelation, saveProviderIncident } = await import('./lib/provider-correlation');
            const correlation = await analyzeProviderCorrelation();
            for (const pc of correlation.providerCorrelations) {
              if (pc.isProviderIncident) {
                await saveProviderIncident(pc);
                // Send webhook alert for provider incidents
                try {
                  const { alertProviderIncident } = await import('./lib/drift-alerts');
                  await alertProviderIncident(
                    pc.provider,
                    pc.alertRate,
                    pc.affectedModels.map(m => m.modelName),
                    pc.severity === 'critical' ? 'critical' : 'warning',
                    pc.recommendation
                  );
                } catch (alertErr) {
                  console.warn(`⚠️ Provider alert delivery failed:`, alertErr);
                }
              }
            }
            console.log(`✅ Provider correlation: ${correlation.summary}`);
          } catch (error) {
            console.error(`❌ Provider correlation failed:`, error);
          }
          
          // PHASE 3: Behavioral fingerprint drift detection (leading indicators)
          console.log(`🔬 Computing behavioral fingerprints...`);
          try {
            const { computeAllBehavioralFingerprints } = await import('./lib/behavioral-fingerprint');
            const fpResult = await computeAllBehavioralFingerprints();
            if (fpResult.drifting > 0) {
              console.log(`⚠️ Behavioral drift: ${fpResult.drifting}/${fpResult.total} models showing response characteristic changes`);
            }
          } catch (error) {
            console.error(`❌ Behavioral fingerprint failed:`, error);
          }
          
          // PHASE 3: Version tracking (correlate drift with API version changes)
          console.log(`📋 Checking for version changes...`);
          try {
            const { detectVersionChanges } = await import('./lib/version-tracker');
            const { db: database } = await import('./db');
            const { models: modelsTable } = await import('./db/schema');
            const { sql: sqlTag } = await import('drizzle-orm');
            const allModels = await database.select().from(modelsTable).where(sqlTag`show_in_rankings = 1`);
            let versionChanges = 0;
            for (const model of allModels) {
              const changes = await detectVersionChanges(model.id, 1); // Last 1 day
              if (changes.length > 0) {
                versionChanges += changes.length;
                console.log(`📋 Version change detected: ${model.name} — ${changes[0].oldVersion} → ${changes[0].newVersion}`);
              }
            }
            if (versionChanges > 0) {
              console.log(`✅ Version tracking: ${versionChanges} version changes detected`);
            }
          } catch (error) {
            console.error(`❌ Version tracking failed:`, error);
          }
          
          // Update router model rankings after canary benchmarks
          console.log(`🔄 Updating router model rankings...`);
          try {
            const { updateModelRankings } = await import('./router/jobs/ranking-updater');
            const result = await updateModelRankings();
            console.log(`✅ Router rankings updated: ${result.totalRankings} rankings across ${result.categories} categories`);
          } catch (error) {
            console.error(`❌ Failed to update router rankings:`, error);
          }
          
          console.log(`✅ ${new Date().toISOString()} - Hourly canary benchmark run completed successfully`);
        } catch (error) {
          console.error(`❌ ${new Date().toISOString()} - Hourly canary benchmark run failed:`, error);
        } finally {
          isCanaryRunning = false;
        }
      });
      
      // NOTE: Do NOT release isCanaryRunning here — the setImmediate callback
      // owns the lock and releases it in its finally block.
      
    } catch (error) {
      console.error(`❌ ${new Date().toISOString()} - Hourly canary benchmark setup failed:`, error);
      isCanaryRunning = false;
    }
  }, {
    timezone: 'Europe/Berlin'
  });

  // HEALTH MONITORING: Run every 10 minutes
  healthScheduledTask = cron.schedule('*/10 * * * *', async () => {
    const now = new Date();
    console.log(`🏥 Health check cron triggered at ${now.toISOString()}`);
    
    if (isHealthRunning) {
      console.log('⏸️ Health check already running, skipping this cycle...');
      return;
    }

    try {
      isHealthRunning = true;
      lastHealthRunTime = now;
      console.log(`🏥 Starting provider health checks...`);
      
      await runHealthChecks();
      
      // Cleanup old health data once per day (at midnight)
      if (now.getHours() === 0 && now.getMinutes() < 10) {
        console.log(`🧹 Running daily health data cleanup...`);
        cleanupOldHealthData();
      }
      
      console.log(`✅ Health checks completed successfully`);
    } catch (error) {
      console.error(`❌ Health check failed:`, error);
    } finally {
      isHealthRunning = false;
    }
  }, {
    timezone: 'Europe/Berlin'
  });

  // API MONITORING: Daily prompt retention cleanup (2:00 AM UTC)
  cron.schedule('0 2 * * *', async () => {
    console.log(`🗑️ [${new Date().toISOString()}] Running prompt retention cleanup...`);
    try {
      const { runPromptRetentionCleanup } = await import('./jobs/prompt-retention');
      await runPromptRetentionCleanup();
    } catch (err) {
      console.error('Prompt retention cleanup failed:', err);
    }
  });

  // API MONITORING: Hourly spend counter reconciliation
  cron.schedule('30 * * * *', async () => {
    try {
      const { reconcileSpendCounters } = await import('./jobs/prompt-retention');
      await reconcileSpendCounters();
    } catch (err) {
      console.error('Spend reconciliation failed:', err);
    }
  });

  // A2: Per-capability drift — runs nightly at 5 AM (after deep+tool benchmarks have data)
  cron.schedule('0 5 * * *', async () => {
    console.log('🔬 [A2] Nightly capability drift detection starting...');
    try {
      const { detectAllCapabilityDrift } = await import('./lib/drift-detection');
      await detectAllCapabilityDrift();
    } catch (err) {
      console.error('❌ [A2] Capability drift detection failed:', err);
    }
  }, { timezone: 'Europe/Berlin' });

  // B3: Nightly mining jobs — hallucination patterns, regression diagnostics, version genealogy
  // Runs at 5:30 AM (after deep+tool+A2 have all run)
  cron.schedule('30 5 * * *', async () => {
    console.log('🧪 [B3] Nightly mining jobs starting...');

    try {
      const { mineHallucinationPatterns, generateHallucinationReport } = await import('./lib/hallucination-analyzer');
      const { db: database } = await import('./db');
      const { models: modelsTable } = await import('./db/schema');
      const { sql: sqlTag } = await import('drizzle-orm');
      const allModels = await database.select().from(modelsTable).where(sqlTag`show_in_rankings = 1`);

      let hallucinationHits = 0;
      for (const model of allModels) {
        try {
          const patterns = await mineHallucinationPatterns(model.id, 7);
          hallucinationHits += patterns.length;
        } catch { /* per-model errors are non-fatal */ }
      }

      const report = await generateHallucinationReport(7);
      const lines = report.split('\n').filter(l => l.trim()).length;
      console.log(`🧪 [B3] Hallucination: ${hallucinationHits} patterns mined, ${lines}-line report generated`);
    } catch (err) {
      console.error('❌ [B3] Hallucination mining failed:', err);
    }

    try {
      const { generateRegressionReport, analyzeFailurePatterns } = await import('./lib/regression-diagnostics');
      const report = await generateRegressionReport(7);
      const lines = report.split('\n').filter(l => l.trim()).length;
      const failures = await analyzeFailurePatterns(7);
      console.log(`🧪 [B3] Regression: ${lines}-line report, ${failures.commonFailures.length} failure patterns, rate=${failures.failureRate.toFixed(1)}%`);
    } catch (err) {
      console.error('❌ [B3] Regression diagnostics failed:', err);
    }

    try {
      const { generateVersionChangeReport } = await import('./lib/version-tracker');
      const report = await generateVersionChangeReport(7);
      const lines = report.split('\n').filter(l => l.trim()).length;
      console.log(`🧪 [B3] Version genealogy: ${lines}-line report generated`);
    } catch (err) {
      console.error('❌ [B3] Version genealogy failed:', err);
    }

    console.log('✅ [B3] Nightly mining jobs complete');
  }, { timezone: 'Europe/Berlin' });

  console.log('📅 Scheduler started with separate timing:');
  console.log('   • Canary benchmarks: Every hour at :00 (12 tasks, 2 trials) - FAST DRIFT DETECTION');
  console.log('   • Drift computation: Every hour after canary (change-point detection, regime classification)');
  console.log('   • Regular (speed) benchmarks: Every 4 hours at :00 (00:00, 04:00, 08:00, 12:00, 16:00, 20:00)');
  console.log('   • Deep (reasoning) benchmarks: Daily at 3:00 AM Berlin time');
  console.log('   • Tool (tooling) benchmarks: Daily at 4:00 AM Berlin time');
  console.log('   • Health monitoring: Every 10 minutes');
  console.log('   • Prompt retention cleanup: Daily at 2:00 AM UTC');
  console.log('   • Spend reconciliation: Every hour at :30');
  console.log(`🌍 Scheduler timezone: Europe/Berlin`);
  console.log(`⚡ Canary scheduler active: ${canaryScheduledTask ? canaryScheduledTask.getStatus() : 'Unknown'}`);
  console.log(`⚡ 4-hourly scheduler active: ${hourlyScheduledTask ? hourlyScheduledTask.getStatus() : 'Unknown'}`);
  console.log(`⚡ Daily scheduler active: ${dailyScheduledTask ? dailyScheduledTask.getStatus() : 'Unknown'}`);
  console.log(`⚡ Tool scheduler active: ${toolScheduledTask ? toolScheduledTask.getStatus() : 'Unknown'}`);
  console.log(`⚡ Health scheduler active: ${healthScheduledTask ? healthScheduledTask.getStatus() : 'Unknown'}`);
  console.log(`🛡️ DST-safe mode: Enabled (non-blocking execution with setImmediate)`);
  
  // Log next scheduled times for both
  const now = new Date();
  const currentHour = now.getHours();
  const minutes = now.getMinutes();
  
  // Calculate next 4-hour interval (0, 4, 8, 12, 16, 20)
  const fourHourSlots = [0, 4, 8, 12, 16, 20];
  let nextFourHourSlot = fourHourSlots.find(slot => slot > currentHour || (slot === currentHour && minutes === 0));
  
  if (!nextFourHourSlot) {
    // If no slot found today, use first slot tomorrow
    nextFourHourSlot = fourHourSlots[0];
  }
  
  const nextFourHourlyRun = new Date(now.getFullYear(), now.getMonth(), now.getDate(), nextFourHourSlot, 0, 0, 0);
  if (nextFourHourSlot <= currentHour) {
    // Next run is tomorrow
    nextFourHourlyRun.setDate(nextFourHourlyRun.getDate() + 1);
  }
  
  console.log(`⏰ Next 4-hourly run: ${nextFourHourlyRun.toLocaleString('en-US', { timeZone: 'Europe/Berlin' })}`);
  console.log(`📊 Time until next 4-hourly: ${Math.ceil((nextFourHourlyRun.getTime() - now.getTime()) / 60000)} minutes`);
  
  // Calculate next daily run (3 AM)
  const nextDailyRun = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 3, 0, 0, 0);
  if (now.getHours() >= 3) {
    nextDailyRun.setDate(nextDailyRun.getDate() + 1); // Tomorrow if already past 3 AM
  }
  console.log(`⏰ Next deep run: ${nextDailyRun.toLocaleString('en-US', { timeZone: 'Europe/Berlin' })}`);
  console.log(`🏗️ Time until next deep: ${Math.ceil((nextDailyRun.getTime() - now.getTime()) / (1000 * 60 * 60))} hours`);
  
  // Calculate next tool run (4 AM)
  const nextToolRun = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 4, 0, 0, 0);
  if (now.getHours() >= 4) {
    nextToolRun.setDate(nextToolRun.getDate() + 1); // Tomorrow if already past 4 AM
  }
  console.log(`⏰ Next tool run: ${nextToolRun.toLocaleString('en-US', { timeZone: 'Europe/Berlin' })}`);
  console.log(`🔧 Time until next tool: ${Math.ceil((nextToolRun.getTime() - now.getTime()) / (1000 * 60 * 60))} hours`);
  
  // Set up debug timer + safety check for stuck flags + MISSED RUN WATCHDOG
  setInterval(() => {
    const currentTime = new Date();
    // Safety: automatically release stuck flags every 5 minutes
    checkAndResetStuckFlags();
    console.log(`🕐 Scheduler status check at ${currentTime.toISOString()}`);
    console.log(`   - Hourly running: ${isRunning}`);
    console.log(`   - Deep running: ${isDeepRunning}`);
    console.log(`   - Tool running: ${isToolRunning}`);
    console.log(`   - Health running: ${isHealthRunning}`);
    console.log(`   - Last hourly run: ${lastRunTime ? lastRunTime.toISOString() : 'Never'}`);
    console.log(`   - Last deep run: ${lastDeepRunTime ? lastDeepRunTime.toISOString() : 'Never'}`);
    console.log(`   - Last tool run: ${lastToolRunTime ? lastToolRunTime.toISOString() : 'Never'}`);
    console.log(`   - Last health run: ${lastHealthRunTime ? lastHealthRunTime.toISOString() : 'Never'}`);
    console.log(`   - Hourly scheduler active: ${hourlyScheduledTask ? hourlyScheduledTask.getStatus() : 'Unknown'}`);
    console.log(`   - Daily scheduler active: ${dailyScheduledTask ? dailyScheduledTask.getStatus() : 'Unknown'}`);
    console.log(`   - Tool scheduler active: ${toolScheduledTask ? toolScheduledTask.getStatus() : 'Unknown'}`);
    console.log(`   - Health scheduler active: ${healthScheduledTask ? healthScheduledTask.getStatus() : 'Unknown'}`);

    // ──────────────────────────────────────────────────────────────────────
    // WATCHDOG: Detect missed 4-hourly runs and trigger a catch-up.
    // node-cron can silently skip ticks when the event loop is blocked by
    // synchronous better-sqlite3 I/O.  If the last run was > 4.5 hours ago
    // AND nothing is currently running, fire a catch-up immediately.
    // ──────────────────────────────────────────────────────────────────────
    const FOUR_HOUR_PLUS_BUFFER_MS = 4.5 * 60 * 60 * 1000; // 4h 30m
    const timeSinceLastRun = lastRunTime
      ? currentTime.getTime() - lastRunTime.getTime()
      : Infinity;

    if (timeSinceLastRun > FOUR_HOUR_PLUS_BUFFER_MS && !isRunning) {
      console.warn(`🚨 WATCHDOG: Last 4-hourly run was ${Math.round(timeSinceLastRun / 60000)}min ago — node-cron likely missed a tick. Triggering catch-up run NOW.`);
      isRunning = true;
      runningStartTime = Date.now();
      lastRunTime = currentTime;

      setImmediate(async () => {
        try {
          await runRealBenchmarks();
          console.log(`✅ WATCHDOG catch-up benchmark completed`);
          const cacheResult = await refreshHotCache();
          console.log(`✅ HOT cache refresh after watchdog: ${cacheResult.refreshed} entries in ${cacheResult.duration}ms`);
        } catch (error) {
          console.error(`❌ WATCHDOG catch-up benchmark failed:`, error);
        } finally {
          isRunning = false;
          runningStartTime = 0;
        }
      });
    }
  }, 5 * 60 * 1000);
  
  // Run initial health check after 30 seconds
  setTimeout(async () => {
    if (!isHealthRunning) {
      console.log('🧪 Running initial health check to verify system...');
      try {
        isHealthRunning = true;
        lastHealthRunTime = new Date();
        await runHealthChecks();
        console.log('✅ Initial health check completed successfully');
      } catch (error) {
        console.error('❌ Initial health check failed:', error);
      } finally {
        isHealthRunning = false;
      }
    }
  }, 30 * 1000);
  
  // REMOVED: The startup test run that used to fire 2 minutes after startup
  // was running `await runRealBenchmarks()` directly in a setTimeout callback,
  // which blocked the event loop with synchronous better-sqlite3 I/O for 1-3
  // hours and held `isRunning = true`, causing the first scheduled cron tick
  // to be skipped.  The watchdog above now handles the case where we need a
  // run shortly after startup — it will detect that lastRunTime is null
  // (Infinity ms ago) and trigger one within 5 minutes.
}

export function getBenchmarkStatus() {
  const now = new Date();
  const currentHour = now.getHours();
  const minutes = now.getMinutes();
  
  // Calculate next 4-hour interval (0, 4, 8, 12, 16, 20)
  const fourHourSlots = [0, 4, 8, 12, 16, 20];
  let nextFourHourSlot = fourHourSlots.find(slot => slot > currentHour || (slot === currentHour && minutes === 0));
  
  if (!nextFourHourSlot) {
    // If no slot found today, use first slot tomorrow
    nextFourHourSlot = fourHourSlots[0];
  }
  
  const nextFourHourlyRun = new Date(now.getFullYear(), now.getMonth(), now.getDate(), nextFourHourSlot, 0, 0, 0);
  if (nextFourHourSlot <= currentHour) {
    // Next run is tomorrow
    nextFourHourlyRun.setDate(nextFourHourlyRun.getDate() + 1);
  }
  
  // Next daily run (3 AM)
  const nextDailyRun = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 3, 0, 0, 0);
  if (now.getHours() >= 3) {
    nextDailyRun.setDate(nextDailyRun.getDate() + 1);
  }
  
  return {
    isRunning: isRunning || isDeepRunning,
    isHourlyRunning: isRunning, // Keep for compatibility (now represents 4-hourly)
    isDeepRunning: isDeepRunning,
    nextScheduledRun: nextFourHourlyRun, // Regular benchmarks for compatibility
    nextHourlyRun: nextFourHourlyRun, // Keep name for compatibility (now 4-hourly)
    nextDeepRun: nextDailyRun,
    minutesUntilNext: Math.ceil((nextFourHourlyRun.getTime() - now.getTime()) / 60000),
    hoursUntilDeepRun: Math.ceil((nextDailyRun.getTime() - now.getTime()) / (1000 * 60 * 60))
  };
}
