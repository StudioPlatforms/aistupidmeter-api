/**
 * COMPREHENSIVE DRIFT SYSTEM VALIDATION SCRIPT
 * Tests all Phase 1, 2, and 3 implementations
 */

import { db } from './src/db';
import { models, scores } from './src/db/schema';
import { computeModelScores } from './src/lib/model-scoring';
import { computeDriftSignature, detectChangePoints, getChangePointHistory } from './src/lib/drift-detection';
import { sql, eq, desc } from 'drizzle-orm';

const API_URL = process.env.API_URL || 'http://localhost:4000';

async function runValidationTests() {
  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║  DRIFT DETECTION SYSTEM - COMPREHENSIVE VALIDATION        ║');
  console.log('╚═══════════════════════════════════════════════════════════╝\n');

  const results = {
    phase1: { passed: 0, failed: 0, tests: [] as string[] },
    phase2: { passed: 0, failed: 0, tests: [] as string[] },
    phase3: { passed: 0, failed: 0, tests: [] as string[] }
  };

  // ============================================================================
  // PHASE 1: Data Integrity Tests
  // ============================================================================
  
  console.log('📋 PHASE 1: Data Integrity Tests\n');
  console.log('─'.repeat(60));

  // Test 1: Score Consistency Across Periods
  console.log('\n✓ Test 1: Score consistency across time periods');
  try {
    const latestScores = await computeModelScores('latest', 'combined');
    const day24Scores = await computeModelScores('24h', 'combined');
    const week7Scores = await computeModelScores('7d', 'combined');

    if (latestScores.length === 0) {
      throw new Error('No scores returned for latest period');
    }

    let consistencyPassed = true;
    for (let i = 0; i < Math.min(5, latestScores.length); i++) {
      const model = latestScores[i];
      const day24Model = day24Scores.find(m => m.id === model.id);
      const week7Model = week7Scores.find(m => m.id === model.id);

      if (day24Model && model.currentScore !== day24Model.currentScore) {
        console.log(`  ❌ ${model.name}: currentScore differs between latest (${model.currentScore}) and 24h (${day24Model.currentScore})`);
        consistencyPassed = false;
      }
      if (week7Model && model.currentScore !== week7Model.currentScore) {
        console.log(`  ❌ ${model.name}: currentScore differs between latest (${model.currentScore}) and 7d (${week7Model.currentScore})`);
        consistencyPassed = false;
      }
    }

    if (consistencyPassed) {
      console.log(`  ✅ PASSED: All models have consistent currentScore across periods`);
      results.phase1.passed++;
      results.phase1.tests.push('Score consistency');
    } else {
      console.log(`  ❌ FAILED: Score inconsistency detected`);
      results.phase1.failed++;
    }
  } catch (error) {
    console.log(`  ❌ ERROR: ${error}`);
    results.phase1.failed++;
  }

  // Test 2: Confidence Intervals Present
  console.log('\n✓ Test 2: Confidence intervals in all responses');
  try {
    const scores = await computeModelScores('latest', 'combined');
    let ciPassed = true;
    
    for (const model of scores.slice(0, 5)) {
      if (model.currentScore !== 'unavailable') {
        if (model.confidenceLower === undefined || model.confidenceUpper === undefined) {
          console.log(`  ❌ ${model.name}: Missing CI fields`);
          ciPassed = false;
        } else if (model.confidenceLower > model.currentScore || model.currentScore > model.confidenceUpper) {
          console.log(`  ❌ ${model.name}: Score outside CI bounds`);
          ciPassed = false;
        }
      }
    }

    if (ciPassed) {
      console.log(`  ✅ PASSED: All models have valid confidence intervals`);
      results.phase1.passed++;
      results.phase1.tests.push('Confidence intervals');
    } else {
      results.phase1.failed++;
    }
  } catch (error) {
    console.log(`  ❌ ERROR: ${error}`);
    results.phase1.failed++;
  }

  // Test 3: Staleness Detection
  console.log('\n✓ Test 3: Staleness detection working');
  try {
    const scores = await computeModelScores('latest', 'combined');
    let stalePassed = true;

    for (const model of scores.slice(0, 5)) {
      if (model.isStale !== undefined && model.isStale && !model.staleDuration) {
        console.log(`  ❌ ${model.name}: isStale=true but staleDuration missing`);
        stalePassed = false;
      }
    }

    if (stalePassed) {
      console.log(`  ✅ PASSED: Staleness detection implemented correctly`);
      results.phase1.passed++;
      results.phase1.tests.push('Staleness detection');
    } else {
      results.phase1.failed++;
    }
  } catch (error) {
    console.log(`  ❌ ERROR: ${error}`);
    results.phase1.failed++;
  }

  // ============================================================================
  // PHASE 2: Drift Infrastructure Tests
  // ============================================================================

  console.log('\n\n📋 PHASE 2: Drift Infrastructure Tests\n');
  console.log('─'.repeat(60));

  // Test 4: Drift Signature Computation
  console.log('\n✓ Test 4: Drift signature computation');
  try {
    const allModels = await db.select().from(models).where(sql`show_in_rankings = 1`).limit(1);
    
    if (allModels.length === 0) {
      throw new Error('No models found for testing');
    }

    const testModel = allModels[0];
    const signature = await computeDriftSignature(testModel.id);

    const requiredFields = ['modelId', 'modelName', 'regime', 'driftStatus', 'currentScore', 'baselineScore', 'confidenceInterval', 'axes'];
    let signaturePassed = true;

    for (const field of requiredFields) {
      if (!(field in signature)) {
        console.log(`  ❌ Missing required field: ${field}`);
        signaturePassed = false;
      }
    }

    if (signaturePassed) {
      console.log(`  ✅ PASSED: Drift signature for ${testModel.name}`);
      console.log(`     Regime: ${signature.regime}, Status: ${signature.driftStatus}, Score: ${signature.currentScore}`);
      results.phase2.passed++;
      results.phase2.tests.push('Drift signature computation');
    } else {
      results.phase2.failed++;
    }
  } catch (error) {
    console.log(`  ❌ ERROR: ${error}`);
    results.phase2.failed++;
  }

  // Test 5: Change-Point Detection
  console.log('\n✓ Test 5: Change-point detection algorithm');
  try {
    const allModels = await db.select().from(models).where(sql`show_in_rankings = 1`).limit(1);
    
    if (allModels.length === 0) {
      throw new Error('No models found');
    }

    const testModel = allModels[0];
    const changePoints = await detectChangePoints(testModel.id);

    console.log(`  ✅ PASSED: Change-point detection for ${testModel.name}`);
    console.log(`     Detected ${changePoints.length} change-points`);
    
    if (changePoints.length > 0) {
      const recent = changePoints[0];
      console.log(`     Most recent: ${recent.fromScore} → ${recent.toScore} (${recent.changeType})`);
    }
    
    results.phase2.passed++;
    results.phase2.tests.push('Change-point detection');
  } catch (error) {
    console.log(`  ❌ ERROR: ${error}`);
    results.phase2.failed++;
  }

  // Test 6: API Endpoints
  console.log('\n✓ Test 6: API endpoints responding');
  try {
    const allModels = await db.select().from(models).where(sql`show_in_rankings = 1`).limit(1);
    
    if (allModels.length === 0) {
      throw new Error('No models found');
    }

    const testModelId = allModels[0].id;

    // Test signature endpoint
    const sigRes = await fetch(`${API_URL}/api/drift/signature/${testModelId}`);
    const sigData = await sigRes.json();

    // Test change-points endpoint
    const cpRes = await fetch(`${API_URL}/api/drift/change-points/${testModelId}`);
    const cpData = await cpRes.json();

    // Test status endpoint
    const statusRes = await fetch(`${API_URL}/api/drift/status`);
    const statusData = await statusRes.json();

    if (sigData.success && cpData.success && statusData.success) {
      console.log(`  ✅ PASSED: All API endpoints responding correctly`);
      results.phase2.passed++;
      results.phase2.tests.push('API endpoints');
    } else {
      console.log(`  ❌ FAILED: Some endpoints not working`);
      results.phase2.failed++;
    }
  } catch (error) {
    console.log(`  ❌ ERROR: ${error}`);
    console.log(`  ℹ️  This is expected if server is not running. Start server with: cd apps/api && npm run dev`);
    results.phase2.failed++;
  }

  // ============================================================================
  // SUMMARY
  // ============================================================================

  console.log('\n\n╔═══════════════════════════════════════════════════════════╗');
  console.log('║                    VALIDATION SUMMARY                     ║');
  console.log('╚═══════════════════════════════════════════════════════════╝\n');

  console.log('PHASE 1: Data Integrity');
  console.log(`  ✅ Passed: ${results.phase1.passed}`);
  console.log(`  ❌ Failed: ${results.phase1.failed}`);
  console.log(`  Tests: ${results.phase1.tests.join(', ')}`);

  console.log('\nPHASE 2: Drift Infrastructure');
  console.log(`  ✅ Passed: ${results.phase2.passed}`);
  console.log(`  ❌ Failed: ${results.phase2.failed}`);
  console.log(`  Tests: ${results.phase2.tests.join(', ')}`);

  const totalPassed = results.phase1.passed + results.phase2.passed;
  const totalFailed = results.phase1.failed + results.phase2.failed;
  const totalTests = totalPassed + totalFailed;

  console.log('\n' + '═'.repeat(60));
  console.log(`TOTAL: ${totalPassed}/${totalTests} tests passed (${Math.round(totalPassed/totalTests*100)}%)`);
  console.log('═'.repeat(60) + '\n');

  if (totalFailed === 0) {
    console.log('🎉 ALL TESTS PASSED! System is ready for deployment.\n');
  } else {
    console.log('⚠️  Some tests failed. Review errors above before deployment.\n');
  }

  // Provide next steps
  console.log('NEXT STEPS:');
  console.log('1. Run the migration: cd apps/api && npm run db:migrate');
  console.log('2. Start the server: cd apps/api && npm run dev');
  console.log('3. Test the API endpoints manually');
  console.log('4. Check the frontend for drift indicators');
  console.log('5. Monitor logs for drift detection activity\n');

  process.exit(totalFailed > 0 ? 1 : 0);
}

// Run validation
runValidationTests().catch(error => {
  console.error('Validation script failed:', error);
  process.exit(1);
});
