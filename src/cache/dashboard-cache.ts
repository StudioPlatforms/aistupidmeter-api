import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { computeDashboardScores, PeriodKey, SortKey } from '../lib/dashboard-compute';

const CACHE_DIR = process.env.DASHBOARD_CACHE_DIR || '/tmp/stupidmeter-cache';
const CACHE_SCHEMA_VERSION = 5; // bump on any format/logic change
const BUILD_ID = process.env.BUILD_ID || safeGitSha() || 'dev';
const CACHE_TTL_SEC = parseInt(process.env.DASHBOARD_CACHE_TTL_SEC || '300', 10); // 5 minutes default

function safeGitSha() {
  try {
    const { execSync } = require('child_process');
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore','pipe','ignore'] }).toString().trim();
  } catch { return null; }
}

// stable, collision-proof key (do NOT omit analyticsPeriod if your UI sends it)
export function getCacheKey(period: string, sortBy: string, analyticsPeriod?: string) {
  const base = JSON.stringify({ p: period, s: sortBy, a: analyticsPeriod || null, sv: CACHE_SCHEMA_VERSION, b: BUILD_ID });
  const digest = crypto.createHash('sha1').update(base).digest('hex').slice(0, 12);
  return `dash:${period}:${sortBy}:${analyticsPeriod || 'na'}:v${CACHE_SCHEMA_VERSION}:${BUILD_ID}:${digest}`;
}

type CacheFile = {
  meta: { schema: number; build: string; createdAt: string; ttlSec: number; key: string; };
  data: any;
};

const memory = new Map<string, CacheFile>();

async function ensureDir() {
  await fs.mkdir(CACHE_DIR, { recursive: true });
}

function isExpired(cf: CacheFile) {
  const ageSec = (Date.now() - Date.parse(cf.meta.createdAt)) / 1000;
  return ageSec > (cf.meta.ttlSec || CACHE_TTL_SEC);
}

async function loadFromFile(cacheKey: string): Promise<CacheFile | null> {
  const file = path.join(CACHE_DIR, `${sanitize(cacheKey)}.json`);
  try {
    const raw = await fs.readFile(file, 'utf-8');
    const parsed: CacheFile = JSON.parse(raw);
    if (parsed?.meta?.schema !== CACHE_SCHEMA_VERSION) return null;
    if (parsed?.meta?.build !== BUILD_ID) return null;
    if (isExpired(parsed)) return null;
    return parsed;
  } catch { return null; }
}

async function saveToFile(cacheKey: string, cf: CacheFile) {
  const file = path.join(CACHE_DIR, `${sanitize(cacheKey)}.json`);
  const tmp  = file + '.tmp';
  const json = JSON.stringify(cf);
  await fs.writeFile(tmp, json);
  await fs.rename(tmp, file); // atomic
}

function sanitize(k: string) { return k.replace(/[^a-zA-Z0-9:_-]/g, '_'); }

export async function getCachedData(period: string, sortBy: string, analyticsPeriod?: string) {
  await ensureDir();
  const key = getCacheKey(period, sortBy, analyticsPeriod);

  // 1) memory
  let cf = memory.get(key);
  if (cf && !isExpired(cf)) {
    return { success: true, cached: true, data: cf.data };
  }

  // 2) file (lazy, version+build checked)
  const fileCache = await loadFromFile(key);
  if (fileCache) {
    memory.set(key, fileCache);
    return { success: true, cached: true, data: fileCache.data };
  }

  // 3) MISS → compute using canonical function
  const data = await computeDashboardScores(period as PeriodKey, sortBy as SortKey);
  const fresh: CacheFile = {
    meta: { schema: CACHE_SCHEMA_VERSION, build: BUILD_ID, createdAt: new Date().toISOString(), ttlSec: CACHE_TTL_SEC, key },
    data
  };
  memory.set(key, fresh);
  await saveToFile(key, fresh);
  return { success: true, cached: false, data };
}

// Optional purge helpers
export async function purgeAllCache() {
  memory.clear();
  try {
    const files = await fs.readdir(CACHE_DIR);
    await Promise.all(files.map(f => fs.unlink(path.join(CACHE_DIR, f)).catch(()=>{})));
  } catch {}
}

export function getCacheStats() {
  return {
    memoryEntries: memory.size,
    memoryKeys: Array.from(memory.keys()),
    cacheDir: CACHE_DIR
  };
}

export function clearMemoryCache() {
  console.log('🧹 Clearing memory cache...');
  const beforeSize = memory.size;
  memory.clear();
  console.log(`✅ Cleared ${beforeSize} cache entries from memory`);
}

// Backward compatibility exports
export async function initializeCache() {
  await ensureDir();
  console.log('✅ Cache system initialized');
}

export async function refreshAllCache() {
  await purgeAllCache();
  return { 
    success: true, 
    message: 'Cache purged',
    refreshed: Date.now(),
    duration: 0,
    type: 'full'
  };
}

export function refreshHotCache() {
  memory.clear();
  return { 
    success: true, 
    message: 'Memory cache cleared',
    refreshed: memory.size,
    duration: 0,
    type: 'hot'
  };
}

export function trackCacheUsage() {
  // No-op for compatibility
}
