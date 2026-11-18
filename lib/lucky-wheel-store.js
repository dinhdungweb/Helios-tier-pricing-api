'use strict';

/**
 * Lucky wheel (account tab) – server side.
 *
 * - Identity: the theme renders a signed token for the logged-in customer
 *   ("<customerId>.<unixSeconds>.<hmac_sha256 hex>"), verified here with
 *   LUCKY_WHEEL_SECRET. The client never chooses who it is.
 * - Result: decided here, never in the browser. The wheel only animates to it.
 * - Daily win cap: N random "win drops" are generated per local day. A spin
 *   wins only if a drop time has passed and has not been claimed yet, so wins
 *   are spread over the day and cannot be predicted.
 * - Prize: picked at random, weighted by remaining stock (Secret items with a
 *   stock of 2 are naturally rarer). Every other spin gets the consolation
 *   card ("Thẻ chương 10 năm"), unlimited, also kept 30 days.
 * - Concurrency: campaign state lives in one shop metafield written with
 *   compareDigest (compare-and-swap), so two spins can never take the same
 *   win slot or the same last item, and a customer can never spin twice a day.
 * - Config: read from the published theme's settings (lucky_wheel_*), so dates,
 *   prizes and stock are edited in the Theme Editor.
 */

const crypto = require('crypto');
const { mergePublishedThemeSettings } = require('./theme-settings');

const SHOPIFY_SHOP = normalizeShopDomain(process.env.SHOPIFY_SHOP);
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const LUCKY_WHEEL_SECRET = process.env.LUCKY_WHEEL_SECRET || '';
const LUCKY_WHEEL_ADMIN_KEY = process.env.LUCKY_WHEEL_ADMIN_KEY || '';
const API_VERSION = '2026-07';

const NAMESPACE = 'lucky_wheel';
const CUSTOMER_KEY = 'history';
const TIME_ZONE = 'Asia/Ho_Chi_Minh';
const PRIZE_COUNT = 9;
const PRIZE_VALID_DAYS = 30;
const TOKEN_MAX_AGE_SECONDS = 24 * 60 * 60;
const TOKEN_FUTURE_SKEW_SECONDS = 5 * 60;
const MAX_CAS_ATTEMPTS = 8;
const CONFIG_CACHE_MS = 60 * 1000;
const KEEP_SPIN_DAYS = 3;
const MAX_CUSTOMER_SPINS = 60;

/* ------------------------------------------------------------------ */
/* Errors / HTTP helpers                                               */
/* ------------------------------------------------------------------ */

function httpError(statusCode, message, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (code) error.code = code;
  return error;
}

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
}

function handleError(res, error) {
  const statusCode = error.statusCode || 500;
  if (statusCode >= 500) console.error('[lucky-wheel]', error);
  return res.status(statusCode).json({
    success: false,
    code: error.code || (statusCode >= 500 ? 'server_error' : 'bad_request'),
    error: statusCode >= 500 ? 'Internal server error' : error.message
  });
}

/* ------------------------------------------------------------------ */
/* Identity token                                                      */
/* ------------------------------------------------------------------ */

function signToken(customerId, timestamp, secret) {
  const payload = `${customerId}.${timestamp}`;
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

/**
 * Token format (built in Liquid):
 *   payload   = customer.id | append: '.' | append: unix seconds
 *   signature = payload | hmac_sha256: settings.lucky_wheel_secret
 *   token     = payload + '.' + signature
 */
function verifyToken(token, secret = LUCKY_WHEEL_SECRET, nowMs = Date.now()) {
  if (!secret) throw httpError(500, 'LUCKY_WHEEL_SECRET is not configured');
  if (typeof token !== 'string') throw httpError(401, 'Missing token', 'unauthorized');

  const parts = token.trim().split('.');
  if (parts.length !== 3) throw httpError(401, 'Invalid token', 'unauthorized');
  const [customerId, timestampRaw, signature] = parts;

  if (!/^\d{1,20}$/.test(customerId) || !/^\d{1,12}$/.test(timestampRaw) || !/^[a-f0-9]{64}$/i.test(signature)) {
    throw httpError(401, 'Invalid token', 'unauthorized');
  }

  const expected = signToken(customerId, timestampRaw, secret);
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(signature.toLowerCase(), 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw httpError(401, 'Invalid token', 'unauthorized');
  }

  const nowSeconds = Math.floor(nowMs / 1000);
  const timestamp = Number(timestampRaw);
  if (timestamp > nowSeconds + TOKEN_FUTURE_SKEW_SECONDS || nowSeconds - timestamp > TOKEN_MAX_AGE_SECONDS) {
    throw httpError(401, 'Token expired, please reload the page', 'token_expired');
  }

  return customerId;
}

/* ------------------------------------------------------------------ */
/* Time helpers (Vietnam local day)                                    */
/* ------------------------------------------------------------------ */

const VN_OFFSET_MS = 7 * 60 * 60 * 1000; // Asia/Ho_Chi_Minh has no DST

function localDayKey(ms) {
  return new Date(ms + VN_OFFSET_MS).toISOString().slice(0, 10);
}

/** Epoch ms of local midnight for a YYYY-MM-DD day key. */
function localDayStart(dayKey) {
  return Date.parse(`${dayKey}T00:00:00.000Z`) - VN_OFFSET_MS;
}

function nextLocalMidnight(ms) {
  return localDayStart(localDayKey(ms)) + 24 * 60 * 60 * 1000;
}

/** Parses "YYYY-MM-DD" or "YYYY-MM-DD HH:mm" (Vietnam time) to epoch ms. */
function parseLocalDateTime(value, endOfDay = false) {
  const text = String(value || '').trim();
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?$/);
  if (!match) return null;
  const [, y, m, d, hh, mm] = match;
  const hours = hh !== undefined ? Number(hh) : (endOfDay ? 23 : 0);
  const minutes = mm !== undefined ? Number(mm) : (endOfDay ? 59 : 0);
  const seconds = hh === undefined && endOfDay ? 59 : 0;
  const utc = Date.UTC(Number(y), Number(m) - 1, Number(d), hours, minutes, seconds);
  return Number.isFinite(utc) ? utc - VN_OFFSET_MS : null;
}

/* ------------------------------------------------------------------ */
/* Config from published theme settings                                */
/* ------------------------------------------------------------------ */

function buildConfig(settings) {
  const s = settings || {};
  const prizes = [];
  for (let i = 1; i <= PRIZE_COUNT; i += 1) {
    const name = String(s[`lucky_wheel_prize_${i}_name`] || '').trim();
    const stock = Math.max(0, Math.floor(Number(s[`lucky_wheel_prize_${i}_stock`]) || 0));
    if (name) prizes.push({ key: `p${i}`, name, stock });
  }

  const startAt = parseLocalDateTime(s.lucky_wheel_start, false);
  const endAt = parseLocalDateTime(s.lucky_wheel_end, true);
  const winsPerDay = clampInt(s.lucky_wheel_wins_per_day, 0, 100, 5);
  const winStartHour = clampInt(s.lucky_wheel_win_start_hour, 0, 23, 8);
  let winEndHour = clampInt(s.lucky_wheel_win_end_hour, 1, 24, 23);
  if (winEndHour <= winStartHour) winEndHour = Math.min(24, winStartHour + 1);

  return {
    enabled: s.lucky_wheel_enabled === true || s.lucky_wheel_enabled === 'true',
    campaignId: String(s.lucky_wheel_campaign_id || '').trim().replace(/[^a-z0-9_-]/gi, '').toLowerCase()
      || (startAt ? localDayKey(startAt).replace(/-/g, '') : 'default'),
    startAt,
    endAt,
    winsPerDay,
    winStartHour,
    winEndHour,
    prizes,
    consolation: {
      key: 'card',
      name: String(s.lucky_wheel_card_name || '').trim() || 'Thẻ chương 10 năm'
    }
  };
}

function clampInt(value, min, max, fallback) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

let configCache = null;

async function loadConfig() {
  const now = Date.now();
  if (configCache && configCache.expiresAt > now) return configCache.config;

  const data = await shopifyGraphql(`
    query LuckyWheelThemeSettings {
      themes(first: 1, roles: [MAIN]) {
        nodes {
          id
          files(first: 2, filenames: ["config/settings_data.json", "config/settings_schema.json"]) {
            nodes {
              filename
              body { ... on OnlineStoreThemeFileBodyText { content } }
            }
          }
        }
      }
    }
  `);

  const theme = data.data?.themes?.nodes?.[0];
  const files = new Map((theme?.files?.nodes || []).map((f) => [f.filename, f.body?.content]));
  if (!theme || !files.get('config/settings_data.json')) {
    throw httpError(503, 'Unable to read published theme settings');
  }

  const settings = mergePublishedThemeSettings(
    files.get('config/settings_data.json'),
    files.get('config/settings_schema.json'),
    'lucky_wheel_'
  );
  const config = buildConfig(settings);
  configCache = { config, expiresAt: now + CONFIG_CACHE_MS };
  return config;
}

function campaignStatus(config, nowMs) {
  if (!config.enabled) return 'disabled';
  if (config.startAt && nowMs < config.startAt) return 'not_started';
  if (config.endAt && nowMs > config.endAt) return 'ended';
  return 'active';
}

/* ------------------------------------------------------------------ */
/* Core decision (pure, unit tested)                                   */
/* ------------------------------------------------------------------ */

function emptyState() {
  return { version: 1, awarded: {}, days: {}, winners: [] };
}

function normalizeState(raw) {
  const state = raw && typeof raw === 'object' ? raw : {};
  return {
    version: 1,
    awarded: state.awarded && typeof state.awarded === 'object' ? state.awarded : {},
    days: state.days && typeof state.days === 'object' ? state.days : {},
    winners: Array.isArray(state.winners) ? state.winners : []
  };
}

/** Random drop times (epoch ms, sorted) inside the day's win window. */
function generateWinTimes(dayKey, config, rng = Math.random) {
  const start = localDayStart(dayKey) + config.winStartHour * 3600000;
  const end = localDayStart(dayKey) + config.winEndHour * 3600000;
  const times = [];
  for (let i = 0; i < config.winsPerDay; i += 1) {
    times.push(Math.floor(start + rng() * (end - start)));
  }
  return times.sort((a, b) => a - b);
}

function remainingStock(state, config) {
  return config.prizes
    .map((p) => ({ ...p, left: p.stock - (Number(state.awarded[p.key]) || 0) }))
    .filter((p) => p.left > 0);
}

function pickWeighted(items, rng = Math.random) {
  const total = items.reduce((sum, p) => sum + p.left, 0);
  let roll = rng() * total;
  for (const item of items) {
    roll -= item.left;
    if (roll < 0) return item;
  }
  return items[items.length - 1];
}

/**
 * Mutates `state` and returns { result, alreadySpun }.
 * result: { id, type: 'win'|'lose', key, name, at, day }
 */
function decideSpin(state, customerId, nowMs, config, rng = Math.random) {
  const dayKey = localDayKey(nowMs);

  if (!state.days[dayKey]) {
    state.days[dayKey] = { winTimes: generateWinTimes(dayKey, config, rng), wins: 0, spins: {} };
  }
  const day = state.days[dayKey];

  // Prune old per-day spin maps to keep the metafield small
  const keep = new Set();
  for (let i = 0; i < KEEP_SPIN_DAYS; i += 1) keep.add(localDayKey(nowMs - i * 86400000));
  for (const key of Object.keys(state.days)) if (!keep.has(key)) delete state.days[key];

  const existing = day.spins[customerId];
  if (existing) return { result: existing, alreadySpun: true };

  const due = day.winTimes.filter((t) => t <= nowMs).length;
  const stock = remainingStock(state, config);
  const id = `${dayKey.replace(/-/g, '')}-${customerId}`;

  let result;
  if (day.wins < due && stock.length > 0) {
    const prize = pickWeighted(stock, rng);
    state.awarded[prize.key] = (Number(state.awarded[prize.key]) || 0) + 1;
    day.wins += 1;
    result = { id, type: 'win', key: prize.key, name: prize.name, at: nowMs, day: dayKey };
    state.winners.push({ id, customer_id: customerId, key: prize.key, name: prize.name, at: nowMs });
  } else {
    result = { id, type: 'card', key: config.consolation.key, name: config.consolation.name, at: nowMs, day: dayKey };
  }

  day.spins[customerId] = result;
  return { result, alreadySpun: false };
}

/** Adds a spin (and its prize) to the customer's history, idempotently. */
function applyToCustomerHistory(history, result) {
  const h = history && typeof history === 'object' ? history : {};
  const spins = Array.isArray(h.spins) ? h.spins : [];
  const prizes = Array.isArray(h.prizes) ? h.prizes : [];

  if (!spins.some((s) => s.id === result.id)) {
    spins.unshift({ id: result.id, day: result.day, at: new Date(result.at).toISOString(), type: result.type, key: result.key, name: result.name });
  }
  if ((result.type === 'win' || result.type === 'card') && !prizes.some((p) => p.id === result.id)) {
    prizes.unshift({
      id: result.id,
      key: result.key,
      name: result.name,
      won_at: new Date(result.at).toISOString(),
      expires_at: new Date(result.at + PRIZE_VALID_DAYS * 86400000).toISOString(),
      status: 'pending'
    });
  }
  return { version: 1, spins: spins.slice(0, MAX_CUSTOMER_SPINS), prizes };
}

/* ------------------------------------------------------------------ */
/* Public operations                                                   */
/* ------------------------------------------------------------------ */

async function getStatus(token) {
  const customerId = verifyToken(token);
  const now = Date.now();
  const config = await loadConfig();
  const status = campaignStatus(config, now);
  const dayKey = localDayKey(now);

  const [stateSnap, historySnap] = await Promise.all([
    getShopMetafield(stateKey(config)),
    getCustomerMetafield(customerId)
  ]);
  const state = normalizeState(parseJson(stateSnap?.value));
  let history = parseJson(historySnap?.value) || {};

  // Repair: a result recorded in campaign state but missing from the customer copy
  const recorded = state.winners.filter((w) => w.customer_id === customerId)
    .map((w) => ({ id: w.id, type: 'win', key: w.key, name: w.name, at: w.at, day: localDayKey(w.at) }));
  for (const day of Object.values(state.days)) {
    const r = day.spins && day.spins[customerId];
    if (r && r.type === 'card') recorded.push(r);
  }
  const missing = recorded.filter((r) => !(history.prizes || []).some((p) => p.id === r.id));
  if (missing.length) {
    for (const r of missing) history = applyToCustomerHistory(history, r);
    await writeCustomerHistory(customerId, () => history).catch((e) => console.error('[lucky-wheel] repair failed', e));
  }

  const today = state.days[dayKey]?.spins?.[customerId] || null;
  return {
    success: true,
    campaign: publicCampaign(config, status),
    can_spin: status === 'active' && !today,
    today,
    next_spin_at: new Date(nextLocalMidnight(now)).toISOString(),
    prizes: (history.prizes || []).map(publicPrize)
  };
}

async function spin(token) {
  const customerId = verifyToken(token);
  const now = Date.now();
  const config = await loadConfig();
  const status = campaignStatus(config, now);
  if (status !== 'active') {
    throw httpError(409, campaignMessage(status), `campaign_${status}`);
  }

  const key = stateKey(config);
  let outcome = null;

  for (let attempt = 1; attempt <= MAX_CAS_ATTEMPTS; attempt += 1) {
    const snap = await getShopMetafield(key);
    const state = normalizeState(parseJson(snap?.value) || emptyState());
    outcome = decideSpin(state, customerId, now, config);
    if (outcome.alreadySpun) break;
    try {
      await setShopMetafield(key, JSON.stringify(state), snap?.compareDigest ?? null);
      break;
    } catch (error) {
      if (!error.isCompareDigestConflict || attempt === MAX_CAS_ATTEMPTS) throw error;
      await wait(60 + Math.random() * 140 * attempt);
    }
  }

  if (outcome.alreadySpun) {
    throw Object.assign(httpError(409, 'Bạn đã quay hôm nay, hãy quay lại vào ngày mai.', 'already_spun'), {
      result: outcome.result
    });
  }

  const [history] = await Promise.all([
    writeCustomerHistory(customerId, (h) => applyToCustomerHistory(h, outcome.result))
      .catch((error) => {
        // The result is safe in campaign state; status() will repair the customer copy.
        console.error('[lucky-wheel] customer history write failed', error);
        return null;
      }),
    mutateShopMetafield(ledgerKey(config, outcome.result.day), (list) => addLedgerEntry(list, outcome.result, customerId))
      .catch((error) => console.error('[lucky-wheel] ledger write failed', error))
  ]);

  return {
    success: true,
    result: publicResult(outcome.result),
    next_spin_at: new Date(nextLocalMidnight(now)).toISOString(),
    prizes: history ? (history.prizes || []).map(publicPrize) : undefined
  };
}

async function writeCustomerHistory(customerId, mutator) {
  for (let attempt = 1; attempt <= MAX_CAS_ATTEMPTS; attempt += 1) {
    const snap = await getCustomerMetafield(customerId);
    const next = mutator(parseJson(snap?.value) || {});
    try {
      await setCustomerMetafield(customerId, JSON.stringify(next), snap?.compareDigest ?? null);
      return next;
    } catch (error) {
      if (!error.isCompareDigestConflict || attempt === MAX_CAS_ATTEMPTS) throw error;
      await wait(50 + Math.random() * 100 * attempt);
    }
  }
  return null;
}

function stateKey(config) {
  return `state_${config.campaignId}`.slice(0, 64);
}

function publicCampaign(config, status) {
  return {
    status,
    start_at: config.startAt ? new Date(config.startAt).toISOString() : null,
    end_at: config.endAt ? new Date(config.endAt).toISOString() : null
  };
}

function publicResult(result) {
  return { id: result.id, type: result.type, key: result.key, name: result.name, at: new Date(result.at).toISOString() };
}

function publicPrize(p) {
  return { id: p.id, key: p.key, name: p.name, won_at: p.won_at, expires_at: p.expires_at, status: p.status || 'pending' };
}

function campaignMessage(status) {
  if (status === 'not_started') return 'Chương trình chưa bắt đầu.';
  if (status === 'ended') return 'Chương trình đã kết thúc.';
  return 'Vòng quay hiện chưa mở.';
}

/* ------------------------------------------------------------------ */
/* Prize ledger (one shop metafield per day) + admin                   */
/* ------------------------------------------------------------------ */

function ledgerKey(config, dayKeyOrId) {
  const day = String(dayKeyOrId).replace(/-/g, '').slice(0, 8);
  return 'ledger_' + config.campaignId.slice(0, 40) + '_' + day;
}

function addLedgerEntry(list, result, customerId) {
  const entries = Array.isArray(list) ? list : [];
  if (entries.some((e) => e.id === result.id)) return entries;
  entries.push({
    id: result.id,
    customer_id: String(customerId),
    type: result.type,
    key: result.key,
    name: result.name,
    at: new Date(result.at).toISOString(),
    expires_at: new Date(result.at + PRIZE_VALID_DAYS * 86400000).toISOString(),
    status: 'pending',
    sent_at: null
  });
  return entries;
}

function setLedgerStatus(list, id, status, nowMs = Date.now()) {
  const entries = Array.isArray(list) ? list : [];
  const entry = entries.find((e) => e.id === id);
  if (!entry) throw httpError(404, 'Prize not found');
  entry.status = status;
  entry.sent_at = status === 'sent' ? new Date(nowMs).toISOString() : null;
  return entries;
}

function setPrizeStatus(history, id, status) {
  const h = history && typeof history === 'object' ? history : {};
  const prizes = Array.isArray(h.prizes) ? h.prizes : [];
  const prize = prizes.find((p) => p.id === id);
  if (prize) prize.status = status;
  return { ...h, version: 1, spins: Array.isArray(h.spins) ? h.spins : [], prizes };
}

function verifyAdmin(key) {
  if (!LUCKY_WHEEL_ADMIN_KEY) throw httpError(500, 'LUCKY_WHEEL_ADMIN_KEY is not configured');
  const a = crypto.createHash('sha256').update(String(key || '')).digest();
  const b = crypto.createHash('sha256').update(LUCKY_WHEEL_ADMIN_KEY).digest();
  if (!crypto.timingSafeEqual(a, b)) throw httpError(401, 'Sai mật khẩu quản trị', 'admin_unauthorized');
}

async function adminOverview(adminKey) {
  verifyAdmin(adminKey);
  configCache = null; // always fresh for staff
  const config = await loadConfig();
  const now = Date.now();
  const state = normalizeState(parseJson((await getShopMetafield(stateKey(config)))?.value));
  const day = state.days[localDayKey(now)] || { winTimes: [], wins: 0, spins: {} };
  return {
    success: true,
    campaign: { ...publicCampaign(config, campaignStatus(config, now)), id: config.campaignId, wins_per_day: config.winsPerDay },
    today: {
      day: localDayKey(now),
      spins: Object.keys(day.spins || {}).length,
      wins: day.wins || 0,
      win_times: (day.winTimes || []).map((t) => new Date(t).toISOString())
    },
    prizes: config.prizes.map((p) => {
      const awarded = Number(state.awarded[p.key]) || 0;
      return { key: p.key, name: p.name, stock: p.stock, awarded, left: Math.max(0, p.stock - awarded) };
    }),
    consolation: config.consolation
  };
}

async function adminList(adminKey) {
  verifyAdmin(adminKey);
  configCache = null;
  const config = await loadConfig();
  const prefix = 'ledger_' + config.campaignId.slice(0, 40) + '_';

  const entries = [];
  let after = null;
  for (let page = 0; page < 20; page += 1) {
    const data = await shopifyGraphql(
      `query LuckyWheelLedger($ns: String!, $after: String) {
        shop { metafields(namespace: $ns, first: 100, after: $after) {
          nodes { key value }
          pageInfo { hasNextPage endCursor }
        } }
      }`,
      { ns: NAMESPACE, after }
    );
    const conn = data.data?.shop?.metafields;
    for (const node of conn?.nodes || []) {
      if (node.key.startsWith(prefix)) entries.push(...(parseJson(node.value) || []));
    }
    if (!conn?.pageInfo?.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }

  const ids = [...new Set(entries.map((e) => e.customer_id))];
  const customers = {};
  for (let i = 0; i < ids.length; i += 100) {
    const data = await shopifyGraphql(
      `query LuckyWheelCustomers($ids: [ID!]!) {
        nodes(ids: $ids) { ... on Customer { legacyResourceId displayName email phone } }
      }`,
      { ids: ids.slice(i, i + 100).map((id) => 'gid://shopify/Customer/' + id) }
    );
    for (const c of data.data?.nodes || []) {
      if (c && c.legacyResourceId) customers[c.legacyResourceId] = { name: c.displayName, email: c.email, phone: c.phone };
    }
  }

  entries.sort((a, b) => (a.at < b.at ? 1 : -1));
  return {
    success: true,
    shop: SHOPIFY_SHOP,
    entries: entries.map((e) => ({ ...e, customer: customers[e.customer_id] || null }))
  };
}

async function adminMark(adminKey, id, status) {
  verifyAdmin(adminKey);
  if (!/^\d{8}-\d+$/.test(String(id || ''))) throw httpError(400, 'Invalid prize id');
  if (status !== 'sent' && status !== 'pending') throw httpError(400, 'Invalid status');
  const config = await loadConfig();
  const customerId = String(id).split('-')[1];

  let updated = null;
  await mutateShopMetafield(ledgerKey(config, id), (list) => {
    const next = setLedgerStatus(list, id, status);
    updated = next.find((e) => e.id === id);
    return next;
  });
  await writeCustomerHistory(customerId, (h) => setPrizeStatus(h, id, status))
    .catch((error) => console.error('[lucky-wheel] customer status update failed', error));
  return { success: true, entry: updated };
}

async function mutateShopMetafield(key, mutator) {
  for (let attempt = 1; attempt <= MAX_CAS_ATTEMPTS; attempt += 1) {
    const snap = await getShopMetafield(key);
    const next = mutator(parseJson(snap?.value));
    try {
      await setShopMetafield(key, JSON.stringify(next), snap?.compareDigest ?? null);
      return next;
    } catch (error) {
      if (!error.isCompareDigestConflict || attempt === MAX_CAS_ATTEMPTS) throw error;
      await wait(50 + Math.random() * 120 * attempt);
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Shopify Admin GraphQL                                               */
/* ------------------------------------------------------------------ */

async function getShopMetafield(key) {
  const data = await shopifyGraphql(
    `query LuckyWheelState($ns: String!, $key: String!) {
      shop { id metafield(namespace: $ns, key: $key) { value compareDigest } }
    }`,
    { ns: NAMESPACE, key }
  );
  const shop = data.data?.shop;
  shopIdCache = shop?.id || shopIdCache;
  return shop?.metafield || null;
}

let shopIdCache = null;

async function setShopMetafield(key, value, compareDigest) {
  if (!shopIdCache) await getShopMetafield(key);
  return metafieldsSet({ ownerId: shopIdCache, namespace: NAMESPACE, key, type: 'json', value, compareDigest });
}

async function getCustomerMetafield(customerId) {
  const data = await shopifyGraphql(
    `query LuckyWheelHistory($id: ID!, $ns: String!, $key: String!) {
      customer(id: $id) { id metafield(namespace: $ns, key: $key) { value compareDigest } }
    }`,
    { id: `gid://shopify/Customer/${customerId}`, ns: NAMESPACE, key: CUSTOMER_KEY }
  );
  if (!data.data?.customer) throw httpError(404, 'Customer not found', 'unauthorized');
  return data.data.customer.metafield || null;
}

function setCustomerMetafield(customerId, value, compareDigest) {
  return metafieldsSet({
    ownerId: `gid://shopify/Customer/${customerId}`,
    namespace: NAMESPACE,
    key: CUSTOMER_KEY,
    type: 'json',
    value,
    compareDigest
  });
}

async function metafieldsSet(input) {
  const data = await shopifyGraphql(
    `mutation LuckyWheelSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id compareDigest }
        userErrors { field message code }
      }
    }`,
    { metafields: [input] }
  );
  const errors = data.data?.metafieldsSet?.userErrors || [];
  if (!errors.length) return data.data.metafieldsSet.metafields?.[0] || null;

  const error = httpError(500, `metafieldsSet failed: ${errors.map((e) => e.message).join('; ')}`);
  error.isCompareDigestConflict = errors.some((e) => (
    e.code === 'STALE_OBJECT' || e.code === 'COMPARE_DIGEST_MISMATCH' || /compare.?digest|digest.*match|stale/i.test(e.message || '')
  ));
  throw error;
}

async function shopifyGraphql(query, variables = {}) {
  if (!SHOPIFY_SHOP || !SHOPIFY_ACCESS_TOKEN) {
    throw httpError(500, 'Missing SHOPIFY_SHOP or SHOPIFY_ACCESS_TOKEN');
  }
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetch(`https://${SHOPIFY_SHOP}/admin/api/${API_VERSION}/graphql.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN },
      body: JSON.stringify({ query, variables })
    });
    const data = await response.json().catch(() => ({}));
    const throttled = response.status === 429 ||
      (Array.isArray(data.errors) && data.errors.some((e) => e.extensions?.code === 'THROTTLED'));
    if (throttled && attempt < 3) {
      await wait(500 * (attempt + 1));
      continue;
    }
    if (response.ok && !data.errors) return data;
    throw httpError(response.ok ? 502 : response.status, `Shopify GraphQL error: ${JSON.stringify(data.errors || response.statusText)}`);
  }
  throw httpError(503, 'Shopify API is busy');
}

/* ------------------------------------------------------------------ */
/* Utils                                                               */
/* ------------------------------------------------------------------ */

function parseJson(value) {
  if (!value) return null;
  try { return JSON.parse(value); } catch (e) { return null; }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeShopDomain(value) {
  return String(value || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
}

module.exports = {
  setCorsHeaders,
  handleError,
  httpError,
  getStatus,
  spin,
  adminOverview,
  adminList,
  adminMark,
  __test: {
    ledgerKey,
    addLedgerEntry,
    setLedgerStatus,
    setPrizeStatus,
    signToken,
    verifyToken,
    buildConfig,
    campaignStatus,
    decideSpin,
    applyToCustomerHistory,
    generateWinTimes,
    localDayKey,
    localDayStart,
    parseLocalDateTime,
    emptyState
  }
};
