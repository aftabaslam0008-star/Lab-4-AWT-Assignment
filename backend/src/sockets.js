/**
 * Socket.io  (real-time status updates + 1-on-1 customer <-> agent chat)
 *
 * Rooms
 *   order:<ORDER_ID>  customers watching one order
 *   agents            logged-in support agents (get every order event + the support queue)
 *   chat:<ORDER_ID>   the private 1-on-1 chat room (max 1 customer + 1 agent)
 *
 * See README.md for the full event table.
 */
const { Server } = require('socket.io');
const store = require('./store');
const { AGENT_KEY, CORS_ORIGINS } = require('./config');

const cleanText = (t) => String(t ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();

function attachSockets(httpServer) {
  const io = new Server(httpServer, {
    cors: { origin: CORS_ORIGINS.includes('*') ? true : CORS_ORIGINS, methods: ['GET', 'POST'] },
  });

  // orderId -> { customer: socketId|null, agent: socketId|null, customerName, agentName }
  const chats = new Map();
  const room = (orderId) => `chat:${orderId}`;
  const reply = (cb, payload) => typeof cb === 'function' && cb(payload);
  const fail = (cb, code, message) => reply(cb, { ok: false, error: { code, message } });

  const presence = (orderId) => {
    const c = chats.get(orderId) || {};
    return {
      orderId,
      customerOnline: !!c.customer,
      agentOnline: !!c.agent,
      customerName: c.customerName || null,
      agentName: c.agentName || null,
    };
  };

  const queue = () =>
    [...chats.entries()]
      .filter(([, c]) => c.customer)
      .map(([orderId, c]) => ({
        orderId,
        customerName: c.customerName,
        waiting: !c.agent,
        agentName: c.agentName || null,
      }));

  const broadcastPresence = (orderId) => {
    io.to(room(orderId)).emit('chat:presence', presence(orderId));
    io.to('agents').emit('support:queue', queue());
  };

  function systemMessage(orderId, text) {
    const msg = store.addMessage(orderId, { from: 'system', name: 'System', text });
    io.to(room(orderId)).emit('chat:message', msg);
  }

  function leaveChat(socket, orderId, reason = 'left the chat') {
    const c = chats.get(orderId);
    if (!c) return;
    let role = null;
    if (c.customer === socket.id) role = 'customer';
    if (c.agent === socket.id) role = 'agent';
    if (!role) return;
    const name = c[`${role}Name`];
    c[role] = null;
    c[`${role}Name`] = null;
    socket.leave(room(orderId));
    socket.data.chats.delete(orderId);
    systemMessage(orderId, `${name} ${reason}`);
    if (!c.customer && !c.agent) chats.delete(orderId);
    broadcastPresence(orderId);
  }

  /* -------- bridge: store events -> socket rooms (real-time status updates) -------- */
  store.bus.on('order:updated', ({ order, previousStatus }) => {
    const payload = { orderId: order.id, status: order.status, previousStatus, order, at: order.updatedAt };
    io.to(`order:${order.id}`).emit('order:status', payload);
    io.to('agents').emit('order:status', payload);
  });
  store.bus.on('order:created', (order) => io.to('agents').emit('order:created', { order }));

  io.on('connection', (socket) => {
    socket.data = { role: 'customer', chats: new Set() };

    /* ---- watching orders ---- */
    socket.on('order:subscribe', ({ orderId } = {}, cb) => {
      try {
        const order = store.getOrder(orderId);
        socket.join(`order:${order.id}`);
        reply(cb, { ok: true, order });
      } catch (e) {
        fail(cb, e.code || 'ERROR', e.message);
      }
    });

    socket.on('order:unsubscribe', ({ orderId } = {}, cb) => {
      socket.leave(`order:${String(orderId).toUpperCase()}`);
      reply(cb, { ok: true });
    });

    /* ---- agent login ---- */
    socket.on('agent:login', ({ agentKey } = {}, cb) => {
      if (agentKey !== AGENT_KEY) return fail(cb, 'UNAUTHORIZED', 'Invalid agent key');
      socket.data.role = 'agent';
      socket.join('agents');
      reply(cb, { ok: true, queue: queue() });
    });

    /* ---- 1-on-1 chat ---- */
    socket.on('chat:join', ({ orderId, role, name, email, agentKey } = {}, cb) => {
      try {
        const order = store.getOrder(orderId);
        if (role === 'agent') {
          if (agentKey !== AGENT_KEY) return fail(cb, 'UNAUTHORIZED', 'Invalid agent key');
        } else if (role === 'customer') {
          if (String(email || '').toLowerCase() !== order.customer.email)
            return fail(cb, 'FORBIDDEN', 'That email does not match this order');
        } else return fail(cb, 'INVALID_ROLE', 'role must be "customer" or "agent"');

        const oid = order.id;
        const c = chats.get(oid) || { customer: null, agent: null };
        if (c[role] && c[role] !== socket.id)
          return fail(cb, 'SLOT_TAKEN', `This chat is 1-on-1 and already has a ${role}`);

        c[role] = socket.id;
        c[`${role}Name`] = cleanText(name).slice(0, 40) || (role === 'agent' ? 'Support Agent' : order.customer.name);
        chats.set(oid, c);
        socket.join(room(oid));
        socket.data.chats.add(oid);

        systemMessage(oid, `${c[`${role}Name`]} joined the chat`);
        reply(cb, { ok: true, orderId: oid, history: store.getMessages(oid), presence: presence(oid) });
        broadcastPresence(oid);
      } catch (e) {
        fail(cb, e.code || 'ERROR', e.message);
      }
    });

    socket.on('chat:message', ({ orderId, text } = {}, cb) => {
      const oid = String(orderId || '').toUpperCase();
      const c = chats.get(oid);
      const role = c && (c.customer === socket.id ? 'customer' : c.agent === socket.id ? 'agent' : null);
      if (!role) return fail(cb, 'NOT_IN_CHAT', 'Join the chat first');
      const body = cleanText(text).slice(0, 1000);
      if (!body) return fail(cb, 'EMPTY', 'Message is empty');
      const msg = store.addMessage(oid, { from: role, name: c[`${role}Name`], text: body });
      io.to(room(oid)).emit('chat:message', msg);
      reply(cb, { ok: true, message: msg });
    });

    socket.on('chat:typing', ({ orderId, typing } = {}) => {
      const oid = String(orderId || '').toUpperCase();
      if (!socket.data.chats.has(oid)) return;
      const c = chats.get(oid);
      const role = c.customer === socket.id ? 'customer' : 'agent';
      socket.to(room(oid)).emit('chat:typing', { orderId: oid, role, name: c[`${role}Name`], typing: !!typing });
    });

    socket.on('chat:leave', ({ orderId } = {}, cb) => {
      leaveChat(socket, String(orderId || '').toUpperCase());
      reply(cb, { ok: true });
    });

    // agent ends the conversation for both sides
    socket.on('chat:close', ({ orderId } = {}, cb) => {
      const oid = String(orderId || '').toUpperCase();
      const c = chats.get(oid);
      if (!c || c.agent !== socket.id) return fail(cb, 'FORBIDDEN', 'Only the agent in this chat can close it');
      systemMessage(oid, 'The agent closed this chat. Thanks for contacting support!');
      io.to(room(oid)).emit('chat:closed', { orderId: oid });
      io.in(room(oid)).socketsLeave(room(oid));
      [...io.sockets.sockets.values()].forEach((s) => s.data.chats?.delete(oid));
      chats.delete(oid);
      io.to('agents').emit('support:queue', queue());
      reply(cb, { ok: true });
    });

    socket.on('disconnect', () => {
      [...socket.data.chats].forEach((oid) => leaveChat(socket, oid, 'disconnected'));
    });
  });

  return io;
}

module.exports = { attachSockets };
