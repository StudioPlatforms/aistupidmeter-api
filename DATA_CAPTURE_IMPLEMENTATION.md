# High-Value Data Capture Implementation Plan

## Overview
This document outlines the implementation plan for capturing high-value benchmark data that can be monetized to AI companies. The implementation focuses on three key areas:

1. **Raw LLM Outputs** - Capture full responses before code extraction
2. **Per-Test-Case Results** - Granular test execution data
3. **API Version Tracking** - Correlate performance with model versions

## Database Schema (✅ COMPLETED)

### Tables Created
- `raw_outputs` - Stores full LLM responses and extraction metadata
- `test_case_results` - Per-test-case execution results
- `adversarial_prompts` - Library of safety/jailbreak test prompts
- `adversarial_results` - Results from adversarial testing

### Schema Additions
- Added `api_version`, `response_headers`, `model_fingerprint` columns to `runs` table

## Implementation Status

### Phase 1: Database Setup ✅
- [x] Schema design
- [x] Migration SQL created
- [x] Migration executed successfully
- [x] Tables verified in database

### Phase 2: Code Integration (IN PROGRESS)
- [x] Import new schema tables into real-benchmarks.ts
- [ ] Modify `runSingleBenchmarkStreaming()` to save raw outputs
- [ ] Modify `evaluateCode()` to save per-test-case results
- [ ] Extract and save API version headers
- [ ] Save response headers for fingerprinting

## Next Steps

### 1. Modify runSingleBenchmarkStreaming()

**Location**: Line ~1150 in `apps/api/src/jobs/real-benchmarks.ts`

**After receiving LLM response** (around line 1200):
```typescript
// After: const rawText = extractTextFromAdapter(res);

// HIGH VALUE DATA CAPTURE: Save raw output before extraction
try {
  const extractionSuccess = sanitized && sanitized.length >= 10;
  const extractionMethod = /```/.test(rawText) ? 'code_block' : 
                          /^(def|class)\s+/.test(rawText) ? 'plain_text' : 'failed';
  
  // Determine failure type if extraction failed
  let failureType: string | null = null;
  let failureDetails: string | null = null;
  
  if (!extractionSuccess) {
    if (rawText.length === 0) {
      failureType = 'empty_response';
    } else if (/sorry|cannot|unable|inappropriate/i.test(rawText)) {
      failureType = 'refusal';
    } else if (rawText.length > 5000) {
      failureType = 'hallucination';
    } else {
      failureType = 'extraction_failed';
      failureDetails = `Raw length: ${rawText.length}, extracted: ${sanitized?.length || 0}`;
    }
  }
  
  // Save to raw_outputs table (will be linked to run after persistCollapsedRun)
  // Note: We'll need to pass this data through and save it after we have runId
  const rawOutputData = {
    rawText,
    extractedCode: sanitized,
    extractionSuccess,
    extractionMethod,
    failureType,
    failureDetails
  };
  
  // Attach to result for later persistence
  result.rawOutputData = rawOutputData;
  
} catch (captureError) {
  console.warn(`[RAW-OUTPUT-CAPTURE] Failed: ${String(captureError).slice(0, 100)}`);
  // Don't let capture errors break benchmarking
}
```

### 2. Modify evaluateCode()

**Location**: Line ~650 in `apps/api/src/jobs/real-benchmarks.ts`

**Inside the test execution loop** (around line 750):
```typescript
// After each test case execution, capture results
const testCaseResults = [];

// In the test loop (around line 750-800):
for (const tc of task.testCases) {
  const testStart = Date.now();
  let testPassed = false;
  let actualOutput: string | null = null;
  let errorMessage: string | null = null;
  
  try {
    // ... existing test execution code ...
    testPassed = result == expected;
    actualOutput = String(result);
  } catch (e) {
    errorMessage = String(e).slice(0, 500);
  }
  
  const testEnd = Date.now();
  
  // HIGH VALUE DATA CAPTURE: Save per-test-case result
  testCaseResults.push({
    testCaseIndex: testCaseResults.length,
    testInput: tc.input,
    expectedOutput: tc.expected,
    actualOutput,
    passed: testPassed,
    errorMessage,
    executionTimeMs: testEnd - testStart
  });
}

// Return test case results with evaluation metrics
return { 
  ...evalMetrics, 
  testCaseResults // Add this to return value
};
```

### 3. Extract API Version Headers

**Location**: After LLM API call in `runSingleBenchmarkStreaming()`

```typescript
// After: const res = await withBackoff(() => adapter.chat(chatRequest));

// HIGH VALUE DATA CAPTURE: Extract API version and response headers
let apiVersion: string | null = null;
let responseHeaders: Record<string, string> = {};
let modelFingerprint: string | null = null;

try {
  // Extract from response object (varies by provider)
  if (res && typeof res === 'object') {
    // OpenAI style
    apiVersion = (res as any)?.model || 
                 (res as any)?.response?.model ||
                 (res as any)?.headers?.['openai-model'] ||
                 null;
    
    // Capture response headers if available
    const headers = (res as any)?.headers || (res as any)?.response?.headers;
    if (headers && typeof headers === 'object') {
      responseHeaders = { ...headers };
    }
    
    // Generate fingerprint from response characteristics
    const fingerprintData = {
      tokensIn: finalTokensIn,
      tokensOut: finalTokensOut,
      latencyMs,
      responseLength: rawText.length,
      timestamp: new Date().toISOString().slice(0, 10) // Date only
    };
    modelFingerprint = crypto.createHash('sha256')
      .update(JSON.stringify(fingerprintData))
      .digest('hex')
      .slice(0, 16);
  }
} catch (headerError) {
  console.warn(`[HEADER-CAPTURE] Failed: ${String(headerError).slice(0, 100)}`);
}

// Attach to result
result.apiVersion = apiVersion;
result.responseHeaders = responseHeaders;
result.modelFingerprint = modelFingerprint;
```

### 4. Persist Captured Data

**Location**: Modify `persistCollapsedRun()` function (around line 1800)

```typescript
async function persistCollapsedRun(params: {
  modelId: number; taskSlug: string;
  latencyMs: number; tokensIn: number; tokensOut: number;
  axes: Axes; code?: string;
  // NEW: Add captured data
  rawOutputData?: any;
  testCaseResults?: any[];
  apiVersion?: string | null;
  responseHeaders?: Record<string, string>;
  modelFingerprint?: string | null;
}) {
  try {
    // ... existing code to insert run ...
    
    const runId = runInsert[0].id;
    
    // ... existing metrics insert ...
    
    // HIGH VALUE DATA CAPTURE: Save raw output
    if (params.rawOutputData && runId) {
      try {
        await db.insert(raw_outputs).values({
          runId,
          rawText: params.rawOutputData.rawText,
          extractedCode: params.rawOutputData.extractedCode,
          extractionSuccess: params.rawOutputData.extractionSuccess,
          extractionMethod: params.rawOutputData.extractionMethod,
          failureType: params.rawOutputData.failureType,
          failureDetails: params.rawOutputData.failureDetails
        });
      } catch (rawError) {
        console.warn(`[RAW-OUTPUT-PERSIST] Failed for run ${runId}: ${String(rawError).slice(0, 100)}`);
      }
    }
    
    // HIGH VALUE DATA CAPTURE: Save test case results
    if (params.testCaseResults && runId) {
      try {
        for (const tcResult of params.testCaseResults) {
          await db.insert(test_case_results).values({
            runId,
            ...tcResult
          });
        }
      } catch (tcError) {
        console.warn(`[TEST-CASE-PERSIST] Failed for run ${runId}: ${String(tcError).slice(0, 100)}`);
      }
    }
    
    // Update run with API version tracking
    if (runId && (params.apiVersion || params.responseHeaders || params.modelFingerprint)) {
      try {
        await db.update(runs)
          .set({
            apiVersion: params.apiVersion,
            responseHeaders: params.responseHeaders ? JSON.stringify(params.responseHeaders) : null,
            modelFingerprint: params.modelFingerprint
          })
          .where(eq(runs.id, runId));
      } catch (versionError) {
        console.warn(`[VERSION-TRACKING] Failed for run ${runId}: ${String(versionError).slice(0, 100)}`);
      }
    }
    
    return runId;
  } catch (e) {
    console.warn(`[PERSIST-ERROR] ${params.taskSlug}: ${String(e).slice(0,200)}`);
    return null;
  }
}
```

## Data Value Proposition

### 1. Raw Outputs ($50K-150K/year)
- **What**: Full LLM responses before code extraction
- **Why Valuable**: 
  - Reveals failure modes and hallucination patterns
  - Shows how models format responses
  - Identifies extraction issues vs. generation issues
- **Buyers**: Model developers, safety researchers

### 2. Per-Test-Case Results ($30K-100K/year)
- **What**: Individual test case pass/fail with timing
- **Why Valuable**:
  - Shows which specific scenarios models struggle with
  - Reveals edge case handling patterns
  - Enables targeted model improvement
- **Buyers**: Model training teams, benchmark designers

### 3. API Version Tracking ($20K-50K/year)
- **What**: Correlation between model versions and performance
- **Why Valuable**:
  - Tracks performance changes across model updates
  - Identifies regressions or improvements
  - Helps with model deployment decisions
- **Buyers**: Enterprise AI teams, model providers

### 4. Adversarial Testing Data ($300K-1M/year)
- **What**: Safety and jailbreak test results
- **Why Valuable**:
  - Extremely rare and difficult to collect
  - Critical for model safety evaluation
  - Required for regulatory compliance
- **Buyers**: Safety teams, regulators, enterprise customers

## Total Potential Value
**$400K - $1.4M per year** from systematic data collection

## Privacy & Ethics
- All data is from public benchmark tasks
- No user data or proprietary information
- Models are tested with consent (via API usage)
- Data can be anonymized for sale if needed

## Implementation Timeline
1. **Week 1**: Complete code integration (this document)
2. **Week 2**: Test data capture with sample benchmarks
3. **Week 3**: Verify data quality and completeness
4. **Week 4**: Begin data aggregation and analysis
5. **Month 2**: Prepare data products for sale

## Success Metrics
- 100% capture rate for raw outputs
- 100% capture rate for test case results
- 90%+ capture rate for API version headers
- Zero performance impact on benchmarks
- Data storage < 500MB per 10K runs
