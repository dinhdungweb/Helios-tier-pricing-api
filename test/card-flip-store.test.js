const test = require('node:test');
const assert = require('node:assert/strict');

const { __test } = require('../lib/card-flip-store');

const baseConfig = {
  orderStartDate: '2026-08-05T17:00:00.000Z',
  dailyOrderAmount: 500000,
  campaignEndDate: '2026-08-31',
  timeZone: 'Asia/Ho_Chi_Minh'
};

function order(createdAt, amount, overrides = {}) {
  return {
    createdAt,
    cancelledAt: null,
    displayFinancialStatus: 'PAID',
    currentTotalPriceSet: { shopMoney: { amount: String(amount) } },
    ...overrides
  };
}

test('grants only one turn for multiple qualifying orders on the same local day', () => {
  const summary = __test.summarizeOrderEligibility([
    order('2026-08-06T02:00:00.000Z', 500000),
    order('2026-08-06T10:00:00.000Z', 3000000)
  ], baseConfig, new Date('2026-08-20T00:00:00.000Z'));

  assert.deepEqual(summary.qualifyingDays, ['2026-08-06']);
  assert.equal(__test.getAllowedTurns({}, summary.qualifyingDays.length), 1);
});

test('grants one accumulated turn for each distinct qualifying local day', () => {
  const summary = __test.summarizeOrderEligibility([
    order('2026-08-06T16:59:00.000Z', 500000),
    order('2026-08-06T17:00:00.000Z', 600000)
  ], baseConfig, new Date('2026-08-20T00:00:00.000Z'));

  assert.deepEqual(summary.qualifyingDays, ['2026-08-06', '2026-08-07']);
  assert.equal(__test.getAllowedTurns({}, summary.qualifyingDays.length), 2);
});

test('does not grant turns for small, cancelled, unpaid, or post-campaign orders', () => {
  const summary = __test.summarizeOrderEligibility([
    order('2026-08-10T02:00:00.000Z', 499999),
    order('2026-08-11T02:00:00.000Z', 500000, { cancelledAt: '2026-08-11T03:00:00.000Z' }),
    order('2026-08-12T02:00:00.000Z', 500000, { displayFinancialStatus: 'PENDING' }),
    order('2026-09-01T02:00:00.000Z', 500000)
  ], baseConfig, new Date('2026-09-10T00:00:00.000Z'));

  assert.deepEqual(summary.qualifyingDays, []);
  assert.equal(__test.getAllowedTurns({}, summary.qualifyingDays.length), 0);
});

test('accepts partially refunded orders only when their current total still meets the minimum', () => {
  const summary = __test.summarizeOrderEligibility([
    order('2026-08-08T02:00:00.000Z', 500000, { displayFinancialStatus: 'PARTIALLY_REFUNDED' }),
    order('2026-08-09T02:00:00.000Z', 400000, { displayFinancialStatus: 'PARTIALLY_REFUNDED' })
  ], baseConfig, new Date('2026-08-20T00:00:00.000Z'));

  assert.deepEqual(summary.qualifyingDays, ['2026-08-08']);
});

test('date-only campaign deadline includes the full Vietnam calendar day', () => {
  assert.equal(__test.isCampaignActive(baseConfig, new Date('2026-08-31T16:59:59.999Z')), true);
  assert.equal(__test.isCampaignActive(baseConfig, new Date('2026-08-31T17:00:00.000Z')), false);
});

test('ISO campaign deadline expires at the exact timestamp', () => {
  const config = { ...baseConfig, campaignEndDate: '2026-08-31T10:00:00.000Z' };
  assert.equal(__test.isCampaignActive(config, new Date('2026-08-31T10:00:00.000Z')), true);
  assert.equal(__test.isCampaignActive(config, new Date('2026-08-31T10:00:00.001Z')), false);
});

test('normalizes valid campaign deadlines and rejects invalid dates', () => {
  assert.equal(__test.normalizeCampaignEndDate('2026-08-31'), '2026-08-31');
  assert.equal(__test.normalizeCampaignEndDate('2026-02-31'), '');
  assert.equal(__test.normalizeCampaignEndDate('not-a-date'), '');
});
