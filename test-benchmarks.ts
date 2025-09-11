import dotenv from 'dotenv';
import path from 'path';

// Load environment variables
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

import { runRealBenchmarks } from './src/jobs/real-benchmarks';

async function testBenchmarks() {
  console.log('🧪 Testing real benchmarks with actual API calls...\n');
  
  try {
    await runRealBenchmarks();
    console.log('\n✅ Benchmark test completed successfully!');
  } catch (error) {
    console.error('\n❌ Benchmark test failed:', error);
    process.exit(1);
  }
}

testBenchmarks()
  .then(() => {
    console.log('\n🎉 All tests passed!');
    process.exit(0);
  })
  .catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
