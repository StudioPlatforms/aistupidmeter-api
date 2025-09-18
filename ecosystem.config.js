module.exports = {
  apps: [
    {
      name: 'aistupidlevel-api',
      script: 'dist/index.js',
      cwd: '/root/apps/api',
      
      // High-performance clustering for 50k concurrent users
      instances: 'max', // Use all available CPU cores
      exec_mode: 'cluster',
      
      // Environment settings
      env: {
        NODE_ENV: 'development',
        PORT: 4000,
        HOST: '0.0.0.0'
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 4000,
        HOST: '0.0.0.0'
      },
      
      // Performance optimizations for high traffic
      node_args: [
        '--max-old-space-size=2048',        // 2GB heap for high memory workload
        '--max-semi-space-size=128',        // Optimize young generation
        '--max-executable-size=256',        // Optimize code cache
        '--optimize-for-size',              // Reduce memory footprint
        '--gc-interval=100',                // More frequent garbage collection
        '--expose-gc'                       // Allow manual GC if needed
      ],
      
      // Auto-restart and monitoring configuration
      watch: false, // Disable file watching in production for performance
      ignore_watch: ['node_modules', 'logs', 'data'],
      restart_delay: 4000,        // 4 second delay between restarts
      max_restarts: 5,            // Limit restarts to prevent flapping
      min_uptime: '10s',          // Minimum uptime before considering restart
      
      // Process management for high availability
      kill_timeout: 5000,         // 5 seconds for graceful shutdown
      wait_ready: true,           // Wait for ready signal
      listen_timeout: 10000,      // 10 seconds to listen
      
      // Memory and CPU limits for stability
      max_memory_restart: '1500M', // Restart if memory exceeds 1.5GB
      
      // Logging configuration optimized for production
      log_type: 'json',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: '/root/apps/api/logs/error.log',
      out_file: '/root/apps/api/logs/out.log',
      log_file: '/root/apps/api/logs/combined.log',
      merge_logs: true,
      
      // Advanced PM2 features for high-traffic scenarios
      automation: false,          // Disable automation features for performance
      pmx: false,                 // Disable PMX for better performance
      
      // Health monitoring
      health_check_url: 'http://localhost:4000/health',
      health_check_grace_period: 3000,
      
      // Advanced clustering options
      increment_var: 'PORT',      // Increment port for each instance if needed
      
      // Source map support for better debugging
      source_map_support: true,
      
      // Process title for easier identification
      name: 'aistupidlevel-api',
      
      // Custom environment variables for high-performance mode
      env_production: {
        NODE_ENV: 'production',
        PORT: 4000,
        HOST: '0.0.0.0',
        // Performance tuning
        UV_THREADPOOL_SIZE: 16,         // Increase thread pool for I/O operations
        NODE_OPTIONS: '--max-old-space-size=2048',
        // Redis optimization
        REDIS_POOL_SIZE: 20,
        // Database optimization  
        DB_POOL_SIZE: 15,
        // Cache settings
        CACHE_TTL: 3600,
        // Rate limiting
        RATE_LIMIT_WINDOW: 60000,
        RATE_LIMIT_MAX: 1000
      }
    },
    
    // Optional: Separate worker process for background tasks
    {
      name: 'aistupidlevel-worker',
      script: 'dist/worker.js', // If you have a separate worker script
      cwd: '/root/apps/api',
      instances: 2,              // Limited instances for background work
      exec_mode: 'cluster',
      
      // Lower resource allocation for background tasks
      node_args: [
        '--max-old-space-size=1024'  // 1GB heap for worker processes
      ],
      
      env_production: {
        NODE_ENV: 'production',
        WORKER_MODE: 'true',
        DB_POOL_SIZE: 5,           // Smaller pool for workers
        REDIS_POOL_SIZE: 10
      },
      
      // Worker-specific settings
      restart_delay: 10000,       // Longer delay for workers
      max_restarts: 3,
      max_memory_restart: '1G',
      
      // Separate logs for workers
      error_file: '/root/apps/api/logs/worker-error.log',
      out_file: '/root/apps/api/logs/worker-out.log',
      log_file: '/root/apps/api/logs/worker-combined.log'
    }
  ],
  
  // PM2 deployment configuration (optional)
  deploy: {
    production: {
      user: 'root',
      host: 'your-server.com',
      ref: 'origin/main',
      repo: 'git@github.com:your-repo/aistupidlevel.git',
      path: '/root/apps/api',
      'post-deploy': 'npm install && npm run build && pm2 reload ecosystem.config.js --env production',
      'pre-setup': 'mkdir -p /root/apps/api/logs'
    }
  },
  
  // PM2 plus monitoring (optional)
  pmx: {
    http: true,           // Enable HTTP monitoring
    ignore_routes: [      // Routes to ignore in monitoring
      /\/health$/,
      /\/metrics$/
    ],
    errors: true,         // Enable error monitoring
    custom_probes: true,  // Enable custom probes
    network: true,        // Enable network monitoring
    ports: true          // Enable port monitoring
  }
};

// Production deployment script helper
if (require.main === module) {
  console.log('🚀 AI Stupid Level API - High-Performance Ecosystem Configuration');
  console.log('📊 Optimized for 50k+ concurrent users');
  console.log('⚡ Multi-core clustering enabled');
  console.log('🛡️ Auto-restart and health monitoring configured');
  console.log('💾 Memory limits and GC optimization enabled');
  console.log('');
  console.log('Commands:');
  console.log('  pm2 start ecosystem.config.js --env production');
  console.log('  pm2 restart aistupidlevel-api');
  console.log('  pm2 logs aistupidlevel-api');
  console.log('  pm2 monit');
}
