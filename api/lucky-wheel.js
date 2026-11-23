'use strict';

/**
 * Lucky wheel API (single function to stay within the Vercel function limit).
 *
 * Customers (token rendered by the theme for the logged-in customer):
 *   POST { "action": "status", "token": "..." }
 *   POST { "action": "spin",   "token": "..." }
 *   POST { "action": "claim",  "token": "...", "id": "<prize id>" }  -> customer-only gift discount code
 *
 * Staff (password = LUCKY_WHEEL_ADMIN_KEY):
 *   GET  /api/lucky-wheel                       -> admin page (no data inside)
 *   POST { "action": "admin_overview", "admin_key": "..." }
 *   POST { "action": "admin_list",     "admin_key": "..." }
 *   POST { "action": "admin_mark",     "admin_key": "...", "id": "...", "status": "sent"|"pending" }
 *   POST { "action": "admin_delete",   "admin_key": "...", "id": "..." }
 *   POST { "action": "admin_reset",    "admin_key": "...", "confirm": "XOA" }
 *
 * POST only for data, so tokens and passwords never end up in URLs or logs.
 */

const {
  setCorsHeaders,
  handleError,
  getStatus,
  spin,
  claim,
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

  try {
    const body = parseBody(req.body);
    switch (body.action) {
      case 'status':
        return res.status(200).json(await getStatus(body.token));
      case 'spin':
        return res.status(200).json(await spin(body.token));
      case 'claim':
        return res.status(200).json(await claim(body.token, body.id));
      case 'admin_overview':
        return res.status(200).json(await adminOverview(body.admin_key));
      case 'admin_list':
        return res.status(200).json(await adminList(body.admin_key));
      case 'admin_mark':
        return res.status(200).json(await adminMark(body.admin_key, body.id, body.status));
      case 'admin_delete':
        return res.status(200).json(await adminDelete(body.admin_key, body.id));
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
