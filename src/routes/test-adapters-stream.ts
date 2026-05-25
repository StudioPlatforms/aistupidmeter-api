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

    const raw = reply.raw;
    const socket = raw.socket;

    // Disable Nagle's algorithm so every write() flushes immediately instead
    // of being coalesced. Without this, SSE events arrive in big bursts
    // (e.g. all messages stamped with the same client timestamp) and nginx
    // can't forward them in real time.
    try {
      if (socket && typeof (socket as any).setNoDelay === 'function') {
        (socket as any).setNoDelay(true);
      }
      if (socket && typeof (socket as any).setKeepAlive === 'function') {
        (socket as any).setKeepAlive(true, 30000);
      }
      // Disable Node's per-socket request/keep-alive timeouts for this long
      // running response - benchmarks routinely take 5-10 minutes.
      if (socket && typeof (socket as any).setTimeout === 'function') {
        (socket as any).setTimeout(0);
      }
    } catch {
      // best effort
    }

    // Set SSE headers
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'X-Accel-Buffering': 'no', // Disable nginx buffering for SSE
    });

    // Force headers + an initial padding so any proxy that buffers until it
    // sees real bytes starts forwarding immediately.
    try {
      raw.flushHeaders?.();
    } catch {
      // ignore
    }

    let closed = false;

    const safeWrite = (chunk: string) => {
      if (closed) return;
      try {
        raw.write(chunk);
      } catch {
        closed = true;
      }
    };

    // 2KB of padding as a leading SSE comment helps any intermediate proxy
    // that holds the response until the buffer fills before flushing.
    safeWrite(`: ${' '.repeat(2048)}\n\n`);

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

    // Heartbeat every 10 seconds keeps nginx / EventSource alive even when a
    // single benchmark trial takes a while between progress events.
    const heartbeat = setInterval(() => {
      safeWrite(`: heartbeat ${Date.now()}\n\n`);
    }, 10000);

    const cleanup = () => {
      if (closed) return;
      closed = true;
      benchmarkEventEmitter.removeListener('progress', progressHandler);
      clearInterval(heartbeat);
      try {
        raw.end();
      } catch {
        // ignore
      }
    };

    // Only react to the client actually closing the underlying TCP connection
    // (or a socket error). NOTE: do NOT listen for req.raw 'end' here - on a
    // GET request the IncomingMessage emits 'end' as soon as the (empty) body
    // is consumed, which would tear down the SSE stream before any progress
    // events fire.
    req.raw.on('close', cleanup);
    req.raw.on('aborted', cleanup);
    raw.on('error', cleanup);
    raw.on('close', cleanup);
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
