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
 *   stock of 2 are naturally rarer).
 * - Chapter card ("Thẻ chương 10 năm"): its own N random drop times per day
 *   (default 50), so cards are spread over the day.
 * - Per account, for the whole campaign: at most N rewards in total (default 2),
 *   of which at most 1 prize: 1 prize + 1 chapter card, or 2 chapter cards.
 *   Other spins are "Chúc bạn may mắn lần sau" (nothing kept).
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
const KEEP_SPIN_DAYS = 2; // today + yesterday (midnight edge)
// Shopify caps a json metafield at 131072 bytes; prune before getting close
const STATE_SOFT_LIMIT_BYTES = 120000;
// Spins wait in line on one metafield (compare-and-swap); give up after this and let the client retry
const SPIN_DEADLINE_MS = 7000;
const MAX_CUSTOMER_SPINS = 60;
const ORDER_TAG = 'vong-quay';

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
    const productHandle = productHandleFromSetting(s[`lucky_wheel_prize_${i}_product`]);
    const stock = Math.max(0, Math.floor(Number(s[`lucky_wheel_prize_${i}_stock`]) || 0));
    // Stock 0 = not on the wheel (the chapter card takes the first such slot)
    if ((name || productHandle) && stock > 0) prizes.push({ key: `p${i}`, name, stock, productHandle });
  }

  const startAt = parseLocalDateTime(s.lucky_wheel_start, false);
  const endAt = parseLocalDateTime(s.lucky_wheel_end, true);
  const winsPerDay = clampInt(s.lucky_wheel_wins_per_day, 0, 100, 5);
  const winChance = clampInt(s.lucky_wheel_win_chance, 1, 100, 40) / 100;
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
    winChance,
    winStartHour,
    winEndHour,
    prizes,
    consolation: {
      key: 'card',
      // Blank name + a product = use the product title (filled in resolveConfigProducts)
      name: String(s.lucky_wheel_card_name || '').trim() ||
        (productHandleFromSetting(s.lucky_wheel_card_product) ? '' : 'Thẻ chương 10 năm'),
      productHandle: productHandleFromSetting(s.lucky_wheel_card_product)
    },
    minOrder: Math.max(0, Number(s.lucky_wheel_min_order) || 0),
    cardsPerDay: clampInt(s.lucky_wheel_cards_per_day, 0, 1000, 50),
    // Rewards (prize + chapter cards) per account for the whole campaign; at most 1 prize. 0 = no limit
    rewardsPerAccount: clampInt(s.lucky_wheel_rewards_per_account, 0, 100, 2),
    prizeExpiry: parseLocalDateTime(s.lucky_wheel_prize_expiry, true),
    lose: {
      key: 'lose',
      name: String(s.lucky_wheel_lose_text || '').trim() || 'Chúc bạn may mắn lần sau'
    }
  };
}

/** Theme "product"/"collection" settings are stored as the handle (older exports: "shopify://products/<handle>"). */
function productHandleFromSetting(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const handle = text.replace(/^shopify:\/\/(products|collections)\//, '');
  return /^[a-z0-9][a-z0-9-_]*$/i.test(handle) ? handle.toLowerCase() : '';
}

/** Fills product id/title for every prize and name fallbacks. */
async function resolveConfigProducts(config) {
  const handles = [...new Set([...config.prizes.map((p) => p.productHandle), config.consolation.productHandle].filter(Boolean))];
  const fields = handles.map((h, i) => `p${i}: productByIdentifier(identifier: { handle: ${JSON.stringify(h)} }) { id title handle status }`);
  const data = fields.length
    ? await shopifyGraphql(`query LuckyWheelProducts { ${fields.join('\n')} }`)
    : { data: {} };
  const byHandle = {};
  handles.forEach((h, i) => { if (data.data?.[`p${i}`]) byHandle[h] = data.data[`p${i}`]; });

  const attach = (p) => {
    const product = p.productHandle ? byHandle[p.productHandle] : null;
    p.productId = product ? product.id : null;
    if (!p.name) p.name = product ? product.title : '';
  };
  config.prizes.forEach(attach);
  config.prizes = config.prizes.filter((p) => p.name);
  attach(config.consolation);
  if (!config.consolation.name) config.consolation.name = 'Thẻ chương 10 năm';
  return config;
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

  const filesSelection = `
    id
    files(first: 2, filenames: ["config/settings_data.json", "config/settings_schema.json"]) {
      nodes {
        filename
        body { ... on OnlineStoreThemeFileBodyText { content } }
      }
    }`;

  // LUCKY_WHEEL_THEME_ID lets staff test on an unpublished theme; default is the live theme.
  const overrideThemeId = String(process.env.LUCKY_WHEEL_THEME_ID || '').trim();
  let theme;
  if (overrideThemeId) {
    const gid = overrideThemeId.startsWith('gid://') ? overrideThemeId : `gid://shopify/OnlineStoreTheme/${overrideThemeId}`;
    const data = await shopifyGraphql(`query LuckyWheelThemeById($id: ID!) { theme(id: $id) { ${filesSelection} } }`, { id: gid });
    theme = data.data?.theme;
  } else {
    const data = await shopifyGraphql(`query LuckyWheelThemeSettings { themes(first: 1, roles: [MAIN]) { nodes { ${filesSelection} } } }`);
    theme = data.data?.themes?.nodes?.[0];
  }

  const files = new Map((theme?.files?.nodes || []).map((f) => [f.filename, f.body?.content]));
  if (!theme || !files.get('config/settings_data.json')) {
    throw httpError(503, 'Unable to read published theme settings');
  }

  const settings = mergePublishedThemeSettings(
    files.get('config/settings_data.json'),
    files.get('config/settings_schema.json'),
    'lucky_wheel_'
  );
  const config = await resolveConfigProducts(buildConfig(settings));
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
  return { version: 1, awarded: {}, days: {}, winners: [], cardCounts: {}, stats: { total: 0, byDay: {} } };
}

function normalizeState(raw) {
  const state = raw && typeof raw === 'object' ? raw : {};
  return {
    version: 1,
    awarded: state.awarded && typeof state.awarded === 'object' ? state.awarded : {},
    days: state.days && typeof state.days === 'object' ? state.days : {},
    winners: Array.isArray(state.winners) ? state.winners : [],
    // Left out when missing, so spin() can still fill it from the ledger once
    ...(state.cardCounts && typeof state.cardCounts === 'object' ? { cardCounts: state.cardCounts } : {}),
    stats: normalizeStats(state)
  };
}

/**
 * Campaign spin counters: total and per local day (a few bytes per day).
 * States written before the counters existed start from the days still kept.
 */
function normalizeStats(state) {
  if (state.stats && typeof state.stats === 'object' && state.stats.byDay) {
    return { total: Number(state.stats.total) || 0, byDay: state.stats.byDay };
  }
  const byDay = {};
  let total = 0;
  for (const [day, d] of Object.entries(state.days || {})) {
    const n = Object.keys((d && d.spins) || {}).length;
    if (n) { byDay[day] = n; total += n; }
  }
  return { total, byDay };
}

/**
 * Per-day spin records are stored compactly to stay far below the metafield size cap:
 *   day.spins[customerId] = 'l' (better luck) | 'c' (chapter card) | 'p<N>' (prize key)
 * (about 20 bytes per spin instead of ~200). Older states may still hold full objects.
 */
function encodeSpin(result) {
  if (result.type === 'lose') return 'l';
  if (result.type === 'card') return 'c';
  return result.key;
}

function spinType(code) {
  if (code && typeof code === 'object') return code.type;
  if (code === 'l') return 'lose';
  if (code === 'c') return 'card';
  return 'win';
}

/** Full result for a stored spin record (names come from config / the winners list). */
function expandSpin(code, customerId, dayKey, state, config) {
  if (!code) return null;
  if (typeof code === 'object') return code;
  const id = `${dayKey.replace(/-/g, '')}-${customerId}`;
  const at = localDayStart(dayKey);
  const type = spinType(code);
  if (type === 'win') {
    const w = state.winners.find((x) => x.id === id);
    if (w) return { id, type, key: w.key, name: w.name, at: w.at, day: dayKey, product: w.product || null, expires: w.expires };
    const def = config.prizes.find((p) => p.key === code) || {};
    return { id, type, key: code, name: def.name || '', at, day: dayKey };
  }
  if (type === 'card') {
    return { id, type, key: config.consolation.key, name: config.consolation.name, at, day: dayKey, product: config.consolation.productHandle || null, expires: prizeExpiresAt(config, at) };
  }
  return { id, type, key: config.lose.key, name: config.lose.name, at, day: dayKey };
}

/** Drops older days' spin maps when the state gets close to the size cap. */
function trimStateForSize(state, nowMs) {
  let json = JSON.stringify(state);
  if (Buffer.byteLength(json) <= STATE_SOFT_LIMIT_BYTES) return json;
  const today = localDayKey(nowMs);
  for (const [key, day] of Object.entries(state.days)) if (key !== today) day.spins = {};
  json = JSON.stringify(state);
  if (Buffer.byteLength(json) > STATE_SOFT_LIMIT_BYTES) {
    throw httpError(503, 'Vòng quay đang quá tải, vui lòng thử lại sau.', 'state_full');
  }
  return json;
}

/** Random drop times (epoch ms, sorted) inside the day's win window. */
function generateWinTimes(dayKey, config, rng = Math.random, count = config.winsPerDay) {
  const start = localDayStart(dayKey) + config.winStartHour * 3600000;
  const end = localDayStart(dayKey) + config.winEndHour * 3600000;
  const times = [];
  for (let i = 0; i < count; i += 1) {
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

function prizeExpiresAt(config, nowMs) {
  return config.prizeExpiry || nowMs + PRIZE_VALID_DAYS * 86400000;
}

/**
 * Mutates `state` and returns { result, alreadySpun }.
 * result: { id, type: 'win'|'card'|'lose', key, name, at, day, expires }
 */
function decideSpin(state, customerId, nowMs, config, rng = Math.random) {
  const dayKey = localDayKey(nowMs);

  if (!state.days[dayKey]) {
    state.days[dayKey] = { winTimes: generateWinTimes(dayKey, config, rng), wins: 0, spins: {} };
  }
  const day = state.days[dayKey];
  if (!Array.isArray(day.cardTimes)) {
    day.cardTimes = generateWinTimes(dayKey, config, rng, config.cardsPerDay || 0);
    day.cards = 0;
  }

  // Prune old per-day spin maps to keep the metafield small
  const keep = new Set();
  for (let i = 0; i < KEEP_SPIN_DAYS; i += 1) keep.add(localDayKey(nowMs - i * 86400000));
  for (const key of Object.keys(state.days)) if (!keep.has(key)) delete state.days[key];

  const existing = day.spins[customerId];
  if (existing) return { result: expandSpin(existing, customerId, dayKey, state, config), alreadySpun: true };

  const id = `${dayKey.replace(/-/g, '')}-${customerId}`;
  const expires = prizeExpiresAt(config, nowMs);
  const hasPrize = state.winners.some((w) => String(w.customer_id) === String(customerId));
  if (!state.cardCounts) state.cardCounts = {};
  const cardCount = Number(state.cardCounts[customerId]) || 0;
  const rewards = (hasPrize ? 1 : 0) + cardCount;
  const underCap = !config.rewardsPerAccount || rewards < config.rewardsPerAccount;
  const due = day.winTimes.filter((t) => t <= nowMs).length;
  const cardsDue = day.cardTimes.filter((t) => t <= nowMs).length;
  const stock = remainingStock(state, config);

  let result;
  // A due drop is only a chance to win (win_chance), so knowing the drop time does not guarantee a prize
  if (!hasPrize && underCap && day.wins < due && stock.length > 0 && rng() < (config.winChance ?? 1)) {
    const prize = pickWeighted(stock, rng);
    state.awarded[prize.key] = (Number(state.awarded[prize.key]) || 0) + 1;
    day.wins += 1;
    result = { id, type: 'win', key: prize.key, name: prize.name, at: nowMs, day: dayKey, product: prize.productHandle || null, expires };
    state.winners.push({ id, customer_id: customerId, key: prize.key, name: prize.name, at: nowMs, product: prize.productHandle || null, expires });
  } else if (underCap && (day.cards || 0) < cardsDue) {
    day.cards = (day.cards || 0) + 1;
    state.cardCounts[customerId] = cardCount + 1;
    result = { id, type: 'card', key: config.consolation.key, name: config.consolation.name, at: nowMs, day: dayKey, product: config.consolation.productHandle || null, expires };
  } else {
    result = { id, type: 'lose', key: config.lose.key, name: config.lose.name, at: nowMs, day: dayKey };
  }

  day.spins[customerId] = encodeSpin(result);
  if (!state.stats) state.stats = { total: 0, byDay: {} };
  state.stats.total += 1;
  state.stats.byDay[dayKey] = (Number(state.stats.byDay[dayKey]) || 0) + 1;
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
      expires_at: new Date(result.expires || result.at + PRIZE_VALID_DAYS * 86400000).toISOString(),
      status: 'pending',
      product: result.product || null
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
    .map((w) => ({ id: w.id, type: 'win', key: w.key, name: w.name, at: w.at, day: localDayKey(w.at), product: w.product || null, expires: w.expires }));
  for (const [dk, day] of Object.entries(state.days)) {
    const code = day.spins && day.spins[customerId];
    if (spinType(code) === 'card') recorded.push(expandSpin(code, customerId, dk, state, config));
  }
  const missing = recorded.filter((r) => !(history.prizes || []).some((p) => p.id === r.id));
  if (missing.length) {
    for (const r of missing) history = applyToCustomerHistory(history, r);
    await writeCustomerHistory(customerId, () => history).catch((e) => console.error('[lucky-wheel] repair failed', e));
  }

  const today = expandSpin(state.days[dayKey]?.spins?.[customerId], customerId, dayKey, state, config);
  return {
    success: true,
    campaign: publicCampaign(config, status),
    can_spin: status === 'active' && !today,
    today: today ? publicResult(today) : null,
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
  const deadline = Date.now() + SPIN_DEADLINE_MS;
  let ledgerCards = null;

  for (let attempt = 1; ; attempt += 1) {
    const snap = await getShopMetafield(key);
    const rawState = parseJson(snap?.value) || emptyState();
    if (!rawState.cardCounts) {
      // One-time upgrade: count the chapter cards already given from the prize ledger
      ledgerCards = ledgerCards || await countCardsFromLedger(config);
      rawState.cardCounts = { ...ledgerCards };
    }
    const state = normalizeState(rawState);
    outcome = decideSpin(state, customerId, now, config);
    if (outcome.alreadySpun) break;
    try {
      await setShopMetafield(key, trimStateForSize(state, now), snap?.compareDigest ?? null);
      break;
    } catch (error) {
      if (!error.isCompareDigestConflict) throw error;
      // Many spins at the same moment: wait a random bit and try again, until the deadline
      if (Date.now() + 400 > deadline) {
        throw httpError(503, 'Đang có nhiều người quay cùng lúc, vui lòng thử lại.', 'busy');
      }
      await wait(30 + Math.random() * 120 * Math.min(attempt, 6));
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
    outcome.result.type === 'lose'
      ? null
      : mutateShopMetafield(ledgerKey(config, outcome.result.day), (list) => addLedgerEntry(list, outcome.result, customerId))
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

/* ------------------------------------------------------------------ */
/* Gifts ship with the customer's next order                           */
/* ------------------------------------------------------------------ */

/**
 * Pure: attaches every pending, unexpired prize won before the order to that order.
 * Returns { history, attached } (attached = prizes linked now). Idempotent per order.
 */
function attachPrizesToOrder(history, order, minOrder = 0) {
  const h = history && typeof history === 'object' ? history : {};
  const prizes = Array.isArray(h.prizes) ? h.prizes : [];
  const createdMs = Date.parse(order.created_at) || Date.now();
  const attached = [];
  const already = prizes.filter((p) => p.order && String(p.order.id) === String(order.id));

  if (!order.cancelled && Number(order.total) >= minOrder) {
    for (const p of prizes) {
      if ((p.status || 'pending') !== 'pending' || p.order) continue;
      if (Date.parse(p.won_at) > createdMs) continue; // only prizes won before this order
      if (Date.parse(p.expires_at) <= createdMs) continue; // expired before the order
      p.status = 'attached';
      p.order = { id: String(order.id), name: order.name, at: new Date(createdMs).toISOString() };
      attached.push(p);
    }
  }
  return { history: { ...h, version: 1, spins: Array.isArray(h.spins) ? h.spins : [], prizes }, attached, already };
}

/** Order note text listing the gifts to pack. */
function giftNote(prizes) {
  return '🎁 Gửi kèm quà vòng quay may mắn: ' + prizes.map((p) => p.name).join(', ');
}

function verifyWebhookHmac(rawBody, hmacHeader, secret = process.env.SHOPIFY_WEBHOOK_SECRET || '') {
  if (!secret || !hmacHeader) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest();
  const given = Buffer.from(String(hmacHeader), 'base64');
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

/**
 * orders/create webhook. The payload is only used for the order id: the order and
 * its customer are re-read from the Admin API before anything is written.
 */
const WEBHOOK_MAX_ORDER_AGE_MS = 2 * 24 * 60 * 60 * 1000;

/** Order GID from a webhook payload, or null (only plain numeric ids are accepted). */
function webhookOrderGid(payload) {
  const gid = String(payload?.admin_graphql_api_id || '');
  if (/^gid:\/\/shopify\/Order\/\d{1,20}$/.test(gid)) return gid;
  const id = String(payload?.id ?? '');
  return /^\d{1,20}$/.test(id) ? `gid://shopify/Order/${id}` : null;
}

/**
 * orders/create webhook.
 * - With SHOPIFY_WEBHOOK_SECRET (the webhook app's client secret): the HMAC must match.
 * - Without it: the request is not trusted at all. Only the order id is taken, the
 *   order is re-read from the Admin API and must be recent; a forged call can only do
 *   what the real webhook would do. The response never reveals order details.
 */
async function handleOrderWebhook(bodies, headers) {
  const list = (Array.isArray(bodies) ? bodies : [bodies]).filter(Boolean);
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET || '';
  const shopHeader = String(headers['x-shopify-shop-domain'] || '').toLowerCase();
  const topic = String(headers['x-shopify-topic'] || '');
  const entry = { at: new Date().toISOString(), topic, signed: !!secret };

  if (topic !== 'orders/create' || !headers['x-shopify-webhook-id'] ||
      (SHOPIFY_SHOP && shopHeader !== SHOPIFY_SHOP.toLowerCase())) {
    throw httpError(401, 'Not a Shopify order webhook', 'unauthorized');
  }

  let rawBody = list[0];
  if (secret) {
    rawBody = list.find((b) => verifyWebhookHmac(b, headers['x-shopify-hmac-sha256'], secret));
    if (!rawBody) {
      await logWebhook({ ...entry, ok: false, error: 'bad signature' });
      throw httpError(401, 'Invalid webhook signature', 'unauthorized');
    }
  }

  const orderGid = webhookOrderGid(parseJson(rawBody ? rawBody.toString('utf8') : '') || {});
  if (!orderGid) return { success: true };
  try {
    const order = await fetchOrder(orderGid);
    if (!order || Date.now() - Date.parse(order.created_at) > WEBHOOK_MAX_ORDER_AGE_MS) return { success: true };
    const result = await attachForOrder(orderGid, order);
    // Logged only when gifts were linked (busy sale days would otherwise fight over the log)
    if (result.attached) await logWebhook({ ...entry, ok: true, order: result.order || order.name, attached: result.attached });
  } catch (error) {
    await logWebhook({ ...entry, ok: false, error: String(error.message || error).slice(0, 200) });
    throw error;
  }
  return { success: true };
}

/** Last webhook deliveries, shown on the admin page (best effort). */
async function logWebhook(entry) {
  await mutateShopMetafield('webhook_log', (list) => [entry, ...(Array.isArray(list) ? list : [])].slice(0, 15))
    .catch((error) => console.error('[lucky-wheel] webhook log failed', error));
}

async function fetchOrder(orderGid) {
  const data = await shopifyGraphql(
    `query LuckyWheelOrder($id: ID!) {
      order(id: $id) {
        id legacyResourceId name createdAt cancelledAt note tags
        currentSubtotalPriceSet { shopMoney { amount } }
        customer { legacyResourceId }
      }
    }`,
    { id: orderGid }
  );
  const o = data.data?.order;
  if (!o) return null;
  return {
    gid: o.id,
    id: o.legacyResourceId,
    name: o.name,
    created_at: o.createdAt,
    cancelled: !!o.cancelledAt,
    note: o.note || '',
    tags: o.tags || [],
    total: Number(o.currentSubtotalPriceSet?.shopMoney?.amount) || 0,
    customerId: o.customer?.legacyResourceId ? String(o.customer.legacyResourceId) : null
  };
}

/** Links the customer's waiting prizes to the order, then writes the note/tag on the order. */
async function attachForOrder(orderGid, preloaded) {
  const order = preloaded || await fetchOrder(orderGid);
  if (!order || !order.customerId) return { success: true, skipped: 'no customer' };
  const config = await loadConfig();

  let result = { attached: [], already: [] };
  const snap = await getCustomerMetafield(order.customerId).catch(() => null);
  const current = parseJson(snap?.value);
  if (!current || !(current.prizes || []).length) return { success: true, skipped: 'no prizes' };

  await writeCustomerHistory(order.customerId, (h) => {
    result = attachPrizesToOrder(h, order, config.minOrder);
    return result.history;
  });

  const onOrder = [...result.already, ...result.attached];
  if (!onOrder.length) return { success: true, order: order.name, attached: 0 };

  // Ledger (admin page) gets the order too
  for (const p of result.attached) {
    await mutateShopMetafield(ledgerKey(config, p.id), (list) => {
      const entries = Array.isArray(list) ? list : [];
      const entry = entries.find((e) => e.id === p.id);
      if (entry && !entry.order) {
        entry.status = 'attached';
        entry.order = p.order;
      }
      return entries;
    }).catch((error) => console.error('[lucky-wheel] ledger attach failed', error));
  }

  // Note + tag on the order so the warehouse packs the gifts (skipped if already written)
  const note = giftNote(onOrder);
  if (!order.note.includes(note)) {
    await shopifyGraphql(
      `mutation LuckyWheelOrderNote($input: OrderInput!) { orderUpdate(input: $input) { userErrors { message } } }`,
      { input: { id: order.gid, note: order.note ? order.note + '\n' + note : note } }
    ).catch((error) => console.error('[lucky-wheel] order note failed', error));
  }
  if (!order.tags.includes(ORDER_TAG)) {
    await shopifyGraphql(
      `mutation LuckyWheelOrderTag($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { userErrors { message } } }`,
      { id: order.gid, tags: [ORDER_TAG] }
    ).catch((error) => console.error('[lucky-wheel] order tag failed', error));
  }
  return { success: true, order: order.name, attached: result.attached.length };
}

/** Legacy gift codes (from the add-to-cart version) are removed with their prize. */
async function deleteDiscount(id) {
  if (!id) return;
  await shopifyGraphql(
    `mutation LuckyWheelDropCode($id: ID!) { discountCodeDelete(id: $id) { deletedCodeDiscountId userErrors { message } } }`,
    { id }
  );
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
  return {
    id: result.id,
    type: result.type,
    key: result.key,
    name: result.name,
    at: new Date(result.at).toISOString(),
    expires_at: result.type === 'lose' ? null : new Date(result.expires || result.at + PRIZE_VALID_DAYS * 86400000).toISOString()
  };
}

function publicPrize(p) {
  return {
    id: p.id,
    key: p.key,
    name: p.name,
    won_at: p.won_at,
    expires_at: p.expires_at,
    status: p.status || 'pending',
    product: p.product || null,
    order: p.order ? { name: p.order.name } : null
  };
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
    expires_at: new Date(result.expires || result.at + PRIZE_VALID_DAYS * 86400000).toISOString(),
    status: 'pending',
    sent_at: null
  });
  return entries;
}

function setLedgerStatus(list, id, status, nowMs = Date.now()) {
  const entries = Array.isArray(list) ? list : [];
  const entry = entries.find((e) => e.id === id);
  if (!entry) throw httpError(404, 'Prize not found');
  applyStatus(entry, status, nowMs);
  return entries;
}

function setPrizeStatus(history, id, status) {
  const h = history && typeof history === 'object' ? history : {};
  const prizes = Array.isArray(h.prizes) ? h.prizes : [];
  const prize = prizes.find((p) => p.id === id);
  if (prize) applyStatus(prize, status);
  return { ...h, version: 1, spins: Array.isArray(h.spins) ? h.spins : [], prizes };
}

/**
 * sent     = packed with its order
 * attached = waiting in an order (un-marking "sent" goes back here when there is an order)
 * pending  = waiting for the next order; also used to detach a prize from a cancelled order
 */
function applyStatus(item, status, nowMs = Date.now()) {
  if (status === 'pending') delete item.order;
  item.status = status === 'attached' && !item.order ? 'pending' : status;
  item.sent_at = status === 'sent' ? new Date(nowMs).toISOString() : null;
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
  const day = state.days[localDayKey(now)] || { winTimes: [], wins: 0, spins: {}, cards: 0 };
  return {
    success: true,
    campaign: { ...publicCampaign(config, campaignStatus(config, now)), id: config.campaignId, wins_per_day: config.winsPerDay, win_chance: config.winChance },
    today: {
      day: localDayKey(now),
      spins: Object.keys(day.spins || {}).length,
      spins_total: state.stats.total,
      spins_by_day: state.stats.byDay,
      wins: day.wins || 0,
      cards: day.cards || 0,
      cards_per_day: config.cardsPerDay,
      rewards_per_account: config.rewardsPerAccount,
      win_times: (day.winTimes || []).map((t) => new Date(t).toISOString())
    },
    webhook_log: parseJson((await getShopMetafield('webhook_log'))?.value) || [],
    prizes: config.prizes.map((p) => {
      const awarded = Number(state.awarded[p.key]) || 0;
      return { key: p.key, name: p.name, stock: p.stock, awarded, left: Math.max(0, p.stock - awarded) };
    }),
    consolation: config.consolation
  };
}

/** Chapter cards per customer from this campaign's prize ledger. */
async function countCardsFromLedger(config) {
  const prefix = 'ledger_' + config.campaignId.slice(0, 40) + '_';
  const counts = {};
  let after = null;
  for (let page = 0; page < 20; page += 1) {
    const data = await shopifyGraphql(
      `query LuckyWheelLedgerCards($ns: String!, $after: String) {
        shop { metafields(namespace: $ns, first: 100, after: $after) {
          nodes { key value }
          pageInfo { hasNextPage endCursor }
        } }
      }`,
      { ns: NAMESPACE, after }
    );
    const conn = data.data?.shop?.metafields;
    for (const node of conn?.nodes || []) {
      if (!node.key.startsWith(prefix)) continue;
      for (const e of parseJson(node.value) || []) {
        if (e.type === 'card') counts[e.customer_id] = (counts[e.customer_id] || 0) + 1;
      }
    }
    if (!conn?.pageInfo?.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  return counts;
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
  if (!['sent', 'attached', 'pending'].includes(status)) throw httpError(400, 'Invalid status');
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

/**
 * Safety net for missed webhooks: finds the first order placed after each waiting
 * prize and attaches it (same rules as the webhook).
 */
async function adminSync(adminKey) {
  verifyAdmin(adminKey);
  configCache = null;
  const config = await loadConfig();
  const { entries } = await adminList(adminKey);
  const now = Date.now();
  const waiting = {};
  for (const e of entries) {
    if ((e.status || 'pending') !== 'pending' || e.order || Date.parse(e.expires_at) <= now) continue;
    const since = waiting[e.customer_id];
    if (!since || e.at < since) waiting[e.customer_id] = e.at;
  }

  let linked = 0, orders = 0;
  for (const [customerId, since] of Object.entries(waiting).slice(0, 100)) {
    const data = await shopifyGraphql(
      `query LuckyWheelCustomerOrders($q: String!) {
        orders(first: 5, sortKey: CREATED_AT, query: $q) {
          nodes { id legacyResourceId name createdAt cancelledAt note tags
            currentSubtotalPriceSet { shopMoney { amount } } customer { legacyResourceId } }
        }
      }`,
      { q: `customer_id:${customerId} created_at:>=${since}` }
    );
    const order = (data.data?.orders?.nodes || [])
      .map((o) => ({
        gid: o.id, id: o.legacyResourceId, name: o.name, created_at: o.createdAt, cancelled: !!o.cancelledAt,
        note: o.note || '', tags: o.tags || [], total: Number(o.currentSubtotalPriceSet?.shopMoney?.amount) || 0,
        customerId: String(o.customer?.legacyResourceId || customerId)
      }))
      .find((o) => !o.cancelled && o.total >= config.minOrder);
    if (!order) continue;
    const r = await attachForOrder(order.gid, order);
    if (r.attached) { linked += r.attached; orders += 1; }
  }
  return { success: true, customers_checked: Math.min(100, Object.keys(waiting).length), orders, prizes_linked: linked };
}

/** Removes one spin everywhere; a deleted prize goes back to stock. Pure on state/history/list. */
function removeFromState(state, id, customerId) {
  const removed = { win: null };
  for (const [dk, day] of Object.entries(state.days)) {
    const code = day.spins && day.spins[customerId];
    const codeId = code && typeof code === 'object' ? code.id : `${dk.replace(/-/g, '')}-${customerId}`;
    if (code && codeId === id) {
      const type = spinType(code);
      delete day.spins[customerId];
      if (type === 'win' && day.wins > 0) day.wins -= 1;
      if (type === 'card' && day.cards > 0) day.cards -= 1;
      if (type === 'card' && state.cardCounts && state.cardCounts[customerId] > 0) {
        state.cardCounts[customerId] -= 1;
        if (!state.cardCounts[customerId]) delete state.cardCounts[customerId];
      }
    }
  }
  const idx = state.winners.findIndex((w) => w.id === id);
  if (idx !== -1) {
    removed.win = state.winners[idx];
    state.winners.splice(idx, 1);
    const k = removed.win.key;
    state.awarded[k] = Math.max(0, (Number(state.awarded[k]) || 0) - 1);
  }
  return removed;
}

function removeFromHistory(history, id) {
  const h = history && typeof history === 'object' ? history : {};
  return {
    ...h,
    version: 1,
    spins: (Array.isArray(h.spins) ? h.spins : []).filter((x) => x.id !== id),
    prizes: (Array.isArray(h.prizes) ? h.prizes : []).filter((x) => x.id !== id)
  };
}

async function adminDelete(adminKey, id) {
  verifyAdmin(adminKey);
  if (!/^\d{8}-\d+$/.test(String(id || ''))) throw httpError(400, 'Invalid prize id');
  configCache = null;
  const config = await loadConfig();
  const customerId = String(id).split('-')[1];

  // Remove the customer's gift code too, so a deleted prize cannot be redeemed
  const histPrize = (parseJson((await getCustomerMetafield(customerId).catch(() => null))?.value)?.prizes || [])
    .find((p) => p.id === id);
  let discountId = histPrize?.discount_id || null;

  await mutateShopMetafield(ledgerKey(config, id), (list) => {
    const entries = Array.isArray(list) ? list : [];
    discountId = discountId || entries.find((e) => e.id === id)?.discount_id || null;
    return entries.filter((e) => e.id !== id);
  });
  if (discountId) await deleteDiscount(discountId).catch((error) => console.error('[lucky-wheel] code delete failed', error));
  await mutateShopMetafield(stateKey(config), (raw) => {
    const state = normalizeState(raw);
    removeFromState(state, id, customerId);
    return state;
  });
  await writeCustomerHistory(customerId, (h) => removeFromHistory(h, id))
    .catch((error) => console.error('[lucky-wheel] customer history delete failed', error));
  return { success: true, deleted: id };
}

async function adminReset(adminKey, confirm) {
  verifyAdmin(adminKey);
  if (confirm !== 'XOA') throw httpError(400, 'Gõ XOA để xác nhận');
  configCache = null;
  const config = await loadConfig();
  const prefix = 'ledger_' + config.campaignId.slice(0, 40) + '_';

  // Collect every key of this campaign and every customer that spun
  const keys = [stateKey(config)];
  const customers = new Set();
  const discountIds = new Set();
  let after = null;
  for (let page = 0; page < 20; page += 1) {
    const data = await shopifyGraphql(
      `query LuckyWheelKeys($ns: String!, $after: String) {
        shop { id metafields(namespace: $ns, first: 100, after: $after) {
          nodes { key value }
          pageInfo { hasNextPage endCursor }
        } }
      }`,
      { ns: NAMESPACE, after }
    );
    shopIdCache = data.data?.shop?.id || shopIdCache;
    const conn = data.data?.shop?.metafields;
    for (const node of conn?.nodes || []) {
      if (node.key.startsWith(prefix)) {
        keys.push(node.key);
        for (const e of parseJson(node.value) || []) {
          customers.add(String(e.customer_id));
          if (e.discount_id) discountIds.add(e.discount_id);
        }
      } else if (node.key === stateKey(config)) {
        const st = normalizeState(parseJson(node.value));
        for (const day of Object.values(st.days)) for (const c of Object.keys(day.spins || {})) customers.add(String(c));
        for (const w of st.winners) customers.add(String(w.customer_id));
      }
    }
    if (!conn?.pageInfo?.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  if (!shopIdCache) await getShopMetafield(stateKey(config));

  const identifiers = [...new Set(keys)].map((key) => ({ ownerId: shopIdCache, namespace: NAMESPACE, key }))
    .concat([...customers].map((c) => ({ ownerId: 'gid://shopify/Customer/' + c, namespace: NAMESPACE, key: CUSTOMER_KEY })));

  let deleted = 0;
  for (let i = 0; i < identifiers.length; i += 25) {
    const data = await shopifyGraphql(
      `mutation LuckyWheelReset($metafields: [MetafieldIdentifierInput!]!) {
        metafieldsDelete(metafields: $metafields) {
          deletedMetafields { key }
          userErrors { field message }
        }
      }`,
      { metafields: identifiers.slice(i, i + 25) }
    );
    const result = data.data?.metafieldsDelete;
    if (result?.userErrors?.length) console.error('[lucky-wheel] reset userErrors', result.userErrors);
    deleted += (result?.deletedMetafields || []).filter(Boolean).length;
  }
  // Gift codes of this campaign stop working too (orders that already used one keep their discount)
  let deletedCodes = 0;
  for (const discountId of discountIds) {
    try { await deleteDiscount(discountId); deletedCodes += 1; } catch (error) { console.error('[lucky-wheel] reset code delete failed', error); }
  }
  return { success: true, campaign_id: config.campaignId, deleted_metafields: deleted, deleted_codes: deletedCodes, customers: customers.size };
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
  adminDelete,
  adminReset,
  adminSync,
  handleOrderWebhook,
  __test: {
    removeFromState,
    removeFromHistory,
    ledgerKey,
    addLedgerEntry,
    setLedgerStatus,
    setPrizeStatus,
    signToken,
    verifyToken,
    productHandleFromSetting,
    resolveConfigProducts,
    attachPrizesToOrder,
    giftNote,
    verifyWebhookHmac,
    encodeSpin,
    expandSpin,
    trimStateForSize,
    webhookOrderGid,
    applyStatus,
    buildConfig,
    campaignStatus,
    decideSpin,
    applyToCustomerHistory,
    generateWinTimes,
    localDayKey,
    localDayStart,
    parseLocalDateTime,
    emptyState,
    normalizeState
  }
};
