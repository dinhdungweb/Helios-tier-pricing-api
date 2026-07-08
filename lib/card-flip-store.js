const SHOPIFY_SHOP = process.env.SHOPIFY_SHOP;
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const API_VERSION = process.env.SHOPIFY_API_VERSION || '2026-07';
const HISTORY_DELETE_PASSWORD = process.env.CARD_FLIP_HISTORY_DELETE_PASSWORD || '';

const DEFAULT_TURNS_NAMESPACE = process.env.CARD_FLIP_TURNS_NAMESPACE || 'custom';
const DEFAULT_TURNS_KEY = process.env.CARD_FLIP_TURNS_KEY || 'card_flip_turns';
const DEFAULT_HISTORY_NAMESPACE = process.env.CARD_FLIP_HISTORY_NAMESPACE || 'card_flip';
const DEFAULT_HISTORY_KEY = process.env.CARD_FLIP_HISTORY_KEY || 'history';
const DEFAULT_GLOBAL_HISTORY_KEY = process.env.CARD_FLIP_GLOBAL_HISTORY_KEY || 'global_history';
const DEFAULT_CUSTOMER_INDEX_KEY = process.env.CARD_FLIP_CUSTOMER_INDEX_KEY || 'customer_index';
const DEFAULT_ALLOWED_TURNS = toNonNegativeInt(process.env.CARD_FLIP_DEFAULT_TURNS, 1);
const MAX_HISTORY_ENTRIES = toNonNegativeInt(process.env.CARD_FLIP_MAX_HISTORY_ENTRIES, 200);
const MAX_GLOBAL_HISTORY_ENTRIES = toNonNegativeInt(process.env.CARD_FLIP_MAX_GLOBAL_HISTORY_ENTRIES, 5000);
const MAX_CUSTOMER_INDEX_ENTRIES = toNonNegativeInt(process.env.CARD_FLIP_MAX_CUSTOMER_INDEX_ENTRIES, 10000);
const DEFAULT_HISTORY_LIST_LIMIT = toNonNegativeInt(process.env.CARD_FLIP_HISTORY_LIST_LIMIT, 0);
const DEFAULT_HISTORY_CUSTOMER_SCAN_LIMIT = toNonNegativeInt(process.env.CARD_FLIP_HISTORY_CUSTOMER_SCAN_LIMIT, 1000);

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

function getConfig(options = {}) {
  const turnsNamespace = cleanString(
    options.turns_namespace || options.turnsNamespace || DEFAULT_TURNS_NAMESPACE,
    80
  ) || DEFAULT_TURNS_NAMESPACE;
  const turnsKey = cleanString(
    options.turns_key || options.turnsKey || DEFAULT_TURNS_KEY,
    80
  ) || DEFAULT_TURNS_KEY;

  const defaultAllowedTurns = toNonNegativeInt(
    optionValue(options.default_turns, options.defaultAllowedTurns),
    DEFAULT_ALLOWED_TURNS
  );

  return {
    turnsNamespace,
    turnsKey,
    historyNamespace: DEFAULT_HISTORY_NAMESPACE,
    historyKey: DEFAULT_HISTORY_KEY,
    globalHistoryKey: DEFAULT_GLOBAL_HISTORY_KEY,
    customerIndexKey: DEFAULT_CUSTOMER_INDEX_KEY,
    defaultAllowedTurns,
    maxHistoryEntries: MAX_HISTORY_ENTRIES
  };
}

async function getGameState(customerId, campaignId, options = {}) {
  assertServerConfig();

  const numericId = normalizeCustomerId(customerId);
  const normalizedCampaignId = normalizeCampaignId(campaignId);
  const config = getConfig(options);

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
  const state = await getGameState(payload.customer_id, payload.campaign_id, payload);

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
    entry
  };
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

  let deletedCustomerEntries = 0;
  let updatedCustomers = 0;
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

    const nextHistory = history.filter((entry) => entry && entry.campaign_id !== campaignId);
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

  return {
    success: true,
    campaign_id: campaignId,
    deleted_entries: deletedCustomerEntries || deletedGlobalEntries,
    deleted_global_entries: deletedGlobalEntries,
    deleted_customer_entries: deletedCustomerEntries,
    updated_customers: updatedCustomers
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

async function shopifyGraphql(query, variables = {}) {
  assertServerConfig();

  const response = await fetch(`https://${SHOPIFY_SHOP}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN
    },
    body: JSON.stringify({ query, variables })
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok || data.errors) {
    const message = data.errors || data.error || response.statusText;
    throw httpError(response.status || 500, `Shopify GraphQL error: ${formatMessage(message)}`);
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
  deleteGameHistory,
  listGameHistory,
  recordPlay,
  httpError
};
