#!/usr/bin/env node
/**
 * Create Admin Account Script
 * Creates an admin user with permanent pro subscription access
 * 
 * Email: admin@aistupidlevel.info
 * Password: Password123$
 * 
 * This account bypasses Stripe and has permanent pro access
 */

import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import path from 'path';

// Database path
const DB_PATH = process.env.DATABASE_URL || '/root/data/stupid_meter.db';

const ADMIN_EMAIL = 'admin@aistupidlevel.info';
const ADMIN_PASSWORD = 'Password123$';
const ADMIN_NAME = 'Admin Account';

async function createAdminAccount() {
  console.log('🔧 Creating admin account...');
  console.log(`📧 Email: ${ADMIN_EMAIL}`);
  console.log(`📁 Database: ${DB_PATH}`);
  
  const db = new Database(DB_PATH);
  
  try {
    // Check if user already exists
    const existingUser = db.prepare('SELECT * FROM router_users WHERE email = ?').get(ADMIN_EMAIL);
    
    if (existingUser) {
      console.log('⚠️  Admin user already exists!');
      console.log('User details:', {
        id: (existingUser as any).id,
        email: (existingUser as any).email,
        subscription_tier: (existingUser as any).subscription_tier,
        created_at: (existingUser as any).created_at
      });
      
      // Update existing user to ensure pro access
      console.log('🔄 Updating existing user to ensure pro access...');
      const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 12);
      
      db.prepare(`
        UPDATE router_users SET
          password_hash = ?,
          subscription_tier = 'pro',
          subscription_status = 'active',
          email_verified = 1,
          name = ?,
          updated_at = datetime('now'),
          -- Clear any expiration dates for permanent access
          trial_ends_at = NULL,
          subscription_ends_at = NULL,
          subscription_canceled_at = NULL
        WHERE email = ?
      `).run(passwordHash, ADMIN_NAME, ADMIN_EMAIL);
      
      console.log('✅ Admin user updated successfully with permanent pro access!');
      return;
    }
    
    // Hash password
    console.log('🔐 Hashing password...');
    const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 12);
    
    // Insert admin user
    console.log('💾 Inserting admin user into database...');
    const result = db.prepare(`
      INSERT INTO router_users (
        email,
        password_hash,
        name,
        email_verified,
        subscription_status,
        subscription_tier,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, 1, 'active', 'pro', datetime('now'), datetime('now'))
    `).run(ADMIN_EMAIL, passwordHash, ADMIN_NAME);
    
    console.log('✅ Admin account created successfully!');
    console.log('📊 User ID:', result.lastInsertRowid);
    
    // Verify the user was created
    const newUser = db.prepare('SELECT id, email, name, subscription_tier, subscription_status, email_verified FROM router_users WHERE id = ?')
      .get(result.lastInsertRowid);
    
    console.log('\n📋 Account Details:');
    console.log('  Email:', (newUser as any).email);
    console.log('  Name:', (newUser as any).name);
    console.log('  Subscription Tier:', (newUser as any).subscription_tier);
    console.log('  Subscription Status:', (newUser as any).subscription_status);
    console.log('  Email Verified:', (newUser as any).email_verified ? 'Yes' : 'No');
    console.log('\n🔑 Login Credentials:');
    console.log(`  Email: ${ADMIN_EMAIL}`);
    console.log(`  Password: ${ADMIN_PASSWORD}`);
    console.log('\n✨ This account has permanent pro access without Stripe subscription!');
    
  } catch (error) {
    console.error('❌ Error creating admin account:', error);
    throw error;
  } finally {
    db.close();
  }
}

// Run the script
createAdminAccount()
  .then(() => {
    console.log('\n✅ Script completed successfully!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Script failed:', error);
    process.exit(1);
  });
