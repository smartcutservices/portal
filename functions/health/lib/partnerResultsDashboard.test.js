'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPartnerResultsTrend } = require('./partnerResultsDashboard');

test('dashboard trend aggregates real order and result timestamps by Haiti calendar day', () => {
  const now = new Date('2026-10-01T16:00:00.000Z');
  const trend = buildPartnerResultsTrend({
    days: 7,
    now,
    orders: [
      { createdAt: '2026-10-01T08:00:00.000Z', paid: true },
      { createdAt: '2026-09-30T16:00:00.000Z', paid: false },
      { createdAt: '2026-09-25T18:00:00.000Z', paid: true }
    ],
    results: [{ createdAt: '2026-10-01T09:00:00.000Z' }],
    isAssignedOrder: (order) => order.paid
  });

  assert.equal(trend.length, 7);
  assert.equal(trend.at(-1).date, '2026-10-01');
  assert.equal(trend.at(-1).assignedOrders, 1);
  assert.equal(trend.at(-1).resultsReceived, 1);
  assert.equal(trend[0].assignedOrders, 1);
  assert.equal(trend[5].assignedOrders, 0);
});

test('dashboard trend returns actual zero counts and never fills absent dates with sample data', () => {
  const trend = buildPartnerResultsTrend({ days: 7, now: new Date('2026-10-01T16:00:00.000Z') });
  assert.equal(trend.length, 7);
  assert.ok(trend.every((row) => row.assignedOrders === 0 && row.resultsReceived === 0));
});

test('dashboard trend defaults invalid periods to 30 days and ignores invalid timestamps', () => {
  const trend = buildPartnerResultsTrend({ days: 31, now: new Date('2026-10-01T16:00:00.000Z'), results: [{ createdAt: 'not-a-date' }] });
  assert.equal(trend.length, 30);
  assert.ok(trend.every((row) => row.resultsReceived === 0));
});
