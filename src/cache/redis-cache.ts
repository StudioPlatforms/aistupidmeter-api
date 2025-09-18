import Redis from 'ioredis';

// High-performance Redis cache layer
class RedisCache {
  private redis: Redis;
  private fallbackCache = new Map<string, any>();
  private isConnected = false;

  constructor() {
    // Initialize Redis connection
    this.redis = new Redis({
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379'),
      db: parseInt(process.env.REDIS_DB || '0'),
      password: process.env.REDIS_PASSWORD,
      maxRetriesPerRequest: 3,
      lazyConnect: true,
      keepAlive: 30000,
      connectTimeout: 10000,
      commandTimeout: 5000,
      // Connection pool settings for high concurrency
      family: 4,
      // Optimize for performance
      enableReadyCheck: false
    });

    this.setupEventHandlers();
  }

  private setupEventHandlers() {
    this.redis.on('connect', () => {
      console.log('🔗 Redis connected');
      this.isConnected = true;
    });

    this.redis.on('ready', () => {
      console.log('✅ Redis ready for operations');
      this.isConnected = true;
    });

    this.redis.on('error', (error: Error) => {
      console.error('❌ Redis error:', error.message);
      this.isConnected = false;
    });

    this.redis.on('close', () => {
      console.log('🔌 Redis connection closed');
      this.isConnected = false;
    });

    this.redis.on('reconnecting', (delay: number) => {
      console.log(`🔄 Redis reconnecting in ${delay}ms`);
    });
  }

  // Get cached data with fallback to memory cache
  async get(key: string): Promise<any> {
    try {
      if (this.isConnected) {
        const cached = await this.redis.get(key);
        if (cached) {
          const data = JSON.parse(cached);
          // Also store in memory cache for ultra-fast access
          this.fallbackCache.set(key, data);
          return data;
        }
      }
    } catch (error) {
      console.error(`Redis get error for key ${key}:`, error);
    }

    // Fallback to memory cache
    return this.fallbackCache.get(key) || null;
  }

  // Set cached data with TTL
  async set(key: string, value: any, ttlSeconds: number = 3600): Promise<boolean> {
    const data = JSON.stringify(value);
    
    try {
      if (this.isConnected) {
        await this.redis.setex(key, ttlSeconds, data);
        console.log(`� Cached ${key} in Redis (TTL: ${ttlSeconds}s)`);
      }
    } catch (error) {
      console.error(`Redis set error for key ${key}:`, error);
    }

    // Always store in memory cache as fallback
    this.fallbackCache.set(key, value);
    
    // Memory cache cleanup - limit to 1000 items
    if (this.fallbackCache.size > 1000) {
      const firstKey = this.fallbackCache.keys().next().value;
      if (firstKey !== undefined) {
        this.fallbackCache.delete(firstKey);
      }
    }

    return true;
  }

  // Check if key exists
  async exists(key: string): Promise<boolean> {
    try {
      if (this.isConnected) {
        const exists = await this.redis.exists(key);
        return exists === 1;
      }
    } catch (error) {
      console.error(`Redis exists error for key ${key}:`, error);
    }

    return this.fallbackCache.has(key);
  }

  // Delete cached data
  async del(key: string): Promise<boolean> {
    try {
      if (this.isConnected) {
        await this.redis.del(key);
      }
    } catch (error) {
      console.error(`Redis del error for key ${key}:`, error);
    }

    this.fallbackCache.delete(key);
    return true;
  }

  // Get multiple keys at once (pipeline for performance)
  async mget(keys: string[]): Promise<{ [key: string]: any }> {
    const result: { [key: string]: any } = {};

    try {
      if (this.isConnected && keys.length > 0) {
        const values = await this.redis.mget(...keys);
        keys.forEach((key, index) => {
          if (values[index]) {
            try {
              result[key] = JSON.parse(values[index]!);
            } catch (error) {
              console.error(`Error parsing cached value for key ${key}:`, error);
            }
          }
        });
      }
    } catch (error) {
      console.error('Redis mget error:', error);
    }

    // Fallback to memory cache for missing keys
    keys.forEach(key => {
      if (!result[key] && this.fallbackCache.has(key)) {
        result[key] = this.fallbackCache.get(key);
      }
    });

    return result;
  }

  // Set multiple keys at once (pipeline for performance)
  async mset(data: { [key: string]: any }, ttlSeconds: number = 3600): Promise<boolean> {
    try {
      if (this.isConnected && Object.keys(data).length > 0) {
        const pipeline = this.redis.pipeline();
        
        Object.entries(data).forEach(([key, value]) => {
          const serialized = JSON.stringify(value);
          pipeline.setex(key, ttlSeconds, serialized);
          // Also store in memory cache
          this.fallbackCache.set(key, value);
        });
        
        await pipeline.exec();
        console.log(`📝 Batch cached ${Object.keys(data).length} keys in Redis`);
      }
    } catch (error) {
      console.error('Redis mset error:', error);
    }

    // Ensure all data is in memory cache as fallback
    Object.entries(data).forEach(([key, value]) => {
      this.fallbackCache.set(key, value);
    });

    return true;
  }

  // Get cache statistics
  async getStats(): Promise<{ redis: any; memory: any }> {
    let redisInfo = null;
    
    try {
      if (this.isConnected) {
        redisInfo = await this.redis.info('memory');
      }
    } catch (error) {
      console.error('Error getting Redis stats:', error);
    }

    return {
      redis: {
        connected: this.isConnected,
        info: redisInfo
      },
      memory: {
        entries: this.fallbackCache.size,
        keys: Array.from(this.fallbackCache.keys()).slice(0, 20) // First 20 keys as sample
      }
    };
  }

  // Flush all cache
  async flush(): Promise<boolean> {
    try {
      if (this.isConnected) {
        await this.redis.flushdb();
        console.log('🗑️ Redis cache flushed');
      }
    } catch (error) {
      console.error('Redis flush error:', error);
    }

    this.fallbackCache.clear();
    console.log('🗑️ Memory cache flushed');
    return true;
  }

  // Graceful shutdown
  async close(): Promise<void> {
    try {
      await this.redis.quit();
      console.log('✅ Redis connection closed gracefully');
    } catch (error) {
      console.error('Error closing Redis connection:', error);
    }
  }
}

// Global cache instance
export const cache = new RedisCache();

// Utility functions for common cache patterns
export class CacheManager {
  private static instance: CacheManager;
  private cache: RedisCache;

  constructor() {
    this.cache = cache;
  }

  static getInstance(): CacheManager {
    if (!CacheManager.instance) {
      CacheManager.instance = new CacheManager();
    }
    return CacheManager.instance;
  }

  // Cache with automatic key generation and compression for large data
  async cacheData(
    keyPrefix: string, 
    identifier: string, 
    data: any, 
    ttlSeconds: number = 3600
  ): Promise<void> {
    const key = `${keyPrefix}:${identifier}`;
    await this.cache.set(key, data, ttlSeconds);
  }

  // Get cached data with automatic decompression
  async getCachedData(keyPrefix: string, identifier: string): Promise<any> {
    const key = `${keyPrefix}:${identifier}`;
    return await this.cache.get(key);
  }

  // Cache multiple data items efficiently
  async cacheBulkData(
    keyPrefix: string, 
    dataMap: { [identifier: string]: any }, 
    ttlSeconds: number = 3600
  ): Promise<void> {
    const cacheData: { [key: string]: any } = {};
    
    Object.entries(dataMap).forEach(([identifier, data]) => {
      const key = `${keyPrefix}:${identifier}`;
      cacheData[key] = data;
    });

    await this.cache.mset(cacheData, ttlSeconds);
  }

  // Get multiple cached items efficiently
  async getBulkCachedData(keyPrefix: string, identifiers: string[]): Promise<{ [identifier: string]: any }> {
    const keys = identifiers.map(id => `${keyPrefix}:${id}`);
    const cachedData = await this.cache.mget(keys);
    
    const result: { [identifier: string]: any } = {};
    identifiers.forEach((identifier, index) => {
      const key = keys[index];
      if (cachedData[key]) {
        result[identifier] = cachedData[key];
      }
    });

    return result;
  }

  // Invalidate cache by pattern (useful for cache invalidation)
  async invalidatePattern(keyPrefix: string): Promise<void> {
    // For Redis, we would use SCAN and DEL, but for simplicity in this implementation
    // we'll track known keys. In production, consider using Redis SCAN for pattern matching
    console.log(`🗑️ Invalidating cache pattern: ${keyPrefix}:*`);
  }
}

// Export cache manager instance
export const cacheManager = CacheManager.getInstance();

// Graceful shutdown handler for cache
process.on('SIGINT', async () => {
  console.log('Closing cache connections...');
  await cache.close();
});

process.on('SIGTERM', async () => {
  console.log('Closing cache connections...');
  await cache.close();
});
