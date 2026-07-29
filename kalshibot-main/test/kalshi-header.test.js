'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  formatDelta,
  formatEtTime,
  formatPrice,
} = require('../public/kalshi-header');

test('formats the Kalshi TO BEAT amount and ET close time', () => {
  assert.equal(formatPrice(63_955.48), '$63,955.48');
  assert.equal(formatEtTime(Date.parse('2026-07-29T16:45:00Z')), '12:45pm ET');
});

test('formats a negative Kalshi NOW move exactly', () => {
  assert.deepEqual(formatDelta(63_773.81, 63_955.48), {
    text: '-$181.67 (-0.284%)',
    direction: 'negative',
  });
});

test('formats a positive Kalshi NOW move with explicit plus signs', () => {
  assert.deepEqual(formatDelta(63_969.76, 63_955.48), {
    text: '+$14.28 (+0.022%)',
    direction: 'positive',
  });
});

test('fails closed until both live values are available', () => {
  assert.deepEqual(formatDelta(null, 63_955.48), {
    text: '--',
    direction: 'neutral',
  });
});
