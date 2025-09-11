import cron from 'node-cron';
import { runRealBenchmarks } from './jobs/real-benchmarks';

let isRunning = false;
let lastRunTime: Date | null = null;
let scheduledTask: any = null; // Using any to avoid TypeScript issues

export function startBenchmarkScheduler() {
  console.log(`🚀 Starting benchmark scheduler at ${new Date().toISOString()}`);
  
  // Validate cron is working by testing the expression
  const isValidCron = cron.validate('0,20,40 * * * *');
  console.log(`📋 Cron expression validation: ${isValidCron ? '✅ Valid' : '❌ Invalid'}`);

  // Run benchmarks every 20 minutes at :00, :20, and :40
  scheduledTask = cron.schedule('0,20,40 * * * *', async () => {
    const now = new Date();
    console.log(`🔔 Cron triggered at ${now.toISOString()}`);
    
    if (isRunning) {
      console.log('⏸️  Benchmark already running, skipping this cycle...');
      return;
    }

    try {
      isRunning = true;
      lastRunTime = now;
      console.log(`🕐 ${now.toISOString()} - Starting scheduled benchmark run...`);
      console.log(`📊 Previous run was: ${lastRunTime ? lastRunTime.toISOString() : 'Never'}`);
      
      await runRealBenchmarks();
      
      console.log(`✅ ${new Date().toISOString()} - Scheduled benchmark completed successfully`);
    } catch (error) {
      console.error(`❌ ${new Date().toISOString()} - Scheduled benchmark failed:`, error);
      // Don't let errors stop future runs
    } finally {
      isRunning = false;
    }
  }, {
    timezone: 'Europe/Berlin' // Explicitly set timezone
  });

  console.log('📅 Benchmark scheduler started - runs every 20 minutes at :00, :20, and :40');
  console.log(`🌍 Scheduler timezone: Europe/Berlin`);
  console.log(`⚡ Scheduler is active: ${scheduledTask ? scheduledTask.getStatus() : 'Unknown'}`);
  
  // Log next scheduled times
  const now = new Date();
  const minutes = now.getMinutes();
  let nextMinute: number;
  let nextHour = now.getHours();
  
  if (minutes < 20) {
    nextMinute = 20;
  } else if (minutes < 40) {
    nextMinute = 40;
  } else {
    nextMinute = 0;
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
    let nextMin: number;
    let nextHr = currentTime.getHours();
    
    if (mins < 20) {
      nextMin = 20;
    } else if (mins < 40) {
      nextMin = 40;
    } else {
      nextMin = 0;
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
  
  // Benchmarks run every 20 minutes at :00, :20, and :40
  if (minutes < 20) {
    nextRun = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), 20, 0, 0);
  } else if (minutes < 40) {
    nextRun = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), 40, 0, 0);
  } else {
    nextRun = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours() + 1, 0, 0, 0);
  }
  
  return {
    isRunning,
    nextScheduledRun: nextRun, // When benchmark actually runs (every 20 min at :00/:20/:40)
    nextActualRun: nextRun,    // Same time - no confusion
    minutesUntilNext: Math.ceil((nextRun.getTime() - now.getTime()) / 60000)
  };
}
