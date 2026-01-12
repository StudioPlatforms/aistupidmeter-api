# Tool Calling Benchmark Scheduling Diagnostic

## 🔍 Root Cause Analysis

### Issues Identified:

1. **Missing Status Logging**: Tool benchmark status wasn't included in the 5-minute scheduler status check
2. **Aggressive Skip Logic**: `recentTestThresholdHours: 24` meant that if tool benchmarks ran 2 days ago, the next daily run would skip all models that still had data within 24 hours

### The Problem:
- Tool benchmarks run daily at **4:00 AM Berlin time**
- If last run was 2 days ago (48 hours), but some model data existed from 23 hours ago, the skip logic would prevent that model from running
- Combined with per-model AND per-task skipping, this created a scenario where benchmarks appeared to run but skipped all work

## ✅ Fixes Applied

### 1. Enhanced Status Logging ([`scheduler.ts`](apps/api/src/scheduler.ts))
```typescript
// Added to 5-minute status check:
console.log(`   - Tool running: ${isToolRunning}`);
console.log(`   - Last tool run: ${lastToolRunTime ? lastToolRunTime.toISOString() : 'Never'}`);
console.log(`   - Tool scheduler active: ${toolScheduledTask ? toolScheduledTask.getStatus() : 'Unknown'}`);

// Added next tool run calculation:
const nextToolRun = new Date(...);
console.log(`⏰ Next tool run: ${nextToolRun.toLocaleString('en-US', { timeZone: 'Europe/Berlin' })}`);
console.log(`🔧 Time until next tool: ${Math.ceil((nextToolRun.getTime() - now.getTime()) / (1000 * 60 * 60))} hours`);
```

### 2. Fixed Skip Logic ([`tool-benchmarks.ts`](apps/api/src/jobs/tool-benchmarks.ts))
```typescript
// Changed from:
recentTestThresholdHours: 24

// To:
recentTestThresholdHours: 20  // Must be less than 24h for daily runs
```

**Why 20 hours?**
- Tool benchmarks run daily at 4:00 AM
- 20-hour threshold ensures that the next day's 4:00 AM run will always execute (24-hour gap > 20-hour threshold)
- Provides a 4-hour safety margin for clock drift and execution time

## 📊 Verification Steps

### 1. Check Current Scheduler Status
```bash
# Check logs for the enhanced status messages
journalctl -u stupid-meter-api.service --since "5 minutes ago" | grep -A 15 "Scheduler status check"
```

Expected output:
```
🕐 Scheduler status check at 2026-01-12T09:25:00.000Z
   - Hourly running: false
   - Deep running: false
   - Tool running: false    ← Should see this now
   - Health running: false
   - Last hourly run: 2026-01-12T08:00:00.000Z
   - Last deep run: 2026-01-12T03:00:00.000Z
   - Last tool run: 2026-01-12T04:00:00.000Z    ← Should see this now
   - Last health run: 2026-01-12T09:20:00.000Z
   - Tool scheduler active: scheduled    ← Should see this now
```

### 2. Check Next Scheduled Tool Run
```bash
# Check for "Next tool run" in logs
journalctl -u stupid-meter-api.service --since "10 minutes ago" | grep "Next tool run"
```

Expected output:
```
⏰ Next tool run: 1/13/2026, 4:00:00 AM
🔧 Time until next tool: 19 hours
```

### 3. Verify Tool Benchmark Configuration
```bash
# Run a test to see the skip logic in action
cd /root/apps/api
node -e "
const config = { skipRecentlyTested: true, recentTestThresholdHours: 20 };
console.log('Config:', config);
console.log('Will skip if tested within:', config.recentTestThresholdHours, 'hours');
console.log('Daily run interval: 24 hours');
console.log('Safety margin:', 24 - config.recentTestThresholdHours, 'hours');
"
```

### 4. Manual Trigger Test (Optional)
```bash
# Force a tool benchmark run to verify it works
cd /root/apps/api
npm run build
node dist/jobs/tool-benchmarks.js
```

This will:
- Run all easy, medium, and hard tasks
- Skip models tested within last 20 hours
- Log each model/task combination
- Generate aggregate scores
- Save to database with `suite='tooling'`

### 5. Check Database for Recent Tool Scores
```bash
# Connect to SQLite and check for recent tool scores
sqlite3 /root/.cache/stupid-meter/benchmarks.db "
SELECT 
  m.name,
  s.suite,
  datetime(s.ts) as timestamp,
  s.stupidScore as score,
  julianday('now') - julianday(s.ts) as days_ago
FROM scores s
JOIN models m ON s.modelId = m.id
WHERE s.suite = 'tooling'
ORDER BY s.ts DESC
LIMIT 10;
"
```

Expected output:
```
GPT-4o|tooling|2026-01-12 04:15:30|85|0.2
Claude-4-Opus|tooling|2026-01-12 04:12:45|87|0.2
Gemini-2.5-Pro|tooling|2026-01-12 04:10:15|82|0.2
...
```

## 🚀 What Happens Next?

### Immediate (After Service Restart)
1. ✅ Enhanced logging starts immediately
2. ✅ Next 5-minute status check will show tool scheduler info
3. ✅ Tool benchmark scheduled for next 4:00 AM run

### At Next 4:00 AM Berlin Time
1. 🔔 Tool benchmark cron triggers
2. 🔧 Runs tool calling benchmarks with 20-hour skip threshold
3. 📊 Models not tested in last 20 hours will be benchmarked
4. 💾 Scores saved to database with `suite='tooling'`
5. 🔄 Dashboard cache refreshed
6. ✅ TOOLING mode on frontend shows updated "Last updated: X hours ago"

### Monitoring
- **5-minute status checks** will confirm tool scheduler is active
- **Daily at 4:00 AM** tool benchmarks will execute
- **Check logs** around 4:00 AM for execution confirmation:
  ```bash
  journalctl -u stupid-meter-api.service --since "4:00 AM" --until "5:00 AM" | grep -E "(tool|tooling|🔧)"
  ```

## 🐛 Troubleshooting

### Tool benchmarks still not running?

1. **Check cron expression is valid:**
   ```bash
   journalctl -u stupid-meter-api.service | grep "Daily tool benchmark cron"
   ```
   Should see: `🔔 Daily tool benchmark cron triggered at ...`

2. **Check for skip messages:**
   ```bash
   journalctl -u stupid-meter-api.service --since "4:00 AM" | grep "Skipping.*tested recently"
   ```
   If you see many skip messages, all models may have recent data

3. **Force run without skip logic:**
   ```bash
   cd /root/apps/api
   node -e "
   const { runToolBenchmarks } = require('./dist/jobs/tool-benchmarks');
   runToolBenchmarks({ skipRecentlyTested: false }).then(() => {
     console.log('Done');
     process.exit(0);
   }).catch(err => {
     console.error(err);
     process.exit(1);
   });
   "
   ```

4. **Check Docker is available:**
   ```bash
   docker ps
   docker run --rm hello-world
   ```
   Tool benchmarks require Docker for sandboxing

## 📝 Notes

- **7-Axis (Speed) Tests**: Run every 4 hours (00:00, 04:00, 08:00, 12:00, 16:00, 20:00)
- **Deep Reasoning Tests**: Run daily at 03:00 AM
- **Tool Calling Tests**: Run daily at 04:00 AM ← Fixed
- **All times are Berlin timezone** (Europe/Berlin)

The fix ensures tool benchmarks will run consistently every 24 hours at 4:00 AM.
