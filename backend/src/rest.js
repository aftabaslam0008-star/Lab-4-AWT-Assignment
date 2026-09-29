/** REST API  ->  /api/v1/... */
const express = require('express');
const store = require('./store');
const { AGENT_KEY } = require('./config');

const { AppError } = store;
const router = express.Router();

const isAgent = (req) => req.get('x-agent-key') === AGENT_KEY;
const requireAgent = (req, _res, next) => {
  if (!isAgent(req)) throw new AppError(401, 'UNAUTHORIZED', 'A valid x-agent-key header is required');
  next();
};

/* ---- catalog ---- */
router.get('/catalog', (req, res) => {
  const data = store.listCatalog(req.query);
  res.json({ data, meta: { total: data.length } });
});

router.get('/catalog/:id', (req, res) => {
  const product = store.findProduct(req.params.id);
  if (!product) throw new AppError(404, 'PRODUCT_NOT_FOUND', `Product ${req.params.id} not found`);
  res.json({ data: product });
});

/* ---- orders ---- */
router.get('/orders', (req, res) => {
  // customers must filter by their email, only agents may list everything
  if (!req.query.email && !isAgent(req))
    throw new AppError(401, 'UNAUTHORIZED', 'Pass ?email=you@example.com or send the x-agent-key header');
  const { items, ...meta } = store.listOrders(req.query);
  res.json({ data: items, meta });
});

router.get('/orders/:id', (req, res) => res.json({ data: store.getOrder(req.params.id) }));

router.post('/orders', (req, res) => {
  const order = store.createOrder(req.body);
  res.status(201).location(`/api/v1/orders/${order.id}`).json({ data: order });
});

router.patch('/orders/:id/status', requireAgent, (req, res) => {
  const { status, note } = req.body || {};
  res.json({ data: store.updateStatus(req.params.id, status, note, 'agent') });
});

router.post('/orders/:id/cancel', (req, res) => {
  res.json({ data: store.cancelOrder(req.params.id, (req.body || {}).reason, 'customer') });
});

/* ---- alerts (agent broadcast -> pushed to every SSE client) ---- */
router.post('/alerts', requireAgent, (req, res) => {
  const { title, message, level } = req.body || {};
  if (!title) throw new AppError(422, 'VALIDATION_ERROR', 'title is required');
  const safeLevel = ['info', 'success', 'warning', 'error'].includes(level) ? level : 'info';
  res.status(201).json({ data: store.pushAlert({ level: safeLevel, title, message }) });
});

router.get('/meta', (_req, res) =>
  res.json({ data: { statuses: store.ALL_STATUSES, flow: store.STATUS_FLOW, cancellable: store.CANCELLABLE } }),
);

module.exports = router;
