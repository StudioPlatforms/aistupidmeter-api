import { db } from './index';
import { models, tasks, runs, metrics, scores } from './schema';

export async function seed() {
  console.log('🌱 Seeding database...');

  // Seed latest 2025 models
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

  // Seed demo tasks (Golden Task Suite)
  const insertedTasks = await db.insert(tasks).values([
    { slug: 'py/mini_interpreter', lang: 'py', type: 'impl', difficulty: 5, hidden: false },
    { slug: 'py/topological_sort', lang: 'py', type: 'impl', difficulty: 4, hidden: false }
  ]).returning();

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
          const runId: number = runsData.length + 1;
          const latency = Math.floor(Math.random() * 3000) + 500; // 500-3500ms
          const tokensIn = Math.floor(Math.random() * 1000) + 200;
          const tokensOut = Math.floor(Math.random() * 2000) + 100;
          const attempts = Math.random() > 0.8 ? Math.floor(Math.random() * 2) + 2 : 1;
          const passed = Math.random() > 0.15; // 85% pass rate

          // Base performance by provider
          let baseCorrectness = 0.7;
          let baseSpec = 0.8;
          let baseCodeQuality = 0.6;
          
          switch (model.vendor) {
            case 'openai':
              baseCorrectness = 0.85;
              baseSpec = 0.9;
              baseCodeQuality = 0.8;
              break;
            case 'anthropic':
              baseCorrectness = 0.82;
              baseSpec = 0.88;
              baseCodeQuality = 0.78;
              break;
            case 'xai':
              baseCorrectness = 0.75;
              baseSpec = 0.8;
              baseCodeQuality = 0.7;
              break;
          }

          // Add some variance and time-based trend
          const dayFactor = 1 - (day * 0.002); // Slight degradation over time
          const randomFactor = 0.8 + Math.random() * 0.4; // ±20% variance
          
          const correctness = Math.max(0, Math.min(1, baseCorrectness * dayFactor * randomFactor));
          const spec = Math.max(0, Math.min(1, baseSpec * dayFactor * randomFactor));
          const codeQuality = Math.max(0, Math.min(1, baseCodeQuality * dayFactor * randomFactor));
          const efficiency = Math.max(0, Math.min(1, (3500 - latency) / 3000)); // Normalize latency
          const stability = Math.max(0, Math.min(1, 0.9 - (attempts - 1) * 0.1));
          const refusal = Math.max(0, Math.min(1, 0.95 + Math.random() * 0.05));
          const recovery = attempts > 1 ? Math.max(0, Math.min(1, passed ? 0.8 : 0.2)) : 0.5;

          runsData.push({
            id: runId,
            modelId: model.id!,
            taskId: task.id!,
            ts: runDate.toISOString(),
            temp: 0.2,
            seed: 1234,
            tokensIn,
            tokensOut,
            latencyMs: latency,
            attempts,
            passed,
            artifacts: { code: `# Sample generated code for run ${runId}`, logs: 'Sample logs' }
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
          // Calculate weighted StupidScore
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

          // Calculate StupidScore (baseline normalized)
          const baselineScore = Object.entries(weights).reduce((sum, [key, weight]) => {
            return sum + (avgMetrics[key as keyof typeof avgMetrics] - 0.7) * weight * 100;
          }, 0);

          scoresData.push({
            modelId: model.id!,
            ts: runDate.toISOString(),
            stupidScore: Math.round(baselineScore * 100) / 100,
            axes: avgMetrics,
            cusum: 0, // Simple placeholder
            note: day === 0 ? 'Latest performance snapshot' : null
          });
        }
      }
    }
  }

  // Insert all the sample data
  console.log(`📊 Inserting ${runsData.length} sample runs...`);
  
  // Insert runs in batches to avoid SQLite limitations
  const batchSize = 50;
  for (let i = 0; i < runsData.length; i += batchSize) {
    const batch = runsData.slice(i, i + batchSize);
    await db.insert(runs).values(batch);
  }

  console.log(`📈 Inserting ${metricsData.length} sample metrics...`);
  for (let i = 0; i < metricsData.length; i += batchSize) {
    const batch = metricsData.slice(i, i + batchSize);
    await db.insert(metrics).values(batch);
  }

  console.log(`🏆 Inserting ${scoresData.length} sample scores...`);
  for (let i = 0; i < scoresData.length; i += batchSize) {
    const batch = scoresData.slice(i, i + batchSize);
    await db.insert(scores).values(batch);
  }

  console.log('✅ Database seeded with comprehensive demo data');
  console.log(`   - ${insertedModels.length} models`);
  console.log(`   - ${insertedTasks.length} tasks`);
  console.log(`   - ${runsData.length} runs`);
  console.log(`   - ${metricsData.length} metrics`);
  console.log(`   - ${scoresData.length} scores`);
}
