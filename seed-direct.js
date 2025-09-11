// Direct database seeding without build
const { drizzle } = require('drizzle-orm/better-sqlite3');
const Database = require('better-sqlite3');
const path = require('path');

// Database setup
const dbPath = path.join(__dirname, 'data/stupid_meter.db');
const sqlite = new Database(dbPath);
const db = drizzle(sqlite);

// Schema (simplified inline)
const { sqliteTable, integer, text, real } = require('drizzle-orm/sqlite-core');

const models = sqliteTable('models', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  vendor: text('vendor').notNull(),
  version: text('version'),
  notes: text('notes')
});

const tasks = sqliteTable('tasks', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  slug: text('slug').notNull().unique(),
  lang: text('lang').notNull(),
  type: text('type').notNull(),
  difficulty: integer('difficulty').notNull(),
  schemaUri: text('schema_uri'),
  hidden: integer('hidden', { mode: 'boolean' }).default(false)
});

const runs = sqliteTable('runs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  modelId: integer('model_id').references(() => models.id).notNull(),
  taskId: integer('task_id').references(() => tasks.id).notNull(),
  ts: text('ts').notNull(),
  temp: real('temp').notNull(),
  seed: integer('seed').notNull(),
  tokensIn: integer('tokens_in').notNull(),
  tokensOut: integer('tokens_out').notNull(),
  latencyMs: integer('latency_ms').notNull(),
  attempts: integer('attempts').notNull(),
  passed: integer('passed', { mode: 'boolean' }).notNull(),
  artifacts: text('artifacts', { mode: 'json' })
});

const metrics = sqliteTable('metrics', {
  runId: integer('run_id').references(() => runs.id).primaryKey(),
  correctness: real('correctness').notNull(),
  spec: real('spec').notNull(),
  codeQuality: real('code_quality').notNull(),
  efficiency: real('efficiency').notNull(),
  stability: real('stability').notNull(),
  refusal: real('refusal').notNull(),
  recovery: real('recovery').notNull()
});

const scores = sqliteTable('scores', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  modelId: integer('model_id').references(() => models.id).notNull(),
  ts: text('ts').notNull(),
  stupidScore: real('stupid_score').notNull(),
  axes: text('axes', { mode: 'json' }).notNull(),
  cusum: real('cusum').notNull(),
  note: text('note')
});

async function seed() {
  console.log('🌱 Seeding database with latest 2025 models...');

  // Create tables
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS models (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      vendor TEXT NOT NULL,
      version TEXT,
      notes TEXT
    );
    
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE,
      lang TEXT NOT NULL,
      type TEXT NOT NULL,
      difficulty INTEGER NOT NULL,
      schema_uri TEXT,
      hidden INTEGER DEFAULT 0
    );
    
    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model_id INTEGER NOT NULL REFERENCES models(id),
      task_id INTEGER NOT NULL REFERENCES tasks(id),
      ts TEXT NOT NULL,
      temp REAL NOT NULL,
      seed INTEGER NOT NULL,
      tokens_in INTEGER NOT NULL,
      tokens_out INTEGER NOT NULL,
      latency_ms INTEGER NOT NULL,
      attempts INTEGER NOT NULL,
      passed INTEGER NOT NULL,
      artifacts TEXT
    );
    
    CREATE TABLE IF NOT EXISTS metrics (
      run_id INTEGER PRIMARY KEY REFERENCES runs(id),
      correctness REAL NOT NULL,
      spec REAL NOT NULL,
      code_quality REAL NOT NULL,
      efficiency REAL NOT NULL,
      stability REAL NOT NULL,
      refusal REAL NOT NULL,
      recovery REAL NOT NULL
    );
    
    CREATE TABLE IF NOT EXISTS scores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model_id INTEGER NOT NULL REFERENCES models(id),
      ts TEXT NOT NULL,
      stupid_score REAL NOT NULL,
      axes TEXT NOT NULL,
      cusum REAL NOT NULL,
      note TEXT
    );
  `);

  // Clear existing data
  sqlite.exec('DELETE FROM scores');
  sqlite.exec('DELETE FROM metrics');
  sqlite.exec('DELETE FROM runs');
  sqlite.exec('DELETE FROM tasks');
  sqlite.exec('DELETE FROM models');

  // Insert latest 2025 models
  const insertedModels = await db.insert(models).values([
    // OpenAI - Latest GPT-5 series
    { name: 'gpt-5', vendor: 'openai', version: '2025-01-15', notes: 'Latest GPT-5 flagship model' },
    { name: 'gpt-5-mini', vendor: 'openai', version: '2025-01-15', notes: 'Efficient GPT-5 variant' },
    { name: 'gpt-4o', vendor: 'openai', version: '2024-11-20', notes: 'GPT-4 Omni multimodal' },
    
    // Anthropic - Latest Claude 4 series with date stamps
    { name: 'claude-opus-4-1-20250805', vendor: 'anthropic', version: '2025-08-05', notes: 'Claude Opus 4.1 latest' },
    { name: 'claude-opus-4-20250514', vendor: 'anthropic', version: '2025-05-14', notes: 'Claude Opus 4' },
    { name: 'claude-sonnet-4-20250514', vendor: 'anthropic', version: '2025-05-14', notes: 'Claude Sonnet 4' },
    
    // xAI - Latest Grok models
    { name: 'grok-4', vendor: 'xai', version: '2025-01-10', notes: 'Grok 4 flagship reasoning model' },
    { name: 'grok-code-fast-1', vendor: 'xai', version: '2025-01-10', notes: 'Grok code-optimized fast model' },
    
    // Google - Latest Gemini 2.5 series
    { name: 'gemini-2.5-pro', vendor: 'google', version: '2025-01-12', notes: 'Gemini 2.5 Pro flagship' },
    { name: 'gemini-2.5-flash', vendor: 'google', version: '2025-01-12', notes: 'Gemini 2.5 Flash optimized' },
    { name: 'gemini-2.5-flash-lite', vendor: 'google', version: '2025-01-12', notes: 'Gemini 2.5 Flash Lite efficient' }
  ]).returning();

  // Insert tasks
  const insertedTasks = await db.insert(tasks).values([
    { slug: 'py/mini_interpreter', lang: 'py', type: 'impl', difficulty: 5, hidden: false },
    { slug: 'py/topological_sort', lang: 'py', type: 'impl', difficulty: 4, hidden: false }
  ]).returning();

  console.log(`✅ Inserted ${insertedModels.length} models and ${insertedTasks.length} tasks`);

  // Generate sample performance data for each model
  const now = new Date();
  const runsData = [];
  const metricsData = [];
  const scoresData = [];

  for (const model of insertedModels) {
    // Generate 30 days of historical data
    for (let day = 0; day < 30; day++) {
      const runDate = new Date(now.getTime() - day * 24 * 60 * 60 * 1000);
      
      for (const task of insertedTasks) {
        // Generate 2-4 runs per task per day
        const numRuns = Math.floor(Math.random() * 3) + 2;
        
        for (let i = 0; i < numRuns; i++) {
          const runId = runsData.length + 1;
          const latency = Math.floor(Math.random() * 3000) + 500;
          const tokensIn = Math.floor(Math.random() * 1000) + 200;
          const tokensOut = Math.floor(Math.random() * 2000) + 100;
          const attempts = Math.random() > 0.8 ? Math.floor(Math.random() * 2) + 2 : 1;
          const passed = Math.random() > 0.15;

          // Base performance by provider with realistic 2025 improvements
          let baseCorrectness = 0.7;
          let baseSpec = 0.8;
          let baseCodeQuality = 0.6;
          
          switch (model.vendor) {
            case 'openai':
              // GPT-5 series should perform better
              if (model.name === 'gpt-5') {
                baseCorrectness = 0.92;
                baseSpec = 0.95;
                baseCodeQuality = 0.88;
              } else {
                baseCorrectness = 0.85;
                baseSpec = 0.9;
                baseCodeQuality = 0.8;
              }
              break;
            case 'anthropic':
              // Claude 4.1 latest should be best
              if (model.name.includes('4-1')) {
                baseCorrectness = 0.90;
                baseSpec = 0.93;
                baseCodeQuality = 0.85;
              } else {
                baseCorrectness = 0.82;
                baseSpec = 0.88;
                baseCodeQuality = 0.78;
              }
              break;
            case 'xai':
              // Grok 4 should be improved
              if (model.name === 'grok-4') {
                baseCorrectness = 0.85;
                baseSpec = 0.87;
                baseCodeQuality = 0.8;
              } else {
                baseCorrectness = 0.75;
                baseSpec = 0.8;
                baseCodeQuality = 0.7;
              }
              break;
            case 'google':
              // Gemini 2.5 Pro should be competitive
              if (model.name === 'gemini-2.5-pro') {
                baseCorrectness = 0.88;
                baseSpec = 0.90;
                baseCodeQuality = 0.82;
              } else {
                baseCorrectness = 0.78;
                baseSpec = 0.85;
                baseCodeQuality = 0.75;
              }
              break;
          }

          const dayFactor = 1 - (day * 0.001); // Slight degradation over time
          const randomFactor = 0.85 + Math.random() * 0.3; // ±15% variance
          
          const correctness = Math.max(0, Math.min(1, baseCorrectness * dayFactor * randomFactor));
          const spec = Math.max(0, Math.min(1, baseSpec * dayFactor * randomFactor));
          const codeQuality = Math.max(0, Math.min(1, baseCodeQuality * dayFactor * randomFactor));
          const efficiency = Math.max(0, Math.min(1, (3500 - latency) / 3000));
          const stability = Math.max(0, Math.min(1, 0.9 - (attempts - 1) * 0.1));
          const refusal = Math.max(0, Math.min(1, 0.95 + Math.random() * 0.05));
          const recovery = attempts > 1 ? Math.max(0, Math.min(1, passed ? 0.8 : 0.2)) : 0.5;

          runsData.push({
            id: runId,
            modelId: model.id,
            taskId: task.id,
            ts: runDate.toISOString(),
            temp: 0.2,
            seed: 1234,
            tokensIn,
            tokensOut,
            latencyMs: latency,
            attempts,
            passed,
            artifacts: JSON.stringify({ code: `# Sample code for run ${runId}`, logs: 'Sample logs' })
          });

          metricsData.push({
            runId,
            correctness,
            spec,
            codeQuality,
            efficiency,
            stability,
            refusal,
            recovery
          });
        }
      }

      // Generate daily score summary
      const dayRuns = runsData.filter(r => 
        r.modelId === model.id && 
        new Date(r.ts).toDateString() === runDate.toDateString()
      );
      
      if (dayRuns.length > 0) {
        const dayMetrics = metricsData.filter(m => 
          dayRuns.some(r => r.id === m.runId)
        );

        if (dayMetrics.length > 0) {
          const weights = {
            correctness: 0.35,
            spec: 0.15,
            codeQuality: 0.15,
            efficiency: 0.1,
            stability: 0.1,
            refusal: 0.1,
            recovery: 0.05
          };

          const avgMetrics = {
            correctness: dayMetrics.reduce((sum, m) => sum + m.correctness, 0) / dayMetrics.length,
            spec: dayMetrics.reduce((sum, m) => sum + m.spec, 0) / dayMetrics.length,
            codeQuality: dayMetrics.reduce((sum, m) => sum + m.codeQuality, 0) / dayMetrics.length,
            efficiency: dayMetrics.reduce((sum, m) => sum + m.efficiency, 0) / dayMetrics.length,
            stability: dayMetrics.reduce((sum, m) => sum + m.stability, 0) / dayMetrics.length,
            refusal: dayMetrics.reduce((sum, m) => sum + m.refusal, 0) / dayMetrics.length,
            recovery: dayMetrics.reduce((sum, m) => sum + m.recovery, 0) / dayMetrics.length
          };

          const baselineScore = Object.entries(weights).reduce((sum, [key, weight]) => {
            return sum + (avgMetrics[key] - 0.7) * weight * 100;
          }, 0);

          scoresData.push({
            modelId: model.id,
            ts: runDate.toISOString(),
            stupidScore: Math.round(baselineScore * 100) / 100,
            axes: JSON.stringify(avgMetrics),
            cusum: 0,
            note: day === 0 ? 'Latest performance snapshot' : null
          });
        }
      }
    }
  }

  console.log(`📊 Inserting ${runsData.length} runs, ${metricsData.length} metrics, ${scoresData.length} scores...`);

  // Insert in batches
  const batchSize = 50;
  
  for (let i = 0; i < runsData.length; i += batchSize) {
    const batch = runsData.slice(i, i + batchSize);
    await db.insert(runs).values(batch);
  }
  
  for (let i = 0; i < metricsData.length; i += batchSize) {
    const batch = metricsData.slice(i, i + batchSize);
    await db.insert(metrics).values(batch);
  }
  
  for (let i = 0; i < scoresData.length; i += batchSize) {
    const batch = scoresData.slice(i, i + batchSize);
    await db.insert(scores).values(batch);
  }

  console.log('✅ Database seeded with latest 2025 models and comprehensive benchmark data!');
}

seed().catch(console.error);
