import cron from 'node-cron';
import { runRealBenchmarks } from './jobs/real-benchmarks';
import { runDeepBenchmarks, isDeepBenchmarkActive } from './deepbench/index';
import { runToolBenchmarks } from './jobs/tool-benchmarks';
import { refreshAllCache, refreshHotCache } from './cache/dashboard-cache';

let isRunning = false;
let isDeepRunning = false;
let isToolRunning = false;
let lastRunTime: Date | null = null;
let lastDeepRunTime: Date | null = null;
let lastToolRunTime: Date | null = null;
let hourlyScheduledTask: any = null;
let dailyScheduledTask: any = null;
let toolScheduledTask: any = null;

export function startBenchmarkScheduler() {
  console.log(`🚀 Starting benchmark scheduler at ${new Date().toISOString()}`);
  
  // Validate cron expressions
  const fourHourlyValid = cron.validate('0 */4 * * *');
  const dailyValid = cron.validate('0 3 * * *');
  console.log(`📋 4-hourly cron expression validation: ${fourHourlyValid ? '✅ Valid' : '❌ Invalid'}`);
  console.log(`📋 Daily cron expression validation: ${dailyValid ? '✅ Valid' : '❌ Invalid'}`);

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
      
      // Run regular benchmarks only
      console.log(`📊 Running regular (speed) benchmarks...`);
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
      
      // Run deep benchmarks only
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
      
      // Run tool benchmarks only
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
  }, {
    timezone: 'Europe/Berlin'
  });

  console.log('📅 Scheduler started with separate timing:');
  console.log('   • Regular (speed) benchmarks: Every 4 hours at :00 (00:00, 04:00, 08:00, 12:00, 16:00, 20:00)');
  console.log('   • Deep (reasoning) benchmarks: Daily at 3:00 AM Berlin time');
  console.log('   • Tool (tooling) benchmarks: Daily at 4:00 AM Berlin time');
  console.log(`🌍 Scheduler timezone: Europe/Berlin`);
  console.log(`⚡ 4-hourly scheduler active: ${hourlyScheduledTask ? hourlyScheduledTask.getStatus() : 'Unknown'}`);
  console.log(`⚡ Daily scheduler active: ${dailyScheduledTask ? dailyScheduledTask.getStatus() : 'Unknown'}`);
  console.log(`⚡ Tool scheduler active: ${toolScheduledTask ? toolScheduledTask.getStatus() : 'Unknown'}`);
  
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
  
  // Set up debug timer
  setInterval(() => {
    const currentTime = new Date();
    console.log(`🕐 Scheduler status check at ${currentTime.toISOString()}`);
    console.log(`   - Hourly running: ${isRunning}`);
    console.log(`   - Deep running: ${isDeepRunning}`);
    console.log(`   - Last hourly run: ${lastRunTime ? lastRunTime.toISOString() : 'Never'}`);
    console.log(`   - Last deep run: ${lastDeepRunTime ? lastDeepRunTime.toISOString() : 'Never'}`);
    console.log(`   - Hourly scheduler active: ${hourlyScheduledTask ? hourlyScheduledTask.getStatus() : 'Unknown'}`);
    console.log(`   - Daily scheduler active: ${dailyScheduledTask ? dailyScheduledTask.getStatus() : 'Unknown'}`);
  }, 5 * 60 * 1000);
  
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
