# Smart Router Deployment Guide

Complete guide for deploying the AI Stupid Level Smart Router system to production.

## 📋 Prerequisites

- Node.js 18+ installed
- PostgreSQL or SQLite database
- API keys for AI providers (OpenAI, Anthropic, Google, etc.)
- Existing AI Stupid Level benchmark data

## 🚀 Quick Start (5 Minutes)

### 1. Register Routes

Add the smart router routes to your main API server:

```typescript
// apps/api/src/index.ts or your main server file

import smartRouterRoutes from './routes/router-smart';

// After creating your Fastify instance
await fastify.register(smartRouterRoutes);
```

### 2. Test the Endpoints

```bash
# Health check
curl http://localhost:3000/v1/router/health

# Analyze a prompt
curl -X POST http://localhost:3000/v1/analyze \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Create a React component"}'

# Test smart routing
curl -X POST http://localhost:3000/v1/chat/completions/auto \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [
      {"role": "user", "content": "Write a Python function to sort an array"}
    ]
  }'
```

### 3. Verify It Works

You should see:
- ✅ Health endpoint returns `{"status": "healthy"}`
- ✅ Analyze endpoint returns language/task detection
- ✅ Auto routing selects a model and returns response

## 📦 Full Deployment Steps

### Step 1: Environment Setup

Ensure your `.env` file has provider API keys:

```bash
# Provider API Keys (for proxying requests)
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
GEMINI_API_KEY=...
XAI_API_KEY=...
DEEPSEEK_API_KEY=...
GLM_API_KEY=...
KIMI_API_KEY=...

# Database
DATABASE_URL=postgresql://user:pass@localhost:5432/aistupidlevel

# Optional: Score calibration
SCORE_SCALE=1.0
SCORE_LIFT=0
SCORE_MIN=0
SCORE_MAX=100
```

### Step 2: Database Verification

Verify your database has the required tables:

```sql
-- Check existing tables
SELECT table_name FROM information_schema.tables 
WHERE table_schema = 'public';

-- Required tables:
-- ✓ models
-- ✓ scores
-- ✓ runs
-- ✓ router_preferences
-- ✓ router_provider_keys
```

If `router_preferences` or `router_provider_keys` don't exist, they'll be created automatically from the schema.

### Step 3: Install Dependencies

```bash
cd apps/api
npm install

# Or if using yarn
yarn install
```

### Step 4: Build TypeScript

```bash
npm run build

# Or for development with watch mode
npm run dev
```

### Step 5: Run Tests (Optional)

```bash
# Run unit tests
npm test

# Run specific test file
npm test -- prompt-analyzer.test.ts

# Run with coverage
npm test -- --coverage
```

### Step 6: Start the Server

```bash
# Production
npm start

# Development with hot reload
npm run dev
```

### Step 7: Verify Deployment

```bash
# 1. Check health
curl http://localhost:3000/v1/router/health

# Expected response:
{
  "status": "healthy",
  "timestamp": "2025-10-19T08:00:00.000Z",
  "cache": {
    "size": 0,
    "keys": [],
    "oldestEntryAge": "0s"
  },
  "features": {
    "promptAnalysis": true,
    "smartRouting": true,
    "costOptimization": true,
    "multiLanguage": true
  }
}

# 2. Test prompt analysis
curl -X POST http://localhost:3000/v1/analyze \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Create a React component for user login"}'

# Expected response:
{
  "success": true,
  "analysis": {
    "language": "javascript",
    "taskType": "ui",
    "framework": "react",
    "complexity": "medium",
    "confidence": 0.92,
    ...
  },
  "summary": "Language: javascript | Task: ui | Framework: react | ..."
}

# 3. Test smart routing
curl -X POST http://localhost:3000/v1/chat/completions/auto \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [
      {"role": "user", "content": "Implement binary search in Python"}
    ]
  }'

# Check response headers for routing decisions:
# X-AISM-Provider: anthropic
# X-AISM-Model: claude-sonnet-4-20250514
# X-AISM-Language-Detected: python
# X-AISM-Task-Type-Detected: algorithm
# X-AISM-Confidence: 0.88
```

## 🔧 Configuration

### User Preferences

Users can configure routing preferences via the database:

```sql
-- Set user routing preferences
INSERT INTO router_preferences (user_id, routing_strategy, max_cost_per_1k_tokens)
VALUES (1, 'best_coding', 0.01)
ON CONFLICT (user_id) DO UPDATE SET
  routing_strategy = EXCLUDED.routing_strategy,
  max_cost_per_1k_tokens = EXCLUDED.max_cost_per_1k_tokens;

-- Add user provider API keys
INSERT INTO router_provider_keys (user_id, provider, encrypted_key, is_active)
VALUES (1, 'openai', 'encrypted_key_here', true);
```

### Cache Configuration

The router uses a 5-minute cache for rankings. To adjust:

```typescript
// apps/api/src/router/selector/index.ts
const CACHE_TTL = 5 * 60 * 1000; // Change to desired TTL in milliseconds
```

### Cost Data Updates

Update provider costs as pricing changes:

```typescript
// apps/api/src/router/selector/index.ts
const PROVIDER_COSTS = {
  openai: { input: 0.03, output: 0.06 },
  // Update these values as needed
};

const MODEL_COSTS = {
  'gpt-4o-mini': { input: 0.00015, output: 0.0006 },
  // Add new models here
};
```

## 📊 Monitoring

### Health Checks

Set up monitoring for the health endpoint:

```bash
# Add to your monitoring system
curl http://localhost:3000/v1/router/health

# Monitor these metrics:
# - status: should be "healthy"
# - cache.size: should be > 0 after first requests
# - cache.oldestEntryAge: should be < 5 minutes
```

### Logging

The router logs important events:

```typescript
// Enable debug logging
process.env.LOG_LEVEL = 'debug';

// Logs include:
// - Cache hits/misses
// - Model selections
// - Errors and warnings
// - Performance metrics
```

### Metrics to Track

1. **Request Volume**
   - Total requests to `/v1/chat/completions/auto`
   - Requests per language/task type
   - Requests per selected model

2. **Performance**
   - Average routing decision time (<250ms target)
   - Cache hit rate (>90% target)
   - End-to-end latency

3. **Accuracy**
   - Language detection confidence
   - User satisfaction with selections
   - Manual override rate

4. **Cost**
   - Average cost per request
   - Cost savings vs always using GPT-4
   - Cost by user/team

## 🔒 Security

### API Key Management

**Important**: Never expose provider API keys to clients!

```typescript
// ✅ Good: Server-side only
const apiKey = process.env.OPENAI_API_KEY;

// ❌ Bad: Never send to client
res.json({ apiKey: process.env.OPENAI_API_KEY });
```

### User Authentication

Add authentication middleware:

```typescript
// apps/api/src/middleware/auth.ts
export async function authenticateUser(request, reply) {
  const token = request.headers.authorization?.replace('Bearer ', '');
  
  if (!token) {
    return reply.code(401).send({ error: 'Unauthorized' });
  }
  
  // Verify token and set userId
  const userId = await verifyToken(token);
  request.userId = userId;
}

// Apply to routes
fastify.addHook('preHandler', authenticateUser);
```

### Rate Limiting

Add rate limiting to prevent abuse:

```typescript
import rateLimit from '@fastify/rate-limit';

await fastify.register(rateLimit, {
  max: 100, // 100 requests
  timeWindow: '1 minute'
});
```

## 🐛 Troubleshooting

### Issue: "No models match your preferences"

**Cause**: User has no active provider API keys or preferences are too restrictive.

**Solution**:
```sql
-- Check user's provider keys
SELECT * FROM router_provider_keys WHERE user_id = 1;

-- Check user's preferences
SELECT * FROM router_preferences WHERE user_id = 1;

-- Add a provider key if missing
INSERT INTO router_provider_keys (user_id, provider, encrypted_key, is_active)
VALUES (1, 'openai', 'encrypted_key', true);
```

### Issue: "No model rankings available"

**Cause**: Benchmarks haven't completed yet.

**Solution**:
```bash
# Check if scores exist
psql -d aistupidlevel -c "SELECT COUNT(*) FROM scores;"

# Run benchmarks if needed
npm run benchmarks
```

### Issue: Low confidence detections

**Cause**: Vague or unclear prompts.

**Solution**:
- Encourage users to be more specific
- Add more keywords to the analyzer
- Lower confidence threshold if acceptable

### Issue: Cache not working

**Cause**: Cache TTL expired or invalidated.

**Solution**:
```bash
# Check cache stats
curl http://localhost:3000/v1/router/health

# Manually invalidate if needed
curl -X POST http://localhost:3000/v1/router/cache/invalidate
```

### Issue: TypeScript errors

**Cause**: Missing type definitions or outdated dependencies.

**Solution**:
```bash
# Reinstall dependencies
rm -rf node_modules package-lock.json
npm install

# Rebuild
npm run build
```

## 📈 Performance Optimization

### 1. Database Indexing

Add indexes for faster queries:

```sql
-- Index on scores table
CREATE INDEX idx_scores_model_suite ON scores(model_id, suite);
CREATE INDEX idx_scores_ts ON scores(ts DESC);

-- Index on runs table
CREATE INDEX idx_runs_model ON runs(model_id);

-- Index on router tables
CREATE INDEX idx_router_keys_user_provider ON router_provider_keys(user_id, provider);
CREATE INDEX idx_router_prefs_user ON router_preferences(user_id);
```

### 2. Connection Pooling

Ensure database connection pooling is configured:

```typescript
// apps/api/src/db/connection-pool.ts
const pool = new Pool({
  max: 20, // Maximum connections
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});
```

### 3. Cache Warming

Pre-warm the cache on startup:

```typescript
// apps/api/src/router/selector/index.ts
async function warmCache() {
  const suites = ['hourly', 'deep'];
  const strategies = ['best_overall', 'best_coding', 'best_reasoning'];
  
  for (const suite of suites) {
    for (const strategy of strategies) {
      await getCachedRankings(suite, strategy);
    }
  }
}

// Call on startup
warmCache().catch(console.error);
```

## 🔄 Updates and Maintenance

### Updating Cost Data

When provider pricing changes:

1. Update `PROVIDER_COSTS` and `MODEL_COSTS` in `selector/index.ts`
2. Restart the server
3. Invalidate cache: `POST /v1/router/cache/invalidate`

### Adding New Languages

1. Update patterns in `analyzer/prompt-analyzer.ts`
2. Add test cases in `__tests__/prompt-analyzer.test.ts`
3. Run tests: `npm test`
4. Deploy

### Adding New Providers

1. Add provider to `PROVIDER_COSTS` in `selector/index.ts`
2. Add adapter in `proxy/model-proxy.ts`
3. Update documentation
4. Deploy

## 📚 Additional Resources

- [Smart Router README](./src/router/README.md) - Complete API reference
- [Usage Examples](./src/router/examples/usage-examples.ts) - Code examples
- [Test Suite](./src/router/__tests__/) - Unit tests

## 🎉 Success Checklist

Before going live, verify:

- [ ] Health endpoint returns healthy status
- [ ] Analyze endpoint detects languages correctly
- [ ] Auto routing selects appropriate models
- [ ] Response headers include routing decisions
- [ ] Cache is working (check cache stats)
- [ ] Authentication is enabled
- [ ] Rate limiting is configured
- [ ] Monitoring is set up
- [ ] Error logging is working
- [ ] Database indexes are created
- [ ] Provider API keys are configured
- [ ] Documentation is updated

## 🆘 Support

If you encounter issues:

1. Check the troubleshooting section above
2. Review logs for error messages
3. Test with curl commands provided
4. Check database for required data
5. Verify environment variables are set

## 🚀 Next Steps

After deployment:

1. Monitor performance metrics
2. Gather user feedback
3. Add multi-language benchmarks
4. Implement streaming support
5. Add more sophisticated cost optimization
6. Build UI for routing decisions
7. Add A/B testing capabilities

---

**Deployment Status**: ✅ Ready for Production

**Last Updated**: October 19, 2025
