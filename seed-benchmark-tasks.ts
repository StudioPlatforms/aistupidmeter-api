import dotenv from 'dotenv';
import path from 'path';

// Load environment variables
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

import { db } from './src/db/index';
import { tasks } from './src/db/schema';
import { eq } from 'drizzle-orm';

const BENCHMARK_TASKS = [
  // Easy tasks (baseline capability check)
  {
    slug: 'py/is_palindrome',
    lang: 'py',
    type: 'impl',
    difficulty: 1,
    schemaUri: null
  },
  {
    slug: 'py/prime_check',
    lang: 'py',
    type: 'impl',
    difficulty: 1,
    schemaUri: null
  },

  // Medium tasks (algorithmic thinking)
  {
    slug: 'py/binary_search',
    lang: 'py',
    type: 'impl',
    difficulty: 2,
    schemaUri: null
  },
  {
    slug: 'py/merge_intervals',
    lang: 'py',
    type: 'impl',
    difficulty: 2,
    schemaUri: null
  },
  {
    slug: 'py/lru_cache',
    lang: 'py',
    type: 'impl',
    difficulty: 3,
    schemaUri: null
  },

  // Hard tasks (complex algorithms)
  {
    slug: 'py/dijkstra',
    lang: 'py',
    type: 'impl',
    difficulty: 4,
    schemaUri: null
  },
  {
    slug: 'py/word_break',
    lang: 'py',
    type: 'impl',
    difficulty: 4,
    schemaUri: null
  },
  {
    slug: 'py/regex_match',
    lang: 'py',
    type: 'impl',
    difficulty: 5,
    schemaUri: null
  },

  // Debugging tasks (fix broken code)
  {
    slug: 'py/debug_sort',
    lang: 'py',
    type: 'fix',
    difficulty: 3,
    schemaUri: null
  },

  // Code optimization tasks
  {
    slug: 'py/optimize_fibonacci',
    lang: 'py',
    type: 'refactor',
    difficulty: 2,
    schemaUri: null
  }
];

async function seedBenchmarkTasks() {
  console.log('🌱 Seeding benchmark tasks...');
  
  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const task of BENCHMARK_TASKS) {
    try {
      // Check if task already exists
      const existing = await db.select().from(tasks).where(eq(tasks.slug, task.slug)).limit(1);
      
      if (existing.length > 0) {
        // Update existing task
        await db.update(tasks)
          .set({
            lang: task.lang,
            type: task.type,
            difficulty: task.difficulty,
            schemaUri: task.schemaUri,
            hidden: false
          })
          .where(eq(tasks.slug, task.slug));
        updated++;
        console.log(`✅ Updated task: ${task.slug}`);
      } else {
        // Create new task
        await db.insert(tasks).values({
          slug: task.slug,
          lang: task.lang,
          type: task.type,
          difficulty: task.difficulty,
          schemaUri: task.schemaUri,
          hidden: false
        });
        created++;
        console.log(`✅ Created task: ${task.slug}`);
      }
    } catch (error) {
      console.error(`❌ Error seeding task ${task.slug}:`, error);
      skipped++;
    }
  }

  console.log(`\n📊 Seeding complete:`);
  console.log(`   • Created: ${created} tasks`);
  console.log(`   • Updated: ${updated} tasks`);
  console.log(`   • Skipped: ${skipped} tasks`);
  console.log(`   • Total: ${BENCHMARK_TASKS.length} benchmark tasks processed`);

  // Verify all tasks exist
  const allTasks = await db.select().from(tasks).where(eq(tasks.lang, 'py'));
  console.log(`\n✅ Database now contains ${allTasks.length} Python tasks`);
  
  return { created, updated, skipped };
}

if (require.main === module) {
  seedBenchmarkTasks()
    .then(() => {
      console.log('\n🎉 Benchmark tasks seeding completed successfully!');
      process.exit(0);
    })
    .catch((error) => {
      console.error('❌ Seeding failed:', error);
      process.exit(1);
    });
}

export { seedBenchmarkTasks };
