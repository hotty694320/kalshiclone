'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { PredictionDatasetStore } = require('../lib/prediction-dataset-store');

function setup() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kalshibot-dataset-'));
  const store = new PredictionDatasetStore(path.join(directory, 'test.db'));
  const open = Date.UTC(2026, 6, 29, 17, 0, 0);
  const market = {
    ticker: 'KXBTC15M-TEST',
    eventTicker: 'KXBTC15M-TEST-EVENT',
    openTime: open,
    closeTime: open + 900_000,
    targetPrice: 64_000,
    targetSource: 'kalshi_floor_strike',
  };
  store.upsertMarket(market, open);
  return { directory, store, market };
}

function settlementTicks(market, price) {
  return Array.from({ length: 60 }, (_, index) => ({
    timestamp: market.closeTime - 60_000 + index * 1_000,
    price,
  }));
}

test('stores and grades both correct and failed opening predictions', () => {
  const { directory, store, market } = setup();
  try {
    assert.equal(store.recordPrediction({
      marketTicker: market.ticker,
      predictionTimestamp: market.openTime,
      modelName: 'candidate',
      modelVersion: 'v1',
      probabilityUp: 0.8,
      latestSourceTimestamp: market.openTime - 1_000,
      latestReceivedTimestamp: market.openTime - 1_000,
      features: { distance: -0.001 },
    }).leakageSafe, true);
    store.recordPrediction({
      marketTicker: market.ticker,
      predictionTimestamp: market.openTime,
      modelName: 'challenger',
      modelVersion: 'v1',
      probabilityUp: 0.2,
      latestSourceTimestamp: market.openTime - 1_000,
      latestReceivedTimestamp: market.openTime - 1_000,
    });
    store.ingestTicks(settlementTicks(market, 64_100), market.closeTime);
    const result = store.gradeSettlements(market.closeTime);
    assert.equal(result[0].actualOutcome, 'up');
    assert.deepEqual(store.status(), {
      ticks: 60,
      markets: 1,
      finalMarkets: 1,
      predictions: 2,
      gradedPredictions: 2,
      failedPredictions: 1,
    });
  } finally {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('does not finalize a label when any settlement second is missing', () => {
  const { directory, store, market } = setup();
  try {
    store.ingestTicks(settlementTicks(market, 63_900).slice(0, 59), market.closeTime);
    const result = store.gradeSettlements(market.closeTime);
    assert.equal(result[0].status, 'incomplete');
    assert.equal(store.status().finalMarkets, 0);
  } finally {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('allows later checkpoints when every input is cutoff-safe', () => {
  const { directory, store, market } = setup();
  try {
    const result = store.recordPrediction({
      marketTicker: market.ticker,
      predictionTimestamp: market.openTime + 5_000,
      checkpointOffsetMs: 5_000,
      featureCutoffTimestamp: market.openTime + 5_000,
      latestSourceTimestamp: market.openTime + 4_000,
      latestReceivedTimestamp: market.openTime + 4_500,
      modelName: 'late-model',
      modelVersion: 'v1',
      probabilityUp: 0.55,
    });
    assert.equal(result.leakageSafe, true);
    assert.equal(result.offset, 5_000);
  } finally {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('rejects a generated prediction whose inputs cross the cutoff or settlement minute', () => {
  const { directory, store, market } = setup();
  try {
    const futureInput = store.recordPrediction({
      marketTicker: market.ticker,
      predictionTimestamp: market.openTime + 720_000,
      checkpointOffsetMs: 720_000,
      featureCutoffTimestamp: market.openTime + 720_000,
      latestSourceTimestamp: market.openTime + 720_001,
      latestReceivedTimestamp: market.openTime + 720_001,
      modelName: 'unsafe-input',
      modelVersion: 'v1',
      probabilityUp: 0.55,
    });
    assert.equal(futureInput.leakageSafe, false);

    const settlementMinute = store.recordPrediction({
      marketTicker: market.ticker,
      predictionTimestamp: market.closeTime - 60_000,
      checkpointOffsetMs: 840_000,
      featureCutoffTimestamp: market.closeTime - 60_000,
      latestSourceTimestamp: market.closeTime - 61_000,
      latestReceivedTimestamp: market.closeTime - 61_000,
      modelName: 'unsafe-window',
      modelVersion: 'v1',
      probabilityUp: 0.55,
    });
    assert.equal(settlementMinute.leakageSafe, false);
  } finally {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('stores multiple checkpoints and never overwrites an existing checkpoint', () => {
  const { directory, store, market } = setup();
  try {
    const first = store.recordPrediction({
      marketTicker: market.ticker,
      predictionTimestamp: market.openTime + 30_000,
      checkpointOffsetMs: 30_000,
      featureCutoffTimestamp: market.openTime + 30_000,
      latestSourceTimestamp: market.openTime + 29_000,
      latestReceivedTimestamp: market.openTime + 29_000,
      modelName: 'structural',
      modelVersion: 'v1',
      probabilityUp: 0.6,
    });
    const second = store.recordPrediction({
      marketTicker: market.ticker,
      predictionTimestamp: market.openTime + 120_000,
      checkpointOffsetMs: 120_000,
      featureCutoffTimestamp: market.openTime + 120_000,
      latestSourceTimestamp: market.openTime + 119_000,
      latestReceivedTimestamp: market.openTime + 119_000,
      modelName: 'structural',
      modelVersion: 'v1',
      probabilityUp: 0.7,
    });
    const duplicate = store.recordPrediction({
      marketTicker: market.ticker,
      predictionTimestamp: market.openTime + 30_000,
      checkpointOffsetMs: 30_000,
      featureCutoffTimestamp: market.openTime + 30_000,
      latestSourceTimestamp: market.openTime + 29_000,
      latestReceivedTimestamp: market.openTime + 29_000,
      modelName: 'structural',
      modelVersion: 'v1',
      probabilityUp: 0.1,
    });

    assert.equal(first.inserted, true);
    assert.equal(second.inserted, true);
    assert.equal(duplicate.inserted, false);
    assert.equal(duplicate.record.probability_up, 0.6);
    assert.deepEqual(
      store.predictionOffsets(market.ticker, 'structural', 'v1'),
      [30_000, 120_000],
    );
  } finally {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('rounds the final 60-second average to two decimals before resolving', () => {
  const { directory, store, market } = setup();
  try {
    market.targetPrice = 64_000.01;
    store.upsertMarket(market, market.openTime);
    store.ingestTicks(settlementTicks(market, 64_000.006), market.closeTime);
    const result = store.gradeSettlements(market.closeTime);
    assert.equal(result[0].settlement, 64_000.01);
    assert.equal(result[0].actualOutcome, 'up');
  } finally {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('migrates legacy prediction rows without losing them', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kalshibot-migration-'));
  const dbPath = path.join(directory, 'legacy.db');
  const db = new Database(dbPath);
  const open = Date.UTC(2026, 6, 29, 17, 0, 0);
  db.exec(`
    CREATE TABLE brti_ticks (
      source_ts_ms INTEGER PRIMARY KEY, price REAL NOT NULL,
      received_ts_ms INTEGER NOT NULL, payload_maturity_ms INTEGER,
      source TEXT NOT NULL DEFAULT 'kalshi_cf_benchmarks_rti'
    ) WITHOUT ROWID;
    CREATE TABLE prediction_markets (
      market_ticker TEXT PRIMARY KEY, event_ticker TEXT, open_ts_ms INTEGER NOT NULL,
      close_ts_ms INTEGER NOT NULL, target_price REAL NOT NULL, target_source TEXT,
      first_seen_ts_ms INTEGER NOT NULL, last_seen_ts_ms INTEGER NOT NULL,
      settlement_value REAL, actual_outcome TEXT, settlement_tick_count INTEGER,
      label_status TEXT NOT NULL DEFAULT 'pending', label_computed_ts_ms INTEGER
    );
    CREATE TABLE opening_predictions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, market_ticker TEXT NOT NULL,
      prediction_ts_ms INTEGER NOT NULL, prediction_offset_ms INTEGER NOT NULL,
      leakage_safe INTEGER NOT NULL, model_name TEXT NOT NULL, model_version TEXT NOT NULL,
      probability_up REAL NOT NULL, predicted_outcome TEXT NOT NULL, features_json TEXT,
      actual_outcome TEXT, correct INTEGER, brier_loss REAL, log_loss REAL,
      graded_ts_ms INTEGER, UNIQUE(market_ticker, model_name, model_version)
    );
    INSERT INTO prediction_markets (
      market_ticker, open_ts_ms, close_ts_ms, target_price, first_seen_ts_ms, last_seen_ts_ms
    ) VALUES ('LEGACY', ${open}, ${open + 900_000}, 64000, ${open}, ${open});
    INSERT INTO opening_predictions (
      market_ticker, prediction_ts_ms, prediction_offset_ms, leakage_safe,
      model_name, model_version, probability_up, predicted_outcome
    ) VALUES ('LEGACY', ${open}, 0, 1, 'legacy-model', 'v1', 0.7, 'up');
  `);
  db.close();

  const store = new PredictionDatasetStore(dbPath);
  try {
    const row = store.getPrediction('LEGACY', 'legacy-model', 'v1', 0);
    assert.equal(row.probability_up, 0.7);
    assert.equal(row.independent_probability_up, 0.7);
    assert.equal(row.checkpoint_label, 'legacy');
  } finally {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
