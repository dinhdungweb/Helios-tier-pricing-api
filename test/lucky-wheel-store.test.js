const test = require('node:test');
const assert = require('node:assert/strict');

const { __test } = require('../lib/lucky-wheel-store');

const SECRET = 'test-secret';

function rawSettings() {
  return {
  lucky_wheel_enabled: true,
  lucky_wheel_start: '2026-12-01',
  lucky_wheel_end: '2026-12-31',
  lucky_wheel_wins_per_day: 5,
  lucky_wheel_win_start_hour: 8,
  lucky_wheel_win_end_hour: 23,
  lucky_wheel_prize_1_name: 'Summer sock', lucky_wheel_prize_1_stock: 8,
  lucky_wheel_prize_2_name: 'Mũ Cruiser', lucky_wheel_prize_2_stock: 7,
  lucky_wheel_prize_3_name: 'Sticker', lucky_wheel_prize_3_stock: 7,
  lucky_wheel_prize_4_name: 'Bài Ngọ', lucky_wheel_prize_4_stock: 7,
  lucky_wheel_prize_5_name: 'Figure Warrior', lucky_wheel_prize_5_stock: 7,
  lucky_wheel_prize_6_name: 'Bandana Seravix', lucky_wheel_prize_6_stock: 7,
  lucky_wheel_prize_7_name: 'Cốc gốm (SECRET)', lucky_wheel_prize_7_stock: 2,
  lucky_wheel_prize_8_name: 'Xu moneta', lucky_wheel_prize_8_stock: 7,
  lucky_wheel_prize_9_name: 'Tất Surgo', lucky_wheel_prize_9_stock: 8
  };
}
const config = __test.buildConfig(rawSettings());

function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

test('token: valid token returns the customer id', () => {
  const now = Date.parse('2026-12-05T03:00:00Z');
  const ts = Math.floor(now / 1000);
  const token = `123456.${ts}.${__test.signToken('123456', ts, SECRET)}`;
  assert.equal(__test.verifyToken(token, SECRET, now), '123456');
});

test('token: tampered customer id is rejected', () => {
  const now = Date.parse('2026-12-05T03:00:00Z');
  const ts = Math.floor(now / 1000);
  const sig = __test.signToken('123456', ts, SECRET);
  assert.throws(() => __test.verifyToken(`999999.${ts}.${sig}`, SECRET, now), /Invalid token/);
});

test('token: expired token is rejected', () => {
  const now = Date.parse('2026-12-05T03:00:00Z');
  const ts = Math.floor(now / 1000) - 2 * 24 * 3600;
  const token = `1.${ts}.${__test.signToken('1', ts, SECRET)}`;
  assert.throws(() => __test.verifyToken(token, SECRET, now), /expired/);
});

test('config: dates are Vietnam time, end date is inclusive', () => {
  assert.equal(new Date(config.startAt).toISOString(), '2026-11-30T17:00:00.000Z');
  assert.equal(new Date(config.endAt).toISOString(), '2026-12-31T16:59:59.000Z');
  assert.equal(__test.campaignStatus(config, Date.parse('2026-11-30T16:59:00Z')), 'not_started');
  assert.equal(__test.campaignStatus(config, Date.parse('2026-12-31T16:00:00Z')), 'active');
  assert.equal(__test.campaignStatus(config, Date.parse('2026-12-31T17:00:00Z')), 'ended');
});

test('one spin per customer per local day, second call returns the same result', () => {
  const state = __test.emptyState();
  const now = Date.parse('2026-12-05T10:00:00Z');
  const first = __test.decideSpin(state, '42', now, config, seeded(1));
  const second = __test.decideSpin(state, '42', now + 60000, config, seeded(2));
  assert.equal(first.alreadySpun, false);
  assert.equal(second.alreadySpun, true);
  assert.deepEqual(second.result, first.result);
});

test('new local day (00:00 Vietnam) allows a new spin', () => {
  const state = __test.emptyState();
  __test.decideSpin(state, '42', Date.parse('2026-12-05T16:59:00Z'), config, seeded(1)); // 23:59 VN
  const next = __test.decideSpin(state, '42', Date.parse('2026-12-05T17:01:00Z'), config, seeded(1)); // 00:01 VN
  assert.equal(next.alreadySpun, false);
});

test('never more than winsPerDay wins in a day, even with many spinners', () => {
  const state = __test.emptyState();
  const rng = seeded(7);
  const dayStart = __test.localDayStart('2026-12-05');
  let wins = 0;
  for (let i = 0; i < 500; i += 1) {
    const at = dayStart + Math.floor((i / 500) * 24 * 3600000);
    const { result } = __test.decideSpin(state, String(1000 + i), at, config, rng);
    if (result.type === 'win') wins += 1;
  }
  assert.equal(wins, 5);
});


test('total stock is never exceeded across the whole campaign', () => {
  const state = __test.emptyState();
  const rng = seeded(11);
  for (let d = 0; d < 30; d += 1) {
    const dayKey = __test.localDayKey(Date.parse('2026-12-01T05:00:00Z') + d * 86400000);
    const dayStart = __test.localDayStart(dayKey);
    for (let i = 0; i < 100; i += 1) {
      __test.decideSpin(state, `${d}-${i}`, dayStart + 23.5 * 3600000 - i, config, rng);
    }
  }
  const totalStock = config.prizes.reduce((s, p) => s + p.stock, 0);
  assert.equal(state.winners.length, totalStock);
  for (const p of config.prizes) assert.equal(state.awarded[p.key], p.stock);
});

test('customer history: prize expires 30 days after winning and is added once', () => {
  const result = { id: '20261205-42', type: 'win', key: 'p7', name: 'Cốc gốm (SECRET)', at: Date.parse('2026-12-05T10:00:00Z'), day: '2026-12-05' };
  let history = __test.applyToCustomerHistory({}, result);
  history = __test.applyToCustomerHistory(history, result);
  assert.equal(history.prizes.length, 1);
  assert.equal(history.spins.length, 1);
  assert.equal(history.prizes[0].expires_at, '2027-01-04T10:00:00.000Z');
});


test('chapter cards do not use up the daily win cap or prize stock', () => {
  const state = __test.emptyState();
  const before = __test.localDayStart('2026-12-05') + 7 * 3600000;
  for (let i = 0; i < 20; i += 1) __test.decideSpin(state, 'c' + i, before, config, seeded(i));
  assert.equal(state.winners.length, 0);
  assert.deepEqual(state.awarded, {});
});

test('ledger: one key per local day, entries added once', () => {
  assert.equal(__test.ledgerKey(config, '2026-12-05'), 'ledger_default_20261205');
  assert.equal(__test.ledgerKey(config, '20261205-42'), 'ledger_default_20261205');
  const result = { id: '20261205-42', type: 'card', key: 'card', name: 'Thẻ chương 10 năm', at: Date.parse('2026-12-05T10:00:00Z'), day: '2026-12-05' };
  let list = __test.addLedgerEntry(null, result, '42');
  list = __test.addLedgerEntry(list, result, '42');
  assert.equal(list.length, 1);
  assert.equal(list[0].status, 'pending');
  assert.equal(list[0].expires_at, '2027-01-04T10:00:00.000Z');
});

test('ledger + customer: marking as sent updates both, unknown id fails', () => {
  const result = { id: '20261205-42', type: 'win', key: 'p1', name: 'Summer sock', at: Date.parse('2026-12-05T10:00:00Z'), day: '2026-12-05' };
  const list = __test.setLedgerStatus(__test.addLedgerEntry([], result, '42'), '20261205-42', 'sent', Date.parse('2026-12-06T02:00:00Z'));
  assert.equal(list[0].status, 'sent');
  assert.equal(list[0].sent_at, '2026-12-06T02:00:00.000Z');
  assert.throws(() => __test.setLedgerStatus(list, 'nope', 'sent'), /not found/);

  const history = __test.setPrizeStatus(__test.applyToCustomerHistory({}, result), '20261205-42', 'sent');
  assert.equal(history.prizes[0].status, 'sent');
});

test('win chance: reaching a drop time does not guarantee a win', () => {
  const low = __test.buildConfig({ ...rawSettings(), lucky_wheel_win_chance: 10 });
  assert.equal(low.winChance, 0.1);
  const dayStart = __test.localDayStart('2026-12-05');
  // First spinner right after every drop: with 10% chance most of them must not win
  let firstSpinWins = 0;
  for (let trial = 0; trial < 200; trial += 1) {
    const state = __test.emptyState();
    const rng = seeded(1000 + trial);
    __test.decideSpin(state, 'warmup', dayStart + 60000, low, rng); // creates the day (00:01, before drops)
    const firstDrop = state.days['2026-12-05'].winTimes[0];
    const { result } = __test.decideSpin(state, 'x' + trial, firstDrop + 1000, low, rng);
    if (result.type === 'win') firstSpinWins += 1;
  }
  assert.ok(firstSpinWins < 60, 'expected ~10% wins, got ' + firstSpinWins + '/200');
  assert.ok(firstSpinWins > 0);
});

test('win chance 100%: first spinner after a drop always wins', () => {
  const sure = __test.buildConfig({ ...rawSettings(), lucky_wheel_win_chance: 100 });
  const dayStart = __test.localDayStart('2026-12-05');
  const state = __test.emptyState();
  const rng = seeded(9);
  __test.decideSpin(state, 'warmup', dayStart + 60000, sure, rng);
  const firstDrop = state.days['2026-12-05'].winTimes[0];
  assert.equal(__test.decideSpin(state, 'a', firstDrop + 1000, sure, rng).result.type, 'win');
});

test('admin delete: a deleted win goes back to stock, reopens the slot and the customer can spin again', () => {
  const sure = __test.buildConfig({ ...rawSettings(), lucky_wheel_win_chance: 100 });
  const state = __test.emptyState();
  const rng = seeded(4);
  const dayStart = __test.localDayStart('2026-12-05');
  __test.decideSpin(state, 'warmup', dayStart + 60000, sure, rng);
  const drop = state.days['2026-12-05'].winTimes[0];
  const { result } = __test.decideSpin(state, '55', drop + 1000, sure, rng);
  assert.equal(result.type, 'win');
  assert.equal(state.awarded[result.key], 1);

  __test.removeFromState(state, result.id, '55');
  assert.equal(state.awarded[result.key], 0);
  assert.equal(state.winners.length, 0);
  assert.equal(state.days['2026-12-05'].wins, 0);
  assert.equal(state.days['2026-12-05'].spins['55'], undefined);

  const again = __test.decideSpin(state, '55', drop + 2000, sure, rng);
  assert.equal(again.alreadySpun, false);
});

test('admin delete: removes the spin and prize from the customer history only', () => {
  const r1 = { id: '20261205-55', type: 'card', key: 'card', name: 'Thẻ chương 10 năm', at: Date.parse('2026-12-05T10:00:00Z'), day: '2026-12-05' };
  const r2 = { id: '20261206-55', type: 'win', key: 'p1', name: 'Summer sock', at: Date.parse('2026-12-06T10:00:00Z'), day: '2026-12-06' };
  let h = __test.applyToCustomerHistory(__test.applyToCustomerHistory({}, r1), r2);
  h = __test.removeFromHistory(h, '20261205-55');
  assert.deepEqual(h.prizes.map((p) => p.id), ['20261206-55']);
  assert.deepEqual(h.spins.map((p) => p.id), ['20261206-55']);
});

/* ---------------- Gifts ship with the next order ---------------- */

const crypto = require('node:crypto');

test('product settings are read as handles (plain or shopify:// form)', () => {
  assert.equal(__test.productHandleFromSetting('summer-sock'), 'summer-sock');
  assert.equal(__test.productHandleFromSetting('shopify://products/Summer-Sock'), 'summer-sock');
  assert.equal(__test.productHandleFromSetting(''), '');
  assert.equal(__test.productHandleFromSetting('bad handle/../x'), '');
});

test('buildConfig keeps prize products, card product and the minimum order', () => {
  const config = __test.buildConfig({
    ...rawSettings(),
    lucky_wheel_prize_1_product: 'summer-sock',
    lucky_wheel_card_product: 'the-chuong',
    lucky_wheel_card_name: '',
    lucky_wheel_min_order: 500000
  });
  assert.equal(config.prizes.find((p) => p.key === 'p1').productHandle, 'summer-sock');
  assert.equal(config.consolation.productHandle, 'the-chuong');
  assert.equal(config.consolation.name, ''); // product title is filled in later
  assert.equal(config.minOrder, 500000);
  assert.equal(__test.buildConfig(rawSettings()).minOrder, 0);
});


function prizeHistory() {
  return { spins: [], prizes: [
    { id: '20261205-42', name: 'Summer sock', status: 'pending', won_at: '2026-12-05T02:00:00Z', expires_at: '2027-01-04T02:00:00Z' },
    { id: '20261206-42', name: 'Thẻ chương 10 năm', status: 'pending', won_at: '2026-12-06T02:00:00Z', expires_at: '2027-01-05T02:00:00Z' },
    { id: '20261101-42', name: 'Sticker', status: 'pending', won_at: '2026-11-01T02:00:00Z', expires_at: '2026-12-01T02:00:00Z' },
    { id: '20261102-42', name: 'Bài Ngọ', status: 'sent', won_at: '2026-11-02T02:00:00Z', expires_at: '2026-12-02T02:00:00Z' },
    { id: '20261220-42', name: 'Mũ Cruiser', status: 'pending', won_at: '2026-12-20T02:00:00Z', expires_at: '2027-01-19T02:00:00Z' }
  ] };
}

test('the next order takes every waiting, unexpired prize won before it', () => {
  const order = { id: '1001', name: '#1001', created_at: '2026-12-10T05:00:00Z', total: 900000, cancelled: false };
  const { history, attached } = __test.attachPrizesToOrder(prizeHistory(), order, 0);
  assert.deepEqual(attached.map((p) => p.id), ['20261205-42', '20261206-42']);
  const byId = Object.fromEntries(history.prizes.map((p) => [p.id, p]));
  assert.equal(byId['20261205-42'].status, 'attached');
  assert.equal(byId['20261205-42'].order.name, '#1001');
  assert.equal(byId['20261101-42'].status, 'pending'); // expired before the order
  assert.equal(byId['20261102-42'].status, 'sent'); // already sent
  assert.equal(byId['20261220-42'].status, 'pending'); // won after the order
  assert.equal(__test.giftNote(attached), '🎁 Gửi kèm quà vòng quay may mắn: Summer sock, Thẻ chương 10 năm');
});

test('a repeated webhook for the same order attaches nothing new; another order cannot take them', () => {
  const order = { id: '1001', name: '#1001', created_at: '2026-12-10T05:00:00Z', total: 900000 };
  const first = __test.attachPrizesToOrder(prizeHistory(), order, 0);
  const again = __test.attachPrizesToOrder(first.history, order, 0);
  assert.equal(again.attached.length, 0);
  assert.equal(again.already.length, 2);
  const other = __test.attachPrizesToOrder(first.history, { ...order, id: '1002', name: '#1002', created_at: '2026-12-11T05:00:00Z' }, 0);
  assert.equal(other.attached.length, 0);
});

test('orders under the minimum or cancelled take no prizes', () => {
  const order = { id: '1001', name: '#1001', created_at: '2026-12-10T05:00:00Z', total: 300000 };
  assert.equal(__test.attachPrizesToOrder(prizeHistory(), order, 500000).attached.length, 0);
  assert.equal(__test.attachPrizesToOrder(prizeHistory(), { ...order, total: 900000, cancelled: true }, 0).attached.length, 0);
});

test('detaching a prize (cancelled order) sends it back to waiting; un-sending keeps its order', () => {
  const prize = { status: 'attached', order: { id: '1001', name: '#1001' } };
  __test.applyStatus(prize, 'sent');
  assert.equal(prize.status, 'sent');
  __test.applyStatus(prize, 'attached');
  assert.equal(prize.status, 'attached');
  assert.equal(prize.order.name, '#1001');
  __test.applyStatus(prize, 'pending');
  assert.equal(prize.status, 'pending');
  assert.equal(prize.order, undefined);
  __test.applyStatus(prize, 'attached'); // no order -> stays waiting
  assert.equal(prize.status, 'pending');
});

test('webhook signature must match the app secret', () => {
  const body = Buffer.from('{"id":1}');
  const good = crypto.createHmac('sha256', 's3cret').update(body).digest('base64');
  assert.equal(__test.verifyWebhookHmac(body, good, 's3cret'), true);
  assert.equal(__test.verifyWebhookHmac(body, good, 'other'), false);
  assert.equal(__test.verifyWebhookHmac(Buffer.from('{"id":2}'), good, 's3cret'), false);
  assert.equal(__test.verifyWebhookHmac(body, '', 's3cret'), false);
});

test('webhook payload: only a plain numeric order id is used', () => {
  assert.equal(__test.webhookOrderGid({ admin_graphql_api_id: 'gid://shopify/Order/123', id: 123 }), 'gid://shopify/Order/123');
  assert.equal(__test.webhookOrderGid({ id: 456 }), 'gid://shopify/Order/456');
  assert.equal(__test.webhookOrderGid({ admin_graphql_api_id: 'gid://shopify/Customer/1' }), null);
  assert.equal(__test.webhookOrderGid({ id: '1 OR 1' }), null);
  assert.equal(__test.webhookOrderGid({}), null);
});

test('requests that do not look like a Shopify orders/create webhook are rejected before any API call', async () => {
  const { handleOrderWebhook } = require('../lib/lucky-wheel-store');
  const body = [Buffer.from('{"id":1}')];
  await assert.rejects(handleOrderWebhook(body, { 'x-shopify-topic': 'orders/create' }), /Not a Shopify order webhook/);
  await assert.rejects(handleOrderWebhook(body, { 'x-shopify-topic': 'customers/create', 'x-shopify-webhook-id': 'x' }), /Not a Shopify order webhook/);
});

/* ---------------- Per-account limits, chapter-card drops, better luck next time ---------------- */

test('before the first drop times every spin is "better luck next time" and nothing is kept', () => {
  const state = __test.emptyState();
  const before = __test.localDayStart('2026-12-05') + 7 * 3600000; // 07:00 VN, window starts 08:00
  for (let i = 0; i < 30; i += 1) {
    const { result } = __test.decideSpin(state, String(i), before, config, seeded(3));
    assert.equal(result.type, 'lose');
    assert.equal(result.name, 'Chúc bạn may mắn lần sau');
    assert.equal(__test.applyToCustomerHistory({}, result).prizes.length, 0);
  }
});

test('chapter cards: at most one per due drop, spread over the day, 50 per day by default', () => {
  const state = __test.emptyState();
  const day = '2026-12-05';
  const end = __test.localDayStart(day) + 23.9 * 3600000; // all drops due
  let cards = 0;
  for (let i = 0; i < 300; i += 1) {
    const { result } = __test.decideSpin(state, 'c' + i, end, { ...config, winsPerDay: 0 }, seeded(i + 1));
    if (result.type === 'card') cards += 1;
  }
  assert.equal(cards, 50);
  assert.equal(state.days[day].cardTimes.length, 50);
});

test('per account: 1 prize + 1 chapter card at most', () => {
  const state = __test.emptyState();
  const always = () => 0; // every chance succeeds
  const types = [];
  for (let d = 5; d <= 9; d += 1) {
    const at = __test.localDayStart('2026-12-0' + d) + 23.9 * 3600000;
    types.push(__test.decideSpin(state, '42', at, config, always).result.type);
  }
  assert.deepEqual(types, ['win', 'card', 'lose', 'lose', 'lose']);
  assert.equal(state.cardCounts['42'], 1);
});

test('prizes keep until the configured expiry date (end of that day, Vietnam time)', () => {
  const cfg = __test.buildConfig({ ...rawSettings(), lucky_wheel_prize_expiry: '2026-12-20' });
  const at = __test.localDayStart('2026-12-05') + 23.9 * 3600000;
  const { result } = __test.decideSpin(__test.emptyState(), '7', at, { ...cfg, winsPerDay: 0 }, () => 0);
  assert.equal(result.type, 'card');
  const prize = __test.applyToCustomerHistory({}, result).prizes[0];
  assert.equal(prize.expires_at, '2026-12-20T16:59:59.000Z');
});

test('a prize with stock 0 is not on the wheel; chapter card keeps its product', () => {
  const cfg = __test.buildConfig({ ...rawSettings(), lucky_wheel_prize_3_stock: 0, lucky_wheel_card_product: 'the-chuong' });
  assert.equal(cfg.prizes.some((p) => p.key === 'p3'), false);
  const at = __test.localDayStart('2026-12-05') + 23.9 * 3600000;
  const { result } = __test.decideSpin(__test.emptyState(), '42', at, { ...cfg, winsPerDay: 0 }, () => 0);
  assert.equal(result.product, 'the-chuong');
});

/* ---------------- Scale: compact state under the 128 KB metafield cap ---------------- */

test('spin counters: total and per day, kept days seed older states', () => {
  const state = __test.emptyState();
  const cfg = { ...config, winsPerDay: 0, cardsPerDay: 0 };
  const at = (d) => __test.localDayStart('2026-12-0' + d) + 10 * 3600000;
  for (let i = 0; i < 3; i += 1) __test.decideSpin(state, 'a' + i, at(5), cfg, () => 0.5);
  for (let i = 0; i < 2; i += 1) __test.decideSpin(state, 'b' + i, at(6), cfg, () => 0.5);
  __test.decideSpin(state, 'b0', at(6) + 1000, cfg, () => 0.5); // already spun: not counted
  assert.equal(state.stats.total, 5);
  assert.deepEqual(state.stats.byDay, { '2026-12-05': 3, '2026-12-06': 2 });

  const old = __test.normalizeState({ days: { '2026-12-06': { spins: { x: 'l', y: 'c' } } }, winners: [] });
  assert.deepEqual(old.stats, { total: 2, byDay: { '2026-12-06': 2 } });
});

test('spins are stored compactly and expand back to full results', () => {
  const state = __test.emptyState();
  const at = __test.localDayStart('2026-12-05') + 23.9 * 3600000;
  const { result } = __test.decideSpin(state, '6832336732381', at, config, () => 0);
  assert.equal(result.type, 'win');
  assert.equal(state.days['2026-12-05'].spins['6832336732381'], result.key);
  const again = __test.decideSpin(state, '6832336732381', at + 1000, config, () => 0);
  assert.equal(again.alreadySpun, true);
  assert.equal(again.result.name, result.name);
  assert.equal(again.result.id, result.id);
});

test('3000 spins a day for two days stay well under the 128 KB metafield cap', () => {
  const state = __test.emptyState();
  const rng = seeded(42);
  for (const day of ['2026-12-05', '2026-12-06']) {
    const start = __test.localDayStart(day);
    for (let i = 0; i < 3000; i += 1) {
      const customerId = String(6800000000000 + i * 7919);
      const at = start + 8 * 3600000 + Math.floor(i * (15 * 3600000) / 3000);
      __test.decideSpin(state, customerId, at, config, rng);
    }
  }
  const json = __test.trimStateForSize(state, __test.localDayStart('2026-12-06') + 23 * 3600000);
  const bytes = Buffer.byteLength(json);
  assert.ok(bytes < 131072, 'state is ' + bytes + ' bytes');
  assert.equal(Object.keys(state.days['2026-12-06'].spins).length, 3000);
});

test('near the cap, older days are trimmed first; legacy full-object spins still work', () => {
  const state = __test.emptyState();
  const day1 = '2026-12-05', day2 = '2026-12-06';
  state.days[day1] = { winTimes: [], wins: 0, spins: {}, cardTimes: [], cards: 0 };
  for (let i = 0; i < 9000; i += 1) state.days[day1].spins[String(6800000000000 + i)] = 'l';
  // a legacy record (full object) today
  state.days[day2] = { winTimes: [], wins: 0, cardTimes: [], cards: 0,
    spins: { '42': { id: '20261206-42', type: 'card', key: 'card', name: 'Thẻ chương 10 năm', at: 1, day: day2 } } };
  const json = __test.trimStateForSize(state, __test.localDayStart(day2) + 3600000);
  assert.ok(Buffer.byteLength(json) < 131072);
  assert.equal(Object.keys(state.days[day1].spins).length, 0);
  const again = __test.decideSpin(state, '42', __test.localDayStart(day2) + 7200000, config, () => 0);
  assert.equal(again.alreadySpun, true);
  assert.equal(again.result.type, 'card');
});

test('per account: 2 chapter cards first means no prize afterwards', () => {
  const always = () => 0;
  const at = (d) => __test.localDayStart('2026-12-0' + d) + 23.9 * 3600000;
  const state = __test.emptyState();
  const noPrizes = { ...config, winsPerDay: 0 };
  assert.equal(__test.decideSpin(state, '5', at(5), noPrizes, always).result.type, 'card');
  assert.equal(__test.decideSpin(state, '5', at(6), noPrizes, always).result.type, 'card');
  assert.equal(__test.decideSpin(state, '5', at(7), config, always).result.type, 'lose');
});

test('reward cap per account is configurable (0 = no limit) and counts cards given before', () => {
  const always = () => 0;
  const at = (d) => __test.localDayStart('2026-12-0' + d) + 23.9 * 3600000;
  const cfg0 = { ...__test.buildConfig({ ...rawSettings(), lucky_wheel_rewards_per_account: 0 }), winsPerDay: 0 };
  const s0 = __test.emptyState();
  assert.deepEqual([5, 6, 7].map((d) => __test.decideSpin(s0, '9', at(d), cfg0, always).result.type), ['card', 'card', 'card']);

  // a state upgraded with counts taken from the ledger: this customer already has 3 cards
  const s1 = { ...__test.emptyState(), cardCounts: { '9': 3 } };
  const cfg = { ...config, winsPerDay: 0 };
  assert.equal(__test.decideSpin(s1, '9', at(5), cfg, always).result.type, 'lose');
  assert.equal(__test.decideSpin(s1, '10', at(5), cfg, always).result.type, 'card');
});

test('deleting a chapter card spin gives the card back to the customer', () => {
  const cfg = { ...config, winsPerDay: 0 };
  const state = __test.emptyState();
  const { result } = __test.decideSpin(state, '9', __test.localDayStart('2026-12-05') + 23.9 * 3600000, cfg, () => 0);
  assert.equal(state.cardCounts['9'], 1);
  __test.removeFromState(state, result.id, '9');
  assert.equal(state.cardCounts['9'], undefined);
});

test('setting or changing dates never switches the campaign; only an explicit id does', () => {
  assert.equal(__test.buildConfig({ ...rawSettings(), lucky_wheel_start: '2026-11-24 00:00' }).campaignId, 'default');
  assert.equal(__test.buildConfig({ ...rawSettings(), lucky_wheel_campaign_id: 'Tet-2027' }).campaignId, 'tet-2027');
});
