import { FastifyInstance } from 'fastify';
import { chatCompletionsHandler, listModelsHandler } from '../router/proxy';

export default async function routerRoutes(fastify: FastifyInstance) {
  // OpenAI-compatible endpoints
  fastify.post('/v1/chat/completions', chatCompletionsHandler);
  fastify.get('/v1/models', listModelsHandler);
  
  // Health check for router service
  fastify.get('/router/health', async (request, reply) => {
    return {
      status: 'ok',
      service: 'ai-router',
      timestamp: new Date().toISOString()
    };
  });
}
