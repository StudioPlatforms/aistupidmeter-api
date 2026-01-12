# Tool Calling System - Fix Summary

## Overview

We've identified and fixed **three critical bugs** that were preventing most models from making tool calls in the benchmark system. The primary issue was that GPT-5 and o-series models (which use OpenAI's Responses API) had their tool calls completely discarded due to a hardcoded empty array.

---

## Critical Bugs Fixed

### 🔴 Bug #1: Responses API Tool Calls Discarded (CRITICAL)

**Location**: [`src/llm/adapters.ts:192`](src/llm/adapters.ts:192)

**Problem**: 
```typescript
// OLD CODE - Line 192
return {
  text,
  tokensIn: ...,
  tokensOut: ...,
  toolCalls: [],  // ❌ HARDCODED EMPTY ARRAY
  raw: j
};
```

**Impact**: ALL tool calls from GPT-5, o1, o3, and other Responses API models were lost. These models would never make tool calls, resulting in 0% scores.

**Fix**: Implemented comprehensive tool call extraction that checks multiple response structures:
```typescript
// NEW CODE - Lines 188-240
const toolCalls: Array<{ name: string; arguments: any }> = [];

// Extract from j.output[*].content (primary Responses API format)
// Extract from j.choices[0].message.tool_calls (fallback format)
// Extract from j.message.content (alternative format)
// Support both 'tool_use' and 'function' types

return {
  text,
  tokensIn: ...,
  tokensOut: ...,
  toolCalls,  // ✅ NOW PROPERLY EXTRACTED
  raw: j
};
```

### 🔴 Bug #2: Incompatible Parameter Added

**Location**: [`src/toolbench/tools/core/execute-command.ts`](src/toolbench/tools/core/execute-command.ts)

**Problem**: Added `requires_approval: boolean` parameter from Cline and marked it as `required: true`. Models weren't trained with this parameter, so they couldn't make valid `execute_command` calls.

**Fix**: Removed `requires_approval` entirely from:
- Tool definitions: [`src/toolbench/tools/definitions/execute-command.ts`](src/toolbench/tools/definitions/execute-command.ts)
- Base tool: [`src/toolbench/tools/core/execute-command.ts`](src/toolbench/tools/core/execute-command.ts)

**Note**: Can be re-added later as an **optional** parameter after testing with each model family.

### 🟡 Bug #3: Double-Formatting Issue

**Location**: [`src/toolbench/tools/registry.ts`](src/toolbench/tools/registry.ts:238)

**Problem**: The registry was returning provider-specific formatted tools (e.g., OpenAI's `{type: 'function', function: {...}}`), but the adapters ALSO format tools internally. This caused double-wrapping.

**Fix**: Modified `formatToolsForLLM()` to return simple `ToolDef` format. The adapters now handle provider-specific wrapping themselves:
```typescript
// Registry returns simple format
{
  name: string,
  description: string,
  parameters: {
    type: 'object',
    properties: {...},
    required: [...]
  }
}

// Adapter wraps it (e.g., for OpenAI)
{
  type: 'function',
  function: {
    name: ...,
    description: ...,
    parameters: ...
  }
}
```

---

## Enhancements Added

### 🔍 Debug Logging System

**Enable with**: `DEBUG_TOOLS=1`

**Logging Points**:

1. **ToolRegistry** ([`src/toolbench/tools/registry.ts:177`](src/toolbench/tools/registry.ts:177))
   - Number of tools being formatted
   - Tool names
   - Model family detection
   - Sample tool structure

2. **OpenAI Adapter** ([`src/llm/adapters.ts:109`](src/llm/adapters.ts:109))
   - Tools sent to Responses API
   - Raw response structure
   - Tool calls extracted

**Example Output**:
```
[ToolRegistry] Formatting 5 tools for provider: openai, model: gpt-5.1, family: OpenAI
[ToolRegistry] Tool names: execute_command, read_file, write_file, list_files, search_files
[OpenAI Responses API] Sending 5 tools: execute_command, read_file, write_file, list_files, search_files
[OpenAI Responses API] Raw response structure: { hasOutput: true, hasChoices: false, ... }
[OpenAI Responses API] Extracted 2 tool calls: list_files, read_file
```

### ✨ Model-Specific Tool Variants

**Implementation**: Created optimized tool descriptions for different model families:
- Generic (fallback)
- OpenAI (GPT family)
- Anthropic (Claude family)
- Google (Gemini family)
- DeepSeek
- OpenRouter

**Location**: [`src/toolbench/tools/definitions/`](src/toolbench/tools/definitions/)

**Benefit**: Each model family gets tool descriptions matching their training and capabilities.

---

## Files Modified

### Core Fixes
1. **src/llm/adapters.ts**
   - Fixed Responses API tool call extraction (lines 188-240)
   - Added debug logging (lines 109-113, 190-200, 238-240)

2. **src/toolbench/tools/core/execute-command.ts**
   - Removed `requires_approval` parameter

3. **src/toolbench/tools/definitions/execute-command.ts**
   - Removed `requires_approval` from all variants

4. **src/toolbench/tools/registry.ts**
   - Fixed `formatToolsForLLM()` to return simple ToolDef format
   - Added debug logging (lines 177-181)

### Enhancement Layer (Already Implemented)
- **src/toolbench/tools/spec.ts** - Core specification system
- **src/toolbench/tools/definitions/*.ts** - Model-specific variants

---

## Testing Instructions

### Quick Test (After Rebuild)

```bash
cd /root/apps/api
chmod +x TEST_TOOL_CALLING_FIXES.sh
./TEST_TOOL_CALLING_FIXES.sh
```

This will:
1. Test GPT-5.1 with DEBUG_TOOLS enabled
2. Test a Claude model for comparison
3. Show detailed output to verify fixes

### Manual Test with Debugging

```bash
cd /root/apps/api
DEBUG_TOOLS=1 npx ts-node -e "
import { ToolBenchmarkSession } from './src/toolbench/session/benchmark-session';
import { EASY_TASKS } from './src/toolbench/tasks/definitions';
import { getAdapter } from './src/jobs/real-benchmarks';
import { db } from './src/db';
import { models } from './src/db/schema';
import { eq } from 'drizzle-orm';

(async () => {
  const [model] = await db.select().from(models).where(eq(models.name, 'gpt-5.1')).limit(1);
  const task = EASY_TASKS[0];
  const adapter = getAdapter('openai');
  
  const session = new ToolBenchmarkSession(model, task, adapter);
  const result = await session.run();
  
  console.log('Tool Calls:', result.summary.toolCallsCount);
  console.log('Score:', result.finalScore);
})();
"
```

### Full Benchmark Suite

```bash
cd /root/apps/api
npm run benchmark
```

---

## Expected Results

### Before Fixes
| Model Family | Score | Tool Calls |
|-------------|-------|------------|
| GPT-5.x     | 0-3%  | 0          |
| o1/o3       | 0-3%  | 0          |
| Grok        | 3%    | Very few   |
| DeepSeek    | 3%    | Very few   |
| Gemini      | 3%    | Very few   |
| Claude      | 45-63%| Many       |

### After Fixes (Expected)
| Model Family | Expected Score | Expected Tool Calls |
|-------------|----------------|---------------------|
| GPT-5.x     | 40-70%         | Multiple per task   |
| o1/o3       | 40-70%         | Multiple per task   |
| Grok        | 30-60%         | Improved            |
| DeepSeek    | 30-60%         | Improved            |
| Gemini      | 30-60%         | Improved            |
| Claude      | 45-63%         | Unchanged           |

---

## Validation Checklist

After testing, verify:

- [ ] GPT-5.1 shows `toolCallsCount > 0` 
- [ ] GPT-5.1 score is above 0%
- [ ] Debug logs show tools being sent to API
- [ ] Debug logs show tool calls in response
- [ ] Debug logs show tool calls being extracted
- [ ] Claude models still work as before (45-63%)
- [ ] No TypeScript compilation errors
- [ ] No runtime errors in tool execution

---

## Rollback Plan

If issues persist or new problems emerge:

### Immediate Rollback
```bash
git checkout HEAD~1 src/llm/adapters.ts
git checkout HEAD~1 src/toolbench/tools/core/execute-command.ts
git checkout HEAD~1 src/toolbench/tools/definitions/execute-command.ts
```

### Partial Rollback (Keep Enhancements)
Only revert the critical fixes while keeping:
- Model-specific variants system
- Debug logging infrastructure
- Tool specification architecture

---

## Next Steps

1. **Rebuild and restart** backend
2. **Run test script**: `./TEST_TOOL_CALLING_FIXES.sh`
3. **Check DEBUG_TOOLS output** to verify tool flow
4. **Run full benchmark** if tests pass
5. **Monitor live rankings** for score improvements
6. **Document any remaining issues**

---

## Support

If you encounter issues:

1. **Enable DEBUG_TOOLS** and check output
2. **Review** [`TOOL_CALLING_CRITICAL_FIXES.md`](TOOL_CALLING_CRITICAL_FIXES.md)
3. **Check logs** for specific error messages
4. **Compare** working models (Claude) vs non-working models

---

## Key Learnings

1. **Always extract tool calls** - Never hardcode empty arrays
2. **Test incrementally** - Don't deploy multiple changes at once
3. **Parameters must be optional** - Unless all models are trained with them
4. **Adapters format tools** - Don't double-format in the registry
5. **Debug logging is essential** - Add it proactively, not reactively

---

**Last Updated**: 2026-01-06 15:02 UTC  
**Status**: ✅ Fixes Applied, Awaiting Backend Rebuild & Testing
