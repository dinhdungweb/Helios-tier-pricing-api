const SHOPIFY_SHOP = process.env.SHOPIFY_SHOP;
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const API_VERSION = process.env.SHOPIFY_API_VERSION || '2026-07';

const DEFAULT_TURNS_NAMESPACE = process.env.CARD_FLIP_TURNS_NAMESPACE || 'custom';
const DEFAULT_TURNS_KEY = process.env.CARD_FLIP_TURNS_KEY || 'card_flip_turns';
const DEFAULT_HISTORY_NAMESPACE = process.env.CARD_FLIP_HISTORY_NAMESPACE || 'card_flip';
const DEFAULT_HISTORY_KEY = process.env.CARD_FLIP_HISTORY_KEY || 'history';
const DEFAULT_ALLOWED_TURNS = toNonNegativeInt(process.env.CARD_FLIP_DEFAULT_TURNS, 1);
const MAX_HISTORY_ENTRIES = toNonNegativeInt(process.env.CARD_FLIP_MAX_HISTORY_ENTRIES, 200);

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
}

function assertServerConfig() {
  if (!SHOPIFY_SHOP || !SHOPIFY_ACCESS_TOKEN) {
    throw httpError(500, 'Missing SHOPIFY_SHOP or SHOPIFY_ACCESS_TOKEN environment variables');
  }
}

function getConfig() {
  return {
    turnsNamespace: DEFAULT_TURNS_NAMESPACE,
    turnsKey: DEFAULT_TURNS_KEY,
    historyNamespace: DEFAULT_HISTORY_NAMESPACE,
    historyKey: DEFAULT_HISTORY_KEY,
    defaultAllowedTurns: DEFAULT_ALLOWED_TURNS,
    maxHistoryEntries: MAX_HISTORY_ENTRIES
  };
}

async function getGameState(customerId, campaignId) {
  assertServerConfig();

  const numericId = normalizeCustomerId(customerId);
  const normalizedCampaignId = normalizeCampaignId(campaignId);
  const config = getConfig();

  const [customer, turnsMetafield, historyMetafield] = await Promise.all([
    getCustomer(numericId),
    getCustomerMetafield(numericId, config.turnsNamespace, config.turnsKey),
    getCustomerMetafield(numericId, config.historyNamespace, config.historyKey)
  ]);

  const allowedTurns = toNonNegativeInt(
    metafieldValue(turnsMetafield),
    config.defaultAllowedTurns
  );

  const history = parseHistory(metafieldValue(historyMetafield));
  const campaignHistory = history.filter((entry) => entry && entry.campaign_id === normalizedCampaignId);
  const usedTurns = campaignHistory.length;
  const remainingTurns = Math.max(0, allowedTurns - usedTurns);

  return {
    numericId,
    campaignId: normalizedCampaignId,
    customer,
    allowedTurns,
    usedTurns,
    remainingTurns,
    history,
    campaignHistory,
    historyMetafield,
    config
  };
}

async function recordPlay(payload) {
  const state = await getGameState(payload.customer_id, payload.campaign_id);

  if (state.remainingTurns <= 0) {
    throw httpError(403, 'Bạn đã hết lượt chơi.');
  }

  const requestEmail = cleanString(payload.customer_email, 180);
  const shopifyEmail = cleanString(state.customer.email, 180);

  if (requestEmail && shopifyEmail && requestEmail.toLowerCase() !== shopifyEmail.toLowerCase()) {
    throw httpError(403, 'Customer email does not match customer_id.');
  }

  const playedAt = new Date().toISOString();
  const entry = {
    id: createEntryId(),
    campaign_id: state.campaignId,
    customer_id: state.numericId,
    customer_email: shopifyEmail || requestEmail,
    card_id: cleanString(payload.card_id, 120),
    card_title: cleanString(payload.card_title, 240),
    card_code: cleanString(payload.card_code, 120),
    card_image: cleanString(payload.card_image, 700),
    card_position: toNonNegativeInt(payload.card_position, 0),
    deck_size: toNonNegativeInt(payload.deck_size, 0),
    result_title: cleanString(payload.card_title, 240),
    result_code: cleanString(payload.card_code, 120),
    result_image: cleanString(payload.card_image, 700),
    played_at: playedAt
  };

  const nextHistory = [entry, ...state.history].slice(0, state.config.maxHistoryEntries);

  await upsertCustomerMetafield(
    state.numericId,
    state.config.historyNamespace,
    state.config.historyKey,
    JSON.stringify(nextHistory),
    'json',
    state.historyMetafield
  );

  const usedTurns = state.usedTurns + 1;
  const remainingTurns = Math.max(0, state.allowedTurns - usedTurns);

  return {
    success: true,
    campaign_id: state.campaignId,
    customer_id: state.numericId,
    allowed_turns: state.allowedTurns,
    used_turns: usedTurns,
    remaining_turns: remainingTurns,
    entry
  };
}

async function getCustomer(customerId) {
  const data = await shopifyFetch(`/customers/${customerId}.json`);
  if (!data.customer) {
    throw httpError(404, 'Customer not found');
  }
  return data.customer;
}

async function getCustomerMetafield(customerId, namespace, key) {
  const query = new URLSearchParams({ namespace, key }).toString();
  const data = await shopifyFetch(`/customers/${customerId}/metafields.json?${query}`);
  const metafields = data.metafields || [];
  return metafields.find((metafield) => metafield.namespace === namespace && metafield.key === key) || null;
}

async function upsertCustomerMetafield(customerId, namespace, key, value, type, existingMetafield) {
  if (existingMetafield && existingMetafield.id) {
    return shopifyFetch(`/customers/${customerId}/metafields/${existingMetafield.id}.json`, {
      method: 'PUT',
      body: JSON.stringify({
        metafield: {
          id: existingMetafield.id,
          value,
          type
        }
      })
    });
  }

  return shopifyFetch(`/customers/${customerId}/metafields.json`, {
    method: 'POST',
    body: JSON.stringify({
      metafield: {
        namespace,
        key,
        value,
        type
      }
    })
  });
}

async function shopifyFetch(path, options = {}) {
  assertServerConfig();

  const response = await fetch(`https://${SHOPIFY_SHOP}/admin/api/${API_VERSION}${path}`, {
    method: options.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
      ...(options.headers || {})
    },
    body: options.body
  });

  const text = await response.text();
  let data = {};

  if (text) {
    try {
      data = JSON.parse(text);
    } catch (error) {
      data = { raw: text };
    }
  }

  if (!response.ok) {
    const message = data.errors || data.error || text || response.statusText;
    throw httpError(response.status, `Shopify API error: ${formatMessage(message)}`);
  }

  return data;
}

function parseHistory(value) {
  if (!value) return [];

  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    return [];
  }
}

function metafieldValue(metafield) {
  if (!metafield) return undefined;
  return metafield.value;
}

function normalizeCustomerId(customerId) {
  const numericId = String(customerId || '').replace(/\D/g, '');
  if (!numericId) {
    throw httpError(400, 'customer_id is required');
  }
  return numericId;
}

function normalizeCampaignId(campaignId) {
  const cleanCampaignId = cleanString(campaignId || 'default', 120);
  return cleanCampaignId || 'default';
}

function cleanString(value, maxLength) {
  return String(value || '').trim().slice(0, maxLength);
}

function toNonNegativeInt(value, fallback) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number) || number < 0) {
    return fallback;
  }
  return number;
}

function createEntryId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function formatMessage(message) {
  if (typeof message === 'string') return message;
  return JSON.stringify(message);
}

function handleError(res, error) {
  const statusCode = error.statusCode || 500;
  return res.status(statusCode).json({
    success: false,
    error: error.message || 'Internal server error'
  });
}

module.exports = {
  setCorsHeaders,
  handleError,
  getGameState,
  recordPlay,
  httpError
};
