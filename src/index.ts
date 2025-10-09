import dotenv from 'dotenv';
import Fastify, { FastifyRequest, FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import compress from '@fastify/compress';
import rateLimit from '@fastify/rate-limit';
import underPressure from '@fastify/under-pressure';

// Load environment variables first
dotenv.config({ path: '/root/.env' });

// Import performance middleware
import { 
  performanceMiddleware, 
  cachePerformanceMiddleware, 
  getHealthStats, 
  getScalingRecommendations,
  cleanupPerformanceMiddleware 
} from './middleware/performance';

// Import database with connection pooling
import { db, checkDatabaseHealth } from './db/connection-pool';

// Import cache system
import { cache } from './cache/redis-cache';

const isDevelopment = process.env.NODE_ENV !== 'production';
const PORT = parseInt(process.env.PORT || '4000');
const HOST = process.env.HOST || '0.0.0.0';

async function startServer() {
  // Initialize Fastify with optimized settings for high concurrency
  const app = Fastify({
    logger: isDevelopment ? {
      level: 'info',
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true
        }
      }
    } : {
      level: 'warn',
      serializers: {
        req: (req) => ({
          method: req.method,
          url: req.url,
          headers: {
            host: req.headers.host,
            'user-agent': req.headers['user-agent'],
            'accept-encoding': req.headers['accept-encoding']
          }
        }),
        res: (res) => ({
          statusCode: res.statusCode,
        })
      }
    },
    trustProxy: true,
    bodyLimit: 1048576 * 2, // 2MB body limit
    keepAliveTimeout: 30000,  // 30 seconds
    connectionTimeout: 10000, // 10 seconds
    maxRequestsPerSocket: 1000, // Limit requests per socket to prevent abuse
    requestIdHeader: 'x-request-id',
    requestIdLogLabel: 'reqId',
    disableRequestLogging: !isDevelopment // Reduce logging overhead in production
  });

  console.log('✅ Database connection pool ready');
  
  // Enhanced security middleware for high-traffic scenarios
  await app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false, // Disable for API server
    hsts: {
      maxAge: 31536000,
      includeSubDomains: true,
      preload: true
    }
  });

  // Advanced compression middleware
  await app.register(compress, {
    global: true,
    encodings: ['gzip', 'deflate', 'br'], // Add Brotli compression
    threshold: 1024,
    customTypes: /^application\/json$|^text\//
  });

  // Optimized rate limiting for high traffic website
  await app.register(rateLimit, {
    global: true,
    max: async (request, key) => {
      // Much higher limits for normal website usage
      if (request.url.startsWith('/dashboard/cached')) {
        return 600; // 10 requests per second for main dashboard (600/minute)
      }
      if (request.url.startsWith('/dashboard/')) {
        return 300; // 5 requests per second for dashboard endpoints (300/minute)
      }
      if (request.url.startsWith('/analytics/')) {
        return 240; // 4 requests per second for analytics (240/minute)
      }
      if (request.url.startsWith('/models/')) {
        return 180; // 3 requests per second for models (180/minute)
      }
      if (request.url.startsWith('/visitors/stats')) {
        return 120; // 2 requests per second for visitor stats (120/minute)
      }
      if (request.url.startsWith('/test-adapters')) {
        return 30;  // Still limited for expensive test endpoints (30/minute)
      }
      if (request.url.startsWith('/internal/')) {
        return 1000; // High limit for internal endpoints
      }
      if (request.url.startsWith('/health')) {
        return 500; // High limit for health checks
      }
      return 150; // Default: 2.5 requests per second (150/minute)
    },
    timeWindow: 60000, // 1 minute window
    cache: 10000, // Cache 10k rate limit records
    allowList: (request) => {
      // Allow internal health checks and localhost
      const ip = request.ip;
      return ip === '127.0.0.1' || ip === '::1' || ip.startsWith('10.') || ip.startsWith('192.168.');
    },
    onExceeding: (request: FastifyRequest, key: string) => {
      // Only log if it's a significant breach (more than 10 over limit)
      console.warn(`⚠️  High traffic from ${key} on ${request.url}`);
    },
    errorResponseBuilder: (request: FastifyRequest, context: any) => {
      return {
        error: 'Too Many Requests',
        message: 'You are making requests too quickly. Please wait a moment and try again.',
        retryAfter: Math.round(context.ttl / 1000) || 30,
        endpoint: request.url
      };
    }
  });

  // System pressure monitoring - circuit breaker
  await app.register(underPressure, {
    maxEventLoopDelay: 1000,    // 1 second max delay
    maxHeapUsedBytes: 1000000000, // 1GB heap limit
    maxRssBytes: 1500000000,    // 1.5GB RSS limit
    maxEventLoopUtilization: 0.98, // 98% max CPU utilization
    retryAfter: 50,             // Retry after 50ms
    message: 'Service temporarily overloaded',
    healthCheck: async () => {
      // Custom health check that verifies database and cache
      try {
        const [dbHealth, cacheStats] = await Promise.all([
          checkDatabaseHealth(),
          cache.getStats()
        ]);
        
        if (dbHealth.healthy < dbHealth.total * 0.5) {
          throw new Error('Database unhealthy');
        }
        
        return { status: 'ok', checks: { database: 'healthy', cache: 'healthy' } };
      } catch (error) {
        throw new Error(`Health check failed: ${String(error)}`);
      }
    },
    healthCheckInterval: 5000   // Check every 5 seconds
  });

  // CORS with optimized settings for high performance
  await app.register(cors, {
    origin: (origin, callback) => {
      // More efficient origin checking
      const allowedOrigins = [
        'http://localhost:3000',
        'http://127.0.0.1:3000', 
        'https://aistupidlevel.info',
        'http://aistupidlevel.info'
      ];
      
      // Allow requests with no origin (mobile apps, curl, etc)
      if (!origin) return callback(null, true);
      
      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      
      return callback(new Error('Not allowed by CORS'), false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'x-user-api-key', 'x-user-id'],
    maxAge: 86400 // Cache preflight for 24 hours
  });

  // Register performance monitoring middleware
  await app.addHook('onRequest', performanceMiddleware);
  await app.addHook('onRequest', cachePerformanceMiddleware);

  // Enhanced health check endpoint with performance metrics
  app.get('/health', async () => {
    const healthStats = getHealthStats();
    const dbHealth = checkDatabaseHealth();
    const cacheStats = await cache.getStats();
    
    return {
      status: healthStats.status,
      timestamp: new Date().toISOString(),
      uptime: Math.round(process.uptime()),
      worker: isDevelopment ? 'development' : process.pid,
      database: {
        status: dbHealth.healthy === dbHealth.total ? 'healthy' : 'degraded',
        connections: `${dbHealth.healthy}/${dbHealth.total}`,
        errors: dbHealth.errors
      },
      cache: {
        status: cacheStats.redis.connected ? 'healthy' : 'degraded',
        entries: cacheStats.memory.entries,
        redis: cacheStats.redis.connected
      },
      performance: healthStats.performance,
      recommendations: getScalingRecommendations()
    };
  });

  // Performance monitoring endpoint
  app.get('/internal/metrics', async () => {
    const healthStats = getHealthStats();
    const memUsage = process.memoryUsage();
    
    return {
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      memory: {
        heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024),
        heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024),
        external: Math.round(memUsage.external / 1024 / 1024),
        rss: Math.round(memUsage.rss / 1024 / 1024)
      },
      performance: healthStats.performance,
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch
    };
  });

  // Register routes dynamically with better error handling
  const routesToTry = [
    { name: 'router', prefix: '' }, // AI Router - OpenAI-compatible endpoints at /v1/*
    { name: 'router-keys', prefix: '' }, // AI Router Key Management - /router/*
    { name: 'router-analytics', prefix: '' }, // AI Router Analytics - /router/analytics/*
    { name: 'analytics', prefix: '/analytics' },
    { name: 'health', prefix: '/providers' },
    { name: 'dashboard-cached', prefix: '/dashboard' },
    { name: 'models', prefix: '/models' },
    { name: 'benchmark', prefix: '/benchmark' },
    { name: 'dashboard', prefix: '/dashboard' },
    { name: 'reference', prefix: '/reference' },
    { name: 'test-adapters', prefix: '/test-adapters' },
    { name: 'test-adapters-stream', prefix: '/test-adapters' },
    { name: 'visitors', prefix: '/visitors' },
    { name: 'dashboard-batch', prefix: '/dashboard' }
  ];

  for (const route of routesToTry) {
    try {
      const routeModule = await import(`./routes/${route.name}`);
      if (routeModule.default) {
        await app.register(routeModule.default, { prefix: route.prefix });
        console.log(`✅ ${route.name} routes registered at ${route.prefix}`);
      }
    } catch (error) {
      console.log(`ℹ️  ${route.name} routes not found, skipping...`);
    }
  }

  // Optimized visitor tracking with batching
  app.post('/track-visit', async (request, reply) => {
    try {
      const { ip, userAgent, referer, path, timestamp } = request.body as {
        ip: string;
        userAgent: string;
        referer: string | null;
        path: string;
        timestamp: string;
      };

      // Use fire-and-forget approach for better performance
      setImmediate(async () => {
        try {
          const { visitors } = await import('./db/schema');
          await db.insert(visitors).values({
            ip,
            userAgent, // This maps to user_agent column in database
            referer,
            path,
            timestamp,
            isUnique: true // Use boolean instead of number
          });
        } catch (error) {
          console.error('Visitor tracking error:', error);
        }
      });

      // Immediate response to avoid blocking
      return { ok: true, tracked: true };
    } catch (error) {
      console.error('Visitor tracking error:', error);
      return reply.code(200).send({ ok: true, tracked: false }); // Graceful failure
    }
  });

  // Cache warming endpoint with performance optimization
  app.post('/internal/warm-cache', async (request, reply) => {
    try {
      const { initializeCache } = await import('./cache/dashboard-cache');
      
      // Run cache warming in background
      setImmediate(async () => {
        try {
          await initializeCache();
          console.log('✅ Cache warmed successfully in background');
        } catch (error) {
          console.error('❌ Background cache warming failed:', error);
        }
      });
      
      return { ok: true, message: 'Cache warming started in background' };
    } catch (error) {
      console.error('Cache warming error:', error);
      return reply.code(500).send({ 
        ok: false, 
        error: 'Cache warming failed',
        message: isDevelopment ? String(error) : 'Internal error'
      });
    }
  });

  // Optimized work queue endpoints
  app.get('/internal/next-work', async () => {
    try {
      // Try Redis first, then fallback to simple response
      const work = await cache.get('work_queue:next');
      if (work) {
        await cache.del('work_queue:next');
        return work;
      }
      return null;
    } catch (error) {
      console.error('Work queue error:', error);
      return null;
    }
  });

  app.post('/internal/enqueue', async (req, reply) => {
    try {
      const body = req.body as any;
      
      // Use Redis for queue management
      const queueKey = `work_queue:${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      await cache.set(queueKey, body, 3600); // 1 hour TTL
      
      return { ok: true, queued: true };
    } catch (error) {
      console.error('Enqueue error:', error);
      return reply.code(500).send({ ok: false, error: 'Queue operation failed' });
    }
  });

  // Global error handler with performance considerations
  app.setErrorHandler((error, request, reply) => {
    const errorId = `err_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    console.error(`[${errorId}] Server error on ${request.method} ${request.url}:`, {
      error: error.message,
      stack: isDevelopment ? error.stack : undefined,
      ip: request.ip,
      userAgent: request.headers['user-agent']
    });
    
    const statusCode = error.statusCode || 500;
    
    reply.code(statusCode).send({ 
      error: statusCode < 500 ? error.message : 'Internal Server Error',
      message: statusCode < 500 ? error.message : 'Something went wrong',
      errorId: isDevelopment ? errorId : undefined,
      timestamp: new Date().toISOString()
    });
  });

  // Not found handler
  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({
      error: 'Not Found',
      message: `Route ${request.method} ${request.url} not found`,
      timestamp: new Date().toISOString()
    });
  });

  // Graceful shutdown handling
  const gracefulShutdown = async (signal: string) => {
    console.log(`🛑 Received ${signal}. Starting graceful shutdown...`);
    
    try {
      // Stop accepting new connections
      await app.close();
      console.log('✅ HTTP server closed');
      
      // Cleanup performance monitoring
      cleanupPerformanceMiddleware();
      console.log('✅ Performance monitoring cleaned up');
      
      // Close cache connections
      await cache.close();
      console.log('✅ Cache connections closed');
      
      console.log('✅ Graceful shutdown completed');
      process.exit(0);
    } catch (error) {
      console.error('❌ Error during shutdown:', error);
      process.exit(1);
    }
  };

  // Register shutdown handlers
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  // Handle uncaught exceptions and rejections
  process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    gracefulShutdown('uncaughtException');
  });

  process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    gracefulShutdown('unhandledRejection');
  });

  // Start the server
  try {
    await app.listen({ port: PORT, host: HOST });
    
    const workerInfo = isDevelopment ? 'Development Mode' : `Worker ${process.pid}`;
    console.log(`🚀 ${workerInfo} - High-Performance API server running on ${HOST}:${PORT}`);
    console.log(`📈 Performance monitoring: ENABLED`);
    console.log(`🛡️  Security features: Rate limiting, Circuit breaker, Request validation`);
    console.log(`💾 Database: Connection pool ready with health monitoring`);
    console.log(`⚡ Cache: Redis with fallback to memory cache`);

    // Initialize cache system in background
    console.log('🔄 Initializing dashboard cache system...');
    setImmediate(async () => {
      try {
        const { initializeCache } = await import('./cache/dashboard-cache');
        await initializeCache();
        console.log('✅ Dashboard cache system initialized');
      } catch (error) {
        console.error('❌ Failed to initialize cache system:', error);
      }
    });

    // Start benchmark scheduler if available
    setImmediate(async () => {
      try {
        const { startBenchmarkScheduler } = await import('./scheduler');
        startBenchmarkScheduler();
        console.log('✅ Benchmark scheduler started');
      } catch (error) {
        console.error('❌ Failed to start benchmark scheduler:', error);
      }
    });

    // Log performance stats every 5 minutes in production
    if (!isDevelopment) {
      setInterval(() => {
        const stats = getHealthStats();
        console.log(`📊 Performance: ${stats.performance.global.activeRequests} active, ${stats.performance.global.avgResponseTime}ms avg, ${stats.performance.memory.heapUsed}MB heap, ${stats.performance.cache.hitRate}% cache hit rate`);
      }, 300000); // 5 minutes
    }

    console.log('🎉 Server is ready to handle high-traffic loads!');

  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

// Start the server with error handling
startServer().catch((error) => {
  console.error('❌ Failed to start server:', error);
  process.exit(1);
});
