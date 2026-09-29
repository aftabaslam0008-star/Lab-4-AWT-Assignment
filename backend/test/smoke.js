/**
 * End-to-end smoke test: boots the server on a random port and exercises
 * REST, JSON-RPC, Socket.io (status push + 1-on-1 chat) and SSE.
 *   npm test
 */
process.env.SIMULATE_PROGRESS = 'false';
process.env.AGENT_KEY = 'test-key';

const assert = require('assert');
const { io: connect } = require('socket.io-client');
const { server } = require('../src/server');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const once = (socket, ev, ms = 3000) =>
  new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`timeout waiting for "${ev}"`)), ms);
    socket.once(ev, (d) => { clearTimeout(t); res(d); });
  });
const emit = (socket, ev, payload) => new Promise((res) => socket.emit(ev, payload, res));

let passed = 0;
const ok = (name) => console.log(`  ✔ ${name}`) || passed++;

(async () => {
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const json = async (path, opts = {}) => {
    const res = await fetch(base + path, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
    return { status: res.status, body: res.status === 204 ? null : await res.json() };
  };
  const rpc = (body, headers) => json('/rpc', { method: 'POST', body: JSON.stringify(body), headers });
  const agent = { 'x-agent-key': 'test-key' };

  console.log('\nREST');
  let r = await json('/api/v1/catalog');
  assert.equal(r.status, 200); assert(r.body.data.length >= 8); ok('GET /catalog');
  r = await json('/api/v1/orders'); assert.equal(r.status, 401); ok('orders list needs email or agent key');
  r = await json('/api/v1/orders', { method: 'POST', body: JSON.stringify({ customer: { name: 'T', email: 'bad' }, items: [] }) });
  assert.equal(r.status, 422); ok('validation error -> 422');
  r = await json('/api/v1/orders', { method: 'POST', body: JSON.stringify({ customer: { name: 'Test User', email: 'test@example.com' }, items: [{ productId: 'p3', quantity: 2 }] }) });
  assert.equal(r.status, 201); const order = r.body.data; assert.equal(order.status, 'pending'); ok(`POST /orders -> ${order.id}`);
  r = await json(`/api/v1/orders?email=test@example.com`); assert.equal(r.body.data.length, 1); ok('GET /orders?email=');
  r = await json(`/api/v1/orders/${order.id}/status`, { method: 'PATCH', body: JSON.stringify({ status: 'shipped' }) });
  assert.equal(r.status, 401); ok('PATCH status without key -> 401');

  console.log('\nSSE');
  const sseRes = await fetch(base + '/events');
  assert(sseRes.headers.get('content-type').startsWith('text/event-stream'));
  const reader = sseRes.body.getReader(); const dec = new TextDecoder(); let sseBuf = '';
  (async () => { for (;;) { const { done, value } = await reader.read(); if (done) break; sseBuf += dec.decode(value); } })().catch(() => {});
  await wait(200); assert(sseBuf.includes('event: connected')); ok('GET /events streams "connected"');

  console.log('\nSocket.io');
  const cust = connect(base, { transports: ['websocket'] });
  const agentS = connect(base, { transports: ['websocket'] });
  const intruder = connect(base, { transports: ['websocket'] });
  await Promise.all([once(cust, 'connect'), once(agentS, 'connect'), once(intruder, 'connect')]);

  let a = await emit(cust, 'order:subscribe', { orderId: order.id }); assert(a.ok); ok('customer subscribes to order room');
  a = await emit(agentS, 'agent:login', { agentKey: 'wrong' }); assert.equal(a.ok, false); ok('agent login rejects bad key');
  a = await emit(agentS, 'agent:login', { agentKey: 'test-key' }); assert(a.ok); ok('agent login');

  const pushed = once(cust, 'order:status');
  r = await json(`/api/v1/orders/${order.id}/status`, { method: 'PATCH', body: JSON.stringify({ status: 'processing' }), headers: agent });
  assert.equal(r.status, 200);
  const evt = await pushed; assert.equal(evt.status, 'processing'); assert.equal(evt.previousStatus, 'pending');
  ok('REST status change pushed live to customer via "order:status"');

  a = await emit(cust, 'chat:join', { orderId: order.id, role: 'customer', email: 'wrong@x.com' }); assert.equal(a.error.code, 'FORBIDDEN'); ok('chat join: wrong email rejected');
  const queueUpdate = once(agentS, 'support:queue');
  a = await emit(cust, 'chat:join', { orderId: order.id, role: 'customer', email: 'test@example.com', name: 'Test User' }); assert(a.ok); ok('customer joins chat');
  const q = await queueUpdate; assert(q.find((x) => x.orderId === order.id && x.waiting)); ok('agents see the waiting customer in "support:queue"');
  a = await emit(agentS, 'chat:join', { orderId: order.id, role: 'agent', agentKey: 'test-key', name: 'Sara' }); assert(a.ok); ok('agent joins chat');
  a = await emit(intruder, 'chat:join', { orderId: order.id, role: 'customer', email: 'test@example.com' }); assert.equal(a.error.code, 'SLOT_TAKEN'); ok('third participant blocked (1-on-1)');

  const gotMsg = once(agentS, 'chat:message'); // first message the agent sees may be a system one
  const waitCustomerMsg = new Promise((res) => agentS.on('chat:message', (m) => m.from === 'customer' && res(m)));
  a = await emit(cust, 'chat:message', { orderId: order.id, text: 'Where is my parcel?' }); assert(a.ok);
  const m = await waitCustomerMsg; assert.equal(m.text, 'Where is my parcel?'); await gotMsg; ok('customer -> agent chat message');
  const waitAgentMsg = new Promise((res) => cust.on('chat:message', (x) => x.from === 'agent' && res(x)));
  await emit(agentS, 'chat:message', { orderId: order.id, text: 'It ships today!' });
  assert.equal((await waitAgentMsg).text, 'It ships today!'); ok('agent -> customer chat message');
  const typing = once(agentS, 'chat:typing'); cust.emit('chat:typing', { orderId: order.id, typing: true });
  assert.equal((await typing).typing, true); ok('typing indicator');
  a = await emit(intruder, 'chat:message', { orderId: order.id, text: 'hi' }); assert.equal(a.ok, false); ok('non-member cannot post');

  console.log('\nJSON-RPC 2.0');
  r = await rpc({ jsonrpc: '2.0', id: 1, method: 'getOrderStatus', params: { orderId: order.id } });
  assert.equal(r.body.result.status, 'processing'); assert.equal(r.body.id, 1); ok('getOrderStatus');
  r = await rpc({ jsonrpc: '2.0', id: 2, method: 'nope' }); assert.equal(r.body.error.code, -32601); ok('unknown method -> -32601');
  r = await rpc({ jsonrpc: '2.0', id: 3, method: 'cancelOrder', params: {} }); assert.equal(r.body.error.code, -32602); ok('missing params -> -32602');
  r = await rpc({ id: 4, method: 'ping' }); assert.equal(r.body.error.code, -32600); ok('missing "jsonrpc" -> -32600');
  const bad = await fetch(base + '/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{oops' });
  assert.equal((await bad.json()).error.code, -32700); ok('broken JSON -> -32700');
  r = await rpc([{ jsonrpc: '2.0', id: 'a', method: 'ping' }, { jsonrpc: '2.0', id: 'b', method: 'listMethods' }, { jsonrpc: '2.0', method: 'ping' }]);
  assert.equal(r.body.length, 2); ok('batch request (notification produces no response)');
  r = await rpc({ jsonrpc: '2.0', method: 'ping' }); assert.equal(r.status, 204); ok('notification -> 204 No Content');
  r = await rpc({ jsonrpc: '2.0', id: 5, method: 'updateOrderStatus', params: { orderId: order.id, status: 'shipped' } });
  assert.equal(r.body.error.data.code, 'UNAUTHORIZED'); ok('updateOrderStatus requires agent key');
  r = await rpc({ jsonrpc: '2.0', id: 6, method: 'updateOrderStatus', params: { orderId: order.id, status: 'shipped' } }, agent);
  assert.equal(r.body.result.status, 'shipped'); ok('updateOrderStatus with key');
  r = await rpc({ jsonrpc: '2.0', id: 7, method: 'cancelOrder', params: { orderId: order.id } });
  assert.equal(r.body.error.data.code, 'NOT_CANCELLABLE'); ok('cannot cancel a shipped order');

  // fresh order for a successful cancel + stock restore
  const before = (await json('/api/v1/catalog/p5')).body.data.stock;
  r = await json('/api/v1/orders', { method: 'POST', body: JSON.stringify({ customer: { name: 'Cancel Me', email: 'c@example.com' }, items: [{ productId: 'p5', quantity: 3 }] }) });
  const o2 = r.body.data;
  assert.equal((await json('/api/v1/catalog/p5')).body.data.stock, before - 3);
  const cancelPush = once(agentS, 'order:status');
  r = await rpc({ jsonrpc: '2.0', id: 8, method: 'cancelOrder', params: { orderId: o2.id, reason: 'changed my mind' } });
  assert.equal(r.body.result.status, 'cancelled'); ok('cancelOrder via RPC');
  assert.equal((await cancelPush).status, 'cancelled'); ok('RPC cancel pushed to agents via Socket.io "order:status"');
  assert.equal((await json('/api/v1/catalog/p5')).body.data.stock, before); ok('stock restored after cancel');

  console.log('\nSSE (continued)');
  await wait(300);
  assert(sseBuf.includes('event: alert')); assert(/Order ORD-\d+ processing/.test(sseBuf) && /cancelled/.test(sseBuf)); ok('status changes arrived on the SSE stream as alerts');
  await json('/api/v1/alerts', { method: 'POST', body: JSON.stringify({ title: 'Warehouse delay', level: 'warning' }), headers: agent });
  await wait(200); assert(sseBuf.includes('Warehouse delay')); ok('agent broadcast alert delivered over SSE');

  const closed = once(cust, 'chat:closed');
  await emit(agentS, 'chat:close', { orderId: order.id }); await closed; ok('agent can close the chat');

  [cust, agentS, intruder].forEach((s) => s.close());
  reader.cancel().catch(() => {});
  console.log(`\nAll ${passed} checks passed ✅\n`);
  process.exit(0);
})().catch((e) => { console.error('\n❌ FAILED:', e.message, '\n', e.stack); process.exit(1); });
