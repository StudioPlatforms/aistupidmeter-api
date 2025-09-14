import cron from 'node-cron';
import { runRealBenchmarks } from './jobs/real-benchmarks';
import { runDeepBenchmarks, isDeepBenchmarkActive } from './deepbench/index';

let isRunning = false;
let lastRunTime: Date | null = null;
let scheduledTask: any = null; // Using any to avoid TypeScript issues

export function startBenchmarkScheduler() {
  console.log(`🚀 Starting benchmark scheduler at ${new Date().toISOString()}`);
  
  // Validate cron is working by testing the expression
  const isValidCron = cron.validate('0 * * * *');
  console.log(`📋 Cron expression validation: ${isValidCron ? '✅ Valid' : '❌ Invalid'}`);

  // Run both regular and deep benchmarks every hour at the top of the hour (:00)
  scheduledTask = cron.schedule('0 * * * *', async () => {
    const now = new Date();
    console.log(`🔔 Combined benchmark cron triggered at ${now.toISOString()}`);
    
    if (isRunning) {
      console.log('⏸️  Benchmark already running, skipping this cycle...');
      return;
    }

    try {
      isRunning = true;
      lastRunTime = now;
      console.log(`🕐 ${now.toISOString()} - Starting scheduled combined benchmark run...`);
      console.log(`📊 Previous run was: ${lastRunTime ? lastRunTime.toISOString() : 'Never'}`);
      
      // Run regular benchmarks first
      console.log(`📊 Running regular benchmarks...`);
      await runRealBenchmarks();
      console.log(`✅ Regular benchmarks completed`);
      
      // Then run deep benchmarks
      console.log(`🏗️ Running deep benchmarks...`);
      await runDeepBenchmarks();
      console.log(`✅ Deep benchmarks completed`);
      
      console.log(`✅ ${new Date().toISOString()} - Combined benchmark run completed successfully`);
    } catch (error) {
      console.error(`❌ ${new Date().toISOString()} - Combined benchmark run failed:`, error);
      // Don't let errors stop future runs
    } finally {
      isRunning = false;
    }
  }, {
    timezone: 'Europe/Berlin' // Explicitly set timezone
  });

  console.log('📅 Combined benchmark scheduler started - runs both regular and deep benchmarks every hour at the top of the hour (:00)');
  console.log(`🌍 Scheduler timezone: Europe/Berlin`);
  console.log(`⚡ Scheduler is active: ${scheduledTask ? scheduledTask.getStatus() : 'Unknown'}`);
  
  // Log next scheduled times
  const now = new Date();
  const minutes = now.getMinutes();
  let nextMinute = 0;
  let nextHour = now.getHours();
  
  // If we're past the top of the hour, schedule for next hour
  if (minutes > 0) {
    nextHour = (nextHour + 1) % 24;
  }
  
  const nextRun = new Date(now.getFullYear(), now.getMonth(), now.getDate(), nextHour, nextMinute, 0, 0);
  console.log(`⏰ Next benchmark run scheduled for: ${nextRun.toLocaleString('en-US', { timeZone: 'Europe/Berlin' })}`);
  console.log(`📊 Time until next run: ${Math.ceil((nextRun.getTime() - now.getTime()) / 60000)} minutes`);
  
  // Set up a debug timer to log scheduler status every 5 minutes
  setInterval(() => {
    const currentTime = new Date();
    console.log(`🕐 Scheduler status check at ${currentTime.toISOString()}`);
    console.log(`   - Is running: ${isRunning}`);
    console.log(`   - Last run: ${lastRunTime ? lastRunTime.toISOString() : 'Never'}`);
    console.log(`   - Scheduler active: ${scheduledTask ? scheduledTask.getStatus() : 'Unknown'}`);
    
    const mins = currentTime.getMinutes();
    let nextMin = 0;
    let nextHr = currentTime.getHours();
    
    // If we're past the top of the hour, schedule for next hour
    if (mins > 0) {
      nextHr = (nextHr + 1) % 24;
    }
    
    const nextScheduled = new Date(currentTime.getFullYear(), currentTime.getMonth(), currentTime.getDate(), nextHr, nextMin, 0, 0);
    const minutesUntil = Math.ceil((nextScheduled.getTime() - currentTime.getTime()) / 60000);
    console.log(`   - Next run in: ${minutesUntil} minutes (at ${nextScheduled.toLocaleTimeString('en-US', { timeZone: 'Europe/Berlin' })})`);
  }, 5 * 60 * 1000); // Every 5 minutes
  
  // Force a test run in 2 minutes to verify the system is working
  setTimeout(async () => {
    if (!isRunning) {
      console.log('🧪 Running test benchmark to verify scheduler...');
      try {
        isRunning = true;
        await runRealBenchmarks();
        console.log('✅ Test benchmark completed successfully');
      } catch (error) {
        console.error('❌ Test benchmark failed:', error);
      } finally {
        isRunning = false;
      }
    }
  }, 2 * 60 * 1000); // 2 minutes
}

export function getBenchmarkStatus() {
  const now = new Date();
  const minutes = now.getMinutes();
  let nextRun: Date;
  
  // Benchmarks run every hour at the top of the hour (:00)
  if (minutes === 0) {
    // If it's exactly the top of the hour, next run is in 1 hour
    nextRun = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours() + 1, 0, 0, 0);
  } else {
    // If we're past the top of the hour, next run is at the next hour's :00
    nextRun = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours() + 1, 0, 0, 0);
  }
  
  return {
    isRunning,
    nextScheduledRun: nextRun, // When benchmark actually runs (every hour at :00)
    nextActualRun: nextRun,    // Same time - no confusion
    minutesUntilNext: Math.ceil((nextRun.getTime() - now.getTime()) / 60000)
  };
}
