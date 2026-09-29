/**
 * JSON-RPC 2.0  ->  POST /rpc
 * Supports: single calls, batch calls (array), notifications (no "id" => no response).
 * Spec: https://www.jsonrpc.org/specification
 */
const express = require('express');
const store = require('./store');
const { AGENT_KEY } = require('./config');

const { AppError } = store;
const router = express.Router();

// JSON-RPC error codes
const E = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  SERVER: -32000, // application errors (order not found, not cancellable ...)
};

class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

const need = (params, key) => {
  if (!params || typeof params !== 'object' || params[key] === undefined || params[key] === '')
    throw new RpcError(E.INVALID_PARAMS, `Invalid params: "${key}" is required`);
  return params[key];
};

const methods = {
  ping: () => ({ pong: true, time: new Date().toISOString() }),

  listMethods: () => Object.keys(methods),

  getOrderStatus: (params) => {
    const o = store.getOrder(need(params, 'orderId'));
    return { orderId: o.id, status: o.status, updatedAt: o.updatedAt };
  },

  cancelOrder: (params) => {
    const o = store.cancelOrder(need(params, 'orderId'), params.reason || 'Cancelled via RPC', 'customer');
    return { orderId: o.id, status: o.status, cancelled: true };
  },

  trackOrders: (params) =>
    store.listOrders({ email: need(params, 'email'), limit: 100 }).items.map((o) => ({
      orderId: o.id, status: o.status, total: o.total,
    })),

  // agent-only
  updateOrderStatus: (params, ctx) => {
    if (ctx.agentKey !== AGENT_KEY) throw new RpcError(E.SERVER, 'Unauthorized: agent key required', { code: 'UNAUTHORIZED' });
    const o = store.updateStatus(need(params, 'orderId'), need(params, 'status'), params.note, 'agent');
    return { orderId: o.id, status: o.status };
  },
};

async function handleOne(req, ctx) {
  const isObj = req && typeof req === 'object' && !Array.isArray(req);
  const valid =
    isObj && req.jsonrpc === '2.0' && typeof req.method === 'string' &&
    (req.id === undefined || req.id === null || ['string', 'number'].includes(typeof req.id)) &&
    (req.params === undefined || (req.params !== null && typeof req.params === 'object'));
  const id = isObj && req.id !== undefined ? req.id : null;

  if (!valid) return { jsonrpc: '2.0', id, error: { code: E.INVALID_REQUEST, message: 'Invalid Request' } };

  const isNotification = req.id === undefined;
  try {
    const fn = Object.prototype.hasOwnProperty.call(methods, req.method) ? methods[req.method] : null;
    if (!fn) throw new RpcError(E.METHOD_NOT_FOUND, `Method not found: ${req.method}`);
    const params = req.params || {};
    const result = await fn(params, { ...ctx, agentKey: params.agentKey || ctx.agentKey });
    return isNotification ? null : { jsonrpc: '2.0', id, result };
  } catch (err) {
    if (isNotification) return null;
    let error;
    if (err instanceof RpcError) error = { code: err.code, message: err.message, data: err.data };
    else if (err instanceof AppError)
      error = { code: E.SERVER, message: err.message, data: { code: err.code, ...(err.data ? { details: err.data } : {}) } };
    else {
      console.error('[rpc] internal error', err);
      error = { code: E.INTERNAL, message: 'Internal error' };
    }
    return { jsonrpc: '2.0', id, error };
  }
}

router.use(express.json({ limit: '100kb' }));

router.post('/', async (req, res) => {
  const ctx = { agentKey: req.get('x-agent-key') };
  const body = req.body;

  if (Array.isArray(body)) {
    if (body.length === 0)
      return res.json({ jsonrpc: '2.0', id: null, error: { code: E.INVALID_REQUEST, message: 'Invalid Request' } });
    const out = (await Promise.all(body.map((r) => handleOne(r, ctx)))).filter(Boolean);
    return out.length ? res.json(out) : res.status(204).end();
  }

  const out = await handleOne(body, ctx);
  return out ? res.json(out) : res.status(204).end();
});

// malformed JSON body -> spec-compliant Parse error
router.use((err, _req, res, _next) => {
  if (err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError))
    return res.status(200).json({ jsonrpc: '2.0', id: null, error: { code: E.PARSE, message: 'Parse error' } });
  console.error('[rpc]', err);
  return res.status(500).json({ jsonrpc: '2.0', id: null, error: { code: E.INTERNAL, message: 'Internal error' } });
});

module.exports = router;
