import Database from 'better-sqlite3';
import path from 'path';
import { OpenAIAdapter, XAIAdapter, AnthropicAdapter, GoogleAdapter } from '../llm/adapters';

// Database connection
const dbPath = path.join(__dirname, '../../data/benchmarks.db');
const db = new Database(dbPath);

// Prepare statements
const insertHealthCheck = db.prepare(`
  INSERT INTO provider_health_checks (provider, status, response_time, error_message, checked_at)
  VALUES (?, ?, ?, ?, datetime('now'))
`);

const insertIncident = db.prepare(`
  INSERT OR IGNORE INTO incidents (
    provider, model_name, incident_type, severity, description, 
    failure_rate, total_requests, failed_requests, metadata, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
`);

interface HealthCheckResult {
  provider: string;
  status: 'operational' | 'degraded' | 'down';
  responseTime: number;
  error?: string;
}

// Initialize adapters with environment variables
function getAdapters() {
  const adapters: { [key: string]: any } = {};
  
  if (process.env.OPENAI_API_KEY) {
    adapters.openai = new OpenAIAdapter(process.env.OPENAI_API_KEY);
  }
  
  if (process.env.XAI_API_KEY) {
    adapters.xai = new XAIAdapter(process.env.XAI_API_KEY);
  }
  
  if (process.env.ANTHROPIC_API_KEY) {
    adapters.anthropic = new AnthropicAdapter(process.env.ANTHROPIC_API_KEY);
  }
  
  const geminiApiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (geminiApiKey) {
    adapters.google = new GoogleAdapter(geminiApiKey);
  }
  
  return adapters;
}

// Health check using production adapters
async function checkProviderHealth(provider: string, adapter: any): Promise<HealthCheckResult> {
  const startTime = Date.now();
  
  try {
    // Use current production models for each provider
    let testModel: string;
    switch (provider) {
      case 'openai':
        testModel = 'gpt-4o-mini'; // Fast and reliable
        break;
      case 'anthropic':
        testModel = 'claude-sonnet-4-20250514'; // Latest Claude Sonnet 4
        break;
      case 'google':
        testModel = 'gemini-2.5-flash'; // Latest Gemini 2.5 Flash
        break;
      case 'xai':
        testModel = 'grok-4'; // Latest Grok 4
        break;
      default:
        // Fallback to listModels for unknown providers
        const models = await adapter.listModels();
        if (!models || models.length === 0) {
          throw new Error('No models available');
        }
        testModel = models[0];
    }
    
    // Make a minimal chat request
    const response = await adapter.chat({
      model: testModel,
      messages: [{ role: 'user', content: 'Hi' }],
      maxTokens: 1,
      temperature: 0
    });
    
    const responseTime = Date.now() - startTime;
    
    // Determine status based on response time and success
    let status: 'operational' | 'degraded' | 'down' = 'operational';
    if (responseTime > 10000) {
      status = 'degraded';
    } else if (responseTime > 5000) {
      status = 'degraded';
    }
    
    // Check if we got a valid response
    if (!response.text && !response.raw) {
      status = 'degraded';
    }
    
    return {
      provider,
      status,
      responseTime
    };
    
  } catch (error) {
    const responseTime = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    
    // Determine if it's a temporary issue or complete failure
    let status: 'operational' | 'degraded' | 'down' = 'down';
    
    // Rate limiting or temporary issues should be degraded, not down
    if (errorMessage.includes('rate limit') || 
        errorMessage.includes('429') ||
        errorMessage.includes('timeout') ||
        errorMessage.includes('temporarily unavailable')) {
      status = 'degraded';
    }
    
    // API key issues are configuration problems, not service issues
    if (errorMessage.includes('API key') || 
        errorMessage.includes('unauthorized') ||
        errorMessage.includes('401') ||
        errorMessage.includes('403')) {
      status = 'down';
    }
    
    return {
      provider,
      status,
      responseTime,
      error: errorMessage
    };
  }
}

// Create incident if provider status changes to down or degraded
function createIncidentIfNeeded(result: HealthCheckResult, previousStatus?: string) {
  if (result.status === 'down' || (result.status === 'degraded' && previousStatus === 'operational')) {
    const severity = result.status === 'down' ? 'critical' : 'major';
    const description = result.status === 'down' 
      ? `${result.provider.toUpperCase()} API is completely unavailable`
      : `${result.provider.toUpperCase()} API is experiencing degraded performance`;
    
    try {
      insertIncident.run(
        result.provider,
        'health-check',
        'service_disruption',
        severity,
        description,
        result.status === 'down' ? 100 : 50, // failure rate
        1, // total requests
        result.status === 'down' ? 1 : 0, // failed requests
        JSON.stringify({
          response_time: result.responseTime,
          error_message: result.error,
          check_type: 'health_monitor',
          previous_status: previousStatus
        })
      );
      
      console.log(`📊 Created incident for ${result.provider}: ${result.status}`);
    } catch (error) {
      console.error(`Failed to create incident for ${result.provider}:`, error);
    }
  }
}

// Get previous status for comparison
function getPreviousStatus(provider: string): string | undefined {
  try {
    const stmt = db.prepare(`
      SELECT status FROM provider_health_checks 
      WHERE provider = ? 
      ORDER BY checked_at DESC 
      LIMIT 1
    `);
    const result = stmt.get(provider) as { status: string } | undefined;
    return result?.status;
  } catch (error) {
    console.error(`Failed to get previous status for ${provider}:`, error);
    return undefined;
  }
}

// Main health monitoring function
export async function runHealthChecks(): Promise<void> {
  console.log('🏥 Starting provider health checks...');
  
  const adapters = getAdapters();
  const results: HealthCheckResult[] = [];
  
  // Run all health checks in parallel
  const promises = Object.entries(adapters).map(async ([provider, adapter]) => {
    try {
      const previousStatus = getPreviousStatus(provider);
      const result = await checkProviderHealth(provider, adapter);
      
      // Store result in database
      insertHealthCheck.run(
        result.provider,
        result.status,
        result.responseTime,
        result.error || null
      );
      
      // Create incident if needed
      createIncidentIfNeeded(result, previousStatus);
      
      results.push(result);
      
      const statusEmoji = result.status === 'operational' ? '🟢' : 
                         result.status === 'degraded' ? '🟡' : '🔴';
      
      console.log(`${statusEmoji} ${result.provider.toUpperCase()}: ${result.status} (${result.responseTime}ms)`);
      
      if (result.error) {
        console.log(`   Error: ${result.error.substring(0, 100)}...`);
      }
      
    } catch (error) {
      console.error(`Failed to check ${provider}:`, error);
      
      // Record failed check
      insertHealthCheck.run(
        provider,
        'down',
        10000,
        error instanceof Error ? error.message : 'Health check failed'
      );
    }
  });
  
  await Promise.all(promises);
  
  console.log(`✅ Health checks completed. Results: ${results.length}/${Object.keys(adapters).length} providers checked`);
}

// Cleanup old health check data (keep last 7 days)
export function cleanupOldHealthData(): void {
  try {
    const stmt = db.prepare(`
      DELETE FROM provider_health_checks 
      WHERE checked_at < datetime('now', '-7 days')
    `);
    const result = stmt.run();
    console.log(`🧹 Cleaned up ${result.changes} old health check records`);
  } catch (error) {
    console.error('Failed to cleanup old health data:', error);
  }
}
