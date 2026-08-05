const SHOPIFY_SHOP = process.env.SHOPIFY_SHOP;
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const API_VERSION = process.env.SHOPIFY_API_VERSION || '2026-07';
const HISTORY_DELETE_PASSWORD = process.env.CARD_FLIP_HISTORY_DELETE_PASSWORD || '';

const DEFAULT_ORDER_START_DATE = process.env.CARD_FLIP_ORDER_START_DATE || '2026-08-05T17:00:00.000Z';
const DEFAULT_DAILY_ORDER_AMOUNT = toNonNegativeNumber(
  process.env.CARD_FLIP_DAILY_ORDER_AMOUNT || process.env.CARD_FLIP_FIRST_TURN_AMOUNT,
  500000
);
const DEFAULT_CAMPAIGN_END_DATE = process.env.CARD_FLIP_CAMPAIGN_END_DATE || '';
const DEFAULT_TIME_ZONE = normalizeTimeZone(process.env.CARD_FLIP_TIME_ZONE, 'Asia/Ho_Chi_Minh');
const DEFAULT_HISTORY_NAMESPACE = process.env.CARD_FLIP_HISTORY_NAMESPACE || 'card_flip';
const DEFAULT_HISTORY_KEY = process.env.CARD_FLIP_HISTORY_KEY || 'history';
const DEFAULT_GLOBAL_HISTORY_KEY = process.env.CARD_FLIP_GLOBAL_HISTORY_KEY || 'global_history';
const DEFAULT_CUSTOMER_INDEX_KEY = process.env.CARD_FLIP_CUSTOMER_INDEX_KEY || 'customer_index';
const DEFAULT_INVENTORY_KEY = process.env.CARD_FLIP_INVENTORY_KEY || 'inventory';
const MAX_HISTORY_ENTRIES = toNonNegativeInt(process.env.CARD_FLIP_MAX_HISTORY_ENTRIES, 200);
const MAX_GLOBAL_HISTORY_ENTRIES = toNonNegativeInt(process.env.CARD_FLIP_MAX_GLOBAL_HISTORY_ENTRIES, 5000);
const MAX_CUSTOMER_INDEX_ENTRIES = toNonNegativeInt(process.env.CARD_FLIP_MAX_CUSTOMER_INDEX_ENTRIES, 10000);
const DEFAULT_HISTORY_LIST_LIMIT = toNonNegativeInt(process.env.CARD_FLIP_HISTORY_LIST_LIMIT, 0);
const DEFAULT_HISTORY_CUSTOMER_SCAN_LIMIT = toNonNegativeInt(process.env.CARD_FLIP_HISTORY_CUSTOMER_SCAN_LIMIT, 1000);
const ORDER_ELIGIBILITY_CACHE_TTL_MS = toNonNegativeInt(process.env.CARD_FLIP_ORDER_CACHE_TTL_MS, 30000);
const ORDER_ELIGIBILITY_STALE_TTL_MS = toNonNegativeInt(process.env.CARD_FLIP_ORDER_STALE_TTL_MS, 300000);
const ORDER_REFERENCE_CACHE_TTL_MS = toNonNegativeInt(process.env.CARD_FLIP_ORDER_REFERENCE_CACHE_TTL_MS, 300000);
const ORDER_REFERENCE_STALE_TTL_MS = toNonNegativeInt(process.env.CARD_FLIP_ORDER_REFERENCE_STALE_TTL_MS, 900000);
const SHOPIFY_MAX_RETRIES = clampInt(process.env.CARD_FLIP_SHOPIFY_MAX_RETRIES, 2, 0, 6);
const SHOPIFY_RETRY_BASE_MS = toNonNegativeInt(process.env.CARD_FLIP_SHOPIFY_RETRY_BASE_MS, 250);
const SHOPIFY_RETRY_MAX_DELAY_MS = clampInt(process.env.CARD_FLIP_SHOPIFY_RETRY_MAX_DELAY_MS, 3000, 250, 10000);
const MAX_RUNTIME_CACHE_ENTRIES = 5000;
const TEST_TURN_OVERRIDES = {
  'dungmaster7@gmail.com': 100
};
const INVENTORY_CARDS = {
  chapter_i: {
    label: 'CHAPTER I - ORIGIN',
    titlePattern: /^chapter\s+i\b/i
  },
  chapter_ii: {
    label: 'CHAPTER II - THE FORGE',
    titlePattern: /^chapter\s+ii\b/i
  },
  chapter_iii: {
    label: 'CHAPTER III - DNA',
    titlePattern: /^chapter\s+iii\b/i
  },
  chapter_iv: {
    label: 'CHAPTER IV - THE ICONS',
    titlePattern: /^chapter\s+iv\b/i
  },
  chapter_v: {
    label: 'CHAPTER V - BEYOND JEWELRY',
    titlePattern: /^chapter\s+v\b/i
  },
  chapter_vi: {
    label: 'CHAPTER VI - CROSSROADS',
    titlePattern: /^chapter\s+vi\b/i
  },
  chapter_vii: {
    label: 'CHAPTER VII - PEOPLE',
    titlePattern: /^chapter\s+vii\b/i
  },
  chapter_viii: {
    label: 'CHAPTER VIII - THE WEARERS',
    titlePattern: /^chapter\s+viii\b/i
  },
  chapter_ix: {
    label: 'CHAPTER IX - HEIRLOOM',
    titlePattern: /^chapter\s+ix\b/i
  },
  chapter_x: {
    label: 'CHAPTER X - FUTURE',
    titlePattern: /^chapter\s+x\b/i
  },
  chapter_xi: {
    label: 'CHAPTER XI – THE OPENING',
    titlePattern: /^chapter\s+xi\b/i
  },
  limited_card: {
    label: 'LIMITED CARD',
    titlePattern: /^limited\s+card\b/i
  }
};
const LEGACY_SPECIAL_CARD_KEYS = new Set(['chapter_xi', 'limited_card']);
const orderEligibilityCache = new Map();
const orderEligibilityInflight = new Map();
const orderReferenceCache = new Map();
const orderReferenceInflight = new Map();

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

  if (DEFAULT_CAMPAIGN_END_DATE && !normalizeCampaignEndDate(DEFAULT_CAMPAIGN_END_DATE)) {
    throw httpError(500, 'CARD_FLIP_CAMPAIGN_END_DATE must be YYYY-MM-DD or a valid ISO timestamp');
  }
}

function getConfig(options = {}) {
  const orderStartDate = normalizeDate(DEFAULT_ORDER_START_DATE, '2026-08-05T17:00:00.000Z');
  const dailyOrderAmount = DEFAULT_DAILY_ORDER_AMOUNT;
  const campaignEndDate = normalizeCampaignEndDate(DEFAULT_CAMPAIGN_END_DATE);

  return {
    orderStartDate,
    dailyOrderAmount,
    campaignEndDate,
    timeZone: DEFAULT_TIME_ZONE,
    historyNamespace: DEFAULT_HISTORY_NAMESPACE,
    historyKey: DEFAULT_HISTORY_KEY,
    globalHistoryKey: DEFAULT_GLOBAL_HISTORY_KEY,
    customerIndexKey: DEFAULT_CUSTOMER_INDEX_KEY,
    inventoryKey: DEFAULT_INVENTORY_KEY,
    maxHistoryEntries: MAX_HISTORY_ENTRIES
  };
}

async function getGameState(customerId, campaignId, options = {}) {
  assertServerConfig();

  const numericId = normalizeCustomerId(customerId);
  const normalizedCampaignId = normalizeCampaignId(campaignId);
  const config = getConfig(options);

  const [orderEligibility, historyMetafield] = await Promise.all([
    getDailyOrderEligibility(numericId, config),
    getCustomerMetafieldSnapshot(numericId, config.historyNamespace, config.historyKey)
  ]);
  const customer = orderEligibility.customer;

  const allowedTurns = getAllowedTurns(customer, orderEligibility.qualifyingDays.length);
  const campaignActive = isCampaignActive(config);

  const history = parseHistory(metafieldValue(historyMetafield));
  const campaignStartTime = new Date(config.orderStartDate).getTime();
  const campaignHistory = history.filter((entry) => {
    if (!entry || entry.campaign_id !== normalizedCampaignId) return false;
    const playedAt = new Date(entry.played_at || 0).getTime();
    return Number.isFinite(playedAt) && playedAt >= campaignStartTime;
  });
  const usedTurns = campaignHistory.length;
  const remainingTurns = campaignActive ? Math.max(0, allowedTurns - usedTurns) : 0;

  return {
    numericId,
    campaignId: normalizedCampaignId,
    customer,
    allowedTurns,
    usedTurns,
    remainingTurns,
    accumulatedOrderAmount: orderEligibility.accumulatedOrderAmount,
    qualifyingOrderDays: orderEligibility.qualifyingDays,
    campaignActive,
    history,
    campaignHistory,
    historyMetafield,
    config
  };
}

async function getDailyOrderEligibility(customerId, config) {
  const cacheKey = `${customerId}:${getOrderConfigCacheKey(config)}`;

  return getCachedResource({
    cache: orderEligibilityCache,
    inflight: orderEligibilityInflight,
    key: cacheKey,
    ttlMs: ORDER_ELIGIBILITY_CACHE_TTL_MS,
    staleTtlMs: ORDER_ELIGIBILITY_STALE_TTL_MS,
    loader: () => fetchDailyOrderEligibility(customerId, config)
  });
}

async function fetchDailyOrderEligibility(customerId, config) {
  let after = null;
  let total = 0;
  const qualifyingDays = new Set();
  let customer = null;

  do {
    const result = await shopifyGraphql(
      `query CardFlipOrders($id: ID!, $first: Int!, $after: String, $query: String!) {
        customer(id: $id) {
          legacyResourceId
          email
          orders(first: $first, after: $after, query: $query, sortKey: CREATED_AT) {
            nodes {
              createdAt
              cancelledAt
              displayFinancialStatus
              currentTotalPriceSet { shopMoney { amount } }
            }
            pageInfo { hasNextPage endCursor }
          }
        }
      }`,
      {
        id: `gid://shopify/Customer/${customerId}`,
        first: 100,
        after,
        query: `created_at:>='${config.orderStartDate}'`
      }
    );

    const customerData = result.data?.customer;
    if (!customerData) {
      throw httpError(404, 'Customer not found');
    }
    if (!customer) {
      customer = {
        id: cleanString(customerData.legacyResourceId || customerId, 80),
        email: cleanString(customerData.email, 180)
      };
    }

    const orders = customerData.orders;
    if (!orders) break;

    const pageEligibility = summarizeOrderEligibility(orders.nodes || [], config);
    total += pageEligibility.accumulatedOrderAmount;
    for (const day of pageEligibility.qualifyingDays) {
      qualifyingDays.add(day);
    }
    after = orders.pageInfo?.hasNextPage ? orders.pageInfo.endCursor : null;
  } while (after);

  return {
    customer,
    accumulatedOrderAmount: total,
    qualifyingDays: Array.from(qualifyingDays).sort()
  };
}

function isEligibleOrder(order) {
  if (!order || order.cancelledAt) return false;
  return ['PAID', 'PARTIALLY_REFUNDED'].includes(order.displayFinancialStatus);
}

function summarizeOrderEligibility(orders, config, now = new Date()) {
  let accumulatedOrderAmount = 0;
  const qualifyingDays = new Set();
  const qualifyingOrders = [];

  for (const order of orders || []) {
    if (!isEligibleOrder(order) || !isOrderWithinCampaign(order.createdAt, config, now)) continue;

    const amount = toNonNegativeNumber(order.currentTotalPriceSet?.shopMoney?.amount, 0);
    accumulatedOrderAmount += amount;
    if (amount < config.dailyOrderAmount) continue;

    const orderDay = formatDateInTimeZone(order.createdAt, config.timeZone);
    if (orderDay) qualifyingDays.add(orderDay);

    const orderName = cleanString(order.name, 120);
    if (orderName) {
      qualifyingOrders.push({
        name: orderName,
        created_at: cleanString(order.createdAt, 80)
      });
    }
  }

  return {
    accumulatedOrderAmount,
    qualifyingDays: Array.from(qualifyingDays).sort(),
    qualifyingOrders
  };
}

function isCampaignActive(config, now = new Date()) {
  const nowTime = new Date(now).getTime();
  const startTime = new Date(config.orderStartDate).getTime();
  if (!Number.isFinite(nowTime) || !Number.isFinite(startTime) || nowTime < startTime) return false;
  if (!config.campaignEndDate) return true;

  if (isDateOnly(config.campaignEndDate)) {
    return formatDateInTimeZone(now, config.timeZone) <= config.campaignEndDate;
  }

  return nowTime <= new Date(config.campaignEndDate).getTime();
}

function isOrderWithinCampaign(createdAt, config, now = new Date()) {
  const orderTime = new Date(createdAt).getTime();
  const startTime = new Date(config.orderStartDate).getTime();
  const nowTime = new Date(now).getTime();
  if (!Number.isFinite(orderTime) || orderTime < startTime || orderTime > nowTime) return false;
  if (!config.campaignEndDate) return true;

  if (isDateOnly(config.campaignEndDate)) {
    return formatDateInTimeZone(createdAt, config.timeZone) <= config.campaignEndDate;
  }

  return orderTime <= new Date(config.campaignEndDate).getTime();
}

function formatDateInTimeZone(value, timeZone) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';

  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function getAllowedTurns(customer, qualifyingDayCount) {
  const customerEmail = cleanString(customer?.email, 180).toLowerCase();
  const testTurns = TEST_TURN_OVERRIDES[customerEmail];

  if (Number.isInteger(testTurns) && testTurns >= 0) {
    return testTurns;
  }

  return toNonNegativeInt(qualifyingDayCount, 0);
}

async function recordPlay(payload) {
  const maxAttempts = 4;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await recordPlayOnce(payload);
    } catch (error) {
      if (!error.isCompareDigestConflict) throw error;
      if (attempt === maxAttempts) {
        throw httpError(409, 'Có lượt chơi khác đang được xử lý, vui lòng thử lại.');
      }
    }
  }
}

async function recordPlayOnce(payload) {
  const state = await getGameState(payload.customer_id, payload.campaign_id, payload);

  if (!state.campaignActive) {
    throw httpError(403, 'Chương trình lật thẻ chưa bắt đầu hoặc đã kết thúc.');
  }

  if (state.remainingTurns <= 0) {
    throw httpError(403, 'Bạn đã hết lượt chơi.');
  }

  const requestEmail = cleanString(payload.customer_email, 180);
  const shopifyEmail = cleanString(state.customer.email, 180);

  if (requestEmail && shopifyEmail && requestEmail.toLowerCase() !== shopifyEmail.toLowerCase()) {
    throw httpError(403, 'Customer email does not match customer_id.');
  }

  const selectedCard = normalizeCard(payload);
  const deckCards = normalizeDeckCards(payload.deck_cards);
  const resolvedCard = await resolveAvailableCard(state, selectedCard, deckCards);
  const playedAt = new Date().toISOString();
  const entry = {
    id: createEntryId(),
    campaign_id: state.campaignId,
    customer_id: state.numericId,
    customer_email: shopifyEmail || requestEmail,
    card_id: resolvedCard.id,
    card_title: resolvedCard.title,
    card_code: resolvedCard.code,
    card_image: resolvedCard.image,
    card_position: toNonNegativeInt(payload.card_position, 0),
    deck_size: toNonNegativeInt(payload.deck_size, 0),
    result_title: resolvedCard.title,
    result_code: resolvedCard.code,
    result_image: resolvedCard.image,
    inventory_card_key: resolvedCard.inventoryTracked ? resolvedCard.inventoryKey : '',
    special_card_key: resolvedCard.inventoryTracked && LEGACY_SPECIAL_CARD_KEYS.has(resolvedCard.inventoryKey)
      ? resolvedCard.inventoryKey
      : '',
    played_at: playedAt
  };

  const nextHistory = [entry, ...state.history].slice(0, state.config.maxHistoryEntries);

  try {
    await setCustomerMetafieldAtomic(
      state.numericId,
      state.config.historyNamespace,
      state.config.historyKey,
      JSON.stringify(nextHistory),
      state.historyMetafield?.compareDigest ?? null
    );
  } catch (error) {
    if (resolvedCard.inventoryTracked && resolvedCard.inventoryKey) {
      await releaseInventoryCard(state.campaignId, resolvedCard.inventoryKey, state.config).catch(() => {});
    }
    throw error;
  }

  try {
    await addGlobalHistory(state.config, entry);
  } catch (error) {
    console.warn('Unable to write global card flip history:', error.message);
  }

  try {
    await addCustomerIndex(state.config, {
      customer_id: state.numericId,
      customer_email: entry.customer_email,
      last_played_at: playedAt
    });
  } catch (error) {
    console.warn('Unable to write card flip customer index:', error.message);
  }

  const usedTurns = state.usedTurns + 1;
  const remainingTurns = Math.max(0, state.allowedTurns - usedTurns);

  return {
    success: true,
    campaign_id: state.campaignId,
    customer_id: state.numericId,
    allowed_turns: state.allowedTurns,
    used_turns: usedTurns,
    remaining_turns: remainingTurns,
    is_campaign_active: state.campaignActive,
    campaign_end_date: state.config.campaignEndDate,
    entry
  };
}

async function resolveAvailableCard(state, selectedCard, deckCards) {
  const selectedIdentity = getCardIdentity(selectedCard);
  const alternatives = shuffleCards(deckCards.filter((card) => getCardIdentity(card) !== selectedIdentity));
  const candidates = uniqueCards([selectedCard, ...alternatives]);
  const result = await claimFirstAvailableCard(state.campaignId, candidates, state.config);

  if (!result.claimed || !result.card) {
    throw httpError(409, 'Tất cả thẻ trong chiến dịch đã hết số lượng.');
  }

  return {
    ...result.card,
    inventoryKey: result.key || '',
    inventoryTracked: result.tracked === true
  };
}

async function getCardInventory(options = {}) {
  assertServerConfig();

  const config = getConfig(options);
  const campaignId = normalizeCampaignId(options.campaign_id || options.campaignId);
  const snapshot = await getShopMetafieldSnapshot(config.historyNamespace, config.inventoryKey);
  const inventory = parseInventory(metafieldValue(snapshot));

  return {
    success: true,
    campaign_id: campaignId,
    cards: serializeCampaignInventory(inventory[campaignId])
  };
}

async function updateCardInventory(payload = {}) {
  assertServerConfig();
  assertDeletePassword(payload.password);

  const config = getConfig(payload);
  const campaignId = normalizeCampaignId(payload.campaign_id || payload.campaignId);
  const capacities = payload.capacities || {};

  await mutateInventory(config, (inventory) => {
    const campaign = normalizeCampaignInventory(inventory[campaignId]);

    Object.keys(INVENTORY_CARDS).forEach((key) => {
      if (capacities[key] === undefined) return;
      campaign[key].capacity = clampInt(capacities[key], campaign[key].capacity, 0, 1000000);
    });

    inventory[campaignId] = campaign;
    return { inventory };
  });

  return getCardInventory({ campaign_id: campaignId });
}

async function claimFirstAvailableCard(campaignId, candidates, config) {
  const result = await mutateInventory(config, (inventory) => {
    const campaign = normalizeCampaignInventory(inventory[campaignId]);
    for (const candidate of candidates) {
      const key = getInventoryCardKey(candidate);
      if (!key) {
        return { inventory, changed: false, claimed: true, tracked: false, key: '', card: candidate };
      }

      const inventoryCard = campaign[key];
      if (!inventoryCard || inventoryCard.capacity === null) {
        return { inventory, changed: false, claimed: true, tracked: false, key, card: candidate };
      }

      if (inventoryCard.claimed >= inventoryCard.capacity) continue;

      inventoryCard.claimed += 1;
      inventory[campaignId] = campaign;
      return { inventory, claimed: true, tracked: true, key, card: candidate };
    }

    return { inventory, changed: false, claimed: false };
  });

  return result;
}

async function releaseInventoryCard(campaignId, inventoryKey, config, amount = 1) {
  await mutateInventory(config, (inventory) => {
    const campaign = normalizeCampaignInventory(inventory[campaignId]);
    const card = campaign[inventoryKey];
    if (!card) return { inventory, changed: false };

    card.claimed = Math.max(0, card.claimed - toNonNegativeInt(amount, 0));
    inventory[campaignId] = campaign;
    return { inventory };
  });
}

async function mutateInventory(config, mutator) {
  const maxAttempts = 5;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const snapshot = await getShopMetafieldSnapshot(config.historyNamespace, config.inventoryKey);
    const inventory = parseInventory(metafieldValue(snapshot));
    const result = mutator(inventory) || { inventory };

    if (result.changed === false) return result;

    try {
      await setShopMetafieldAtomic(
        config.historyNamespace,
        config.inventoryKey,
        JSON.stringify(result.inventory || inventory),
        snapshot?.compareDigest ?? null
      );
      return result;
    } catch (error) {
      if (!error.isCompareDigestConflict || attempt === maxAttempts) throw error;
    }
  }
}

function serializeCampaignInventory(value) {
  const campaign = normalizeCampaignInventory(value);

  return Object.keys(INVENTORY_CARDS).map((key) => ({
    key,
    label: INVENTORY_CARDS[key].label,
    capacity: campaign[key].capacity,
    claimed: campaign[key].claimed,
    remaining: campaign[key].capacity === null
      ? null
      : Math.max(0, campaign[key].capacity - campaign[key].claimed),
    managed: campaign[key].capacity !== null
  }));
}

function normalizeCampaignInventory(value) {
  const source = value && typeof value === 'object' ? value : {};
  const normalized = {};

  Object.keys(INVENTORY_CARDS).forEach((key) => {
    const card = source[key] && typeof source[key] === 'object' ? source[key] : {};
    const hasCapacity = Object.prototype.hasOwnProperty.call(card, 'capacity');
    const defaultCapacity = LEGACY_SPECIAL_CARD_KEYS.has(key) ? 0 : null;
    const capacity = hasCapacity ? toNonNegativeInt(card.capacity, defaultCapacity) : defaultCapacity;
    normalized[key] = {
      capacity,
      claimed: toNonNegativeInt(card.claimed, 0)
    };
  });

  return normalized;
}

function parseInventory(value) {
  if (!value) return {};
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    return {};
  }
}

async function listGameHistory(options = {}) {
  assertServerConfig();

  const config = getConfig(options);
  const campaignId = normalizeCampaignId(options.campaign_id || options.campaignId);
  const entryLimit = resolveHistoryLimit(options.limit);
  const maxCustomers = clampInt(options.max_customers, DEFAULT_HISTORY_CUSTOMER_SCAN_LIMIT, 1, 5000);
  const includeCustomerId = String(options.include_customer_id || options.includeCustomerId || '').replace(/\D/g, '');
  const shouldScanCustomers = options.scan_customers === true || options.scan_customers === 'true';

  const entryMap = new Map();
  let scannedCustomers = 0;
  let cursor = null;
  let hasNextPage = false;
  let indexedCustomers = 0;
  const uniqueCustomers = new Set();
  const fetchedCustomerIds = new Set();

  try {
    const globalMetafield = await getShopMetafield(config.historyNamespace, config.globalHistoryKey);
    parseHistory(metafieldValue(globalMetafield)).forEach((entry) => {
      if (!entry || entry.campaign_id !== campaignId) return;
      addHistoryEntry(entryMap, uniqueCustomers, entry);
    });
  } catch (error) {
    console.warn('Unable to read global card flip history:', error.message);
  }

  try {
    const customerIndex = await getCustomerIndex(config);
    const indexedCustomerIds = customerIndex
      .map((customer) => cleanString(customer.customer_id, 80))
      .filter(Boolean)
      .slice(0, maxCustomers);

    indexedCustomers = indexedCustomerIds.length;
    await mergeCustomerHistories(entryMap, uniqueCustomers, fetchedCustomerIds, indexedCustomerIds, campaignId, config);
  } catch (error) {
    console.warn('Unable to read card flip customer index:', error.message);
  }

  if (includeCustomerId) {
    try {
      await mergeCustomerHistories(
        entryMap,
        uniqueCustomers,
        fetchedCustomerIds,
        [includeCustomerId],
        campaignId,
        config
      );
    } catch (error) {
      console.warn('Unable to merge included customer history:', error.message);
    }
  }

  if (shouldScanCustomers) {
    hasNextPage = true;
  }

  while (shouldScanCustomers && hasNextPage && scannedCustomers < maxCustomers) {
    const pageSize = Math.min(100, maxCustomers - scannedCustomers);
    const data = await shopifyGraphql(
      `query CardFlipHistory($first: Int!, $after: String, $namespace: String!, $key: String!) {
        customers(first: $first, after: $after) {
          edges {
            cursor
            node {
              legacyResourceId
              email
              metafield(namespace: $namespace, key: $key) {
                value
              }
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }`,
      {
        first: pageSize,
        after: cursor,
        namespace: config.historyNamespace,
        key: config.historyKey
      }
    );

    const customers = data.data?.customers;
    const edges = customers?.edges || [];

    scannedCustomers += edges.length;

    edges.forEach(({ node }) => {
      const customerId = cleanString(node?.legacyResourceId, 80);
      const customerEmail = cleanString(node?.email, 180);
      const history = parseHistory(node?.metafield?.value);

      history.forEach((entry) => {
        if (!entry || entry.campaign_id !== campaignId) return;
        addHistoryEntry(entryMap, uniqueCustomers, {
          ...entry,
          customer_id: cleanString(entry.customer_id || customerId, 80),
          customer_email: cleanString(entry.customer_email || customerEmail, 180)
        });
      });
    });

    hasNextPage = !!customers?.pageInfo?.hasNextPage;
    cursor = customers?.pageInfo?.endCursor || null;
  }

  const entries = Array.from(entryMap.values());
  entries.sort(sortHistoryEntries);

  if (shouldScanCustomers && entries.length) {
    try {
      await syncGlobalHistory(config, entries);
      await syncCustomerIndex(config, entries);
    } catch (error) {
      console.warn('Unable to backfill global card flip history:', error.message);
    }
  }

  const visibleEntries = entryLimit === null ? entries : entries.slice(0, entryLimit);

  try {
    const orderReferences = await getCustomerOrderReferences(
      visibleEntries.map((entry) => entry.customer_id),
      config
    );

    visibleEntries.forEach((entry) => {
      const customerId = cleanString(entry.customer_id, 80).replace(/\D/g, '');
      const liveOrderNames = orderReferences.get(customerId);
      if (liveOrderNames) {
        entry.customer_order_names = liveOrderNames;
      } else if (!Array.isArray(entry.customer_order_names)) {
        entry.customer_order_names = [];
      }
    });
  } catch (error) {
    console.warn('Unable to enrich card flip history with customer orders:', error.message);
  }

  return {
    success: true,
    campaign_id: campaignId,
    scanned_customers: scannedCustomers,
    indexed_customers: indexedCustomers,
    unique_customers: uniqueCustomers.size,
    total_entries: entries.length,
    limit: entryLimit === null ? 'all' : entryLimit,
    is_limited: entryLimit !== null && visibleEntries.length < entries.length,
    max_customers: maxCustomers,
    has_more_customers: hasNextPage,
    history: visibleEntries
  };
}

async function getCustomerOrderReferences(customerIds, config) {
  const ids = Array.from(new Set(
    customerIds
      .map((customerId) => cleanString(customerId, 80).replace(/\D/g, ''))
      .filter(Boolean)
  ));
  const references = new Map();
  const missingIds = [];

  ids.forEach((customerId) => {
    const cacheKey = `${customerId}:${getOrderConfigCacheKey(config)}`;
    const cached = readRuntimeCache(orderReferenceCache, cacheKey, ORDER_REFERENCE_CACHE_TTL_MS);
    if (cached.hit) {
      references.set(customerId, cached.value);
    } else {
      missingIds.push(customerId);
    }
  });

  for (let index = 0; index < missingIds.length; index += 5) {
    const batch = missingIds.slice(index, index + 5);
    const batchKey = `${getOrderConfigCacheKey(config)}:${batch.join(',')}`;
    let request = orderReferenceInflight.get(batchKey);

    if (!request) {
      request = fetchCustomerOrderReferenceBatch(batch, config)
        .then((batchReferences) => {
          batch.forEach((customerId) => {
            const names = batchReferences.get(customerId) || [];
            const cacheKey = `${customerId}:${getOrderConfigCacheKey(config)}`;
            writeRuntimeCache(orderReferenceCache, cacheKey, names);
          });
          return batchReferences;
        })
        .catch((error) => {
          console.warn(`Unable to load order references for customers ${batch.join(', ')}:`, error.message);
          const staleReferences = new Map();
          batch.forEach((customerId) => {
            const cacheKey = `${customerId}:${getOrderConfigCacheKey(config)}`;
            const stale = readRuntimeCache(orderReferenceCache, cacheKey, ORDER_REFERENCE_STALE_TTL_MS);
            if (stale.hit) staleReferences.set(customerId, stale.value);
          });
          return staleReferences;
        })
        .finally(() => {
          orderReferenceInflight.delete(batchKey);
        });
      orderReferenceInflight.set(batchKey, request);
    }

    const batchReferences = await request;
    batchReferences.forEach((names, customerId) => references.set(customerId, names));
  }

  return references;
}

async function fetchCustomerOrderReferenceBatch(customerIds, config) {
  const result = await shopifyGraphql(
    `query CardFlipCustomerOrders($ids: [ID!]!, $first: Int!, $query: String!) {
      nodes(ids: $ids) {
        ... on Customer {
          legacyResourceId
          orders(first: $first, query: $query, sortKey: CREATED_AT, reverse: true) {
            nodes {
              name
              createdAt
              cancelledAt
              displayFinancialStatus
              currentTotalPriceSet { shopMoney { amount } }
            }
          }
        }
      }
    }`,
    {
      ids: customerIds.map((customerId) => `gid://shopify/Customer/${customerId}`),
      first: 100,
      query: `created_at:>='${config.orderStartDate}'`
    }
  );
  const references = new Map();

  (result.data?.nodes || []).forEach((customer) => {
    const customerId = cleanString(customer?.legacyResourceId, 80).replace(/\D/g, '');
    if (!customerId) return;

    const summary = summarizeOrderEligibility(customer?.orders?.nodes || [], config);
    references.set(customerId, summary.qualifyingOrders.map((order) => order.name));
  });

  return references;
}

async function deleteGameHistory(payload = {}) {
  assertServerConfig();
  assertDeletePassword(payload.password);

  const config = getConfig(payload);
  const campaignId = normalizeCampaignId(payload.campaign_id || payload.campaignId);
  const globalMetafield = await getShopMetafield(config.historyNamespace, config.globalHistoryKey);
  const indexMetafield = await getShopMetafield(config.historyNamespace, config.customerIndexKey);
  const globalHistory = parseHistory(metafieldValue(globalMetafield));
  const customerIndex = parseHistory(metafieldValue(indexMetafield));
  const customerIds = new Set();
  let deletedGlobalEntries = 0;

  const nextGlobalHistory = globalHistory.filter((entry) => {
    if (!entry || entry.campaign_id !== campaignId) return true;
    deletedGlobalEntries += 1;
    const customerId = cleanString(entry.customer_id, 80).replace(/\D/g, '');
    if (customerId) customerIds.add(customerId);
    return false;
  });

  customerIndex.forEach((customer) => {
    const customerId = cleanString(customer.customer_id, 80).replace(/\D/g, '');
    if (customerId) customerIds.add(customerId);
  });

  // History can still exist on a customer even when the global history or
  // customer index is missing/stale. Accept the IDs returned by the history
  // page so those customer metafields can also be cleaned up.
  const requestedCustomerIds = Array.isArray(payload.customer_ids)
    ? payload.customer_ids.slice(0, 5000)
    : [];
  requestedCustomerIds.forEach((customerId) => {
    const numericId = cleanString(customerId, 80).replace(/\D/g, '');
    if (numericId) customerIds.add(numericId);
  });

  let deletedCustomerEntries = 0;
  let updatedCustomers = 0;
  const releasedInventoryCards = {};
  const nextCustomerIndexMap = new Map();

  for (const customer of customerIndex) {
    const customerId = cleanString(customer.customer_id, 80).replace(/\D/g, '');
    if (customerId && !customerIds.has(customerId)) {
      addCustomerIndexEntry(nextCustomerIndexMap, customer);
    }
  }

  for (const customerId of customerIds) {
    const historyMetafield = await getCustomerMetafield(customerId, config.historyNamespace, config.historyKey);
    const history = parseHistory(metafieldValue(historyMetafield));
    if (!historyMetafield && !history.length) continue;

    const nextHistory = history.filter((entry) => {
      const shouldDelete = entry && entry.campaign_id === campaignId;
      const inventoryKey = cleanString(entry?.inventory_card_key || entry?.special_card_key, 80);
      if (shouldDelete && INVENTORY_CARDS[inventoryKey]) {
        releasedInventoryCards[inventoryKey] = (releasedInventoryCards[inventoryKey] || 0) + 1;
      }
      return !shouldDelete;
    });
    const removedEntries = history.length - nextHistory.length;

    if (removedEntries > 0) {
      await upsertCustomerMetafield(
        customerId,
        config.historyNamespace,
        config.historyKey,
        JSON.stringify(nextHistory),
        'json',
        historyMetafield
      );
      updatedCustomers += 1;
      deletedCustomerEntries += Math.max(0, removedEntries);
    }

    if (nextHistory.length) {
      const latestEntry = [...nextHistory].sort(sortHistoryEntries)[0];
      addCustomerIndexEntry(nextCustomerIndexMap, {
        customer_id: customerId,
        customer_email: latestEntry.customer_email,
        last_played_at: latestEntry.played_at
      });
    }
  }

  const nextCustomerIndex = Array.from(nextCustomerIndexMap.values());

  await upsertShopMetafield(
    config.historyNamespace,
    config.globalHistoryKey,
    JSON.stringify(nextGlobalHistory),
    'json',
    globalMetafield
  );

  await upsertShopMetafield(
    config.historyNamespace,
    config.customerIndexKey,
    JSON.stringify(nextCustomerIndex),
    'json',
    indexMetafield
  );

  for (const [inventoryKey, amount] of Object.entries(releasedInventoryCards)) {
    await releaseInventoryCard(campaignId, inventoryKey, config, amount);
  }

  return {
    success: true,
    campaign_id: campaignId,
    deleted_entries: deletedCustomerEntries || deletedGlobalEntries,
    deleted_global_entries: deletedGlobalEntries,
    deleted_customer_entries: deletedCustomerEntries,
    updated_customers: updatedCustomers,
    released_inventory_cards: releasedInventoryCards,
    released_special_cards: releasedInventoryCards
  };
}

async function getCustomerMetafield(customerId, namespace, key) {
  const query = new URLSearchParams({ namespace, key }).toString();
  const data = await shopifyFetch(`/customers/${customerId}/metafields.json?${query}`);
  const metafields = data.metafields || [];
  return metafields.find((metafield) => metafield.namespace === namespace && metafield.key === key) || null;
}

async function getCustomerMetafieldSnapshot(customerId, namespace, key) {
  const result = await shopifyGraphql(
    `query CardFlipMetafieldSnapshot($id: ID!, $namespace: String!, $key: String!) {
      customer(id: $id) {
        metafield(namespace: $namespace, key: $key) {
          id
          value
          compareDigest
        }
      }
    }`,
    {
      id: `gid://shopify/Customer/${customerId}`,
      namespace,
      key
    }
  );

  return result.data?.customer?.metafield || null;
}

async function setCustomerMetafieldAtomic(customerId, namespace, key, value, compareDigest) {
  const result = await shopifyGraphql(
    `mutation SetCardFlipHistory($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id compareDigest }
        userErrors { field message code }
      }
    }`,
    {
      metafields: [{
        ownerId: `gid://shopify/Customer/${customerId}`,
        namespace,
        key,
        type: 'json',
        value,
        compareDigest
      }]
    }
  );

  const errors = result.data?.metafieldsSet?.userErrors || [];
  if (!errors.length) return result.data.metafieldsSet.metafields?.[0] || null;

  const message = errors.map((error) => error.message).join('; ');
  const error = httpError(500, `Unable to save card flip history: ${message}`);
  error.isCompareDigestConflict = errors.some((item) => (
    item.code === 'COMPARE_DIGEST_MISMATCH' || /compare.?digest|digest.*match/i.test(item.message || '')
  ));
  throw error;
}

async function getShopMetafieldSnapshot(namespace, key) {
  const result = await shopifyGraphql(
    `query CardFlipShopMetafieldSnapshot($namespace: String!, $key: String!) {
      shop {
        id
        metafield(namespace: $namespace, key: $key) {
          id
          value
          compareDigest
        }
      }
    }`,
    { namespace, key }
  );

  const shop = result.data?.shop;
  return shop ? { ...shop.metafield, ownerId: shop.id } : null;
}

async function setShopMetafieldAtomic(namespace, key, value, compareDigest) {
  const snapshot = await getShopMetafieldSnapshot(namespace, key);
  const ownerId = snapshot?.ownerId;
  if (!ownerId) {
    throw httpError(500, 'Unable to resolve Shopify shop ID.');
  }

  const result = await shopifyGraphql(
    `mutation SetCardFlipShopMetafield($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id compareDigest }
        userErrors { field message code }
      }
    }`,
    {
      metafields: [{
        ownerId,
        namespace,
        key,
        type: 'json',
        value,
        compareDigest
      }]
    }
  );

  const errors = result.data?.metafieldsSet?.userErrors || [];
  if (!errors.length) return result.data.metafieldsSet.metafields?.[0] || null;

  const message = errors.map((error) => error.message).join('; ');
  const error = httpError(500, `Unable to save card flip inventory: ${message}`);
  error.isCompareDigestConflict = errors.some((item) => (
    item.code === 'COMPARE_DIGEST_MISMATCH' || /compare.?digest|digest.*match/i.test(item.message || '')
  ));
  throw error;
}

async function getShopMetafield(namespace, key) {
  const query = new URLSearchParams({ namespace, key }).toString();
  const data = await shopifyFetch(`/metafields.json?${query}`);
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

async function upsertShopMetafield(namespace, key, value, type, existingMetafield) {
  if (existingMetafield && existingMetafield.id) {
    return shopifyFetch(`/metafields/${existingMetafield.id}.json`, {
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

  return shopifyFetch('/metafields.json', {
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

async function addGlobalHistory(config, entry) {
  const globalMetafield = await getShopMetafield(config.historyNamespace, config.globalHistoryKey);
  const history = parseHistory(metafieldValue(globalMetafield));
  const nextHistory = [entry, ...history.filter((item) => getHistoryEntryKey(item) !== getHistoryEntryKey(entry))]
    .slice(0, MAX_GLOBAL_HISTORY_ENTRIES);

  await upsertShopMetafield(
    config.historyNamespace,
    config.globalHistoryKey,
    JSON.stringify(nextHistory),
    'json',
    globalMetafield
  );
}

async function syncGlobalHistory(config, entries) {
  const globalMetafield = await getShopMetafield(config.historyNamespace, config.globalHistoryKey);
  const entryMap = new Map();

  entries.forEach((entry) => {
    addHistoryEntry(entryMap, new Set(), entry);
  });

  parseHistory(metafieldValue(globalMetafield)).forEach((entry) => {
    addHistoryEntry(entryMap, new Set(), entry);
  });

  const nextHistory = Array.from(entryMap.values())
    .sort(sortHistoryEntries)
    .slice(0, MAX_GLOBAL_HISTORY_ENTRIES);

  await upsertShopMetafield(
    config.historyNamespace,
    config.globalHistoryKey,
    JSON.stringify(nextHistory),
    'json',
    globalMetafield
  );
}

async function getCustomerIndex(config) {
  const indexMetafield = await getShopMetafield(config.historyNamespace, config.customerIndexKey);
  return parseHistory(metafieldValue(indexMetafield));
}

async function addCustomerIndex(config, customer) {
  await syncCustomerIndex(config, [customer]);
}

async function syncCustomerIndex(config, customers) {
  const indexMetafield = await getShopMetafield(config.historyNamespace, config.customerIndexKey);
  const customerMap = new Map();

  customers.forEach((customer) => {
    addCustomerIndexEntry(customerMap, customer);
  });

  parseHistory(metafieldValue(indexMetafield)).forEach((customer) => {
    addCustomerIndexEntry(customerMap, customer);
  });

  const nextIndex = Array.from(customerMap.values())
    .sort((a, b) => {
      const dateA = new Date(a.last_played_at || 0).getTime() || 0;
      const dateB = new Date(b.last_played_at || 0).getTime() || 0;
      return dateB - dateA;
    })
    .slice(0, MAX_CUSTOMER_INDEX_ENTRIES);

  await upsertShopMetafield(
    config.historyNamespace,
    config.customerIndexKey,
    JSON.stringify(nextIndex),
    'json',
    indexMetafield
  );
}

async function mergeCustomerHistories(entryMap, uniqueCustomers, fetchedCustomerIds, customerIds, campaignId, config) {
  const ids = customerIds
    .map((customerId) => cleanString(customerId, 80).replace(/\D/g, ''))
    .filter((customerId) => customerId && !fetchedCustomerIds.has(customerId));

  for (let index = 0; index < ids.length; index += 10) {
    const batch = ids.slice(index, index + 10);
    const results = await Promise.all(batch.map((customerId) => (
      getCustomerHistory(customerId, config).catch((error) => {
        console.warn(`Unable to read card flip history for customer ${customerId}:`, error.message);
        return null;
      })
    )));

    results.forEach((result) => {
      if (!result) return;
      fetchedCustomerIds.add(result.customer_id);
      result.history.forEach((entry) => {
        if (!entry || entry.campaign_id !== campaignId) return;
        addHistoryEntry(entryMap, uniqueCustomers, {
          ...entry,
          customer_id: entry.customer_id || result.customer_id,
          customer_email: entry.customer_email || result.customer_email
        });
      });
    });
  }
}

async function getCustomerHistory(customerId, config) {
  const historyMetafield = await getCustomerMetafield(customerId, config.historyNamespace, config.historyKey);

  return {
    customer_id: cleanString(customerId, 80),
    customer_email: '',
    history: parseHistory(metafieldValue(historyMetafield))
  };
}

function getOrderConfigCacheKey(config) {
  return [
    config.orderStartDate,
    config.campaignEndDate,
    config.dailyOrderAmount,
    config.timeZone
  ].join('|');
}

async function getCachedResource({ cache, inflight, key, ttlMs, staleTtlMs, loader }) {
  const cached = readRuntimeCache(cache, key, ttlMs);
  if (cached.hit) return cached.value;

  if (inflight.has(key)) return inflight.get(key);

  const stale = readRuntimeCache(cache, key, staleTtlMs);
  const request = Promise.resolve()
    .then(loader)
    .then((value) => {
      writeRuntimeCache(cache, key, value);
      return value;
    })
    .catch((error) => {
      if (stale.hit) {
        console.warn(`Using stale Shopify cache for ${key}:`, error.message);
        return stale.value;
      }
      throw error;
    })
    .finally(() => {
      inflight.delete(key);
    });

  inflight.set(key, request);
  return request;
}

function readRuntimeCache(cache, key, ttlMs, now = Date.now()) {
  const entry = cache.get(key);
  if (!entry || now - entry.cachedAt > ttlMs) {
    return { hit: false, value: undefined };
  }

  cache.delete(key);
  cache.set(key, entry);
  return { hit: true, value: entry.value };
}

function writeRuntimeCache(cache, key, value, now = Date.now()) {
  cache.delete(key);
  cache.set(key, { value, cachedAt: now });

  while (cache.size > MAX_RUNTIME_CACHE_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    cache.delete(oldestKey);
  }
}

async function shopifyFetch(path, options = {}) {
  assertServerConfig();
  const method = String(options.method || 'GET').toUpperCase();
  const isReadOnly = method === 'GET' || method === 'HEAD';

  for (let attempt = 0; attempt <= SHOPIFY_MAX_RETRIES; attempt += 1) {
    let response;
    try {
      response = await fetch(`https://${SHOPIFY_SHOP}/admin/api/${API_VERSION}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
          ...(options.headers || {})
        },
        body: options.body
      });
    } catch (error) {
      if (!isReadOnly || attempt === SHOPIFY_MAX_RETRIES) throw error;
      await waitFor(getShopifyRetryDelayMs('', {}, attempt));
      continue;
    }

    const text = await response.text();
    let data = {};

    if (text) {
      try {
        data = JSON.parse(text);
      } catch (error) {
        data = { raw: text };
      }
    }

    if (response.ok) return data;

    const retryable = response.status === 429 || (isReadOnly && response.status >= 500);
    if (retryable && attempt < SHOPIFY_MAX_RETRIES) {
      await waitFor(getShopifyRetryDelayMs(response.headers.get('retry-after'), data, attempt));
      continue;
    }

    const message = data.errors || data.error || text || response.statusText;
    throw httpError(response.status, `Shopify API error: ${formatMessage(message)}`);
  }

  throw httpError(503, 'Shopify API is temporarily unavailable');
}

async function shopifyGraphql(query, variables = {}) {
  assertServerConfig();
  const isReadOnly = /^\s*query\b/i.test(query);

  for (let attempt = 0; attempt <= SHOPIFY_MAX_RETRIES; attempt += 1) {
    let response;
    try {
      response = await fetch(`https://${SHOPIFY_SHOP}/admin/api/${API_VERSION}/graphql.json`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN
        },
        body: JSON.stringify({ query, variables })
      });
    } catch (error) {
      if (!isReadOnly || attempt === SHOPIFY_MAX_RETRIES) throw error;
      await waitFor(getShopifyRetryDelayMs('', {}, attempt));
      continue;
    }

    const data = await response.json().catch(() => ({}));
    const throttled = response.status === 429 || isGraphqlThrottled(data);
    const retryableServerError = isReadOnly && (
      response.status >= 500 || isGraphqlInternalError(data)
    );

    if ((throttled || retryableServerError) && attempt < SHOPIFY_MAX_RETRIES) {
      await waitFor(getShopifyRetryDelayMs(response.headers.get('retry-after'), data, attempt));
      continue;
    }

    if (response.ok && !data.errors) return data;

    const message = data.errors || data.error || response.statusText;
    const statusCode = throttled ? 429 : (response.ok ? 502 : response.status || 500);
    throw httpError(statusCode, `Shopify GraphQL error: ${formatMessage(message)}`);
  }

  throw httpError(503, 'Shopify GraphQL API is temporarily unavailable');
}

function isGraphqlThrottled(data) {
  return (Array.isArray(data?.errors) ? data.errors : []).some((error) => (
    error?.extensions?.code === 'THROTTLED' || /throttl/i.test(String(error?.message || ''))
  ));
}

function isGraphqlInternalError(data) {
  return (Array.isArray(data?.errors) ? data.errors : []).some((error) => (
    error?.extensions?.code === 'INTERNAL_SERVER_ERROR'
  ));
}

function getShopifyRetryDelayMs(retryAfter, data, attempt, random = Math.random) {
  const retryAfterSeconds = Number.parseFloat(retryAfter);
  const retryAfterMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
    ? retryAfterSeconds * 1000
    : 0;
  const cost = data?.extensions?.cost || {};
  const throttleStatus = cost.throttleStatus || {};
  const requestedCost = toNonNegativeNumber(cost.requestedQueryCost, 0);
  const currentlyAvailable = toNonNegativeNumber(throttleStatus.currentlyAvailable, 0);
  const restoreRate = toNonNegativeNumber(throttleStatus.restoreRate, 0);
  const costDelayMs = restoreRate > 0 && requestedCost > currentlyAvailable
    ? ((requestedCost - currentlyAvailable) / restoreRate) * 1000
    : 0;
  const exponentialDelayMs = SHOPIFY_RETRY_BASE_MS * (2 ** Math.max(0, attempt));
  const jitterMs = Math.floor(Math.max(0, random()) * 100);

  return Math.min(SHOPIFY_RETRY_MAX_DELAY_MS, Math.ceil(Math.max(retryAfterMs, costDelayMs, exponentialDelayMs) + jitterMs));
}

function waitFor(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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

function normalizeCard(value = {}) {
  return {
    id: cleanString(value.id || value.card_id, 120),
    title: cleanString(value.title || value.card_title, 240),
    code: cleanString(value.code || value.card_code, 500),
    image: cleanString(value.image || value.card_image, 700),
    alt: cleanString(value.alt, 240),
    inventoryKey: cleanString(value.inventoryKey || value.inventory_key, 80)
  };
}

function normalizeDeckCards(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 100).map(normalizeCard).filter((card) => card.id || card.title);
}

function getInventoryCardKey(card) {
  const explicitKey = cleanString(card?.inventoryKey || card?.inventory_key, 80);
  if (INVENTORY_CARDS[explicitKey]) return explicitKey;

  const title = cleanString(card?.title, 240);
  return Object.keys(INVENTORY_CARDS).find((key) => INVENTORY_CARDS[key].titlePattern.test(title)) || '';
}

function getCardIdentity(card) {
  return getInventoryCardKey(card) || cleanString(card?.id, 120) || cleanString(card?.title, 240).toLowerCase();
}

function uniqueCards(cards) {
  const seen = new Set();
  return cards.filter((card) => {
    const identity = getCardIdentity(card);
    if (!identity || seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

function shuffleCards(cards) {
  const items = cards.slice();
  for (let index = items.length - 1; index > 0; index -= 1) {
    const randomIndex = Math.floor(Math.random() * (index + 1));
    const temporary = items[index];
    items[index] = items[randomIndex];
    items[randomIndex] = temporary;
  }
  return items;
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

function toNonNegativeNumber(value, fallback) {
  const number = Number.parseFloat(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function normalizeDate(value, fallback) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : fallback;
}

function normalizeCampaignEndDate(value) {
  const normalizedValue = String(value || '').trim();
  if (!normalizedValue) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalizedValue)) {
    return isDateOnly(normalizedValue) ? normalizedValue : '';
  }

  const date = new Date(normalizedValue);
  return Number.isFinite(date.getTime()) ? date.toISOString() : '';
}

function isDateOnly(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (!match) return false;

  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.getUTCFullYear() === Number(match[1]) &&
    date.getUTCMonth() === Number(match[2]) - 1 &&
    date.getUTCDate() === Number(match[3]);
}

function normalizeTimeZone(value, fallback) {
  const timeZone = String(value || fallback).trim();
  try {
    new Intl.DateTimeFormat('en', { timeZone }).format();
    return timeZone;
  } catch (error) {
    return fallback;
  }
}

function clampInt(value, fallback, min, max) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, number));
}

function resolveHistoryLimit(value) {
  const selectedValue = optionValue(value, DEFAULT_HISTORY_LIST_LIMIT);
  const normalizedValue = String(selectedValue || '').trim().toLowerCase();

  if (!normalizedValue || normalizedValue === '0' || normalizedValue === 'all') {
    return null;
  }

  const number = Number.parseInt(normalizedValue, 10);
  if (!Number.isFinite(number) || number <= 0) {
    return null;
  }

  return Math.min(50000, number);
}

function optionValue(value, fallback) {
  return value === undefined || value === null || value === '' ? fallback : value;
}

function createEntryId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function assertDeletePassword(password) {
  if (!HISTORY_DELETE_PASSWORD) {
    throw httpError(500, 'Missing CARD_FLIP_HISTORY_DELETE_PASSWORD environment variable');
  }

  if (String(password || '') !== HISTORY_DELETE_PASSWORD) {
    throw httpError(403, 'Mật khẩu xóa lịch sử không đúng.');
  }
}

function addHistoryEntry(entryMap, uniqueCustomers, entry) {
  if (!entry) return;

  const cleanEntry = {
    ...entry,
    customer_id: cleanString(entry.customer_id, 80),
    customer_email: cleanString(entry.customer_email, 180)
  };
  const key = getHistoryEntryKey(cleanEntry);

  if (cleanEntry.customer_id) {
    uniqueCustomers.add(cleanEntry.customer_id);
  }

  if (!entryMap.has(key)) {
    entryMap.set(key, cleanEntry);
  }
}

function addCustomerIndexEntry(customerMap, customer) {
  if (!customer) return;

  const customerId = cleanString(customer.customer_id, 80).replace(/\D/g, '');
  if (!customerId) return;

  const existing = customerMap.get(customerId);
  const nextEntry = {
    customer_id: customerId,
    customer_email: cleanString(customer.customer_email, 180),
    last_played_at: cleanString(customer.last_played_at || customer.played_at, 80)
  };

  if (!existing) {
    customerMap.set(customerId, nextEntry);
    return;
  }

  const existingTime = new Date(existing.last_played_at || 0).getTime() || 0;
  const nextTime = new Date(nextEntry.last_played_at || 0).getTime() || 0;

  customerMap.set(customerId, {
    customer_id: customerId,
    customer_email: nextEntry.customer_email || existing.customer_email,
    last_played_at: nextTime > existingTime ? nextEntry.last_played_at : existing.last_played_at
  });
}

function sortHistoryEntries(a, b) {
  const dateA = new Date(a.played_at || 0).getTime() || 0;
  const dateB = new Date(b.played_at || 0).getTime() || 0;
  return dateB - dateA;
}

function getHistoryEntryKey(entry) {
  if (entry && entry.id) {
    return `id:${entry.id}`;
  }

  return [
    entry?.campaign_id || '',
    entry?.customer_id || '',
    entry?.played_at || '',
    entry?.card_id || ''
  ].join('|');
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
  getCardInventory,
  updateCardInventory,
  deleteGameHistory,
  listGameHistory,
  recordPlay,
  httpError,
  __test: {
    formatDateInTimeZone,
    getCachedResource,
    getInventoryCardKey,
    getAllowedTurns,
    getShopifyRetryDelayMs,
    isGraphqlThrottled,
    isCampaignActive,
    normalizeCampaignInventory,
    normalizeCampaignEndDate,
    readRuntimeCache,
    serializeCampaignInventory,
    summarizeOrderEligibility,
    writeRuntimeCache
  }
};
