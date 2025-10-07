#!/usr/bin/env node
// Run the suite field migration on the correct database
const { execSync } = require('child_process');
const path = require('path');

const dbPath = path.join(__dirname, 'data', 'stupid_meter.db');
const migrationPath = path.join(__dirname, 'migrations', 'add_suite_field.sql');

console.log(`Running migration on: ${dbPath}`);
console.log(`Migration file: ${migrationPath}`);

try {
  execSync(`sqlite3 "${dbPath}" < "${migrationPath}"`, { 
    stdio: 'inherit',
    cwd: __dirname 
  });
  console.log('✅ Migration completed successfully!');
  
  // Verify the field was added
  const result = execSync(`sqlite3 "${dbPath}" "PRAGMA table_info(scores);" | grep suite`, {
    encoding: 'utf8'
  });
  
  if (result.includes('suite')) {
    console.log('✅ Verified: suite field exists in scores table');
  } else {
    console.log('⚠️ Warning: Could not verify suite field');
  }
} catch (error) {
  console.error('❌ Migration failed:', error.message);
  process.exit(1);
}
