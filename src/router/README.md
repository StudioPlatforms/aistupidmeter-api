# Smart Router System

Production-ready intelligent model routing system that automatically selects the best AI model based on prompt analysis and benchmark data.

## 🎯 Overview

The Smart Router analyzes user prompts to detect programming language, task type, and complexity, then automatically routes to the optimal model based on real benchmark performance data.

## 📁 Directory Structure

```
router/
├── analyzer/
│   └── prompt-analyzer.ts    # Fast pattern-matching prompt analysis
├── selector/
│   ├── index.ts              # Core model selection logic
│   └── smart-selector.ts     # Automatic routing with prompt analysis
├── keys/                     # API key management
├── proxy/                    # Request proxying
└── jobs/                     # Background jobs
```

## 🚀 Quick Start

### Basic Usage

```typescript
import { selectModelAutomatically } from './router/selector/smart-selector';

// Automatic routing based on prompt
const result = await selectModelAutomatically(
  "Create a React component for a todo list",
  userId,
  { includeAlternatives: true }
);

console.log(result);
// {
//   model: "claude-sonnet-4-20250514",
//   provider: "anthropic",
//   score: 87.3,
//   reasoning: "Selected for ui tasks in javascript...",
//   estimatedCost: 0.009,
//   analysis: {
//     language: "javascript",
//     taskType: "ui",
//     framework: "react",
//     complexity: "medium",
//     confidence: 0.92
//   }
// }
```

### Manual Strategy Selection

```typescript
import { selectBestModel } from './router/selector';

// Manual strategy selection (existing system)
const result = await selectBestModel({
  userId: 123,
  strategy: 'best_coding',
  maxCost: 0.01,
  excludeProviders: ['openai']
});
```

## 🔍 Prompt Analyzer

### Features

- **Fast**: Sub-50ms pattern matching (no AI overhead)
- **Accurate**: 85-95% confidence on clear prompts
- **Comprehensive**: Detects language, task type, framework, complexity

### Supported Languages

- Python
- JavaScript
- TypeScript
- Rust
- Go

### Supported Task Types

- **UI**: Frontend components, styling, layouts
- **Algorithm**: Data structures, sorting, optimization
- **Backend**: APIs, databases, servers
- **Debug**: Error fixing, troubleshooting
- **Refactor**: Code improvement, restructuring

### Supported Frameworks

- React, Vue, Angular, Next.js (Frontend)
- Express, FastAPI, Django, Flask (Backend)

### Example Analysis

```typescript
import { analyzePrompt, getAnalysisSummary } from './router/analyzer/prompt-analyzer';

const analysis = analyzePrompt(
  "Write a Python function to implement binary search on a sorted array"
);

console.log(getAnalysisSummary(analysis));
// "Language: python | Task: algorithm | Complexity: medium | Confidence: 88%"

console.log(analysis);
// {
//   language: "python",
//   taskType: "algorithm",
//   complexity: "medium",
//   keywords: ["binary", "search", "sorted", "array", "function"],
//   confidence: 0.88,
//   detectionReasons: [
//     "Python keywords detected",
//     "Algorithm keywords detected"
//   ]
// }
```

## 🎯 Smart Selector

### Automatic Strategy Determination

The smart selector automatically chooses the optimal strategy based on task analysis:

| Task Type | Complexity | Strategy |
|-----------|-----------|----------|
| UI | Simple/Medium | `fastest` |
| UI | Complex | `best_coding` |
| Algorithm | Simple/Medium | `best_coding` |
| Algorithm | Complex | `best_reasoning` |
| Backend | Any | `best_coding` |
| Debug | Any | `best_reasoning` |
| Refactor | Any | `best_coding` |

### Task-Specific Rankings

Queries benchmark data filtered by:
- Programming language
- Task type
- Benchmark suite (hourly/deep/tooling)
- User's available providers

### Cost Optimization

Automatically balances performance vs cost:
- Prefers models within 5% performance of top model
- Considers cost savings >30% significant
- Respects user-defined cost constraints

## 🛠️ Utility Functions

### Explain Selection (Preview)

```typescript
import { explainSelection } from './router/selector/smart-selector';

const explanation = await explainSelection(
  "Debug this React component that's not rendering",
  userId
);

console.log(explanation);
// {
//   analysis: { language: "javascript", taskType: "debug", ... },
//   strategy: "best_reasoning",
//   reasoning: "Would select claude-opus-4-1-20250805...",
//   availableModels: 8
// }
```

### Compare Strategies

```typescript
import { compareStrategies } from './router/selector/smart-selector';

const comparison = await compareStrategies(
  "Implement a REST API for user management",
  userId
);

console.log(comparison);
// [
//   { strategy: "best_overall", model: "gpt-4o", cost: 0.0065, ... },
//   { strategy: "best_coding", model: "claude-sonnet-4", cost: 0.009, ... },
//   { strategy: "cheapest", model: "gemini-2.5-flash", cost: 0.00045, ... },
//   ...
// ]
```

### Batch Processing

```typescript
import { selectModelsForBatch } from './router/selector/smart-selector';

const prompts = [
  "Create a login form in React",
  "Implement quicksort in Python",
  "Build a REST API in Go"
];

const results = await selectModelsForBatch(prompts, userId);
// Returns array of { prompt, selection } objects
```

## 📊 How It Works

```
┌─────────────────┐
│   User Prompt   │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Prompt Analyzer │ ◄── Pattern matching (50ms)
│  - Language     │
│  - Task Type    │
│  - Framework    │
│  - Complexity   │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│   Determine     │ ◄── Map task → strategy
│    Strategy     │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Query Rankings  │ ◄── Filter by language/task
│  (Cached 5min)  │     Use benchmark data
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Cost Optimize   │ ◄── Balance performance/cost
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Apply User      │ ◄── Preferences, constraints
│  Preferences    │     Available providers
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Select Best     │
│     Model       │
└─────────────────┘
```

## 🔧 Configuration

### User Preferences

Users can configure routing preferences in the database:

```sql
-- Router preferences table
CREATE TABLE router_preferences (
  user_id INTEGER PRIMARY KEY,
  routing_strategy TEXT,           -- 'best_overall', 'best_coding', etc.
  max_cost_per_1k_tokens REAL,     -- Cost constraint
  max_latency_ms INTEGER,           -- Latency constraint
  excluded_providers TEXT,          -- JSON array
  excluded_models TEXT              -- JSON array
);

-- Provider API keys
CREATE TABLE router_provider_keys (
  user_id INTEGER,
  provider TEXT,
  api_key TEXT,
  is_active BOOLEAN DEFAULT true
);
```

### Environment Variables

```bash
# Provider API Keys (for benchmarking)
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
GEMINI_API_KEY=...
XAI_API_KEY=...
DEEPSEEK_API_KEY=...
GLM_API_KEY=...
KIMI_API_KEY=...

# Optional: Score calibration
SCORE_SCALE=1.0
SCORE_LIFT=0
SCORE_MIN=0
SCORE_MAX=100
```

## 📈 Performance

- **Prompt Analysis**: <50ms (pattern matching)
- **Model Selection**: 50-200ms (cached rankings)
- **Total Overhead**: <250ms per request
- **Cache Hit Rate**: ~95% (5-minute TTL)

## 🧪 Testing

```typescript
// Test prompt analyzer
import { analyzePrompt } from './router/analyzer/prompt-analyzer';

const testCases = [
  "Create a React component",
  "Implement binary search in Python",
  "Debug this API endpoint",
  "Refactor this Rust code"
];

testCases.forEach(prompt => {
  const analysis = analyzePrompt(prompt);
  console.log(`${prompt} → ${analysis.language}/${analysis.taskType}`);
});
```

## 🚀 Next Steps

### Phase 1: API Endpoints (Week 6)
- [ ] Create `POST /v1/chat/completions/auto` endpoint
- [ ] Create `POST /v1/analyze` endpoint
- [ ] Create `POST /v1/explain` endpoint
- [ ] Add routing decision headers

### Phase 2: Multi-Language Benchmarks (Weeks 1-3)
- [ ] Add 10 JavaScript/TypeScript tasks
- [ ] Add 5 Rust tasks
- [ ] Add 5 Go tasks
- [ ] Update database schema with language/task_type columns

### Phase 3: Kilo Code Integration (Week 7)
- [ ] Update provider to use auto-routing
- [ ] Add routing decision UI
- [ ] Add manual override capability

## 📚 API Reference

### `analyzePrompt(prompt: string): PromptAnalysis`

Analyzes a prompt to detect language, task type, framework, and complexity.

**Returns:**
```typescript
{
  language: 'python' | 'javascript' | 'typescript' | 'rust' | 'go' | 'unknown',
  taskType: 'ui' | 'algorithm' | 'backend' | 'debug' | 'refactor' | 'general',
  framework?: string,
  complexity: 'simple' | 'medium' | 'complex',
  keywords: string[],
  confidence: number,
  detectionReasons: string[]
}
```

### `selectModelAutomatically(prompt: string, userId: number, options?): Promise<SmartSelectionResult>`

Automatically selects the best model based on prompt analysis.

**Options:**
- `includeAlternatives?: boolean` - Include top 3 alternatives
- `maxAlternatives?: number` - Number of alternatives (default: 3)

**Returns:**
```typescript
{
  model: string,
  provider: string,
  score: number,
  reasoning: string,
  estimatedCost: number,
  avgLatency?: number,
  analysis: PromptAnalysis,
  alternativeModels?: Array<{...}>
}
```

### `selectBestModel(criteria: SelectionCriteria): Promise<ModelSelection>`

Manual model selection with explicit strategy (existing system).

**Criteria:**
```typescript
{
  userId: number,
  strategy: 'best_overall' | 'best_coding' | 'best_reasoning' | 'best_creative' | 'cheapest' | 'fastest',
  excludeProviders?: string[],
  excludeModels?: string[],
  maxCost?: number,
  maxLatency?: number
}
```

## 🐛 Troubleshooting

### Low Confidence Detection

If confidence is <60%, the system will:
1. Still make a selection (with warning in reasoning)
2. Default to Python for language
3. Default to 'general' for task type
4. Use 'best_overall' strategy

**Solution**: Encourage users to be more specific in prompts.

### No Models Available

If no models match criteria:
1. Check user has active provider API keys
2. Check user preferences aren't too restrictive
3. Verify benchmarks have completed

### Cache Issues

Clear cache manually:
```typescript
import { invalidateRouterCache } from './router/selector';
invalidateRouterCache(); // Clear all
invalidateRouterCache('hourly'); // Clear specific suite
```

## 📝 License

Part of the AI Stupid Level project.

## 🤝 Contributing

When adding new languages or frameworks:
1. Update patterns in `prompt-analyzer.ts`
2. Add test cases
3. Update this README
4. Add corresponding benchmark tasks
