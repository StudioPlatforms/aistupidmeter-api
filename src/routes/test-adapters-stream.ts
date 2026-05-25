import { FastifyInstance } from 'fastify';
import { EventEmitter } from 'events';

// Global event emitter for benchmark progress
export const benchmarkEventEmitter = new EventEmitter();
// Allow many concurrent SSE listeners without warnings
benchmarkEventEmitter.setMaxListeners(0);

export default async function testAdaptersStreamRoutes(fastify: FastifyInstance) {
  // SSE endpoint for streaming benchmark progress
  fastify.get('/benchmark-stream/:sessionId', (req: any, reply) => {
    const { sessionId } = req.params as { sessionId: string };

    // CRITICAL: Take over the connection from Fastify so it doesn't try to
    // serialize/close the response itself - this prevents ERR_INCOMPLETE_CHUNKED_ENCODING.
    reply.hijack();

    // Set SSE headers
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'X-Accel-Buffering': 'no', // Disable nginx buffering for SSE
    });

    let closed = false;

    const safeWrite = (chunk: string) => {
      if (closed) return;
      try {
        reply.raw.write(chunk);
      } catch {
        closed = true;
      }
    };

    // Send initial connection message
    safeWrite(
      `data: ${JSON.stringify({
        type: 'connected',
        message: 'Connected to benchmark stream',
        sessionId,
      })}\n\n`
    );

    // Create event listener for this session
    const progressHandler = (data: any) => {
      if (data.sessionId === sessionId) {
        safeWrite(`data: ${JSON.stringify(data)}\n\n`);
      }
    };

    // Listen for progress events
    benchmarkEventEmitter.on('progress', progressHandler);

    // Send heartbeat every 15 seconds to keep nginx/EventSource from dropping the connection
    const heartbeat = setInterval(() => {
      safeWrite(`: heartbeat ${Date.now()}\n\n`);
    }, 15000);

    const cleanup = () => {
      if (closed) return;
      closed = true;
      benchmarkEventEmitter.removeListener('progress', progressHandler);
      clearInterval(heartbeat);
      try {
        reply.raw.end();
      } catch {
        // ignore
      }
    };

    // Cleanup on disconnect / error
    req.raw.on('close', cleanup);
    req.raw.on('end', cleanup);
    reply.raw.on('error', cleanup);
  });
}

// Helper function to emit progress events
export function emitBenchmarkProgress(sessionId: string, data: any) {
  benchmarkEventEmitter.emit('progress', {
    sessionId,
    timestamp: new Date().toISOString(),
    ...data,
  });
}
