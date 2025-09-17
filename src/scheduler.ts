import cron from 'node-cron';
import { runRealBenchmarks } from './jobs/real-benchmarks';
import { runDeepBenchmarks, isDeepBenchmarkActive } from './deepbench/index';
import { refreshAllCache } from './cache/dashboard-cache';

let isRunning = false;
let isDeepRunning = false;
let lastRunTime: Date | null = null;
let lastDeepRunTime: Date | null = null;
let hourlyScheduledTask: any = null;
let dailyScheduledTask: any = null;

export function startBenchmarkScheduler() {
  console.log(`🚀 Starting benchmark scheduler at ${new Date().toISOString()}`);
  
  // Validate cron expressions
  const hourlyValid = cron.validate('0 * * * *');
  const dailyValid = cron.validate('0 3 * * *');
  console.log(`📋 Hourly cron expression validation: ${hourlyValid ? '✅ Valid' : '❌ Invalid'}`);
  console.log(`📋 Daily cron expression validation: ${dailyValid ? '✅ Valid' : '❌ Invalid'}`);

  // REGULAR (Speed) BENCHMARKS: Run every hour at the top of the hour (:00)
  hourlyScheduledTask = cron.schedule('0 * * * *', async () => {
    const now = new Date();
    console.log(`🔔 Hourly benchmark cron triggered at ${now.toISOString()}`);
    
    if (isRunning) {
      console.log('⏸️ Hourly benchmark already running, skipping this cycle...');
      return;
    }

    try {
      isRunning = true;
      lastRunTime = now;
      console.log(`🕐 ${now.toISOString()} - Starting scheduled hourly benchmark run...`);
      console.log(`📊 Previous run was: ${lastRunTime ? lastRunTime.toISOString() : 'Never'}`);
      
      // Run regular benchmarks only
      console.log(`📊 Running regular (speed) benchmarks...`);
      await runRealBenchmarks();
      console.log(`✅ Regular benchmarks completed`);
      
      // Refresh cache after benchmark completion
      console.log(`🔄 Refreshing dashboard cache after benchmark completion...`);
      const cacheResult = await refreshAllCache();
      console.log(`✅ Cache refresh completed: ${cacheResult.refreshed} entries refreshed in ${cacheResult.duration}ms`);
      
      console.log(`✅ ${new Date().toISOString()} - Hourly benchmark run completed successfully`);
    } catch (error) {
      console.error(`❌ ${new Date().toISOString()} - Hourly benchmark run failed:`, error);
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

  console.log('📅 Scheduler started with separate timing:');
  console.log('   • Regular (speed) benchmarks: Every hour at :00');
  console.log('   • Deep (reasoning) benchmarks: Daily at 3:00 AM Berlin time');
  console.log(`🌍 Scheduler timezone: Europe/Berlin`);
  console.log(`⚡ Hourly scheduler active: ${hourlyScheduledTask ? hourlyScheduledTask.getStatus() : 'Unknown'}`);
  console.log(`⚡ Daily scheduler active: ${dailyScheduledTask ? dailyScheduledTask.getStatus() : 'Unknown'}`);
  
  // Log next scheduled times for both
  const now = new Date();
  const minutes = now.getMinutes();
  let nextMinute = 0;
  let nextHour = now.getHours();
  
  // If we're past the top of the hour, schedule for next hour
  if (minutes > 0) {
    nextHour = (nextHour + 1) % 24;
  }
  
  const nextHourlyRun = new Date(now.getFullYear(), now.getMonth(), now.getDate(), nextHour, nextMinute, 0, 0);
  console.log(`⏰ Next hourly run: ${nextHourlyRun.toLocaleString('en-US', { timeZone: 'Europe/Berlin' })}`);
  console.log(`📊 Time until next hourly: ${Math.ceil((nextHourlyRun.getTime() - now.getTime()) / 60000)} minutes`);
  
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
  const minutes = now.getMinutes();
  
  // Next hourly run
  let nextHourlyRun: Date;
  if (minutes === 0) {
    nextHourlyRun = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours() + 1, 0, 0, 0);
  } else {
    nextHourlyRun = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours() + 1, 0, 0, 0);
  }
  
  // Next daily run (3 AM)
  const nextDailyRun = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 3, 0, 0, 0);
  if (now.getHours() >= 3) {
    nextDailyRun.setDate(nextDailyRun.getDate() + 1);
  }
  
  return {
    isRunning: isRunning || isDeepRunning,
    isHourlyRunning: isRunning,
    isDeepRunning: isDeepRunning,
    nextScheduledRun: nextHourlyRun, // Regular benchmarks for compatibility
    nextHourlyRun: nextHourlyRun,
    nextDeepRun: nextDailyRun,
    minutesUntilNext: Math.ceil((nextHourlyRun.getTime() - now.getTime()) / 60000),
    hoursUntilDeepRun: Math.ceil((nextDailyRun.getTime() - now.getTime()) / (1000 * 60 * 60))
  };
}
