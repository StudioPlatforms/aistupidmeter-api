# Verification Checklist for Hour Analysis Fix

## Required Checks (Do NOT skip)

### Check A: Inspect 24h API Response

**Steps**:
1. Open browser DevTools → Network tab
2. Navigate to `/router/performance-timing`
3. Select 24h period
4. Find the request: `hour-analysis?period=24h&suite=hourly`
5. Click on it → Response tab

**Verify ALL of these**:
- [ ] `mode === "timeline"` (exact string)
- [ ] `hours.length === 24` (exactly 24 buckets)
- [ ] Each `hours[i].ts` increments by exactly 1 hour
- [ ] Missing hours exist as objects with `{ avg: null, min: null, max: null, count: 0 }`
- [ ] Buckets have `ts` and `label` fields (NOT `hour` field)

**❌ If `hours.length` is NOT 24**: Backend is still returning only populated buckets - backend code is wrong.

**Expected Response Structure**:
```json
{
  "mode": "timeline",
  "modelId": 1,
  "period": "24h",
  "suite": "hourly",
  "hours": [
    {
      "ts": "2026-01-12T10:00:00.000Z",
      "label": "10:00",
      "avg": 75.3,
      "min": 72.1,
      "max": 78.5,
      "count": 2
    },
    {
      "ts": "2026-01-12T11:00:00.000Z",
      "label": "11:00",
      "avg": null,
      "min": null,
      "max": null,
      "count": 0
    },
    // ... exactly 24 total buckets
  ]
}
```

### Check B: Inspect 7d API Response

**Steps**: Same as above but select 7d period

**Verify ALL of these**:
- [ ] `mode === "hourOfDay"` (exact string)
- [ ] `hours.length === 24` (exactly 24 buckets)
- [ ] Entries have `hour` field with values 0..23
- [ ] Buckets have `hour` field (NOT `ts` or `label` fields)

**Expected Response Structure**:
```json
{
  "mode": "hourOfDay",
  "modelId": 1,
  "period": "7d",
  "suite": "hourly",
  "hours": [
    {
      "hour": 0,
      "avg": 72.5,
      "min": 68.2,
      "max": 76.8,
      "count": 7
    },
    {
      "hour": 1,
      "avg": 71.3,
      "min": 67.1,
      "max": 75.5,
      "count": 7
    },
    // ... 24 total buckets (one per hour-of-day)
  ]
}
```

### Check C: Inspect Chart Console Logs

**Steps**:
1. Open browser DevTools → Console tab
2. Switch between 24h/7d periods
3. Look for console.log output from the chart

**Verify for 24h**:
- [ ] `hoursLen: 24` (not 4 or some other number)
- [ ] `nonNullAvg` shows count of hours with data (e.g., 4)
- [ ] `first` object has `ts` and `label` fields
- [ ] `last` object has `ts` and `label` fields

**Verify for 7d**:
- [ ] `hoursLen: 24`
- [ ] `nonNullAvg` shows higher count (e.g., 18-24)
- [ ] `first` object has `hour: 0`
- [ ] `last` object has `hour: 23`

**Example Console Output (24h with sparse data)**:
```
period 24h mode timeline hoursLen 24
nonNullAvg 4
first { ts: "2026-01-12T10:00:00.000Z", label: "10:00", avg: null, min: null, max: null, count: 0 }
last { ts: "2026-01-13T09:00:00.000Z", label: "09:00", avg: 78.5, min: 76.2, max: 80.1, count: 1 }
```

## Visual Verification

### What "Correct" Looks Like

#### 24h Chart (with only 4 tests / 17% coverage)
- ✅ X-axis **spans the entire width** of the chart
- ✅ You see **4 dots** at their correct hour positions (spread across the width)
- ✅ The line has **visible gaps** between the dots
- ✅ X-axis labels show hour times like "10:00", "14:00", "18:00", "22:00"
- ❌ NOT everything stuck on the left side
- ❌ NOT all 4 dots clustered together

#### 7d Chart
- ✅ X-axis shows "00:00", "03:00", "06:00", "09:00", "12:00", "15:00", "18:00", "21:00"
- ✅ Usually has more complete data (fewer gaps)
- ✅ Line connects more points

#### 30d Chart
- ✅ Similar to 7d but potentially even more complete

## Common Issues and Fixes

### Issue 1: Backend returns < 24 buckets for 24h

**Symptom**: `hours.length` is 4 instead of 24 in the API response

**Cause**: Backend is only returning populated buckets, not generating all 24 hour slots

**Fix Location**: `apps/api/src/routes/models.ts` lines 656-730

**Required Fix**:
```typescript
// WRONG (only returns populated hours)
const hourBuckets = Array.from(bucketMap.values());

// CORRECT (always returns 24 buckets)
const hourBuckets = [];
for (let i = 0; i < 24; i++) {
  const hourStart = new Date(startHourBoundary.getTime() + i * 60 * 60 * 1000);
  const key = hourStart.toISOString();
  const vals = bucketMap.get(key) ?? [];
  
  hourBuckets.push({
    ts: key,
    label: `${String(hourStart.getUTCHours()).padStart(2, '0')}:00`,
    avg: vals.length ? ... : null,
    min: vals.length ? ... : null,
    max: vals.length ? ... : null,
    count: vals.length
  });
}
```

### Issue 2: Chart shows all dots clustered on left side

**Symptom**: Even though API returns 24 buckets, chart only shows data points on the left 20% of the chart

**Cause**: Frontend is using filtered array length instead of full array length for X positioning

**Fix Location**: `apps/web/app/router/performance-timing/page.tsx` lines 392-544

**Critical Rules**:
1. **X positioning must use FULL array**: `const N = hours.length; const xScale = (i) => ... i / (N - 1) ...`
2. **Never filter before calculating X position**: Use `hours.map((h, i) => ...)` not `hours.filter().map()`
3. **Skip rendering null points but keep their X slots**: `if (h.avg === null) return null;`

**Required Fix**:
```typescript
// WRONG (filters before positioning - compresses X scale)
const points = hours.filter(h => h.avg !== null);
const xScale = (i) => padding.left + (i / (points.length - 1)) * plotWidth;

// CORRECT (uses full array for positioning)
const N = hours.length; // MUST be 24
const xScale = (i) => padding.left + (i / (N - 1)) * plotWidth;

// Then when rendering:
hours.map((h, i) => {
  if (h.avg === null) return null; // Skip rendering but keep X slot
  return <circle cx={xScale(i)} cy={yScale(h.avg)} />;
})
```

### Issue 3: Charts still look identical after fix

**Symptom**: 24h and 7d charts appear exactly the same

**Possible Causes**:
1. **Browser cache**: Old JavaScript bundle still loaded
   - Fix: Hard refresh (Ctrl+Shift+R) or use incognito mode
   
2. **Build not deployed**: Code changes not compiled/restarted
   - Fix: 
     ```bash
     cd /root/apps/api && npm run build
     cd /root/apps/web && npm run build
     sudo systemctl restart aistupid-api
     sudo systemctl restart aistupid-web
     ```

3. **API returning wrong mode**: Both periods return same mode
   - Fix: Check backend code - ensure `if (period === '24h')` branch is executed

## Success Criteria

**All of these must be true**:
- [ ] 24h API response has `mode: "timeline"` and 24 buckets with `ts`/`label`
- [ ] 7d API response has `mode: "hourOfDay"` and 24 buckets with `hour: 0-23`
- [ ] Console logs show `hoursLen: 24` for both periods
- [ ] 24h chart X-axis spans full width even with sparse data
- [ ] 24h chart shows gaps between non-null data points
- [ ] 7d chart X-axis shows different labels than 24h chart
- [ ] Visual appearance differs between 24h and 7d/30d

**If ANY of these fail**: Use this checklist to identify which step is broken.
