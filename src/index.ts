
import dotenv from 'dotenv';
import path from 'path';

// Load environment variables from the project root
dotenv.config({ path: '/root/.env' });
import Fastify from 'fastify';
import cors from '@fastify/cors';
import modelsRoutes from './routes/models';
import benchmarkRoutes from './routes/benchmark';
import dashboardRoutes from './routes/dashboard';
import dashboardCachedRoutes from './routes/dashboard-cached';
import referenceRoutes from './routes/reference';
import testAdaptersRoutes from './routes/test-adapters';
import testAdaptersStreamRoutes from './routes/test-adapters-stream';
import visitorsRoutes from './routes/visitors';
import analyticsRoutes from './routes/analytics';

const app = Fastify({
  logger: true
});

// Register CORS plugin
app.register(cors, {
  origin: [
    'http://localhost:3000', 
    'http://127.0.0.1:3000',
    'https://aistupidlevel.info',
    'http://aistupidlevel.info'
  ],
  credentials: true
});

app.get('/health', async () => ({ ok: true }));

// Visitor tracking endpoint for Next.js middleware
app.post('/track-visit', async (request, reply) => {
  try {
    const { ip, userAgent, referer, path, timestamp } = request.body as {
      ip: string;
      userAgent: string;
      referer: string | null;
      path: string;
      timestamp: string;
    };
    
    const { db } = await import('./db/index');
    const { visitors } = await import('./db/schema');
    const { sql } = await import('drizzle-orm');
    
    // Check if this IP visited today (for unique visitor tracking)
    const today = new Date().toISOString().split('T')[0];
    const existingToday = await db.select()
      .from(visitors)
      .where(sql`ip = ${ip} AND DATE(timestamp) = ${today}`)
      .limit(1);
    
    const isUnique = existingToday.length === 0;
    
    // Record the visit
    await db.insert(visitors).values({
      ip,
      userAgent,
      referer,
      path,
      timestamp,
      isUnique
    });
    
    return { ok: true };
  } catch (error) {
    console.error('Visitor tracking error:', error);
    return reply.status(500).send({ error: 'Failed to track visit' });
  }
});

console.log('✅ LLM API starting with multi-provider support');

// Visitor tracking middleware (before routes)
app.addHook('onRequest', async (request, reply) => {
  // Skip tracking for ALL server API routes - only track actual frontend page visits
  if (request.url.startsWith('/internal/') || 
      request.url === '/health' ||
      request.url.startsWith('/api/') ||
      request.url.startsWith('/admin') ||
      request.url.startsWith('/dashboard/') ||
      request.url.startsWith('/visitors/') ||
      request.url.startsWith('/models/') ||
      request.url.startsWith('/benchmark/') ||
      request.url.startsWith('/reference/') ||
      request.url.startsWith('/test-adapters/')) {
    return;
  }
  
  try {
    const { db } = await import('./db/index');
    const { visitors } = await import('./db/schema');
    const { sql } = await import('drizzle-orm');
    
    const rawIp = request.headers['x-forwarded-for'] || 
                  request.headers['x-real-ip'] || 
                  request.ip || 
                  'unknown';
    
    const ip = Array.isArray(rawIp) ? rawIp[0] : String(rawIp).split(',')[0].trim();
    const userAgent = request.headers['user-agent'] || null;
    const referer = request.headers['referer'] || request.headers['referrer'] || null;
    const path = request.url;
    
    // Check if this IP visited today (for unique visitor tracking)
    const today = new Date().toISOString().split('T')[0];
    const existingToday = await db.select()
      .from(visitors)
      .where(sql`ip = ${ip} AND DATE(timestamp) = ${today}`)
      .limit(1);
    
    const isUnique = existingToday.length === 0;
    
    // Record the visit with explicit timestamp
    await db.insert(visitors).values({
      ip,
      userAgent: Array.isArray(userAgent) ? userAgent[0] : userAgent,
      referer: Array.isArray(referer) ? referer[0] : referer,
      path,
      timestamp: new Date().toISOString(), // Explicit timestamp instead of CURRENT_TIMESTAMP
      isUnique
    });
    
  } catch (error) {
    console.error('Visitor tracking error:', error);
    // Don't fail the request if visitor tracking fails
  }
});

// Routes
app.register(modelsRoutes, { prefix: '/models' });
app.register(benchmarkRoutes, { prefix: '/benchmark' });
app.register(dashboardRoutes, { prefix: '/dashboard' });
app.register(dashboardCachedRoutes, { prefix: '/dashboard' }); // Adds /dashboard/cached, /dashboard/scores-cached etc.
app.register(referenceRoutes, { prefix: '/reference' });
app.register(testAdaptersRoutes, { prefix: '/test-adapters' });
app.register(testAdaptersStreamRoutes, { prefix: '/test-adapters' });
app.register(visitorsRoutes, { prefix: '/visitors' });
app.register(analyticsRoutes, { prefix: '/analytics' });

// Work queue (very simple MVP)
let queued = [] as any[];

app.get('/internal/next-work', async () => {
  return queued.shift() || null;
});

app.post('/internal/enqueue', async (req, res) => {
  const body = req.body as any;
  queued.push(body); // {model, task}
  return { ok: true };
});

app.get('/internal/run-all', async () => {
  const { db } = await import('./db/index');
  const { models, tasks } = await import('./db/schema');
  const { eq } = await import('drizzle-orm');
  
  try {
    // Get all active models and tasks
    const activeModels = await db.select().from(models);
    const activeTasks = await db.select().from(tasks).where(eq(tasks.hidden, false));
    
    let enqueued = 0;
    
    // Create work items for each model-task combination
    for (const model of activeModels) {
      for (const task of activeTasks) {
        const workItem = {
          model: {
            id: model.id,
            name: model.name,
            vendor: model.vendor
          },
          task: {
            id: task.id,
            slug: task.slug,
            lang: task.lang,
            type: task.type,
            constraints: {
              maxLines: 80, // From constraints.json
              requiredFunction: task.slug.includes('mini_interpreter') ? 'evaluate' : 'resolve_dependencies',
              fileName: 'solution.py'
            },
            promptPath: `data/tasks/${task.slug}/prompt.md`
          }
        };
        
        queued.push(workItem);
        enqueued++;
      }
    }
    
    return { enqueued };
  } catch (error) {
    console.error('Error enqueuing work:', error);
    return { enqueued: 0, error: String(error) };
  }
});

app.post('/internal/report', async (req, res) => {
  const { db } = await import('./db/index');
  const { runs, metrics, scores, models, tasks } = await import('./db/schema');
  const { eq } = await import('drizzle-orm');
  
  try {
    const body = req.body as any;
    const {
      modelName,
      taskSlug,
      latencyMs,
      attempts,
      tokensIn,
      tokensOut,
      passed,
      metrics: calculatedMetrics,
      artifacts
    } = body;
    
    // Find model and task IDs
    const model = await db.select().from(models).where(eq(models.name, modelName)).limit(1);
    const task = await db.select().from(tasks).where(eq(tasks.slug, taskSlug)).limit(1);
    
    if (model.length === 0 || task.length === 0) {
      return res.status(400).send({ error: 'Model or task not found' });
    }
    
    const modelId = model[0].id;
    const taskId = task[0].id;
    
    // Insert run record (simplified for MVP)
    const runData = {
      modelId,
      taskId,
      temp: 0.2,
      seed: 1234,
      tokensIn: tokensIn || 0,
      tokensOut: tokensOut || 0,
      latencyMs: latencyMs || 0,
      attempts: attempts || 1,
      passed: passed || false,
      artifacts: artifacts || {}
    };
    
    // Calculate StupidScore (simplified version)
    const metricsData = calculatedMetrics || {};
    const mockBaseline = { correctness: 0.7, spec: 0.7, codeQuality: 0.7 };
    
    let stupidScore = 0;
    const weights = { correctness: 0.35, spec: 0.15, codeQuality: 0.15 };
    
    for (const [metric, weight] of Object.entries(weights)) {
      const value = metricsData[metric as keyof typeof metricsData] || 0;
      const baseline = mockBaseline[metric as keyof typeof mockBaseline] || 0.5;
      const zScore = (value - baseline) / 0.15;
      stupidScore -= weight * zScore;
    }
    
    const gaugeValue = Math.max(0, Math.min(100, Math.round(50 + 15 * Math.tanh(-stupidScore))));
    
    return res.send({ 
      ok: true, 
      stupidScore,
      gaugeValue
    });
    
  } catch (error) {
    console.error('Error reporting run:', error);
    return res.status(500).send({ error: String(error) });
  }
});

// Import the proper cron-based scheduler
import { startBenchmarkScheduler } from './scheduler';
import { initializeCache } from './cache/dashboard-cache';

// Start the server
app.listen({ port: 4000, host: '0.0.0.0' }, async () => {
  console.log('🚀 Server is running on port 4000');
  
  // Initialize the cache system first
  console.log('🔄 Initializing dashboard cache system...');
  try {
    await initializeCache();
    console.log('✅ Dashboard cache system initialized successfully');
  } catch (error) {
    console.error('❌ Failed to initialize cache system:', error);
  }
  
  // Start the proper cron-based benchmark scheduler
  startBenchmarkScheduler();
});
