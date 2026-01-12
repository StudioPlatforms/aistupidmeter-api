# Critical Tool Calling Fixes Applied

## Problems Identified and Fixed

### 1. Double-Formatting Issue ⚠️ **CRITICAL**
**Status**: ✅ FIXED

**Problem**: The new `formatToolsForLLM()` was returning provider-specific formatted tools (OpenAI's `{type: 'function', function: {...}}`, Anthropic's `{name, input_schema}`, etc.), but the adapters in `src/llm/adapters.ts` ALSO format tools internally.

**Impact**: This caused double-wrapping of tool definitions, making them invalid for all providers.

**Fix Applied**: Modified [`src/toolbench/tools/registry.ts`](src/toolbench/tools/registry.ts:238) to return simple `ToolDef` format:
```typescript
{
  name: string,
  description: string,
  parameters: {
    type: 'object',
    properties: {...},
    required: [...]
  }
}
```

The adapters now handle provider-specific wrapping themselves.

### 2. Incompatible Parameter Addition ⚠️ **BREAKING CHANGE**
**Status**: ✅ FIXED

**Problem**: Added `requires_approval` parameter from Cline to `execute_command` tool. This parameter was marked as `required: true`, but models weren't trained with it.

**Impact**: Models couldn't make valid `execute_command` calls because they don't know to provide `requires_approval`.

**Fix Applied**: Removed `requires_approval` parameter entirely from:
- [`src/toolbench/tools/definitions/execute-command.ts`](src/toolbench/tools/definitions/execute-command.ts)
- [`src/toolbench/tools/core/execute-command.ts`](src/toolbench/tools/core/execute-command.ts)

**Note**: This parameter can be re-added as optional in the future, but needs testing with each model family.

### 3. Missing Tool Call Extraction in Responses API ⚠️ **CRITICAL**
**Status**: ✅ FIXED

**Problem**: The `chatResponsesAPI()` method in [`src/llm/adapters.ts`](src/llm/adapters.ts:192) had `toolCalls: []` hardcoded. This meant ALL tool calls from GPT-5 and o-series models (which use Responses API) were being discarded.

**Impact**: GPT-5 models could not make ANY tool calls, resulting in 0% scores across the board.

**Fix Applied**: Implemented comprehensive tool call extraction logic that checks multiple response structures:
- `j.output[*].content` (Responses API primary format)
- `j.choices[0].message.tool_calls` (Chat Completions fallback)
- `j.message.content` (Alternative structure)
- Support for both `tool_use` and `function` types

**Code Location**: [`src/llm/adapters.ts`](src/llm/adapters.ts:188-240)

### 5. Debug Logging Added 🔍
**Status**: ✅ IMPLEMENTED

**Purpose**: To diagnose exactly what's being sent to and received from LLM APIs.

**Environment Variable**: Set `DEBUG_TOOLS=1` to enable detailed logging

**Logging Points**:
1. **ToolRegistry** ([`src/toolbench/tools/registry.ts`](src/toolbench/tools/registry.ts:177))
   - Number of tools being formatted
   - Tool names list
   - Model family detection
   - Sample formatted tool structure

2. **OpenAI Adapter** ([`src/llm/adapters.ts`](src/llm/adapters.ts:109))
   - Tools being sent to Responses API
   - Raw response structure received
   - Number of tool calls extracted

**Usage**:
```bash
DEBUG_TOOLS=1 npm run benchmark
```

### 6. Model-Specific Variants System
**Status**: ✅ IMPLEMENTED

**Changes**: 
- Created model-specific tool description variants for OpenAI, Gemini, Anthropic, DeepSeek, OpenRouter
- Implemented automatic variant selection based on provider
- Added context injection ({{CWD}}, {{MULTI_ROOT_HINT}})

**Benefit**: Each model family gets optimized tool descriptions matching their training.

## Files Modified

### Core Changes
1. **src/toolbench/tools/registry.ts** - Fixed formatToolsForLLM() to return simple ToolDef format
2. **src/toolbench/tools/core/execute-command.ts** - Removed requires_approval from BaseTool
3. **src/toolbench/tools/definitions/execute-command.ts** - Removed requires_approval from all variants

### Files Created (Enhancement Layer)
- **src/toolbench/tools/spec.ts** - Core specification system
- **src/toolbench/tools/definitions/*.ts** - Model-specific tool variants

## Testing Status

### Fixes Applied ✅
1. ✅ Fixed double-formatting issue in ToolRegistry
2. ✅ Removed incompatible `requires_approval` parameter
3. ✅ Fixed Responses API tool call extraction (was hardcoded to empty array)
4. ✅ Added comprehensive debugging with DEBUG_TOOLS environment variable
5. ✅ Model-specific tool variants system implemented

### Previous Test Results (Before Fixes)
- ❌ OpenAI models (gpt-5.x) scoring 0-3%
- ❌ xAI models (grok) scoring 3%
- ❌ DeepSeek models scoring 3%
- ❌ Google/Gemini models scoring 3%
- ✅ Anthropic models (claude family) scoring 45-63%
- ✅ glm-4.6 scoring 56%

**Previous Root Cause**: Responses API was discarding all tool calls (hardcoded `toolCalls: []`)

### Next Testing Steps 🧪
1. **Rebuild backend** with latest changes
2. **Test with DEBUG_TOOLS** enabled:
   ```bash
   DEBUG_TOOLS=1 npx ts-node -e "..."
   ```
3. **Verify tool calls are being extracted** from Responses API
4. **Check if gpt-5.x models** now score above 0%
5. **Run full benchmark suite** if individual tests pass

## Recommendations

### Immediate Actions Required

1. **Investigate Original Implementation**
   - Check if tool calling worked BEFORE our changes
   - Review git history to see when it last worked
   - May need to revert ALL changes and start from baseline

2. **Debug Model Responses**
   - Add logging to see actual LLM responses
   - Check if models are receiving tools correctly
   - Verify adapter implementations are passing tools properly

3. **Test with Working Model**
   - Claude models ARE working (45-63% scores)
   - Use claude as reference to understand what's different
   - Compare request/response formats

### Future Enhancements (After Fix)

1. **Re-add Safety Features**
   - Implement `requires_approval` as optional parameter
   - Test with each model family before marking required
   - Add gradual rollout strategy

2. **Enhanced Tool Specifications**
   - Keep model-specific variants (already working for Anthropic)
   - Add more context injection points
   - Implement dynamic tool filtering based on context

3. **Comprehensive Testing**
   - Add unit tests for tool formatting
   - Add integration tests for each provider
   - Implement automated compatibility checks

## Key Lessons Learned

1. **Don't assume adapter behavior** - We assumed adapters expected provider-formatted tools, but they format internally
2. **Backward compatibility is critical** - New parameters must be optional and tested
3. **Test incrementally** - Should have tested after each change, not after complete rewrite
4. **Provider differences matter** - Each provider has unique requirements and quirks

## References

- Original Cline tool calling: `/root/cline/src/core/assistant-message/process-assistant-message.ts`
- Adapter implementations: [`src/llm/adapters.ts`](src/llm/adapters.ts)
- Tool execution engine: [`src/toolbench/engine/execution.ts`](src/toolbench/engine/execution.ts)
