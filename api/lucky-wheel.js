'use strict';

/**
 * Lucky wheel API (single function to stay within the Vercel function limit).
 *
 * Customers (token rendered by the theme for the logged-in customer):
 *   POST { "action": "status", "token": "..." }
 *   POST { "action": "spin",   "token": "..." }
 *
 * Staff (password = LUCKY_WHEEL_ADMIN_KEY):
 *   GET  /api/lucky-wheel                       -> admin page (no data inside)
 *   POST { "action": "admin_overview", "admin_key": "..." }
 *   POST { "action": "admin_list",     "admin_key": "..." }
 *   POST { "action": "admin_mark",     "admin_key": "...", "id": "...", "status": "sent"|"pending" }
 *   POST { "action": "admin_delete",   "admin_key": "...", "id": "..." }
 *   POST { "action": "admin_reset",    "admin_key": "...", "confirm": "XOA" }
 *   POST { "action": "admin_sync",     "admin_key": "..." }   -> attach waiting prizes to orders
 *
 * Shopify webhook (orders/create, HMAC-signed): POST with X-Shopify-Topic header.
 *   Waiting prizes of the customer are linked to the order (note + tag "vong-quay").
 *
 * POST only for data, so tokens and passwords never end up in URLs or logs.
 */

const {
  setCorsHeaders,
  handleError,
  getStatus,
  spin,
  handleOrderWebhook,
  adminSync,
  adminOverview,
  adminList,
  adminMark,
  adminDelete,
  adminReset,
  httpError
} = require('../lib/lucky-wheel-store');
const adminPage = require('../lib/lucky-wheel-admin-page');

module.exports = async (req, res) => {
  setCorsHeaders(res);

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    return res.status(200).send(adminPage);
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  // Shopify webhook: needs the raw body for the HMAC, so read the stream before req.body is touched
  if (req.headers['x-shopify-topic']) {
    try {
      const raw = await readRawBody(req);
      const result = await handleOrderWebhook(raw, req.headers);
      return res.status(200).json(result);
    } catch (error) {
      return handleError(res, error);
    }
  }

  try {
    const body = parseBody(req.body);
    switch (body.action) {
      case 'status':
        return res.status(200).json(await getStatus(body.token));
      case 'spin':
        return res.status(200).json(await spin(body.token));
      case 'admin_overview':
        return res.status(200).json(await adminOverview(body.admin_key));
      case 'admin_list':
        return res.status(200).json(await adminList(body.admin_key));
      case 'admin_mark':
        return res.status(200).json(await adminMark(body.admin_key, body.id, body.status));
      case 'admin_delete':
        return res.status(200).json(await adminDelete(body.admin_key, body.id));
      case 'admin_sync':
        return res.status(200).json(await adminSync(body.admin_key));
      case 'admin_reset':
        return res.status(200).json(await adminReset(body.admin_key, body.confirm));
      default:
        throw httpError(400, 'Unknown action');
    }
  } catch (error) {
    if (error.code === 'already_spun') {
      return res.status(409).json({ success: false, code: 'already_spun', error: error.message, result: publicResult(error.result) });
    }
    return handleError(res, error);
  }
};

function publicResult(result) {
  if (!result) return null;
  return { id: result.id, type: result.type, key: result.key, name: result.name, at: new Date(result.at).toISOString() };
}

function parseBody(body) {
  if (!body) return {};
  if (typeof body === 'string') {
    try {
      return JSON.parse(body);
    } catch (error) {
      throw httpError(400, 'Invalid JSON body');
    }
  }
  return body;
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
