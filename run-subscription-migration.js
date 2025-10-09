#!/usr/bin/env node

/**
 * Run Subscription Fields Migration
 * Adds Stripe subscription management fields to router_users table
 */

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

// Database path - stupid_meter.db
const DB_PATH = '/root/data/stupid_meter.db';

console.log('🔄 Running subscription fields migration...');
console.log(`📁 Database: ${DB_PATH}`);

try {
  // Check if database exists
  if (!fs.existsSync(DB_PATH)) {
    console.error(`❌ Database not found at ${DB_PATH}`);
    process.exit(1);
  }

  // Open database connection
  const db = new Database(DB_PATH);
  
  // Read migration SQL
  const migrationPath = path.join(__dirname, 'migrations', 'add-subscription-fields.sql');
  const migrationSQL = fs.readFileSync(migrationPath, 'utf8');
  
  // Execute migration
  console.log('📝 Executing migration SQL...');
  db.exec(migrationSQL);
  
  // Verify the migration
  console.log('✅ Verifying migration...');
  const tableInfo = db.prepare("PRAGMA table_info(router_users)").all();
  const newColumns = tableInfo.filter(col => 
    ['stripe_customer_id', 'stripe_subscription_id', 'subscription_tier', 
     'trial_started_at', 'trial_ends_at', 'subscription_ends_at',
     'subscription_canceled_at', 'last_payment_at'].includes(col.name)
  );
  
  console.log(`✅ Added ${newColumns.length} subscription columns:`);
  newColumns.forEach(col => {
    console.log(`   - ${col.name} (${col.type})`);
  });
  
  // Check indexes
  const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='router_users'").all();
  const subscriptionIndexes = indexes.filter(idx => idx.name.includes('subscription') || idx.name.includes('stripe') || idx.name.includes('trial'));
  console.log(`✅ Created ${subscriptionIndexes.length} subscription indexes`);
  
  db.close();
  console.log('✅ Subscription migration completed successfully!');
  
} catch (error) {
  console.error('❌ Migration failed:', error.message);
  console.error(error.stack);
  process.exit(1);
}
