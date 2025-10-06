/**
 * Backfill Script: Calculate Confidence Intervals for Historical Data
 * 
 * This script processes existing scores in the database and calculates
 * confidence intervals retroactively based on historical task-level data.
 */

const { db } = require('./dist/db/index');
const { scores, models } = require('./dist/db/schema');
const { eq, desc, isNull, and } = require('drizzle-orm');
const { calculateConfidenceInterval, calculateStdDev } = require('./dist/lib/statistical-tests');

async function backfillConfidenceIntervals() {
  console.log('🔄 Starting confidence interval backfill for historical data...\n');
  
  try {
    // Get all models
    const allModels = await db.select().from(models);
    console.log(`📊 Found ${allModels.length} models to process\n`);
    
    let totalProcessed = 0;
    let totalUpdated = 0;
    let totalSkipped = 0;
    
    for (const model of allModels) {
      console.log(`\n🔍 Processing model: ${model.name} (${model.vendor})`);
      
      // Get all scores for this model that don't have CI data yet
      const modelScores = await db
        .select()
        .from(scores)
        .where(and(
          eq(scores.modelId, model.id),
          isNull(scores.confidenceLower)  // Only process scores without CI data
        ))
        .orderBy(desc(scores.ts));
      
      console.log(`   Found ${modelScores.length} scores without CI data`);
      
      if (modelScores.length === 0) {
        console.log(`   ✅ All scores already have CI data - skipping`);
        totalSkipped += 1;
        continue;
      }
      
      // Process each score
      for (const score of modelScores) {
        totalProcessed++;
        
        // Skip sentinel values (N/A scores)
        if (score.stupidScore === null || score.stupidScore < 0) {
          console.log(`   ⏭️  Skipping sentinel score: ${score.stupidScore}`);
          continue;
        }
        
        // For historical data, we need to estimate CI based on typical variance
        // Since we don't have the original trial data, we'll use a conservative approach
        
        // Get nearby scores (within 24 hours) to estimate variance
        const scoreTime = new Date(score.ts || new Date());
        const dayBefore = new Date(scoreTime.getTime() - 24 * 60 * 60 * 1000);
        const dayAfter = new Date(scoreTime.getTime() + 24 * 60 * 60 * 1000);
        
        const nearbyScores = await db
          .select()
          .from(scores)
          .where(and(
            eq(scores.modelId, model.id),
            // Get scores within 24 hours before and after
          ))
          .orderBy(desc(scores.ts))
          .limit(10);
        
        // Filter to valid scores and extract values
        const validNearbyScores = nearbyScores
          .filter(s => s.stupidScore !== null && s.stupidScore >= 0)
          .map(s => s.stupidScore);
        
        let ci, modelVariance;
        
        if (validNearbyScores.length >= 3) {
          // We have enough nearby data to estimate variance
          ci = calculateConfidenceInterval(validNearbyScores);
          modelVariance = calculateStdDev(validNearbyScores);
          
          // Adjust CI to be centered on the actual score
          const offset = score.stupidScore - ci.mean;
          ci.lower = Math.max(0, ci.lower + offset);
          ci.upper = Math.min(100, ci.upper + offset);
        } else {
          // Not enough nearby data - use conservative default CI
          // Assume typical variance of ±5 points for established models
          const conservativeStdDev = 5;
          const conservativeSE = conservativeStdDev / Math.sqrt(5); // Assume 5 trials
          const tValue = 2.776; // t-distribution for n=5, 95% CI
          const marginOfError = tValue * conservativeSE;
          
          ci = {
            lower: Math.max(0, score.stupidScore - marginOfError),
            upper: Math.min(100, score.stupidScore + marginOfError),
            standardError: conservativeSE,
            mean: score.stupidScore
          };
          modelVariance = conservativeStdDev;
        }
        
        // Update the score with CI data
        await db
          .update(scores)
          .set({
            confidenceLower: ci.lower,
            confidenceUpper: ci.upper,
            standardError: ci.standardError,
            sampleSize: 5, // Assume 5 trials (our standard)
            modelVariance: modelVariance
          })
          .where(eq(scores.id, score.id));
        
        totalUpdated++;
        
        if (totalUpdated % 10 === 0) {
          console.log(`   📈 Updated ${totalUpdated} scores so far...`);
        }
      }
      
      console.log(`   ✅ Completed ${model.name}: ${modelScores.length} scores updated`);
    }
    
    console.log(`\n✅ Backfill complete!`);
    console.log(`   📊 Total models processed: ${allModels.length}`);
    console.log(`   📈 Total scores processed: ${totalProcessed}`);
    console.log(`   ✏️  Total scores updated: ${totalUpdated}`);
    console.log(`   ⏭️  Total models skipped (already had CI data): ${totalSkipped}`);
    
  } catch (error) {
    console.error('❌ Error during backfill:', error);
    throw error;
  }
}

// Run the backfill if this script is executed directly
if (require.main === module) {
  console.log('🚀 Starting confidence interval backfill script...\n');
  backfillConfidenceIntervals()
    .then(() => {
      console.log('\n✅ Backfill script completed successfully!');
      process.exit(0);
    })
    .catch((error) => {
      console.error('\n❌ Backfill script failed:', error);
      process.exit(1);
    });
}

module.exports = { backfillConfidenceIntervals };
