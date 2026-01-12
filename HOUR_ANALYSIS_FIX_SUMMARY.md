# Hour-of-Day Performance Analysis: 24h Timeline Fix

## Problem Statement

**Issue**: When users switch between time periods (24h/7d/30d) on the Performance Timing page, all three charts appeared identical because they all used hour-of-day distribution (0-23) instead of having different data structures.

**Root Cause**: The backend API endpoint `/api/models/:id/hour-analysis` was using hour-of-day aggregation (`GROUP BY hour-of-day`) for ALL periods including 24h, when 24h should be a rolling timeline of the last 24 hourly buckets.

## What Was Fixed

### Backend Changes (`apps/api/src/routes/models.ts`)

**Location**: Lines 623-811 (hour-analysis endpoint)

**Key Changes**:

1. **Split logic based on period**:
   - `period=24h` → **Timeline mode** (last 24 hourly buckets chronologically)
   - `period=7d|30d` → **Hour-of-day mode** (aggregated by hour 0-23 across multiple days)

2. **24h Timeline Implementation** (Lines 656-748):
   ```typescript
   // Anchor to current UTC hour boundary
   const currentHourStart = new Date(Date.UTC(
     now.getUTCFullYear(),
     now.getUTCMonth(),
     now.getUTCDate(),
     now.getUTCHours(), 0, 0, 0
   ));
   
   // Calculate 24 hours ago from current hour start
   const startHourBoundary = new Date(currentHourStart.getTime() - 23 * 60 * 60 * 1000);
   ```

3. **Always return EXACTLY 24 buckets** (even if some hours have no data):
   ```typescript
   // Build EXACTLY 24 hourly buckets
   const hourBuckets = [];
   for (let i = 0; i < 24; i++) {
     const hourStart = new Date(startHourBoundary.getTime() + i * 60 * 60 * 1000);
     const key = hourStart.toISOString();
     const vals = bucketMap.get(key) ?? [];
     
     // If no data for this hour: avg/min/max = null, count = 0
     hourBuckets.push({
       ts: key,                    // ISO timestamp of hour start
       label: "HH:00",            // Display label
       avg: vals.length ? ... : null,
       min: vals.length ? ... : null,
       max: vals.length ? ... : null,
       count: vals.length
     });
   }
   ```

4. **Added mode discriminator** in response:
   ```typescript
   return {
     mode: 'timeline',        // For 24h
     // OR
     mode: 'hourOfDay',       // For 7d/30d
     modelId,
     period,
     suite,
     hours: hourBuckets,
     insights: {...}
   };
   ```

5. **Bucket structure differs by mode**:
   - **24h buckets**: `{ ts, label, avg, min, max, count }`
   - **7d/30d buckets**: `{ hour (0-23), avg, min, max, count }`

### Frontend Changes (`apps/web/app/router/performance-timing/page.tsx`)

**1. Updated TypeScript Interfaces** (Lines 16-40):
```typescript
interface HourBucket {
  hour?: number;        // For hour-of-day mode (7d/30d)
  ts?: string;          // For timeline mode (24h) - ISO timestamp
  label?: string;       // For timeline mode (24h) - display label
  avg: number | null;
  min: number | null;
  max: number | null;
  count: number;
}

interface HourAnalysisData {
  mode?: 'timeline' | 'hourOfDay';  // Backend mode indicator
  // ... rest of interface
  insights: {
    bestHour: number | string | null;  // Can be "14:00" or 14
    // ... rest
  };
}
```

**2. Updated Chart Component** (Lines 392-544):
```typescript
function HourOfDayChart({ data, period }) {
  const { hours, mode } = data;
  
  // Detect mode
  const isTimeline = mode === 'timeline' || period === '24h';
  
  // Use array indices for X positioning (works for both modes)
  const xScale = (index: number) => padding.left + (index / (hours.length - 1 || 1)) * plotWidth;
  
  // X-axis labels adapt based on mode
  {isTimeline ? (
    // Timeline: show labels from data (every 4th hour)
    hours.filter((h, i) => i % 4 === 0 && h.label).map((h, i) => ...)
  ) : (
    // Hour-of-day: show every 3 hours (0, 3, 6, ...)
    [0, 3, 6, 9, 12, 15, 18, 21].map(hour => ...)
  )}
}
```

**3. Added UX Helper for Low Coverage** (Lines 294-305):
```typescript
{period === '24h' && analysisData.insights.coverage < 50 && (
  <div className="terminal-text--dim">
    ℹ️ Only {dataPoints} test{s} ran in the last 24 hours — 
    empty hours are shown as gaps.
  </div>
)}
```

## Expected Behavior After Fix

### 24h Period (Timeline Mode)
- **Backend returns**: 24 buckets with `ts`, `label`, `avg/min/max`, `count`
- **X-axis**: Shows hour labels from the data (e.g., "10:00", "11:00", "12:00"...)
- **Empty hours**: Shown as `null` values (gaps in the chart)
- **Chart appearance**: May look sparse if only 4-5 tests ran (17% coverage)
- **Helper text**: "Only X tests ran in the last 24 hours — empty hours are shown as gaps"

### 7d Period (Hour-of-Day Mode)
- **Backend returns**: 24 buckets with `hour` (0-23), aggregated averages across 7 days
- **X-axis**: Fixed labels "00:00", "03:00", "06:00", ... "21:00"
- **Chart appearance**: Usually looks "full" because data accumulates across multiple days
- **No gaps**: Averages calculated for each hour-of-day

### 30d Period (Hour-of-Day Mode)
- Same as 7d but with 30 days of data aggregated

## How to Verify the Fix

### 1. Test Backend API Directly
```bash
# Test 24h timeline mode
curl http://localhost:4000/api/models/1/hour-analysis?period=24h&suite=hourly | jq '.'

# Should see:
# - mode: "timeline"
# - hours[].ts: "2026-01-12T10:00:00.000Z"
# - hours[].label: "10:00"
# - Exactly 24 buckets even if some have count=0

# Test 7d hour-of-day mode
curl http://localhost:4000/api/models/1/hour-analysis?period=7d&suite=hourly | jq '.'

# Should see:
# - mode: "hourOfDay"
# - hours[].hour: 0, 1, 2, ... 23
# - Exactly 24 buckets
```

### 2. Test Frontend in Browser
1. Open browser DevTools → Network tab
2. Navigate to `/router/performance-timing`
3. Switch between 24h/7d/30d
4. Verify:
   - Network tab shows different `period` parameters in API calls
   - Response JSON structure differs (check `mode` field)
   - Chart X-axis labels change between periods
   - 24h chart shows gaps if coverage < 50%

### 3. Visual Differences Expected
- **24h chart**: X-axis shows recent hour labels, may have gaps
- **7d chart**: X-axis shows "00:00" to "23:00", usually more complete
- **30d chart**: Same as 7d, potentially even more complete

## Debugging Checklist

If charts still look identical:

1. **Check backend logs** for mode detection:
   ```
   ⏱️  Timeline mode: Fetching last 24 hours of data
   📊 Hour-of-day mode: Aggregating across X days
   ```

2. **Inspect API response** in browser DevTools:
   - Does `mode` field exist?
   - Are bucket structures different between 24h and 7d?

3. **Check browser cache**:
   - Hard refresh (Ctrl+Shift+R)
   - Try incognito mode

4. **Verify build deployment**:
   - Backend: `cd /root/apps/api && npm run build`
   - Frontend: `cd /root/apps/web && npm run build`
   - Restart services:
     ```bash
     sudo systemctl restart aistupid-api
     sudo systemctl restart aistupid-web
     ```

## Files Modified

1. **apps/api/src/routes/models.ts** (Lines 623-811)
   - Added timeline mode for 24h period
   - Anchored to UTC hour boundaries
   - Always return 24 buckets
   - Added `mode` discriminator

2. **apps/web/app/router/performance-timing/page.tsx**
   - Lines 16-40: Updated TypeScript interfaces
   - Lines 148-152: Updated `formatHour` helper
   - Lines 294-305: Added low-coverage helper text
   - Lines 392-544: Updated chart rendering logic

## Why It Was Broken

**Original code** (WRONG):
```typescript
// Used for ALL periods including 24h
const hourlyData = await db
  .select({
    hour: sql`CAST(strftime('%H', ${scores.ts}) AS INTEGER)`,  // ← Hour-of-day (0-23)
    avgScore: sql`AVG(...)`,
  })
  .groupBy(sql`hour`)  // ← Groups by hour-of-day
```

**Result**: All periods (24h/7d/30d) returned the same hour-of-day buckets (0-23), making charts appear identical.

**Fixed code** (CORRECT):
```typescript
if (period === '24h') {
  // Fetch raw rows without hour-of-day grouping
  const rawRows = await db.select({ ts, stupidScore }).from(scores).where(...)
  
  // Bucket by actual UTC hour timestamp (not hour-of-day)
  // Return 24 chronological buckets with ts/label fields
}
```

**Result**: 24h returns timeline buckets, 7d/30d returns hour-of-day distribution.

## Contact

If issues persist, provide:
1. Screenshot of browser DevTools → Network tab showing API response
2. Backend logs showing mode detection
3. Frontend console errors (if any)
