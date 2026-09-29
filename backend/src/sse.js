/**
 * Server-Sent Events  ->  GET /events
 * One-way server -> browser stream of live system alerts.
 *   event: connected  - sent once on connect
 *   event: alert      - every system alert (new order, status change, agent broadcast)
 *   event: stats      - server stats every 10 s
 * Supports Last-Event-ID so a reconnecting client gets the alerts it missed.
 */
const store = require('./store');

const clients = new Set();

const send = (res, event, data, id) => {
  if (id !== undefined) res.write(`id: ${id}\n`);
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
};

function attachSSE(app, getSocketCount) {
  app.get('/events', (req, res) => {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // stop nginx/Render proxies from buffering the stream
    });
    res.flushHeaders();
    res.write('retry: 3000\n\n');

    send(res, 'connected', { message: 'Live alert stream connected', clients: clients.size + 1 });

    // replay missed alerts (reconnect) or the last few (first connect)
    const lastId = parseInt(req.get('Last-Event-ID'), 10);
    const replay = Number.isFinite(lastId)
      ? store.alerts.filter((a) => a.id > lastId)
      : store.alerts.slice(-5);
    replay.forEach((a) => send(res, 'alert', a, a.id));

    clients.add(res);
    req.on('close', () => clients.delete(res));
  });

  store.bus.on('alert', (alert) => clients.forEach((res) => send(res, 'alert', alert, alert.id)));

  // heartbeat keeps the connection alive through proxies + periodic stats
  setInterval(() => clients.forEach((res) => res.write(': ping\n\n')), 15000).unref();
  setInterval(() => {
    const stats = {
      orders: store.orders.size,
      sseClients: clients.size,
      socketClients: getSocketCount(),
      time: new Date().toISOString(),
    };
    clients.forEach((res) => send(res, 'stats', stats));
  }, 10000).unref();
}

module.exports = { attachSSE };
