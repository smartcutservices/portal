'use strict';

function asDate(value) {
  if (value && typeof value.toDate === 'function') return value.toDate();
  if (value instanceof Date) return value;
  if (typeof value === 'number' || typeof value === 'string') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

function partsFor(date, timeZone) {
  return Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date).map(({ type, value }) => [type, value]));
}

function dayKey(value, timeZone) {
  const date = asDate(value);
  if (!date) return '';
  const parts = partsFor(date, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function buildPartnerResultsTrend({ days = 30, now = new Date(), timeZone = 'America/Port-au-Prince', orders = [], results = [], isAssignedOrder = () => true } = {}) {
  const length = [7, 30, 90].includes(Number(days)) ? Number(days) : 30;
  const current = asDate(now) || new Date();
  const today = partsFor(current, timeZone);
  const calendarStart = Date.UTC(Number(today.year), Number(today.month) - 1, Number(today.day), 12);
  const rows = Array.from({ length }, (_, index) => {
    const date = new Date(calendarStart - (length - index - 1) * 86_400_000);
    const parts = partsFor(date, 'UTC');
    const key = `${parts.year}-${parts.month}-${parts.day}`;
    return { date: key, label: date.toLocaleDateString('fr-HT', { timeZone: 'UTC', day: '2-digit', month: 'short' }), assignedOrders: 0, resultsReceived: 0 };
  });
  const byDate = new Map(rows.map((row) => [row.date, row]));
  for (const order of orders) {
    if (!isAssignedOrder(order)) continue;
    const row = byDate.get(dayKey(order.createdAt, timeZone));
    if (row) row.assignedOrders += 1;
  }
  for (const result of results) {
    const row = byDate.get(dayKey(result.createdAt, timeZone));
    if (row) row.resultsReceived += 1;
  }
  return rows;
}

module.exports = { asDate, dayKey, buildPartnerResultsTrend };
