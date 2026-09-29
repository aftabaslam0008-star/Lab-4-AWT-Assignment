const fs = require('fs');
const path = require('path');
const http = require('http');
const cors = require('cors');
const express = require('express');

const config = require('./config');
const store = require('./store');
const rest = require('./rest');
const rpc = require('./rpc');
const { attachSSE } = require('./sse');
const { attachSockets } = require('./sockets');

const app = express();
const server = http.createServer(app);

app.disable('x-powered-by');
app.use(cors({ origin: config.CORS_ORIGINS.includes('*') ? true : config.CORS_ORIGINS, exposedHeaders: ['Location'] }));

/* health check (Render / Railway ping this) */
app.get('/health', (_req, res) => res.json({ status: 'ok', uptime: process.uptime(), time: new Date().toISOString() }));

/* 1. REST      */ app.use('/api/v1', express.json({ limit: '100kb' }), rest);
/* 2. JSON-RPC  */ app.use('/rpc', rpc);
/* 3. Socket.io */ const io = attachSockets(server);
/* 4. SSE       */ attachSSE(app, () => io.engine.clientsCount);

/* optional: serve ../frontend so the whole app runs on http://localhost:4000 in dev */
const frontendDir = path.join(__dirname, '..', '..', 'frontend');
if (fs.existsSync(path.join(frontendDir, 'index.html'))) app.use(express.static(frontendDir));
else app.get('/', (_req, res) => res.json({ name: 'Order Tracking API', docs: 'See README.md', health: '/health' }));

/* 404 + error handler for the REST API (consistent JSON errors) */
app.use('/api', (req, res) =>
  res.status(404).json({ error: { code: 'NOT_FOUND', message: `No route for ${req.method} ${req.originalUrl}` } }),
);
app.use((err, _req, res, _next) => {
  if (err.type === 'entity.parse.failed')
    return res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Request body is not valid JSON' } });
  if (err instanceof store.AppError)
    return res.status(err.status).json({ error: { code: err.code, message: err.message, ...(err.data ? { details: err.data } : {}) } });
  console.error(err);
  return res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong' } });
});

/* demo data + simulated courier progress so the live features move on their own */
store.seed();
if (config.SIMULATE) {
  setInterval(() => {
    const cutoff = Date.now() - config.STEP_SECONDS * 1000;
    for (const o of store.orders.values()) {
      if (store.TERMINAL.includes(o.status) || new Date(o.updatedAt).getTime() > cutoff) continue;
      const next = store.STATUS_FLOW[store.STATUS_FLOW.indexOf(o.status) + 1];
      if (next) store.updateStatus(o.id, next, 'Courier update', 'system');
    }
  }, 5000).unref();
}

if (require.main === module) {
  server.listen(config.PORT, () => {
    console.log(`Order Tracking server running on port ${config.PORT}`);
    console.log(`  REST  /api/v1   RPC  /rpc   SSE  /events   WebSocket  /socket.io`);
  });
}

module.exports = { app, server, io };
