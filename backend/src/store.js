/**
 * In-memory data layer + event bus.
 * Every protocol (REST, RPC, Socket.io, SSE) talks to this one module, so a change
 * made through any of them is instantly visible to all the others via `bus`.
 */
const EventEmitter = require('events');

const bus = new EventEmitter();
bus.setMaxListeners(50);

class AppError extends Error {
  constructor(status, code, message, data) {
    super(message);
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

const STATUS_FLOW = ['pending', 'processing', 'shipped', 'out_for_delivery', 'delivered'];
const ALL_STATUSES = [...STATUS_FLOW, 'cancelled'];
const CANCELLABLE = ['pending', 'processing'];
const TERMINAL = ['delivered', 'cancelled'];

/* ---------------------------------- catalog --------------------------------- */
const catalog = [
  { id: 'p1', name: 'Noise-Cancelling Headphones', category: 'Audio', price: 129.0, stock: 25, emoji: '🎧' },
  { id: 'p2', name: 'Mechanical Keyboard', category: 'Accessories', price: 89.5, stock: 40, emoji: '⌨️' },
  { id: 'p3', name: 'Wireless Mouse', category: 'Accessories', price: 34.99, stock: 60, emoji: '🖱️' },
  { id: 'p4', name: '27" 4K Monitor', category: 'Displays', price: 349.0, stock: 12, emoji: '🖥️' },
  { id: 'p5', name: 'USB-C Hub (7-in-1)', category: 'Accessories', price: 45.0, stock: 80, emoji: '🔌' },
  { id: 'p6', name: 'Smart Watch', category: 'Wearables', price: 199.0, stock: 18, emoji: '⌚' },
  { id: 'p7', name: 'Portable SSD 1TB', category: 'Storage', price: 109.0, stock: 30, emoji: '💾' },
  { id: 'p8', name: 'Bluetooth Speaker', category: 'Audio', price: 59.9, stock: 45, emoji: '🔊' },
];

/* ---------------------------------- orders ---------------------------------- */
const orders = new Map();
let orderSeq = 1000;

const now = () => new Date().toISOString();
const round2 = (n) => Math.round(n * 100) / 100;

function findProduct(id) {
  return catalog.find((p) => p.id === id);
}

function listCatalog({ q, category } = {}) {
  return catalog.filter(
    (p) =>
      (!q || p.name.toLowerCase().includes(String(q).toLowerCase())) &&
      (!category || p.category.toLowerCase() === String(category).toLowerCase()),
  );
}

function getOrder(id) {
  const order = orders.get(String(id || '').toUpperCase());
  if (!order) throw new AppError(404, 'ORDER_NOT_FOUND', `Order ${id} not found`);
  return order;
}

function listOrders({ status, email, page = 1, limit = 20 } = {}) {
  let all = [...orders.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  if (status) all = all.filter((o) => o.status === status);
  if (email) all = all.filter((o) => o.customer.email.toLowerCase() === String(email).toLowerCase());
  const p = Math.max(1, parseInt(page, 10) || 1);
  const l = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  return { items: all.slice((p - 1) * l, p * l), page: p, limit: l, total: all.length };
}

function createOrder({ customer, items } = {}) {
  const details = {};
  if (!customer || typeof customer.name !== 'string' || !customer.name.trim()) details.customer = 'customer.name is required';
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.email || '')) details.customer = 'customer.email must be a valid email';
  if (!Array.isArray(items) || items.length === 0) details.items = 'items must be a non-empty array';
  if (Object.keys(details).length) throw new AppError(422, 'VALIDATION_ERROR', 'Invalid order payload', details);

  const lines = items.map((it) => {
    const product = findProduct(it.productId);
    const quantity = Number(it.quantity);
    if (!product) throw new AppError(422, 'UNKNOWN_PRODUCT', `Unknown product ${it.productId}`);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 20)
      throw new AppError(422, 'INVALID_QUANTITY', `Quantity for ${product.name} must be an integer 1-20`);
    return { product, quantity };
  });

  // stock check first, then reserve (all-or-nothing)
  const wanted = {};
  lines.forEach(({ product, quantity }) => (wanted[product.id] = (wanted[product.id] || 0) + quantity));
  for (const [pid, qty] of Object.entries(wanted)) {
    const p = findProduct(pid);
    if (p.stock < qty) throw new AppError(409, 'OUT_OF_STOCK', `Only ${p.stock} of "${p.name}" left`);
  }
  Object.entries(wanted).forEach(([pid, qty]) => (findProduct(pid).stock -= qty));

  const id = `ORD-${++orderSeq}`;
  const orderLines = lines.map(({ product, quantity }) => ({
    productId: product.id,
    name: product.name,
    emoji: product.emoji,
    price: product.price,
    quantity,
  }));
  const order = {
    id,
    customer: { name: customer.name.trim(), email: customer.email.trim().toLowerCase() },
    items: orderLines,
    total: round2(orderLines.reduce((s, l) => s + l.price * l.quantity, 0)),
    status: 'pending',
    createdAt: now(),
    updatedAt: now(),
    history: [{ status: 'pending', at: now(), note: 'Order placed' }],
  };
  orders.set(id, order);
  bus.emit('order:created', order);
  pushAlert({ level: 'info', title: 'New order', message: `${id} placed by ${order.customer.name}` });
  return order;
}

function updateStatus(id, status, note = '', by = 'system') {
  const order = getOrder(id);
  if (!ALL_STATUSES.includes(status))
    throw new AppError(422, 'INVALID_STATUS', `Status must be one of: ${ALL_STATUSES.join(', ')}`);
  if (status === 'cancelled') return cancelOrder(id, note || 'Cancelled by ' + by, by);
  if (TERMINAL.includes(order.status))
    throw new AppError(409, 'ORDER_CLOSED', `Order is already ${order.status} and can no longer change`);
  if (STATUS_FLOW.indexOf(status) <= STATUS_FLOW.indexOf(order.status))
    throw new AppError(409, 'INVALID_TRANSITION', `Cannot move from ${order.status} back to ${status}`);
  return applyStatus(order, status, note || `Updated by ${by}`);
}

function cancelOrder(id, reason = 'No reason given', by = 'customer') {
  const order = getOrder(id);
  if (!CANCELLABLE.includes(order.status))
    throw new AppError(409, 'NOT_CANCELLABLE', `Order ${order.id} is ${order.status} and can no longer be cancelled`, {
      status: order.status,
    });
  order.items.forEach((l) => {
    const p = findProduct(l.productId);
    if (p) p.stock += l.quantity; // restore stock
  });
  applyStatus(order, 'cancelled', `${reason} (by ${by})`);
  return order;
}

function applyStatus(order, status, note) {
  const previousStatus = order.status;
  order.status = status;
  order.updatedAt = now();
  order.history.push({ status, at: order.updatedAt, note });
  bus.emit('order:updated', { order, previousStatus });
  pushAlert({
    level: status === 'cancelled' ? 'warning' : status === 'delivered' ? 'success' : 'info',
    title: `Order ${order.id} ${status.replace(/_/g, ' ')}`,
    message: note,
  });
  return order;
}

/* ---------------------------------- alerts ---------------------------------- */
const alerts = [];
let alertSeq = 0;

function pushAlert({ level = 'info', title, message = '' }) {
  const alert = { id: ++alertSeq, level, title, message, at: now() };
  alerts.push(alert);
  if (alerts.length > 100) alerts.shift();
  bus.emit('alert', alert);
  return alert;
}

/* ----------------------------------- chat ----------------------------------- */
const messages = new Map(); // orderId -> [msg]
let msgSeq = 0;

function addMessage(orderId, { from, name, text }) {
  const msg = { id: ++msgSeq, orderId, from, name, text, at: now() };
  if (!messages.has(orderId)) messages.set(orderId, []);
  const list = messages.get(orderId);
  list.push(msg);
  if (list.length > 200) list.shift();
  return msg;
}

const getMessages = (orderId) => messages.get(orderId) || [];

/* --------------------------------- demo seed -------------------------------- */
function seed() {
  const a = createOrder({
    customer: { name: 'Ayesha Khan', email: 'ayesha@example.com' },
    items: [{ productId: 'p1', quantity: 1 }, { productId: 'p3', quantity: 2 }],
  });
  updateStatus(a.id, 'processing', 'Payment confirmed', 'system');
  createOrder({
    customer: { name: 'Bilal Ahmed', email: 'bilal@example.com' },
    items: [{ productId: 'p4', quantity: 1 }],
  });
  alerts.length = 0; // start with a clean alert feed
}

module.exports = {
  bus, AppError, STATUS_FLOW, ALL_STATUSES, CANCELLABLE, TERMINAL,
  catalog, alerts, orders,
  findProduct, listCatalog, getOrder, listOrders, createOrder, updateStatus, cancelOrder,
  pushAlert, addMessage, getMessages, seed,
};
