'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildAuthoritativeItems,
  getTierPolicy
} = require('../lib/tier-pricing-policy');

function createVariant({
  id = '100',
  price = '3515500',
  compareAtPrice = '3950000',
  shopPrice = price,
  shopCompareAtPrice = compareAtPrice,
  currency = 'VND',
  tags = [],
  collections = ['all-products']
} = {}) {
  return {
    id: `gid://shopify/ProductVariant/${id}`,
    price: shopPrice,
    compareAtPrice: shopCompareAtPrice,
    contextualPricing: {
      price: { amount: price, currencyCode: currency },
      compareAtPrice: compareAtPrice === null
        ? null
        : { amount: compareAtPrice, currencyCode: currency }
    },
    product: {
      tags,
      collections: {
        nodes: collections.map(handle => ({ handle }))
      }
    }
  };
}

function createCustomer(tags = ['DIAMOND'], totalSpent = '0') {
  return {
    tags,
    totalSpentMetafield: { value: totalSpent },
    amountSpent: { amount: totalSpent, currencyCode: 'VND' }
  };
}

test('ignores forged client price, discount and gift fields', () => {
  const variant = createVariant();
  const items = buildAuthoritativeItems({
    requestedItems: [{
      variant_id: '100',
      quantity: 1,
      price_minor: 1,
      discount_percent: 100,
      is_gift: true
    }],
    variantsById: new Map([['100', variant]]),
    customer: createCustomer(),
    currency: 'VND',
    policy: getTierPolicy({})
  });

  assert.equal(items[0].price, 3515500);
  assert.equal(items[0].discountPercent, 8);
  assert.equal(items[0].unitDiscountAmount, 316000);
  assert.equal(items[0].shopUnitDiscountAmount, 316000);
  assert.equal(items[0].isGift, false);
});

test('uses a matching authoritative product tier tag', () => {
  const variant = createVariant({
    tags: ['tier-diamond-12']
  });
  const items = buildAuthoritativeItems({
    requestedItems: [{ variant_id: '100', quantity: 1 }],
    variantsById: new Map([['100', variant]]),
    customer: createCustomer(),
    currency: 'VND',
    policy: getTierPolicy({})
  });

  assert.equal(items[0].discountPercent, 12);
  assert.equal(items[0].unitDiscountAmount, 474000);
});

test('rounds discounts using the active currency precision', () => {
  const usdVariant = createVariant({
    id: '200',
    price: '100',
    compareAtPrice: '110',
    shopPrice: '3515500',
    shopCompareAtPrice: '3950000',
    currency: 'USD'
  });
  const jpyVariant = createVariant({
    id: '300',
    price: '1001',
    compareAtPrice: null,
    currency: 'JPY'
  });
  const policy = getTierPolicy({});

  const usdItems = buildAuthoritativeItems({
    requestedItems: [{ variant_id: '200', quantity: 1 }],
    variantsById: new Map([['200', usdVariant]]),
    customer: createCustomer(),
    currency: 'USD',
    shopCurrency: 'VND',
    policy
  });
  const jpyItems = buildAuthoritativeItems({
    requestedItems: [{ variant_id: '300', quantity: 1 }],
    variantsById: new Map([['300', jpyVariant]]),
    customer: createCustomer(),
    currency: 'JPY',
    policy
  });

  assert.equal(usdItems[0].unitDiscountAmount, 8.8);
  assert.equal(usdItems[0].shopUnitDiscountAmount, 316000);
  assert.equal(jpyItems[0].unitDiscountAmount, 80);
});

test('rejects a currency that does not match Shopify contextual pricing', () => {
  const variant = createVariant({ currency: 'VND' });

  assert.throws(() => buildAuthoritativeItems({
    requestedItems: [{ variant_id: '100', quantity: 1 }],
    variantsById: new Map([['100', variant]]),
    customer: createCustomer(),
    currency: 'USD',
    policy: getTierPolicy({})
  }), error => error.statusCode === 409);
});

test('only makes an allowlisted gift free when server requirements are met', () => {
  const paidVariant = createVariant({
    id: '100',
    price: '2100000',
    compareAtPrice: null
  });
  const giftVariant = createVariant({
    id: '999',
    price: '200000',
    compareAtPrice: null
  });
  const policy = getTierPolicy({
    FREE_GIFT_ENABLED: 'true',
    FREE_GIFT_VARIANT_IDS: '999',
    FREE_GIFT_TRIGGER_COLLECTION: 'all-products',
    FREE_GIFT_MINIMUMS_JSON: '{"VND":2000000}'
  });
  const items = buildAuthoritativeItems({
    requestedItems: [
      { variant_id: '100', quantity: 1 },
      { variant_id: '999', quantity: 1, is_gift: false }
    ],
    variantsById: new Map([
      ['100', paidVariant],
      ['999', giftVariant]
    ]),
    customer: createCustomer(),
    currency: 'VND',
    shopCurrency: 'VND',
    policy
  });

  assert.equal(items[1].isGift, true);
  assert.equal(items[1].discountPercent, 100);
  assert.equal(items[1].unitDiscountAmount, 200000);
});
