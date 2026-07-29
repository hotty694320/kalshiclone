'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  currentMarket,
  formatCountdown,
  marketKey,
} = require('../public/kalshi-countdown');

test('formats a live market countdown as tabular minutes and seconds', () => {
  const now = 1_000_000;
  assert.equal(formatCountdown(now + 8 * 60_000 + 8_000, now), '08:08');
  assert.equal(formatCountdown(now + 65_000, now), '01:05');
});

test('keeps a partial final second visible and clamps after market close', () => {
  const close = 2_000_000;
  assert.equal(formatCountdown(close, close - 1), '00:01');
  assert.equal(formatCountdown(close, close), '00:00');
  assert.equal(formatCountdown(close, close + 5_000), '00:00');
});

test('shows a placeholder when the market close time is unavailable', () => {
  assert.equal(formatCountdown(null, Date.now()), '--:--');
  assert.equal(formatCountdown('not-a-time', Date.now()), '--:--');
});

test('selects only the nearest unexpired market for an atomic rollover', () => {
  const now = 5_000_000;
  const market = currentMarket([
    { ticker: 'EXPIRED', closeTime: now, status: 'active' },
    { ticker: 'LATER', closeTime: now + 1_800_000, status: 'active' },
    { ticker: 'NEXT', eventTicker: 'EVENT-NEXT', closeTime: now + 900_000, status: 'active' },
  ], now);

  assert.equal(market.ticker, 'NEXT');
  assert.equal(marketKey(market), 'EVENT-NEXT');
});
