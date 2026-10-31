import { Router } from 'express';
import { addClient, clientCount, removeClient } from '../lib/sse.js';

export const eventsRouter = Router();

/** SSE 订阅端点：前端用 EventSource 连接，自动重连由浏览器负责 */
eventsRouter.get('/', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');
  res.write(`event: ping\ndata: ${JSON.stringify({ clients: clientCount() })}\n\n`);

  addClient(res);

  req.on('close', () => {
    removeClient(res);
    res.end();
  });
});
