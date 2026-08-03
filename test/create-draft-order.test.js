'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

process.env.SHOPIFY_SHOP = 'heliosjewels-vn.myshopify.com';
process.env.SHOPIFY_ACCESS_TOKEN = 'test-token';
process.env.SHOPIFY_API_SECRET = 'test-secret';
process.env.REQUIRE_APP_PROXY = 'false';

const handler = require('../api/create-draft-order-secure');
const {
  authenticateAppProxy,
  buildDraftOrderLineItem,
  validateRequestedItems
} = handler._test;

test('validates a fresh Shopify App Proxy signature and customer identity', () => {
  const query = {
    logged_in_customer_id: '12345',
    path_prefix: '/apps/helios-tier-pricing',
    shop: 'heliosjewels-vn.myshopify.com',
    timestamp: String(Math.floor(Date.now() / 1000))
  };
  const message = Object.keys(query)
    .sort()
    .map(key => `${key}=${query[key]}`)
    .join('');
  query.signature = crypto
    .createHmac('sha256', 'test-secret')
    .update(message)
    .digest('hex');

  const result = authenticateAppProxy({ query });

  assert.equal(result.valid, true);
  assert.equal(result.customerId, '12345');
});

test('rejects a forged App Proxy request', () => {
  const result = authenticateAppProxy({
    query: {
      signature: 'not-valid',
      shop: 'heliosjewels-vn.myshopify.com',
      timestamp: String(Math.floor(Date.now() / 1000))
    }
  });

  assert.equal(result.valid, false);
  assert.equal(result.error, 'Invalid App Proxy signature');
});

test('validates item count, variant id and quantity boundaries', () => {
  assert.deepEqual(
    validateRequestedItems([{ variant_id: '123', quantity: 2 }]),
    [{ variant_id: '123', quantity: 2 }]
  );
  assert.throws(
    () => validateRequestedItems([{ variant_id: 'x', quantity: 1 }]),
    error => error.statusCode === 400
  );
  assert.throws(
    () => validateRequestedItems([{ variant_id: '123', quantity: 101 }]),
    error => error.statusCode === 400
  );
});

test('fixed discount amount covers the full quantity', () => {
  const lineItem = buildDraftOrderLineItem({
    variantId: '100',
    quantity: 2,
    currency: 'VND',
    shopCurrency: 'VND',
    discountPercent: 8,
    unitDiscountAmount: 316000,
    shopUnitDiscountAmount: 316000,
    isGift: false
  });

  assert.equal(lineItem.appliedDiscount.value, 316000);
  assert.deepEqual(lineItem.appliedDiscount.amountWithCurrency, {
    amount: '632000',
    currencyCode: 'VND'
  });
});

test('handler derives price and discount from Shopify responses', async () => {
  const originalFetch = global.fetch;
  let capturedDraftInput;
  global.fetch = async (url, options) => {
    const request = JSON.parse(options.body);

    if (request.query.includes('query CheckoutContext')) {
      return mockFetchResponse({
        data: {
          shop: { currencyCode: 'VND' },
          themes: {
            nodes: [{
              id: 'gid://shopify/OnlineStoreTheme/1',
              updatedAt: '2026-08-03T00:00:00Z'
            }]
          },
          customer: {
            id: 'gid://shopify/Customer/12345',
            tags: ['DIAMOND'],
            amountSpent: { amount: '0', currencyCode: 'VND' },
            totalSpentMetafield: { value: '0' }
          },
          variants: [{
            id: 'gid://shopify/ProductVariant/100',
            price: '3515500',
            compareAtPrice: '3950000',
            contextualPricing: {
              price: { amount: '3515500', currencyCode: 'VND' },
              compareAtPrice: { amount: '3950000', currencyCode: 'VND' }
            },
            product: {
              tags: [],
              collections: { nodes: [{ handle: 'all-products' }] }
            }
          }]
        }
      });
    }

    if (request.query.includes('query PublishedThemeTierSettings')) {
      const settingsData = JSON.stringify({
        current: {
          tier_pricing_enabled: true,
          tier_pricing_scope: 'all',
          tier_2_discount: 8,
          tier_prioritize_tags: true,
          tier_use_custom_metafield: true
        }
      });
      const settingsSchema = JSON.stringify([{
        name: 'Tier Pricing',
        settings: [
          { id: 'tier_1_name', default: 'BLACK DIAMOND' },
          { id: 'tier_1_tag', default: 'BLACK DIAMOND' },
          { id: 'tier_1_discount', default: 10 },
          { id: 'tier_1_threshold', default: '100000000' },
          { id: 'tier_2_name', default: 'DIAMOND' },
          { id: 'tier_2_tag', default: 'DIAMOND' },
          { id: 'tier_2_discount', default: 8 },
          { id: 'tier_2_threshold', default: '20000000' },
          { id: 'tier_3_name', default: 'PLATINUM' },
          { id: 'tier_3_tag', default: 'PLATINUM' },
          { id: 'tier_3_discount', default: 6 },
          { id: 'tier_3_threshold', default: '10000000' },
          { id: 'tier_4_name', default: 'GOLD' },
          { id: 'tier_4_tag', default: 'GOLD' },
          { id: 'tier_4_discount', default: 4 },
          { id: 'tier_4_threshold', default: '6000000' },
          { id: 'tier_5_name', default: 'SILVER' },
          { id: 'tier_5_tag', default: 'SILVER' },
          { id: 'tier_5_discount', default: 2 },
          { id: 'tier_5_threshold', default: '3000000' },
          { id: 'tier_6_name', default: 'MEMBER' },
          { id: 'tier_6_discount', default: 0 }
        ]
      }]);
      return mockFetchResponse({
        data: {
          theme: {
            id: 'gid://shopify/OnlineStoreTheme/1',
            files: {
              nodes: [
                {
                  filename: 'config/settings_data.json',
                  body: { content: settingsData }
                },
                {
                  filename: 'config/settings_schema.json',
                  body: { content: settingsSchema }
                }
              ],
              userErrors: []
            }
          }
        }
      });
    }

    capturedDraftInput = request.variables.input;
    return mockFetchResponse({
      data: {
        draftOrderCreate: {
          draftOrder: {
            id: 'gid://shopify/DraftOrder/1',
            legacyResourceId: '1',
            invoiceUrl: 'https://example.test/invoice',
            presentmentCurrencyCode: 'VND',
            totalPriceSet: {
              presentmentMoney: {
                amount: '6399000',
                currencyCode: 'VND'
              }
            }
          },
          userErrors: []
        }
      }
    });
  };

  try {
    const req = {
      method: 'POST',
      headers: { origin: 'https://helios.vn' },
      query: {},
      body: {
        customer_id: '12345',
        customer_email: 'forged@example.test',
        currency: 'VND',
        country: 'VN',
        items: [{
          variant_id: '100',
          quantity: 2,
          price_minor: 0,
          discount_percent: 100,
          is_gift: true
        }]
      }
    };
    const res = createMockResponse();

    await handler(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(
      capturedDraftInput.purchasingEntity.customerId,
      'gid://shopify/Customer/12345'
    );
    assert.equal(
      capturedDraftInput.lineItems[0].appliedDiscount.value,
      316000
    );
    assert.equal(
      capturedDraftInput.lineItems[0].appliedDiscount.amountWithCurrency.amount,
      '632000'
    );
    assert.equal(
      capturedDraftInput.lineItems[0].appliedDiscount.amountWithCurrency.currencyCode,
      'VND'
    );
  } finally {
    global.fetch = originalFetch;
  }
});

function mockFetchResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body)
  };
}

function createMockResponse() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(statusCode) {
      this.statusCode = statusCode;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    end() {
      return this;
    }
  };
}
