'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  currentMarket,
  marketKey,
  rolloverDelay,
} = require('../lib/market-rollover');

test('selects the nearest unexpired 15-minute market', () => {
  const now = 1_000_000;
  const expired = { ticker: 'OLD', closeTime: now, status: 'active' };
  const later = { ticker: 'LATER', closeTime: now + 1_800_000, status: 'active' };
  const next = { ticker: 'NEXT', eventTicker: 'EVENT-NEXT', closeTime: now + 900_000, status: 'active' };

  assert.equal(currentMarket([later, expired, next], now), next);
  assert.equal(marketKey(next), 'EVENT-NEXT');
});

test('schedules discovery precisely after the active market close', () => {
  const now = 2_000_000;
  assert.equal(
    rolloverDelay([{ ticker: 'CURRENT', closeTime: now + 900_000, status: 'active' }], now),
    900_025,
  );
});

test('retries quickly when the previous market expired and the next is not available yet', () => {
  const now = 3_000_000;
  assert.equal(
    rolloverDelay([{ ticker: 'EXPIRED', closeTime: now, status: 'active' }], now),
    500,
  );
  assert.equal(currentMarket([{ ticker: 'CLOSED', closeTime: now + 1_000, status: 'closed' }], now), null);
});
