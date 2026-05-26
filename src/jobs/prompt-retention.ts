/**
 * Prompt Retention Cleanup Job
 *
 * Runs daily to purge expired prompt text based on per-user retention settings.
 * Also reconciles per-key spend counters against actual request costs.
 * Also cleans up the prompt access log (Fix #12).
 */

import { db, dbPool } from '../db/connection-pool';
import { routerUsers, routerRequests, routerApiKeys, routerPromptAccessLog } from '../db/router-schema';
import { eq, and, sql, lt } from 'drizzle-orm';

// Fix #12: Access log retention — 365 days by default
const ACCESS_LOG_RETENTION_DAYS = 365;

/**
 * Purge expired prompts based on each user's retention_days setting.
 * Sets prompt_text to NULL (does not delete the request row).
 * Fix #13: Runs WAL checkpoint + secure_delete after purge.
 */
export async function runPromptRetentionCleanup(): Promise<{ usersProcessed: number; promptsPurged: number; accessLogPurged: number }> {
  let usersProcessed = 0;
  let promptsPurged = 0;
  let accessLogPurged = 0;

  try {
    // Get all users with prompt retention configured
    const users = await db
      .select({
        id: routerUsers.id,
        retentionDays: routerUsers.prompt_retention_days,
      })
      .from(routerUsers);

    // Fix #13 (corrected ordering): Enable secure_delete BEFORE the UPDATEs that
    // NULL prompt_text. secure_delete affects future writes: freed pages are zeroed
    // during the write, not retroactively. Order must be:
    //   1. PRAGMA secure_delete = ON
    //   2. UPDATE ... SET prompt_text = NULL (writes zeros over freed bytes)
    //   3. PRAGMA wal_checkpoint(TRUNCATE) (reclaims WAL file)
    //   4. PRAGMA secure_delete = OFF (restore default for normal operations)
    const sqlite = dbPool.getWriteConnection();
    let needsSecureCleanup = false;

    // Check if any users have expired prompts (pre-scan to decide secure_delete)
    for (const user of users) {
      const retentionDays = user.retentionDays;
      if (!retentionDays || retentionDays <= 0) continue;
      const cutoff = new Date(Date.now() - retentionDays * 86400000).toISOString();
      const check = await db
        .select({ count: sql<number>`count(*)` })
        .from(routerRequests)
        .where(
          and(
            eq(routerRequests.user_id, user.id),
            lt(routerRequests.created_at, cutoff),
            sql`${routerRequests.prompt_text} IS NOT NULL`
          )
        );
      if ((check[0]?.count || 0) > 0) {
        needsSecureCleanup = true;
        break;
      }
    }

    // Step 1: Enable secure_delete BEFORE any destructive writes
    if (needsSecureCleanup) {
      try { sqlite.pragma('secure_delete = ON'); } catch {}
    }

    // Step 2: Perform the actual purge (now writes zeros over freed pages)
    for (const user of users) {
      const retentionDays = user.retentionDays;
      if (!retentionDays || retentionDays <= 0) continue;

      const cutoff = new Date(Date.now() - retentionDays * 86400000).toISOString();

      const result = await db
        .update(routerRequests)
        .set({ prompt_text: null })
        .where(
          and(
            eq(routerRequests.user_id, user.id),
            lt(routerRequests.created_at, cutoff),
            sql`${routerRequests.prompt_text} IS NOT NULL`
          )
        )
        .returning({ id: routerRequests.id });

      if (result.length > 0) {
        promptsPurged += result.length;
        usersProcessed++;
        console.log(`🗑️ Purged ${result.length} expired prompts for user ${user.id} (retention: ${retentionDays}d)`);
      }
    }

    // Fix #12: Clean up old access log entries (unbounded growth prevention)
    try {
      const accessCutoff = new Date(Date.now() - ACCESS_LOG_RETENTION_DAYS * 86400000).toISOString();
      const accessResult = await db
        .delete(routerPromptAccessLog)
        .where(lt(routerPromptAccessLog.accessed_at, accessCutoff))
        .returning({ id: routerPromptAccessLog.id });
      accessLogPurged = accessResult.length;
      if (accessLogPurged > 0) {
        console.log(`🗑️ Purged ${accessLogPurged} old access log entries (> ${ACCESS_LOG_RETENTION_DAYS}d)`);
      }
    } catch (err) {
      console.error('Access log cleanup failed:', err);
    }

    // Step 3: WAL checkpoint to reclaim the WAL file
    // Step 4: Disable secure_delete for normal operations
    if (promptsPurged > 0) {
      try {
        sqlite.pragma('wal_checkpoint(TRUNCATE)');
        sqlite.pragma('secure_delete = OFF');
        console.log(`🔒 secure_delete + WAL checkpoint completed after purging ${promptsPurged} prompts`);
      } catch (err) {
        console.error('WAL checkpoint failed:', err);
        try { sqlite.pragma('secure_delete = OFF'); } catch {} // Always restore
      }
    } else if (needsSecureCleanup) {
      // No prompts purged despite expectation — still restore
      try { sqlite.pragma('secure_delete = OFF'); } catch {}
    }

    if (promptsPurged > 0) {
      console.log(`✅ Prompt retention cleanup: purged ${promptsPurged} prompts across ${usersProcessed} users`);
    }
  } catch (error) {
    console.error('❌ Prompt retention cleanup failed:', error);
  }

  return { usersProcessed, promptsPurged, accessLogPurged };
}

/**
 * Reconcile per-key spend counters against actual SUM from router_requests.
 * Corrects any drift in the denormalized current_month_spend counter.
 * Fix #6: Also zeros stale counters for keys with no traffic this month,
 *         and logs drift magnitude per key for monitoring.
 */
export async function reconcileSpendCounters(): Promise<{ keysReconciled: number; driftCorrected: number; staleZeroed: number }> {
  let keysReconciled = 0;
  let driftCorrected = 0;
  let staleZeroed = 0;

  try {
    const currentMonth = new Date().toISOString().substring(0, 7);

    // Get all active keys with their current counter
    const keys = await db
      .select({
        id: routerApiKeys.id,
        currentSpend: routerApiKeys.current_month_spend,
        currentMonthKey: routerApiKeys.current_month_key,
      })
      .from(routerApiKeys)
      .where(eq(routerApiKeys.revoked, false));

    for (const key of keys) {
      keysReconciled++;

      // Fix #6: Zero out stale counters from previous months that received no traffic
      if (key.currentMonthKey && key.currentMonthKey !== currentMonth && (key.currentSpend || 0) > 0) {
        staleZeroed++;
        await db
          .update(routerApiKeys)
          .set({
            current_month_spend: 0,
            current_month_key: currentMonth,
          })
          .where(eq(routerApiKeys.id, key.id));
        console.log(`🔧 Zeroed stale spend counter for key ${key.id} (was $${(key.currentSpend || 0).toFixed(4)} from ${key.currentMonthKey})`);
        continue; // No need to reconcile, we just reset
      }

      // Calculate actual spend from requests table
      const actualResult = await db
        .select({
          totalCost: sql<number>`COALESCE(SUM(${routerRequests.cost_estimate}), 0)`,
        })
        .from(routerRequests)
        .where(
          and(
            eq(routerRequests.api_key_id, key.id),
            sql`${routerRequests.created_at} >= ${currentMonth + '-01'}`
          )
        );

      const actualSpend = actualResult[0]?.totalCost || 0;
      const counterSpend = key.currentMonthKey === currentMonth ? (key.currentSpend || 0) : 0;
      const drift = Math.abs(actualSpend - counterSpend);

      // Only update if there's meaningful drift (> $0.0001)
      if (drift > 0.0001) {
        driftCorrected++;
        // Fix #9 from review: Log drift magnitude per key as a canary for concurrency bugs
        console.log(`🔧 Spend drift for key ${key.id}: counter=$${counterSpend.toFixed(4)} actual=$${actualSpend.toFixed(4)} drift=$${drift.toFixed(4)}`);
        await db
          .update(routerApiKeys)
          .set({
            current_month_spend: actualSpend,
            current_month_key: currentMonth,
          })
          .where(eq(routerApiKeys.id, key.id));
      }
    }

    if (driftCorrected > 0 || staleZeroed > 0) {
      console.log(`🔧 Spend reconciliation: corrected ${driftCorrected}/${keysReconciled} keys, zeroed ${staleZeroed} stale counters`);
    }
  } catch (error) {
    console.error('❌ Spend reconciliation failed:', error);
  }

  return { keysReconciled, driftCorrected, staleZeroed };
}
