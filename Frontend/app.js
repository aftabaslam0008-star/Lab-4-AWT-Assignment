/* Parcelwise front-end: REST + Socket.io + JSON-RPC + SSE in one page. No build step. */
(() => {
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (n) => '$' + Number(n).toFixed(2);
  const time = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const STEPS = ['pending', 'processing', 'shipped', 'out_for_delivery', 'delivered'];
  const LABEL = { pending: 'Pending', processing: 'Processing', shipped: 'Shipped', out_for_delivery: 'Out for delivery', delivered: 'Delivered', cancelled: 'Cancelled' };

  const params = new URLSearchParams(location.search);
  const cfg = window.APP_CONFIG || {};
  const API = (params.get('api') || cfg.API_URL || location.origin).replace(/\/$/, '');

  const S = {
    role: localStorage.getItem('role') || 'customer',
    agentKey: sessionStorage.getItem('agentKey') || '',
    name: localStorage.getItem('name') || '',
    email: localStorage.getItem('email') || '',
    catalog: [], cart: {}, orders: [], alerts: [], queue: [],
    chat: { orderId: null, joined: false }, unread: 0, unreadAlerts: 0,
    tab: 'shop', socket: null,
  };

  /* ------------------------------ helpers ------------------------------ */
  function toast(msg, kind = '') {
    const t = document.createElement('div');
    t.className = 'toast ' + kind;
    t.textContent = msg;
    $('#toasts').append(t);
    setTimeout(() => t.remove(), 4500);
  }

  function log(proto, text) {
    const li = document.createElement('li');
    li.innerHTML = `<time>${time(new Date())}</time><span class="p ${proto}">${proto}</span><span>${esc(text)}</span>`;
    const ul = $('#log');
    ul.prepend(li);
    while (ul.children.length > 80) ul.lastChild.remove();
  }

  const pill = (id, up) => { const el = $(id); el.classList.toggle('up', up); el.classList.toggle('down', !up); };
  const agentHeaders = () => (S.role === 'agent' && S.agentKey ? { 'x-agent-key': S.agentKey } : {});

  async function api(path, { method = 'GET', body } = {}) {
    log('REST', `${method} ${path}`);
    const res = await fetch(API + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...agentHeaders() },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error?.message || res.statusText);
    return data;
  }

  let rpcId = 1;
  async function rpc(method, params = {}) {
    log('RPC', `${method} ${JSON.stringify(params)}`);
    const res = await fetch(API + '/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...agentHeaders() },
      body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params }),
    });
    const j = await res.json();
    if (j.error) throw new Error(j.error.message);
    return j.result;
  }

  const wsEmit = (ev, payload) => new Promise((resolve) => {
    if (!S.socket?.connected) return resolve({ ok: false, error: { message: 'Not connected to the WebSocket server yet' } });
    S.socket.emit(ev, payload, resolve);
  });

  /* ------------------------------- shop -------------------------------- */
  async function loadCatalog() {
    const { data } = await api('/api/v1/catalog');
    S.catalog = data;
    renderCatalog();
  }

  function renderCatalog() {
    $('#catalog').innerHTML = S.catalog.map((p) => `
      <article class="product">
        <div class="emoji" aria-hidden="true">${p.emoji}</div>
        <h3>${esc(p.name)}</h3>
        <span class="muted">${esc(p.category)}, ${p.stock} in stock</span>
        <div class="row"><b>${money(p.price)}</b>
          <button class="btn small" data-act="add" data-id="${p.id}" ${p.stock < 1 ? 'disabled' : ''}>Add to cart</button></div>
      </article>`).join('');
  }

  function renderCart() {
    const lines = Object.entries(S.cart).map(([id, q]) => ({ p: S.catalog.find((x) => x.id === id), q })).filter((l) => l.p);
    $('#cart-lines').innerHTML = lines.length
      ? lines.map(({ p, q }) => `<div class="cart-line"><span>${p.emoji} ${esc(p.name)}</span>
          <span class="qty"><button data-act="dec" data-id="${p.id}" aria-label="Remove one">-</button>${q}<button data-act="add" data-id="${p.id}" aria-label="Add one">+</button></span></div>`).join('')
      : '<p class="muted">Your cart is empty. Add a product to start.</p>';
    $('#cart-total').textContent = money(lines.reduce((s, l) => s + l.p.price * l.q, 0));
  }

  async function placeOrder() {
    const name = $('#co-name').value.trim(), email = $('#co-email').value.trim();
    const items = Object.entries(S.cart).map(([productId, quantity]) => ({ productId, quantity }));
    if (!items.length) return toast('Add at least one product first', 'bad');
    try {
      const { data } = await api('/api/v1/orders', { method: 'POST', body: { customer: { name, email }, items } });
      S.name = name; S.email = email.toLowerCase();
      localStorage.setItem('name', S.name); localStorage.setItem('email', S.email);
      $('#lookup-email').value = S.email;
      S.cart = {}; renderCart();
      toast(`Order ${data.id} placed. Watch it move under Orders.`, 'good');
      await loadCatalog();
      await loadOrders();
      showTab('orders');
    } catch (e) { toast(e.message, 'bad'); }
  }

  /* ------------------------------ orders ------------------------------- */
  async function loadOrders() {
    try {
      if (S.role === 'agent') {
        if (!S.agentKey) { S.orders = []; return renderOrders(); }
        S.orders = (await api('/api/v1/orders?limit=100')).data;
      } else if (S.email) {
        S.orders = (await api(`/api/v1/orders?email=${encodeURIComponent(S.email)}`)).data;
        S.orders.forEach((o) => wsEmit('order:subscribe', { orderId: o.id }));
      }
    } catch (e) { toast(e.message, 'bad'); }
    renderOrders();
    renderChatSelect();
  }

  const canCancel = (o) => ['pending', 'processing'].includes(o.status);

  function renderOrders() {
    if (S.role === 'agent') return renderAgentTable();
    const box = $('#orders-list');
    if (!S.email) return (box.innerHTML = '<div class="empty">Enter your email above to see your orders. Try ayesha@example.com.</div>');
    if (!S.orders.length) return (box.innerHTML = `<div class="empty">No orders found for ${esc(S.email)}. Place one in the Shop tab.</div>`);
    box.innerHTML = S.orders.map(orderCard).join('');
  }

  function orderCard(o) {
    const idx = STEPS.indexOf(o.status);
    const track = STEPS.map((s, i) => `<div class="stop ${i <= idx ? 'done' : ''} ${i === idx ? 'now' : ''}"><span class="dot"></span>${LABEL[s]}</div>`).join('');
    return `<article class="order" id="order-${o.id}">
      <div class="order-head"><h3>${o.id}</h3><span class="tag ${o.status}">${LABEL[o.status]}</span></div>
      <div class="muted">Placed ${new Date(o.createdAt).toLocaleString()} by ${esc(o.customer.name)}</div>
      <div class="track ${o.status}">${track}</div>
      <ul class="lines">${o.items.map((l) => `<li>${l.emoji} ${l.quantity} x ${esc(l.name)} <span class="muted">${money(l.price * l.quantity)}</span></li>`).join('')}</ul>
      <b>Total ${money(o.total)}</b>
      <div class="actions">
        ${canCancel(o) ? `<button class="btn small danger" data-act="cancel" data-id="${o.id}">Cancel order</button>` : ''}
        <button class="btn small ghost" data-act="chat" data-id="${o.id}">Chat with support</button>
      </div>
      <div class="history">${[...o.history].reverse().map((h) => `<span>${time(h.at)}  ${LABEL[h.status]}: ${esc(h.note)}</span>`).join('')}</div>
    </article>`;
  }

  function renderAgentTable() {
    const body = $('#agent-table');
    if (!S.agentKey) return (body.innerHTML = '<tr><td colspan="6" class="muted">Enter the agent key at the top (default: support123).</td></tr>');
    if (!S.orders.length) return (body.innerHTML = '<tr><td colspan="6" class="muted">No orders yet.</td></tr>');
    body.innerHTML = S.orders.map((o) => {
      const nexts = o.status === 'delivered' || o.status === 'cancelled' ? [] : [...STEPS.slice(STEPS.indexOf(o.status) + 1), 'cancelled'];
      return `<tr id="row-${o.id}"><td><b>${o.id}</b></td><td>${esc(o.customer.name)}<br><span class="muted">${esc(o.customer.email)}</span></td>
        <td>${money(o.total)}</td><td><span class="tag ${o.status}">${LABEL[o.status]}</span></td>
        <td>${nexts.length ? `<select data-sel="${o.id}">${nexts.map((s) => `<option value="${s}">${LABEL[s]}</option>`).join('')}</select>
          <button class="btn small" data-act="setstatus" data-id="${o.id}">Update</button>` : '<span class="muted">Closed</span>'}</td>
        <td><button class="btn small ghost" data-act="chat" data-id="${o.id}">Open chat</button></td></tr>`;
    }).join('');
  }

  function upsertOrder(order, flash = true) {
    const i = S.orders.findIndex((o) => o.id === order.id);
    if (i >= 0) S.orders[i] = order; else if (S.role === 'agent') S.orders.unshift(order); else return;
    renderOrders();
    renderChatSelect();
    if (flash) { const el = $(`#order-${order.id}`) || $(`#row-${order.id}`); el?.classList.add('flash'); }
  }

  /* ------------------------------- chat -------------------------------- */
  function renderChatSelect() {
    const sel = $('#chat-order');
    const keep = S.chat.orderId || sel.value;
    sel.innerHTML = S.orders.length
      ? S.orders.map((o) => `<option value="${o.id}">${o.id} - ${esc(o.customer.name)} (${LABEL[o.status]})</option>`).join('')
      : '<option value="">No orders to discuss yet</option>';
    if (keep && S.orders.some((o) => o.id === keep)) sel.value = keep;
    sel.disabled = S.chat.joined;
    $('#chat-join').disabled = !S.orders.length || S.chat.joined;
  }

  function setChatUI(joined) {
    S.chat.joined = joined;
    $('#chat-input').disabled = !joined;
    $('#chat-form button').disabled = !joined;
    $('#chat-join').hidden = joined;
    $('#chat-leave').hidden = !joined;
    $('#chat-close').hidden = !(joined && S.role === 'agent');
    renderChatSelect();
    if (!joined) { $('#typing').textContent = ''; }
  }

  async function joinChat(orderId) {
    if (S.chat.joined) await leaveChat();
    const payload = { orderId, role: S.role, name: S.name || undefined, email: S.email, agentKey: S.agentKey };
    if (S.role === 'agent') payload.name = 'Support Agent';
    const r = await wsEmit('chat:join', payload);
    if (!r.ok) return toast(r.error.message, 'bad');
    S.chat.orderId = r.orderId;
    $('#msgs').innerHTML = '';
    r.history.forEach(addMessage);
    setPresence(r.presence);
    setChatUI(true);
    $('#chat-input').focus();
  }

  async function leaveChat() {
    if (S.chat.orderId) await wsEmit('chat:leave', { orderId: S.chat.orderId });
    setChatUI(false);
    $('#presence').textContent = 'Not connected to a chat room.';
  }

  function addMessage(m) {
    if (m.orderId !== S.chat.orderId) return;
    const div = document.createElement('div');
    div.className = 'msg ' + (m.from === 'system' ? 'system' : m.from === S.role ? 'me' : '');
    div.innerHTML = m.from === 'system' ? esc(m.text) : `<small>${esc(m.name)}, ${time(m.at)}</small>${esc(m.text)}`;
    const box = $('#msgs');
    box.append(div);
    box.scrollTop = box.scrollHeight;
    if (m.from !== 'system' && m.from !== S.role && S.tab !== 'chat') { S.unread++; badge('#chat-badge', S.unread); }
  }

  function setPresence(p) {
    if (p.orderId !== S.chat.orderId) return;
    const dot = (on, who) => (on ? `<b>${esc(who)} is online</b>` : 'waiting for the other side');
    $('#presence').innerHTML = `${p.orderId}: Customer ${dot(p.customerOnline, p.customerName)} / Agent ${dot(p.agentOnline, p.agentName)}`;
  }

  function renderQueue() {
    if (S.role !== 'agent') return;
    $('#queue-title').textContent = 'Customers in chat';
    $('#queue-body').innerHTML = S.queue.length
      ? S.queue.map((q) => `<div class="q"><span><b>${q.orderId}</b><br><span class="muted">${esc(q.customerName)} ${q.waiting ? 'is waiting' : 'with ' + esc(q.agentName)}</span></span>
          ${q.waiting ? `<button class="btn small" data-act="chat" data-id="${q.orderId}">Take chat</button>` : ''}</div>`).join('')
      : 'Nobody is waiting. New customers appear here the moment they join.';
  }

  let typingTimer, typingSent = false;
  function onTypingInput() {
    if (!S.chat.joined) return;
    if (!typingSent) { S.socket.emit('chat:typing', { orderId: S.chat.orderId, typing: true }); typingSent = true; }
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => { S.socket.emit('chat:typing', { orderId: S.chat.orderId, typing: false }); typingSent = false; }, 1200);
  }

  async function sendMessage(e) {
    e.preventDefault();
    const input = $('#chat-input'), text = input.value.trim();
    if (!text) return;
    input.value = '';
    const r = await wsEmit('chat:message', { orderId: S.chat.orderId, text });
    if (!r.ok) toast(r.error.message, 'bad');
    S.socket.emit('chat:typing', { orderId: S.chat.orderId, typing: false }); typingSent = false;
  }

  /* ---------------------------- sockets (WS) --------------------------- */
  function loadScript(src) {
    return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('Could not load ' + src)); document.head.append(s); });
  }

  async function connectSocket() {
    try { await loadScript(API + '/socket.io/socket.io.js'); } catch (e) { pill('#pill-ws', false); return toast('WebSocket client failed to load. Is the backend URL right?', 'bad'); }
    const s = (S.socket = io(API, { transports: ['websocket', 'polling'] }));
    s.onAny((ev) => log('WS', '<- ' + ev));
    s.onAnyOutgoing((ev) => log('WS', '-> ' + ev));

    s.on('connect', async () => {
      pill('#pill-ws', true);
      if (S.role === 'agent' && S.agentKey) agentLogin();
      S.orders.forEach((o) => S.role === 'customer' && s.emit('order:subscribe', { orderId: o.id }, () => {}));
      if (S.chat.joined && S.chat.orderId) { const id = S.chat.orderId; setChatUI(false); await joinChat(id); } // auto-rejoin after reconnect
    });
    s.on('disconnect', () => pill('#pill-ws', false));
    s.on('connect_error', () => pill('#pill-ws', false));

    s.on('order:status', ({ order, status }) => {
      upsertOrder(order);
      toast(`${order.id} is now ${LABEL[status].toLowerCase()}`, status === 'cancelled' ? 'bad' : 'good');
    });
    s.on('order:created', ({ order }) => { upsertOrder(order); toast(`New order ${order.id} from ${order.customer.name}`); });
    s.on('chat:message', addMessage);
    s.on('chat:presence', setPresence);
    s.on('chat:typing', (t) => { $('#typing').textContent = t.typing && t.orderId === S.chat.orderId ? `${t.name} is typing...` : ''; });
    s.on('support:queue', (q) => { S.queue = q; renderQueue(); });
    s.on('chat:closed', () => { toast('The agent closed this chat', 'good'); setChatUI(false); $('#presence').textContent = 'Chat closed.'; });
  }

  async function agentLogin() {
    const r = await wsEmit('agent:login', { agentKey: S.agentKey });
    if (!r.ok) return toast(r.error.message, 'bad');
    S.queue = r.queue; renderQueue();
  }

  /* ------------------------------- SSE --------------------------------- */
  function connectSSE() {
    const es = new EventSource(API + '/events');
    es.onopen = () => pill('#pill-sse', true);
    es.onerror = () => pill('#pill-sse', false); // EventSource retries automatically
    es.addEventListener('connected', (e) => log('SSE', 'connected: ' + JSON.parse(e.data).message));
    es.addEventListener('alert', (e) => {
      const a = JSON.parse(e.data);
      log('SSE', `alert: ${a.title}`);
      if (S.alerts.some((x) => x.id === a.id)) return;
      S.alerts.unshift(a); S.alerts = S.alerts.slice(0, 50);
      renderAlerts();
      if (S.tab !== 'alerts') { S.unreadAlerts++; badge('#alert-badge', S.unreadAlerts); }
    });
    es.addEventListener('stats', (e) => {
      const s = JSON.parse(e.data);
      $('#stats').textContent = `${s.orders} orders, ${s.socketClients} WebSocket and ${s.sseClients} SSE clients connected`;
    });
  }

  function renderAlerts() {
    $('#alerts').innerHTML = S.alerts.length
      ? S.alerts.map((a) => `<li class="${a.level}"><b>${esc(a.title)}</b><time>${time(a.at)}</time><span>${esc(a.message)}</span></li>`).join('')
      : '<li><b>No alerts yet</b><span>Place or update an order and it will show up here instantly.</span></li>';
  }

  /* ---------------------------- RPC console ---------------------------- */
  const rpcId0 = () => (S.orders[0] ? S.orders[0].id : 'ORD-1001');
  const templates = () => ({
    'getOrderStatus': { jsonrpc: '2.0', id: 1, method: 'getOrderStatus', params: { orderId: rpcId0() } },
    'cancelOrder': { jsonrpc: '2.0', id: 2, method: 'cancelOrder', params: { orderId: rpcId0(), reason: 'Changed my mind' } },
    'trackOrders': { jsonrpc: '2.0', id: 3, method: 'trackOrders', params: { email: S.email || 'ayesha@example.com' } },
    'updateOrderStatus (agent)': { jsonrpc: '2.0', id: 4, method: 'updateOrderStatus', params: { orderId: rpcId0(), status: 'shipped', agentKey: S.agentKey || 'support123' } },
    'listMethods': { jsonrpc: '2.0', id: 5, method: 'listMethods' },
    'batch (3 calls)': [{ jsonrpc: '2.0', id: 'a', method: 'ping' }, { jsonrpc: '2.0', id: 'b', method: 'listMethods' }, { jsonrpc: '2.0', id: 'c', method: 'getOrderStatus', params: { orderId: rpcId0() } }],
    'notification (no reply)': { jsonrpc: '2.0', method: 'ping' },
    'error: unknown method': { jsonrpc: '2.0', id: 9, method: 'refundEverything' },
  });

  function fillTemplate() {
    const t = templates()[$('#rpc-template').value];
    $('#rpc-body').value = JSON.stringify(t, null, 2);
  }

  async function sendRpc() {
    const body = $('#rpc-body').value;
    log('RPC', 'POST /rpc (console)');
    try {
      const res = await fetch(API + '/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json', ...agentHeaders() }, body });
      const text = await res.text();
      $('#rpc-status').textContent = `HTTP ${res.status}`;
      $('#rpc-out').textContent = text ? JSON.stringify(JSON.parse(text), null, 2) : '(empty body: notification, nothing to return)';
    } catch (e) { $('#rpc-out').textContent = 'Request failed: ' + e.message; }
  }

  /* -------------------------- tabs, role, wiring ------------------------ */
  function badge(sel, n) { const el = $(sel); el.textContent = n; el.hidden = n < 1; }

  function showTab(name) {
    S.tab = name;
    $$('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
    $$('.panel').forEach((p) => (p.hidden = p.id !== 'tab-' + name));
    if (name === 'chat') { S.unread = 0; badge('#chat-badge', 0); }
    if (name === 'alerts') { S.unreadAlerts = 0; badge('#alert-badge', 0); }
    if (name === 'rpc') fillTemplate();
  }

  function applyRole() {
    const agent = S.role === 'agent';
    $('#role-customer').classList.toggle('on', !agent);
    $('#role-agent').classList.toggle('on', agent);
    $('#agent-key').hidden = !agent;
    $('#agent-key').value = S.agentKey;
    $('#customer-orders').hidden = agent;
    $('#agent-orders').hidden = !agent;
    $$('#tabs [data-for="customer"]').forEach((b) => (b.hidden = agent));
    if (agent) { $('#queue-title').textContent = 'Customers in chat'; renderQueue(); }
  }

  document.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const id = el.dataset.id;
    if (el.dataset.act === 'add') { S.cart[id] = (S.cart[id] || 0) + 1; renderCart(); }
    if (el.dataset.act === 'dec') { S.cart[id] = (S.cart[id] || 1) - 1; if (S.cart[id] < 1) delete S.cart[id]; renderCart(); }
    if (el.dataset.act === 'cancel') {
      if (!confirm(`Cancel order ${id}?`)) return;
      try { await rpc('cancelOrder', { orderId: id, reason: 'Cancelled from the website' }); toast(`${id} cancelled`, 'good'); loadCatalog(); }
      catch (err) { toast(err.message, 'bad'); }
    }
    if (el.dataset.act === 'setstatus') {
      const status = $(`[data-sel="${id}"]`).value;
      try { await api(`/api/v1/orders/${id}/status`, { method: 'PATCH', body: { status } }); } catch (err) { toast(err.message, 'bad'); }
    }
    if (el.dataset.act === 'chat') {
      showTab('chat');
      $('#chat-order').value = id;
      await joinChat(id);
    }
  });

  function init() {
    $('#co-name').value = S.name; $('#co-email').value = S.email; $('#lookup-email').value = S.email;
    $$('#tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
    $$('.seg button').forEach((b) => b.addEventListener('click', () => { localStorage.setItem('role', b.dataset.role); location.reload(); }));
    $('#agent-key').addEventListener('change', async (e) => {
      S.agentKey = e.target.value.trim(); sessionStorage.setItem('agentKey', S.agentKey);
      await agentLogin(); loadOrders();
    });
    $('#place-order').addEventListener('click', placeOrder);
    $('#lookup').addEventListener('submit', (e) => { e.preventDefault(); S.email = $('#lookup-email').value.trim().toLowerCase(); localStorage.setItem('email', S.email); loadOrders(); });
    $('#broadcast').addEventListener('submit', async (e) => {
      e.preventDefault();
      try { await api('/api/v1/alerts', { method: 'POST', body: { title: $('#bc-title').value, level: $('#bc-level').value } }); $('#bc-title').value = ''; toast('Alert broadcast to every open browser', 'good'); }
      catch (err) { toast(err.message, 'bad'); }
    });
    $('#chat-join').addEventListener('click', () => $('#chat-order').value && joinChat($('#chat-order').value));
    $('#chat-leave').addEventListener('click', leaveChat);
    $('#chat-close').addEventListener('click', async () => { await wsEmit('chat:close', { orderId: S.chat.orderId }); });
    $('#chat-form').addEventListener('submit', sendMessage);
    $('#chat-input').addEventListener('input', onTypingInput);
    $('#rpc-template').innerHTML = Object.keys(templates()).map((k) => `<option>${k}</option>`).join('');
    $('#rpc-template').addEventListener('change', fillTemplate);
    $('#rpc-send').addEventListener('click', sendRpc);

    applyRole(); renderCart(); renderAlerts();
    showTab(S.role === 'agent' ? 'orders' : 'shop');

    fetch(API + '/health').then((r) => pill('#pill-rest', r.ok)).catch(() => pill('#pill-rest', false));
    loadCatalog().catch((e) => toast('Cannot reach the API at ' + API + '. ' + e.message, 'bad'));
    connectSocket().then(loadOrders);
    connectSSE();
    setInterval(() => fetch(API + '/health').then((r) => pill('#pill-rest', r.ok)).catch(() => pill('#pill-rest', false)), 30000);
  }

  init();
})();
