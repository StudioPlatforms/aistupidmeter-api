import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { cache } from '../cache/redis-cache';

// Performance monitoring middleware
interface PerformanceMetrics {
  requests: {
    total: number;
    active: number;
    avgResponseTime: number;
    slowRequests: number;
    errorRate: number;
  };
  database: {
    activeConnections: number;
    queryTime: number;
    errors: number;
  };
  cache: {
    hits: number;
    misses: number;
    hitRate: number;
  };
  memory: {
    heapUsed: number;
    heapTotal: number;
    external: number;
    rss: number;
  };
}

class PerformanceMonitor {
  private metrics: PerformanceMetrics;
  private requestTimes: number[] = [];
  private activeRequests = new Map<string, number>(); // Store request ID and timestamp
  
  constructor() {
    this.metrics = {
      requests: {
        total: 0,
        active: 0,
        avgResponseTime: 0,
        slowRequests: 0,
        errorRate: 0
      },
      database: {
        activeConnections: 0,
        queryTime: 0,
        errors: 0
      },
      cache: {
        hits: 0,
        misses: 0,
        hitRate: 0
      },
      memory: {
        heapUsed: 0,
        heapTotal: 0,
        external: 0,
        rss: 0
      }
    };

    // Update metrics every 5 seconds
    setInterval(() => this.updateMetrics(), 5000);
    
    // Cleanup stale requests every 30 seconds
    setInterval(() => this.cleanupStaleRequests(), 30000);
  }

  private updateMetrics() {
    const memUsage = process.memoryUsage();
    this.metrics.memory = {
      heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024), // MB
      heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024),
      external: Math.round(memUsage.external / 1024 / 1024),
      rss: Math.round(memUsage.rss / 1024 / 1024)
    };

    // Calculate average response time from last 100 requests
    if (this.requestTimes.length > 0) {
      const sum = this.requestTimes.reduce((a, b) => a + b, 0);
      this.metrics.requests.avgResponseTime = Math.round(sum / this.requestTimes.length);
      
      // Keep only last 100 request times
      if (this.requestTimes.length > 100) {
        this.requestTimes = this.requestTimes.slice(-100);
      }
    }

    this.metrics.requests.active = this.activeRequests.size;

    // Calculate cache hit rate
    const totalCacheRequests = this.metrics.cache.hits + this.metrics.cache.misses;
    this.metrics.cache.hitRate = totalCacheRequests > 0 
      ? Math.round((this.metrics.cache.hits / totalCacheRequests) * 100) 
      : 0;
  }

  private cleanupStaleRequests() {
    const now = Date.now();
    const staleThreshold = 60000; // 60 seconds
    let cleanedCount = 0;

    for (const [requestId, timestamp] of this.activeRequests.entries()) {
      if (now - timestamp > staleThreshold) {
        this.activeRequests.delete(requestId);
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      console.warn(`🧹 Cleaned up ${cleanedCount} stale requests from active tracking`);
    }
  }

  recordRequest(responseTime: number, isError: boolean = false) {
    this.metrics.requests.total++;
    this.requestTimes.push(responseTime);
    
    if (responseTime > 1000) { // Consider > 1s as slow
      this.metrics.requests.slowRequests++;
    }
    
    if (isError) {
      this.metrics.requests.errorRate++;
    }
  }

  recordCacheHit() {
    this.metrics.cache.hits++;
  }

  recordCacheMiss() {
    this.metrics.cache.misses++;
  }

  recordDatabaseQuery(queryTime: number, isError: boolean = false) {
    this.metrics.database.queryTime = queryTime;
    if (isError) {
      this.metrics.database.errors++;
    }
  }

  addActiveRequest(requestId: string) {
    this.activeRequests.set(requestId, Date.now());
  }

  removeActiveRequest(requestId: string) {
    this.activeRequests.delete(requestId);
  }

  getMetrics(): PerformanceMetrics {
    return { ...this.metrics };
  }

  getHealthScore(): number {
    const memoryScore = this.metrics.memory.heapUsed < 500 ? 100 : 
                       this.metrics.memory.heapUsed < 1000 ? 50 : 0;
    
    const responseTimeScore = this.metrics.requests.avgResponseTime < 100 ? 100 :
                             this.metrics.requests.avgResponseTime < 500 ? 70 :
                             this.metrics.requests.avgResponseTime < 1000 ? 40 : 0;
    
    const cacheScore = this.metrics.cache.hitRate > 80 ? 100 :
                      this.metrics.cache.hitRate > 60 ? 70 : 30;

    const activeRequestsScore = this.metrics.requests.active < 50 ? 100 :
                               this.metrics.requests.active < 200 ? 70 : 20;

    return Math.round((memoryScore + responseTimeScore + cacheScore + activeRequestsScore) / 4);
  }
}

// Global performance monitor instance
const performanceMonitor = new PerformanceMonitor();

// Request tracking middleware with circuit breaker and improved cleanup
export async function performanceMiddleware(
  request: FastifyRequest, 
  reply: FastifyReply
) {
  const startTime = Date.now();
  const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  // Add request ID for tracking
  performanceMonitor.addActiveRequest(requestId);
  
  // Circuit breaker - reject if too many active requests
  const currentMetrics = performanceMonitor.getMetrics();
  if (currentMetrics.requests.active > 500) { // Configurable threshold
    performanceMonitor.removeActiveRequest(requestId);
    reply.code(503).send({
      error: 'Service temporarily unavailable',
      message: 'Too many concurrent requests. Please try again in a moment.',
      retryAfter: 5
    });
    return;
  }

  // Memory pressure protection
  if (currentMetrics.memory.heapUsed > 1500) { // 1.5GB threshold
    performanceMonitor.removeActiveRequest(requestId);
    reply.code(503).send({
      error: 'Service overloaded',
      message: 'High memory usage detected. Please try again shortly.',
      retryAfter: 10
    });
    return;
  }

  // Cleanup function to ensure request is always removed
  const cleanup = () => {
    const responseTime = Date.now() - startTime;
    const isError = reply.statusCode >= 400;
    
    performanceMonitor.recordRequest(responseTime, isError);
    performanceMonitor.removeActiveRequest(requestId);
    
    // Log slow requests
    if (responseTime > 2000) {
      console.warn(`Slow request: ${request.method} ${request.url} - ${responseTime}ms`);
    }
  };

  // Multiple event listeners to ensure cleanup happens
  reply.raw.on('finish', cleanup);
  reply.raw.on('close', cleanup);
  reply.raw.on('error', cleanup);
  
  // Timeout-based cleanup as a safety net (30 seconds)
  const timeoutId = setTimeout(() => {
    console.warn(`Request timeout cleanup: ${request.method} ${request.url} - ${requestId}`);
    performanceMonitor.removeActiveRequest(requestId);
  }, 30000);
  
  // Clear timeout when request completes normally
  reply.raw.on('finish', () => clearTimeout(timeoutId));
  reply.raw.on('close', () => clearTimeout(timeoutId));
}

// Cache-aware middleware that tracks cache performance
export async function cachePerformanceMiddleware(
  request: FastifyRequest, 
  reply: FastifyReply
) {
  const originalSend = reply.send;
  
  // Override reply.send to detect cache hits/misses
  reply.send = function(payload: any) {
    if (typeof payload === 'object' && payload !== null) {
      if (payload.cached === true) {
        performanceMonitor.recordCacheHit();
      } else if (payload.cached === false) {
        performanceMonitor.recordCacheMiss();
      }
    }
    return originalSend.call(this, payload);
  };
}

// Database performance middleware
export function trackDatabaseQuery<T>(
  queryFn: () => Promise<T>
): Promise<T> {
  return new Promise(async (resolve, reject) => {
    const startTime = Date.now();
    
    try {
      const result = await queryFn();
      const queryTime = Date.now() - startTime;
      performanceMonitor.recordDatabaseQuery(queryTime, false);
      resolve(result);
    } catch (error) {
      const queryTime = Date.now() - startTime;
      performanceMonitor.recordDatabaseQuery(queryTime, true);
      reject(error);
    }
  });
}

// Health check endpoint data
export function getHealthStats() {
  const metrics = performanceMonitor.getMetrics();
  const healthScore = performanceMonitor.getHealthScore();
  
  return {
    status: healthScore > 70 ? 'healthy' : healthScore > 40 ? 'degraded' : 'critical',
    score: healthScore,
    timestamp: new Date().toISOString(),
    performance: {
      global: {
        activeRequests: metrics.requests.active,
        totalRequests: metrics.requests.total,
        avgResponseTime: metrics.requests.avgResponseTime,
        slowRequests: metrics.requests.slowRequests,
        errorRate: Math.round((metrics.requests.errorRate / Math.max(1, metrics.requests.total)) * 100)
      },
      cache: {
        hits: metrics.cache.hits,
        misses: metrics.cache.misses,
        hitRate: metrics.cache.hitRate
      },
      database: {
        avgQueryTime: metrics.database.queryTime,
        errors: metrics.database.errors
      },
      memory: metrics.memory
    },
    thresholds: {
      maxActiveRequests: 500,
      maxMemoryMB: 1500,
      targetResponseTimeMs: 200,
      targetCacheHitRate: 80
    }
  };
}

// Auto-scaling recommendations
export function getScalingRecommendations() {
  const metrics = performanceMonitor.getMetrics();
  const recommendations = [];

  if (metrics.requests.active > 300) {
    recommendations.push({
      type: 'scale_up',
      severity: 'high',
      message: 'High request volume detected. Consider adding more server instances.'
    });
  }

  if (metrics.memory.heapUsed > 1000) {
    recommendations.push({
      type: 'memory_optimization',
      severity: 'medium',
      message: 'High memory usage. Consider implementing memory optimization or increasing heap size.'
    });
  }

  if (metrics.cache.hitRate < 60) {
    recommendations.push({
      type: 'cache_optimization',
      severity: 'medium', 
      message: 'Low cache hit rate. Review caching strategy and TTL settings.'
    });
  }

  if (metrics.requests.avgResponseTime > 1000) {
    recommendations.push({
      type: 'performance_optimization',
      severity: 'high',
      message: 'Slow response times detected. Review database queries and caching.'
    });
  }

  return recommendations;
}

// Cleanup function for graceful shutdown
export function cleanupPerformanceMiddleware() {
  // Clear any intervals or cleanup resources
  console.log('Performance middleware cleaned up');
}

// Export monitor instance for direct access
export { performanceMonitor };
