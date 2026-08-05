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

test('maps every campaign card title to its own inventory key', () => {
  const titles = [
    ['CHAPTER I - ORIGIN', 'chapter_i'],
    ['CHAPTER II - THE FORGE', 'chapter_ii'],
    ['CHAPTER III - DNA', 'chapter_iii'],
    ['CHAPTER IV - THE ICONS', 'chapter_iv'],
    ['CHAPTER V - BEYOND JEWELRY', 'chapter_v'],
    ['CHAPTER VI - CROSSROADS', 'chapter_vi'],
    ['CHAPTER VII - PEOPLE', 'chapter_vii'],
    ['CHAPTER VIII - THE WEARERS', 'chapter_viii'],
    ['CHAPTER IX - HEIRLOOM', 'chapter_ix'],
    ['CHAPTER X - FUTURE', 'chapter_x'],
    ['CHAPTER XI - THE OPENING', 'chapter_xi'],
    ['LIMITED CARD', 'limited_card']
  ];

  titles.forEach(([title, expectedKey]) => {
    assert.equal(__test.getInventoryCardKey({ title }), expectedKey);
  });

  assert.equal(__test.getInventoryCardKey({ inventoryKey: 'chapter_v', title: 'Tên hiển thị tùy chỉnh' }), 'chapter_v');
});

test('keeps new regular cards unlimited until a quantity is configured', () => {
  const inventory = __test.normalizeCampaignInventory({});

  assert.equal(inventory.chapter_i.capacity, null);
  assert.equal(inventory.chapter_x.capacity, null);
  assert.equal(inventory.chapter_xi.capacity, 0);
  assert.equal(inventory.limited_card.capacity, 0);
});

test('serializes configured quantities with claimed and remaining counts', () => {
  const cards = __test.serializeCampaignInventory({
    chapter_i: { capacity: 20, claimed: 7 },
    chapter_ii: { capacity: 3, claimed: 5 }
  });
  const chapterI = cards.find((card) => card.key === 'chapter_i');
  const chapterII = cards.find((card) => card.key === 'chapter_ii');
  const chapterIII = cards.find((card) => card.key === 'chapter_iii');

  assert.deepEqual(
    { capacity: chapterI.capacity, claimed: chapterI.claimed, remaining: chapterI.remaining, managed: chapterI.managed },
    { capacity: 20, claimed: 7, remaining: 13, managed: true }
  );
  assert.equal(chapterII.remaining, 0);
  assert.equal(chapterIII.capacity, null);
  assert.equal(chapterIII.remaining, null);
  assert.equal(chapterIII.managed, false);
});
