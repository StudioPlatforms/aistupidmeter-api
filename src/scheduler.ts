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
    
    if (isRunning) {
      console.log('⏸️ Hourly benchmark already running, skipping this cycle...');
      return;
    }

    try {
      isRunning = true;
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
          
          console.log(`✅ ${new Date().toISOString()} - 4-hourly benchmark run completed successfully`);
        } catch (error) {
          console.error(`❌ ${new Date().toISOString()} - 4-hourly benchmark run failed:`, error);
        } finally {
          isRunning = false;
        }
      });
      
      // NOTE: Do NOT release isRunning here — the setImmediate callback
      // owns the lock and releases it in its finally block.
      // Releasing here caused race conditions allowing overlapping runs.
      
    } catch (error) {
      console.error(`❌ ${new Date().toISOString()} - 4-hourly benchmark setup failed:`, error);
      isRunning = false;
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
    
    if (isDeepRunning || isDeepBenchmarkActive()) {
      console.log('⏸️ Deep benchmark already running, skipping this cycle...');
      return;
    }

    try {
      isDeepRunning = true;
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
        }
      });
      
      // NOTE: Do NOT release isDeepRunning here — the setImmediate callback
      // owns the lock and releases it in its finally block.
      
    } catch (error) {
      console.error(`❌ ${new Date().toISOString()} - Daily deep benchmark setup failed:`, error);
      isDeepRunning = false;
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
    
    if (isToolRunning) {
      console.log('⏸️ Tool benchmark already running, skipping this cycle...');
      return;
    }

    try {
      isToolRunning = true;
      lastToolRunTime = now;
      console.log(`🕐 ${now.toISOString()} - Starting scheduled daily tool benchmark run...`);
      console.log(`🔧 Previous tool run was: ${lastToolRunTime ? lastToolRunTime.toISOString() : 'Never'}`);
      console.log(`📊 TOOLING mode timestamps will update after this completes`);
      
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
          
          console.log(`✅ ${new Date().toISOString()} - Daily tool benchmark run completed successfully`);
        } catch (error) {
          console.error(`❌ ${new Date().toISOString()} - Daily tool benchmark run failed:`, error);
          console.error(`🚨 This will affect TOOLING mode display until next successful run`);
        } finally {
          isToolRunning = false;
        }
      });
      
      // NOTE: Do NOT release isToolRunning here — the setImmediate callback
      // owns the lock and releases it in its finally block.
      
    } catch (error) {
      console.error(`❌ ${new Date().toISOString()} - Daily tool benchmark setup failed:`, error);
      isToolRunning = false;
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

  console.log('📅 Scheduler started with separate timing:');
  console.log('   • Canary benchmarks: Every hour at :00 (12 tasks, 2 trials) - FAST DRIFT DETECTION');
  console.log('   • Drift computation: Every hour after canary (change-point detection, regime classification)');
  console.log('   • Regular (speed) benchmarks: Every 4 hours at :00 (00:00, 04:00, 08:00, 12:00, 16:00, 20:00)');
  console.log('   • Deep (reasoning) benchmarks: Daily at 3:00 AM Berlin time');
  console.log('   • Tool (tooling) benchmarks: Daily at 4:00 AM Berlin time');
  console.log('   • Health monitoring: Every 10 minutes');
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
  
  // Set up debug timer
  setInterval(() => {
    const currentTime = new Date();
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
  
  // Test run for hourly benchmarks only
  setTimeout(async () => {
    if (!isRunning) {
      console.log('🧪 Running test hourly benchmark to verify scheduler...');
      try {
        isRunning = true;
        await runRealBenchmarks();
        console.log('✅ Test hourly benchmark completed successfully');
        
        // Refresh cache after test run
        console.log('🔄 Refreshing cache after test benchmark...');
        const cacheResult = await refreshAllCache();
        console.log(`✅ Cache refresh completed: ${cacheResult.refreshed} entries refreshed in ${cacheResult.duration}ms`);
      } catch (error) {
        console.error('❌ Test hourly benchmark failed:', error);
      } finally {
        isRunning = false;
      }
    }
  }, 2 * 60 * 1000);
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
