/**
 * Performance Monitoring Middleware
 *
 * Tracks request timing, cache hit rates, and slow queries
 * for ongoing performance optimization
 */

import { FastifyRequest, FastifyReply, FastifyInstance } from 'fastify';

interface PerformanceMetrics {
  totalRequests: number;
  slowRequests: number;
  cacheHits: number;
  cacheMisses: number;
  averageResponseTime: number;
  p95ResponseTime: number;
  p99ResponseTime: number;
}

const metrics: PerformanceMetrics = {
  totalRequests: 0,
  slowRequests: 0,
  cacheHits: 0,
  cacheMisses: 0,
  averageResponseTime: 0,
  p95ResponseTime: 0,
  p99ResponseTime: 0,
};

const responseTimes: number[] = [];
const requestStartTimes = new WeakMap<FastifyRequest, number>();
const MAX_RESPONSE_TIME_SAMPLES = 1000;
const SLOW_REQUEST_THRESHOLD_MS = 3000;

/**
 * Performance monitoring hook for Fastify
 * Use this as a preHandler hook to track request timing
 */
export async function performanceMonitorPreHandler(
  request: FastifyRequest,
  reply: FastifyReply
) {
  // Record start time for this request
  requestStartTimes.set(request, Date.now());
}

/**
 * Performance monitoring onResponse hook
 * Calculates and logs request duration
 */
export async function performanceMonitorOnResponse(
  request: FastifyRequest,
  reply: FastifyReply
) {
  const startTime = requestStartTimes.get(request);
  if (!startTime) return;
  
  const duration = Date.now() - startTime;
  const route = request.routerPath || request.url;
  
  // Update metrics
  metrics.totalRequests++;
  
  if (duration > SLOW_REQUEST_THRESHOLD_MS) {
    metrics.slowRequests++;
    console.warn(`⚠️ Slow request: ${route} took ${duration}ms`);
  }
  
  // Track response times for percentile calculation
  responseTimes.push(duration);
  if (responseTimes.length > MAX_RESPONSE_TIME_SAMPLES) {
    responseTimes.shift();
  }
  
  // Calculate rolling average
  const sum = responseTimes.reduce((a, b) => a + b, 0);
  metrics.averageResponseTime = Math.round(sum / responseTimes.length);
  
  // Calculate percentiles
  if (responseTimes.length > 10) {
    const sorted = [...responseTimes].sort((a, b) => a - b);
    const p95Index = Math.floor(sorted.length * 0.95);
    const p99Index = Math.floor(sorted.length * 0.99);
    metrics.p95ResponseTime = sorted[p95Index];
    metrics.p99ResponseTime = sorted[p99Index];
  }
  
  // Log performance for monitoring
  if (process.env.LOG_PERFORMANCE === 'true') {
    console.log(`📊 ${route} - ${duration}ms - ${reply.statusCode}`);
  }
  
  // Clean up
  requestStartTimes.delete(request);
}

/**
 * Register performance monitoring hooks with Fastify instance
 */
export function registerPerformanceMonitoring(app: FastifyInstance) {
  app.addHook('preHandler', performanceMonitorPreHandler);
  app.addHook('onResponse', performanceMonitorOnResponse);
  console.log('✅ Performance monitoring middleware registered');
}

export function trackCacheHit() {
  metrics.cacheHits++;
}

export function trackCacheMiss() {
  metrics.cacheMisses++;
}

export function getPerformanceMetrics(): PerformanceMetrics & {
  cacheHitRate: number;
  slowRequestRate: number;
} {
  const cacheHitRate = metrics.cacheHits + metrics.cacheMisses > 0
    ? metrics.cacheHits / (metrics.cacheHits + metrics.cacheMisses)
    : 0;
  
  const slowRequestRate = metrics.totalRequests > 0
    ? metrics.slowRequests / metrics.totalRequests
    : 0;
  
  return {
    ...metrics,
    cacheHitRate: Math.round(cacheHitRate * 100) / 100,
    slowRequestRate: Math.round(slowRequestRate * 100) / 100,
  };
}

export function resetPerformanceMetrics() {
  metrics.totalRequests = 0;
  metrics.slowRequests = 0;
  metrics.cacheHits = 0;
  metrics.cacheMisses = 0;
  metrics.averageResponseTime = 0;
  metrics.p95ResponseTime = 0;
  metrics.p99ResponseTime = 0;
  responseTimes.length = 0;
  console.log('📊 Performance metrics reset');
}

// Export metrics endpoint handler
export async function handlePerformanceMetricsRequest(
  request: FastifyRequest,
  reply: FastifyReply
) {
  const metrics = getPerformanceMetrics();
  
  reply.send({
    success: true,
    data: metrics,
    timestamp: new Date().toISOString(),
  });
}
