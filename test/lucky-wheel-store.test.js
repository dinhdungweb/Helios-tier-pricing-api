const test = require('node:test');
const assert = require('node:assert/strict');

const { __test } = require('../lib/lucky-wheel-store');

const SECRET = 'test-secret';

const config = __test.buildConfig({
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
});

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

test('no wins before the first random drop time (everyone gets the chapter card)', () => {
  const state = __test.emptyState();
  const before = __test.localDayStart('2026-12-05') + 7 * 3600000; // 07:00 VN, window starts 08:00
  for (let i = 0; i < 50; i += 1) {
    const { result } = __test.decideSpin(state, String(i), before, config, seeded(3));
    assert.equal(result.type, 'card');
    assert.equal(result.name, 'Thẻ chương 10 năm');
  }
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

test('chapter card spins are saved to the customer prizes with a 30-day expiry', () => {
  const state = __test.emptyState();
  const before = __test.localDayStart('2026-12-05') + 7 * 3600000;
  const { result } = __test.decideSpin(state, '77', before, config, seeded(5));
  assert.equal(result.key, 'card');
  const history = __test.applyToCustomerHistory({}, result);
  assert.equal(history.prizes.length, 1);
  assert.equal(history.prizes[0].name, 'Thẻ chương 10 năm');
  assert.equal(Date.parse(history.prizes[0].expires_at) - result.at, 30 * 86400000);
});

test('chapter cards do not use up the daily win cap or prize stock', () => {
  const state = __test.emptyState();
  const before = __test.localDayStart('2026-12-05') + 7 * 3600000;
  for (let i = 0; i < 20; i += 1) __test.decideSpin(state, 'c' + i, before, config, seeded(i));
  assert.equal(state.winners.length, 0);
  assert.deepEqual(state.awarded, {});
});

test('ledger: one key per local day, entries added once', () => {
  assert.equal(__test.ledgerKey(config, '2026-12-05'), 'ledger_20261201_20261205');
  assert.equal(__test.ledgerKey(config, '20261205-42'), 'ledger_20261201_20261205');
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
