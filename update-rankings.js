// Script to manually update model rankings
// Run with: node apps/api/update-rankings.js

const { updateModelRankings, getRankingStats } = require('./src/router/jobs/ranking-updater.ts');

async function main() {
  console.log('🚀 Manual ranking update started...\n');
  
  try {
    // Update rankings
    const result = await updateModelRankings();
    
    console.log('\n📊 Update Summary:');
    console.log(`  Success: ${result.success}`);
    console.log(`  Total Rankings: ${result.totalRankings}`);
    console.log(`  Categories: ${result.categories}`);
    
    // Get stats
    console.log('\n📈 Rankings by Category:');
    const stats = await getRankingStats();
    for (const stat of stats) {
      console.log(`  ${stat.category}: ${stat.count} models (updated: ${stat.lastUpdated})`);
    }
    
    console.log('\n✅ Ranking update complete!');
    process.exit(0);
    
  } catch (error) {
    console.error('\n❌ Ranking update failed:', error);
    process.exit(1);
  }
}

main();
