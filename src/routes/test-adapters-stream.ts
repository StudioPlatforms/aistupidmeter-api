import { FastifyInstance, FastifyReply } from 'fastify';
import { Provider } from '../llm/adapters';
import { EventEmitter } from 'events';

// Global event emitter for benchmark progress
export const benchmarkEventEmitter = new EventEmitter();

export default async function (fastify: FastifyInstance, opts: any) {
  
  // SSE endpoint for streaming benchmark progress
  fastify.get('/benchmark-stream/:sessionId', async (req, reply) => {
    const { sessionId } = req.params as { sessionId: string };
    
    // Set SSE headers
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'X-Accel-Buffering': 'no' // Disable nginx buffering
    });
    
    // Send initial connection message
    reply.raw.write(`data: ${JSON.stringify({ 
      type: 'connected', 
      message: 'Connected to benchmark stream',
      sessionId 
    })}\n\n`);
    
    // Create event listener for this session
    const progressHandler = (data: any) => {
      if (data.sessionId === sessionId) {
        reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
      }
    };
    
    // Listen for progress events
    benchmarkEventEmitter.on('progress', progressHandler);
    
    // Send heartbeat every 20 seconds to keep connection alive
    const heartbeat = setInterval(() => {
      reply.raw.write(`:heartbeat\n\n`);
    }, 20000);
    
    // Cleanup on disconnect
    req.raw.on('close', () => {
      benchmarkEventEmitter.removeListener('progress', progressHandler);
      clearInterval(heartbeat);
      reply.raw.end();
    });
    
    // Keep connection open
    return reply;
  });
}

// Helper function to emit progress events
export function emitBenchmarkProgress(sessionId: string, data: any) {
  benchmarkEventEmitter.emit('progress', {
    sessionId,
    timestamp: new Date().toISOString(),
    ...data
  });
}
