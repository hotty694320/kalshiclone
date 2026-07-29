'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  formatCents,
  quote,
  tradingFee,
} = require('../public/order-ticket');

test('formats whole-cent and sub-cent Kalshi prices', () => {
  assert.equal(formatCents(0.77), '77¢');
  assert.equal(formatCents(0.998), '99.8¢');
  assert.equal(formatCents(0.038), '3.8¢');
  assert.equal(formatCents(null), '--');
});

test('matches the one-share 99.8 cent buy ticket shown in the reference', () => {
  const result = quote({
    mode: 'buy',
    side: 'no',
    quantity: 1,
    yesAsk: 0.038,
    noAsk: 0.998,
  });

  assert.equal(result.price, 0.998);
  assert.equal(result.gross, 0.998);
  assert.equal(result.fee, 0.01);
  assert.equal(result.total, 1.008);
  assert.equal(result.payout, 1);
  assert.ok(Math.abs(result.profit - (-0.008)) < 1e-12);
});

test('uses the displayed bid for a sell quote and subtracts the fee', () => {
  const result = quote({
    mode: 'sell',
    side: 'yes',
    quantity: 4,
    yesBid: 0.62,
    noBid: 0.37,
  });

  assert.equal(result.price, 0.62);
  assert.equal(result.gross, 2.48);
  assert.equal(result.fee, 0.07);
  assert.equal(result.total, 2.41);
});

test('rounds the general taker fee up to the next cent', () => {
  assert.equal(tradingFee(1, 0.998), 0.01);
  assert.equal(tradingFee(10, 0.5), 0.18);
});

test('fails closed when quantity or a market quote is unavailable', () => {
  assert.equal(quote({ quantity: 0, yesAsk: 0.5 }).valid, false);
  assert.equal(quote({ quantity: 1, yesAsk: null }).valid, false);
});
