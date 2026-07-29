'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SettlementProbabilityModel,
  blendProbabilities,
  marketProbability,
} = require('../lib/settlement-probability-model');

const CUTOFF = Date.UTC(2026, 6, 29, 17, 12, 0);
const CLOSE = CUTOFF + 180_000;

function healthyTicks(basePrice) {
  return Array.from({ length: 600 }, (_, index) => {
    const timestamp = CUTOFF - 600_000 + index * 1_000;
    const oscillation = Math.sin(index / 7) * 1.5 + Math.sin(index / 19) * 0.8;
    return {
      source_ts_ms: timestamp,
      received_ts_ms: timestamp + 100,
      price: basePrice + oscillation,
    };
  });
}

test('produces a deterministic bounded settlement probability', () => {
  const model = new SettlementProbabilityModel({ paths: 2_000 });
  const input = {
    marketTicker: 'KXBTC15M-TEST',
    targetPrice: 64_000,
    closeTimestamp: CLOSE,
    cutoffTimestamp: CUTOFF,
    ticks: healthyTicks(64_000),
    marketQuote: { yesBid: 0.52, yesAsk: 0.54 },
  };
  const first = model.predict(input);
  const second = model.predict(input);

  assert.deepEqual(first, second);
  assert.equal(first.status, 'generated');
  assert.equal(first.dataHealth, 'healthy');
  assert.ok(first.independentProbabilityUp >= 0.02);
  assert.ok(first.independentProbabilityUp <= 0.98);
  assert.ok(first.assistedProbabilityUp >= 0.02);
  assert.ok(first.assistedProbabilityUp <= 0.98);
  assert.equal(first.features.pathCount, 2_000);
  assert.equal(first.features.settlementStartSecond, 120);
});

test('probability rises when the full observed path is higher relative to the same target', () => {
  const model = new SettlementProbabilityModel({ paths: 2_000 });
  const lower = model.predict({
    marketTicker: 'LOWER',
    targetPrice: 64_000,
    closeTimestamp: CLOSE,
    cutoffTimestamp: CUTOFF,
    ticks: healthyTicks(63_990),
  });
  const higher = model.predict({
    marketTicker: 'HIGHER',
    targetPrice: 64_000,
    closeTimestamp: CLOSE,
    cutoffTimestamp: CUTOFF,
    ticks: healthyTicks(64_010),
  });
  assert.ok(higher.independentProbabilityUp > lower.independentProbabilityUp);
});

test('fails closed with insufficient cutoff-safe history', () => {
  const model = new SettlementProbabilityModel({ paths: 100 });
  const result = model.predict({
    marketTicker: 'SHORT',
    targetPrice: 64_000,
    closeTimestamp: CLOSE,
    cutoffTimestamp: CUTOFF,
    ticks: healthyTicks(64_000).slice(-299),
  });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.dataHealth, 'unavailable');
  assert.match(result.reason, /at least 300/i);
});

test('keeps the market-assisted probability unavailable without a valid quote', () => {
  const model = new SettlementProbabilityModel({ paths: 500 });
  const result = model.predict({
    marketTicker: 'NO-QUOTE',
    targetPrice: 64_000,
    closeTimestamp: CLOSE,
    cutoffTimestamp: CUTOFF,
    ticks: healthyTicks(64_000),
  });
  assert.equal(result.status, 'generated');
  assert.equal(result.marketProbabilityUp, null);
  assert.equal(result.assistedProbabilityUp, null);
});

test('derives the market midpoint and blends in log-odds space', () => {
  assert.deepEqual(
    marketProbability({ yesBid: 0.6, yesAsk: 0.64 }),
    { probability: 0.62, spread: 0.040000000000000036 },
  );
  const blended = blendProbabilities(0.5, 0.8);
  assert.ok(blended > 0.5);
  assert.ok(blended < 0.8);
});
