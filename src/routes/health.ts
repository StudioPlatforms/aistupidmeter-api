import { FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import path from 'path';

// Database connection
const dbPath = path.join(__dirname, '../../data/benchmarks.db');
const db = new Database(dbPath);

// Prepare statements
const getLatestHealthStatus = db.prepare(`
  SELECT 
    provider,
    status,
    response_time,
    error_message,
    checked_at
  FROM provider_health_checks 
  WHERE provider = ? 
  ORDER BY checked_at DESC 
  LIMIT 1
`);

const getAllLatestHealthStatus = db.prepare(`
  SELECT 
    provider,
    status,
    response_time,
    error_message,
    checked_at
  FROM provider_health_checks p1
  WHERE checked_at = (
    SELECT MAX(checked_at) 
    FROM provider_health_checks p2 
    WHERE p2.provider = p1.provider
  )
  ORDER BY provider
`);

const getHealthHistory = db.prepare(`
  SELECT 
    provider,
    status,
    response_time,
    error_message,
    checked_at
  FROM provider_health_checks 
  WHERE provider = ? 
    AND checked_at >= datetime('now', '-24 hours')
  ORDER BY checked_at DESC
`);

export default async function (fastify: FastifyInstance, opts: any) {
  
  // GET /health - Get current health status for all providers
  fastify.get('/', async (request, reply) => {
    try {
      const healthData = getAllLatestHealthStatus.all() as Array<{
        provider: string;
        status: string;
        response_time: number;
        error_message: string | null;
        checked_at: string;
      }>;

      // Transform data for frontend consumption
      const healthStatus = healthData.reduce((acc, item) => {
        acc[item.provider] = {
          status: item.status,
          responseTime: item.response_time,
          lastChecked: item.checked_at,
          error: item.error_message
        };
        return acc;
      }, {} as Record<string, any>);

      // Add default status for any missing providers
      const allProviders = ['openai', 'anthropic', 'google', 'xai'];
      allProviders.forEach(provider => {
        if (!healthStatus[provider]) {
          healthStatus[provider] = {
            status: 'unknown',
            responseTime: null,
            lastChecked: null,
            error: 'No health data available'
          };
        }
      });

      return {
        success: true,
        data: healthStatus,
        timestamp: new Date().toISOString()
      };

    } catch (error) {
      console.error('Health status endpoint error:', error);
      reply.status(500);
      return {
        success: false,
        error: 'Failed to fetch health status',
        timestamp: new Date().toISOString()
      };
    }
  });

  // GET /health/:provider - Get health status for specific provider
  fastify.get('/:provider', async (request, reply) => {
    try {
      const { provider } = request.params as { provider: string };
      
      if (!['openai', 'anthropic', 'google', 'xai'].includes(provider)) {
        reply.status(400);
        return {
          success: false,
          error: 'Invalid provider. Must be one of: openai, anthropic, google, xai'
        };
      }

      const currentStatus = getLatestHealthStatus.get(provider) as {
        provider: string;
        status: string;
        response_time: number;
        error_message: string | null;
        checked_at: string;
      } | undefined;

      if (!currentStatus) {
        reply.status(404);
        return {
          success: false,
          error: `No health data found for provider: ${provider}`
        };
      }

      return {
        success: true,
        data: {
          provider: currentStatus.provider,
          status: currentStatus.status,
          responseTime: currentStatus.response_time,
          lastChecked: currentStatus.checked_at,
          error: currentStatus.error_message
        },
        timestamp: new Date().toISOString()
      };

    } catch (error) {
      console.error(`Health status endpoint error for ${(request.params as any).provider}:`, error);
      reply.status(500);
      return {
        success: false,
        error: 'Failed to fetch provider health status',
        timestamp: new Date().toISOString()
      };
    }
  });

  // GET /health/:provider/history - Get 24h health history for specific provider
  fastify.get('/:provider/history', async (request, reply) => {
    try {
      const { provider } = request.params as { provider: string };
      
      if (!['openai', 'anthropic', 'google', 'xai'].includes(provider)) {
        reply.status(400);
        return {
          success: false,
          error: 'Invalid provider. Must be one of: openai, anthropic, google, xai'
        };
      }

      const history = getHealthHistory.all(provider) as Array<{
        provider: string;
        status: string;
        response_time: number;
        error_message: string | null;
        checked_at: string;
      }>;

      // Calculate uptime percentage for last 24h
      const totalChecks = history.length;
      const operationalChecks = history.filter(h => h.status === 'operational').length;
      const uptimePercentage = totalChecks > 0 ? Math.round((operationalChecks / totalChecks) * 100) : 0;

      // Calculate average response time
      const responseTimes = history.filter(h => h.response_time > 0).map(h => h.response_time);
      const avgResponseTime = responseTimes.length > 0 
        ? Math.round(responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length)
        : 0;

      return {
        success: true,
        data: {
          provider,
          history: history.map(h => ({
            status: h.status,
            responseTime: h.response_time,
            checkedAt: h.checked_at,
            error: h.error_message
          })),
          summary: {
            totalChecks,
            operationalChecks,
            uptimePercentage,
            avgResponseTime
          }
        },
        timestamp: new Date().toISOString()
      };

    } catch (error) {
      console.error(`Health history endpoint error for ${(request.params as any).provider}:`, error);
      reply.status(500);
      return {
        success: false,
        error: 'Failed to fetch provider health history',
        timestamp: new Date().toISOString()
      };
    }
  });
}
