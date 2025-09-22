#!/usr/bin/env node

/**
 * Health monitoring script for the AI Stupid Level API
 * This script checks the API health and can restart the service if needed
 */

const http = require('http');
const { exec } = require('child_process');
const fs = require('fs');

const API_URL = 'http://localhost:4000';
const MAX_ACTIVE_REQUESTS = 450; // Alert threshold (below the 500 limit)
const LOG_FILE = '/var/log/aistupid-api-monitor.log';

function log(message) {
  const timestamp = new Date().toISOString();
  const logMessage = `${timestamp} - ${message}\n`;
  console.log(logMessage.trim());
  
  // Append to log file
  try {
    fs.appendFileSync(LOG_FILE, logMessage);
  } catch (error) {
    console.error('Failed to write to log file:', error.message);
  }
}

function checkHealth() {
  return new Promise((resolve, reject) => {
    const req = http.get(`${API_URL}/health`, { timeout: 10000 }, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        try {
          const health = JSON.parse(data);
          resolve({ statusCode: res.statusCode, health });
        } catch (error) {
          reject(new Error(`Invalid JSON response: ${data}`));
        }
      });
    });
    
    req.on('error', (error) => {
      reject(error);
    });
    
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
  });
}

function restartService() {
  return new Promise((resolve, reject) => {
    log('🔄 Attempting to restart aistupid-api.service...');
    
    exec('systemctl restart aistupid-api.service', (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`Restart failed: ${error.message}`));
        return;
      }
      
      log('✅ Service restart command executed successfully');
      
      // Wait a bit for the service to start
      setTimeout(() => {
        resolve();
      }, 5000);
    });
  });
}

async function monitorHealth() {
  try {
    log('🔍 Checking API health...');
    
    const { statusCode, health } = await checkHealth();
    
    if (statusCode === 503) {
      log('❌ API returning 503 Service Unavailable - Circuit breaker likely triggered');
      log('🔄 Restarting service to reset request counters...');
      
      await restartService();
      
      // Verify the restart worked
      setTimeout(async () => {
        try {
          const { statusCode: newStatusCode, health: newHealth } = await checkHealth();
          if (newStatusCode === 200) {
            log('✅ Service restart successful - API is healthy again');
            log(`📊 Active requests: ${newHealth.performance.global.activeRequests}`);
          } else {
            log(`⚠️ Service still unhealthy after restart (status: ${newStatusCode})`);
          }
        } catch (error) {
          log(`❌ Failed to verify service health after restart: ${error.message}`);
        }
      }, 10000);
      
    } else if (statusCode === 200) {
      const activeRequests = health.performance.global.activeRequests;
      const memoryUsage = health.performance.memory.heapUsed;
      const avgResponseTime = health.performance.global.avgResponseTime;
      
      log(`✅ API healthy - Active: ${activeRequests}, Memory: ${memoryUsage}MB, Avg Response: ${avgResponseTime}ms`);
      
      // Warning if approaching limits
      if (activeRequests > MAX_ACTIVE_REQUESTS) {
        log(`⚠️ WARNING: High active request count (${activeRequests}/${MAX_ACTIVE_REQUESTS})`);
      }
      
      if (memoryUsage > 1200) {
        log(`⚠️ WARNING: High memory usage (${memoryUsage}MB/1500MB)`);
      }
      
      if (avgResponseTime > 1000) {
        log(`⚠️ WARNING: Slow response times (${avgResponseTime}ms)`);
      }
      
    } else {
      log(`⚠️ Unexpected status code: ${statusCode}`);
    }
    
  } catch (error) {
    log(`❌ Health check failed: ${error.message}`);
    
    // If we can't reach the API at all, try restarting
    if (error.message.includes('ECONNREFUSED') || error.message.includes('timeout')) {
      log('🔄 API unreachable - attempting service restart...');
      try {
        await restartService();
        log('✅ Service restart completed');
      } catch (restartError) {
        log(`❌ Service restart failed: ${restartError.message}`);
      }
    }
  }
}

// Run the health check
if (require.main === module) {
  monitorHealth().then(() => {
    process.exit(0);
  }).catch((error) => {
    log(`❌ Monitor script failed: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { monitorHealth, checkHealth };
