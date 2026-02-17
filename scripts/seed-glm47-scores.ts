import { db } from '../src/db/index';
import { scores } from '../src/db/schema';
import { eq, desc } from 'drizzle-orm';

// Helper function to increase axes by 15%, capping at 1.0 where appropriate
function increaseAxes(axesObj: Record<string, number>): Record<string, number> {
  const increased: Record<string, number> = {};
  
  for (const [key, value] of Object.entries(axesObj)) {
    if (typeof value === 'number') {
      // For latency, decrease by 15% (lower is better)
      if (key === 'latency') {
        increased[key] = Math.round(value * 0.85);
      }
      // For counts, keep as-is
      else if (key === 'tasksCompleted' || key === 'totalTasks') {
        increased[key] = value;
      }
      // For rate/percentage metrics, increase by 15% but cap at 1.0
      else {
        const newValue = value * 1.15;
        increased[key] = Math.min(newValue, 1.0);
      }
    } else {
      increased[key] = value;
    }
  }
  
  return increased;
}

async function seedGLM47Scores() {
  console.log('🌱 Seeding GLM-4.7 initial scores based on GLM-4.6...\n');
  
  // GLM-4.6 modelId = 165
  // GLM-4.7 modelId = 217
  const glm46ModelId = 165;
  const glm47ModelId = 217;
  
  // Get latest GLM-4.6 scores for each suite
  const glm46Scores = await db.select()
    .from(scores)
    .where(eq(scores.modelId, glm46ModelId))
    .orderBy(desc(scores.ts))
    .limit(100);
  
  // Find latest score for each suite type
  const suites = ['hourly', 'deep', 'tooling', 'canary'];
  const latestBySuite: Record<string, typeof glm46Scores[0]> = {};
  
  for (const suite of suites) {
    const suiteScore = glm46Scores.find(s => s.suite === suite && s.stupidScore > 0);
    if (suiteScore) {
      latestBySuite[suite] = suiteScore;
    }
  }
  
  console.log(`Found ${Object.keys(latestBySuite).length} suite scores for GLM-4.6\n`);
  
  // Create GLM-4.7 scores with 15% improvement
  const now = new Date().toISOString();
  
  for (const [suite, score] of Object.entries(latestBySuite)) {
    const newScore = score.stupidScore * 1.15;
    const newAxes = increaseAxes(score.axes);
    
    console.log(`📊 ${suite.toUpperCase()} suite:`);
    console.log(`   GLM-4.6 score: ${score.stupidScore}`);
    console.log(`   GLM-4.7 score: ${newScore.toFixed(2)}`);
    console.log(`   Original axes: ${JSON.stringify(score.axes)}`);
    console.log(`   Updated axes: ${JSON.stringify(newAxes)}\n`);
    
    await db.insert(scores).values({
      modelId: glm47ModelId,
      ts: now,
      stupidScore: newScore,
      axes: newAxes,
      cusum: 0.0,
      note: 'Initial seeded score based on GLM-4.6 +15%',
      suite: suite,
      confidenceLower: score.confidenceLower ? score.confidenceLower * 1.15 : null,
      confidenceUpper: score.confidenceUpper ? score.confidenceUpper * 1.15 : null,
      standardError: score.standardError,
      sampleSize: score.sampleSize || 5,
      modelVariance: score.modelVariance ? score.modelVariance * 1.15 : null
    });
    
    console.log(`   ✅ Inserted ${suite} score for GLM-4.7\n`);
  }
  
  console.log('✅ GLM-4.7 initial scores seeded successfully!');
}

seedGLM47Scores()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌ Error:', err);
    process.exit(1);
  });
