/**
 * Smart Router API Endpoints
 * 
 * Provides REST API for automatic model routing based on prompt analysis
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { selectModelAutomatically, explainSelection, compareStrategies } from '../router/selector/smart-selector';
import { analyzePrompt, getAnalysisSummary } from '../router/analyzer/prompt-analyzer';
import { selectBestModel } from '../router/selector';

interface ChatCompletionRequest {
  messages: Array<{ role: string; content: string }>;
  model?: string;
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  [key: string]: any;
}

interface AnalyzeRequest {
  prompt: string;
}

interface ExplainRequest {
  prompt: string;
}

interface CompareRequest {
  prompt: string;
}

export default async function smartRouterRoutes(fastify: FastifyInstance) {
  
  /**
   * POST /v1/chat/completions/auto
   * 
   * Automatic model routing - analyzes prompt and selects best model
   * Compatible with OpenAI API format
   */
  fastify.post('/v1/chat/completions/auto', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const body = request.body as ChatCompletionRequest;
      const userId = (request as any).userId || 1; // From auth middleware
      
      // Validate request
      if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
        return reply.code(400).send({
          error: {
            message: 'Invalid request: messages array is required',
            type: 'invalid_request_error'
          }
        });
      }
      
      // Extract user prompt from messages
      const userMessage = body.messages.find(m => m.role === 'user');
      if (!userMessage || !userMessage.content) {
        return reply.code(400).send({
          error: {
            message: 'Invalid request: user message with content is required',
            type: 'invalid_request_error'
          }
        });
      }
      
      const userPrompt = userMessage.content;
      
      // Get smart model selection
      const selection = await selectModelAutomatically(userPrompt, userId, {
        includeAlternatives: true,
        maxAlternatives: 3
      });
      
      // Add routing decision headers
      reply.header('X-AISM-Provider', selection.provider);
      reply.header('X-AISM-Model', selection.model);
      reply.header('X-AISM-Language-Detected', selection.analysis.language);
      reply.header('X-AISM-Task-Type-Detected', selection.analysis.taskType);
      reply.header('X-AISM-Confidence', selection.analysis.confidence.toFixed(2));
      reply.header('X-AISM-Score', selection.score.toFixed(1));
      reply.header('X-AISM-Cost-Per-1k', selection.estimatedCost.toFixed(4));
      reply.header('X-AISM-Reasoning', selection.reasoning);
      
      if (selection.analysis.framework) {
        reply.header('X-AISM-Framework-Detected', selection.analysis.framework);
      }
      
      if (selection.alternativeModels && selection.alternativeModels.length > 0) {
        const alternatives = selection.alternativeModels
          .map(alt => `${alt.model}(${alt.score.toFixed(1)})`)
          .join(',');
        reply.header('X-AISM-Alternatives', alternatives);
      }
      
      // Return selection info (actual proxying handled by existing router/proxy/index.ts)
      // For now, return the routing decision
      return {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: selection.model,
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: `[Smart Router] Selected ${selection.model} from ${selection.provider}. ${selection.reasoning}`
          },
          finish_reason: 'stop'
        }],
        usage: {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0
        }
      };
      
    } catch (error: any) {
      console.error('Smart routing error:', error);
      
      return reply.code(500).send({
        error: {
          message: error.message || 'Internal server error during smart routing',
          type: 'smart_routing_error',
          details: process.env.NODE_ENV === 'development' ? error.stack : undefined
        }
      });
    }
  });
  
  /**
   * POST /v1/analyze
   * 
   * Analyze a prompt without making a selection
   * Useful for debugging and UI preview
   */
  fastify.post('/v1/analyze', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const body = request.body as AnalyzeRequest;
      
      if (!body.prompt || typeof body.prompt !== 'string') {
        return reply.code(400).send({
          error: {
            message: 'Invalid request: prompt string is required',
            type: 'invalid_request_error'
          }
        });
      }
      
      const analysis = analyzePrompt(body.prompt);
      const summary = getAnalysisSummary(analysis);
      
      return {
        success: true,
        analysis,
        summary,
        timestamp: new Date().toISOString()
      };
      
    } catch (error: any) {
      console.error('Analysis error:', error);
      
      return reply.code(500).send({
        error: {
          message: error.message || 'Internal server error during analysis',
          type: 'analysis_error'
        }
      });
    }
  });
  
  /**
   * POST /v1/explain
   * 
   * Explain what model would be selected without actually selecting it
   * Useful for UI preview and debugging
   */
  fastify.post('/v1/explain', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const body = request.body as ExplainRequest;
      const userId = (request as any).userId || 1;
      
      if (!body.prompt || typeof body.prompt !== 'string') {
        return reply.code(400).send({
          error: {
            message: 'Invalid request: prompt string is required',
            type: 'invalid_request_error'
          }
        });
      }
      
      const explanation = await explainSelection(body.prompt, userId);
      
      return {
        success: true,
        ...explanation,
        timestamp: new Date().toISOString()
      };
      
    } catch (error: any) {
      console.error('Explanation error:', error);
      
      return reply.code(500).send({
        error: {
          message: error.message || 'Internal server error during explanation',
          type: 'explanation_error'
        }
      });
    }
  });
  
  /**
   * POST /v1/compare
   * 
   * Compare all strategies for a given prompt
   * Useful for understanding trade-offs
   */
  fastify.post('/v1/compare', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const body = request.body as CompareRequest;
      const userId = (request as any).userId || 1;
      
      if (!body.prompt || typeof body.prompt !== 'string') {
        return reply.code(400).send({
          error: {
            message: 'Invalid request: prompt string is required',
            type: 'invalid_request_error'
          }
        });
      }
      
      const comparison = await compareStrategies(body.prompt, userId);
      
      return {
        success: true,
        prompt: body.prompt,
        strategies: comparison,
        timestamp: new Date().toISOString()
      };
      
    } catch (error: any) {
      console.error('Comparison error:', error);
      
      return reply.code(500).send({
        error: {
          message: error.message || 'Internal server error during comparison',
          type: 'comparison_error'
        }
      });
    }
  });
  
  /**
   * GET /v1/router/health
   * 
   * Health check for smart router system
   */
  fastify.get('/v1/router/health', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { getCacheStats } = await import('../router/selector');
      const cacheStats = getCacheStats();
      
      return {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        cache: {
          size: cacheStats.size,
          keys: cacheStats.keys,
          oldestEntryAge: Math.round(cacheStats.oldestEntry / 1000) + 's'
        },
        features: {
          promptAnalysis: true,
          smartRouting: true,
          costOptimization: true,
          multiLanguage: true
        }
      };
      
    } catch (error: any) {
      return reply.code(500).send({
        status: 'unhealthy',
        error: error.message
      });
    }
  });
  
  /**
   * POST /v1/router/cache/invalidate
   * 
   * Manually invalidate router cache
   * Requires admin privileges
   */
  fastify.post('/v1/router/cache/invalidate', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      // TODO: Add admin auth check
      const { suite } = request.body as { suite?: string };
      
      const { invalidateRouterCache } = await import('../router/selector');
      invalidateRouterCache(suite);
      
      return {
        success: true,
        message: suite ? `Cache invalidated for suite: ${suite}` : 'All cache invalidated',
        timestamp: new Date().toISOString()
      };
      
    } catch (error: any) {
      return reply.code(500).send({
        error: {
          message: error.message || 'Failed to invalidate cache',
          type: 'cache_error'
        }
      });
    }
  });
}
