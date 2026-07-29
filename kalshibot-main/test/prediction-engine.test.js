'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PredictionDatasetStore } = require('../lib/prediction-dataset-store');
const {
  FINAL_OFFSET_MS,
  PredictionEngine,
} = require('../lib/prediction-engine');
const { MODEL_NAME, MODEL_VERSION } = require('../lib/settlement-probability-model');

function setup() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kalshibot-engine-'));
  const store = new PredictionDatasetStore(path.join(directory, 'test.db'));
  const open = Date.UTC(2026, 6, 29, 17, 0, 0);
  const market = {
    ticker: 'KXBTC15M-ENGINE',
    eventTicker: 'KXBTC15M-ENGINE',
    openTime: open,
    closeTime: open + 900_000,
    targetPrice: 64_000,
    yesBid: 0.48,
    yesAsk: 0.52,
    status: 'open',
  };
  store.upsertMarket(market, open);
  const updates = [];
  const state = {
    updatePrediction(value) {
      updates.push(value);
      this.prediction = value;
    },
  };
  const model = {
    calls: [],
    predict(input) {
      this.calls.push(input);
      return {
        status: 'generated',
        dataHealth: 'healthy',
        reason: null,
        independentProbabilityUp: 0.64,
        marketProbabilityUp: 0.5,
        assistedProbabilityUp: 0.57,
        latestSourceTimestamp: input.cutoffTimestamp - 1_000,
        latestReceivedTimestamp: input.cutoffTimestamp - 500,
        features: { pathCount: 20_000 },
      };
    },
  };
  return { directory, store, market, state, updates, model };
}

test('locks once at the exact 12-minute checkpoint and restores it on restart', () => {
  const context = setup();
  const { directory, store, market, state, model } = context;
  try {
    const engine = new PredictionEngine({
      store,
      state,
      model,
      now: () => market.openTime,
    });
    engine.handleMarkets([market], market.openTime);
    assert.equal(state.prediction.status, 'analyzing');

    engine.handleMarkets([market], market.openTime + FINAL_OFFSET_MS - 1_000);
    engine.tick(market.openTime + FINAL_OFFSET_MS);
    assert.equal(state.prediction.status, 'finalized');
    assert.deepEqual(state.prediction.independent, { up: 0.64, down: 0.36 });
    assert.deepEqual(state.prediction.marketAssisted, { up: 0.57, down: 0.43 });
    assert.equal(model.calls.at(-1).cutoffTimestamp, market.openTime + FINAL_OFFSET_MS);

    const countAfterLock = store.status().predictions;
    engine.tick(market.openTime + FINAL_OFFSET_MS + 1_000);
    assert.equal(store.status().predictions, countAfterLock);

    const restartedState = { updatePrediction(value) { this.prediction = value; } };
    const restarted = new PredictionEngine({
      store,
      state: restartedState,
      model,
      now: () => market.openTime + FINAL_OFFSET_MS + 30_000,
    });
    restarted.handleMarkets([market], market.openTime + FINAL_OFFSET_MS + 30_000);
    assert.equal(restartedState.prediction.status, 'finalized');
    assert.equal(model.calls.filter(call => call.cutoffTimestamp === market.openTime + FINAL_OFFSET_MS).length, 1);
  } finally {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('marks a deadline missed instead of creating a retroactive forecast', () => {
  const { directory, store, market, state, model } = setup();
  try {
    const late = market.openTime + FINAL_OFFSET_MS + 3_000;
    const engine = new PredictionEngine({ store, state, model, now: () => late });
    engine.handleMarkets([market], late);
    assert.equal(state.prediction.status, 'missed');
    assert.equal(model.calls.length, 0);
    const record = store.getPrediction(
      market.ticker,
      MODEL_NAME,
      MODEL_VERSION,
      FINAL_OFFSET_MS,
    );
    assert.equal(record.status, 'missed');
    assert.equal(record.immutable_finalized, 1);
  } finally {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('resets to analyzing when a new market rolls over', () => {
  const { directory, store, market, state, model } = setup();
  try {
    const engine = new PredictionEngine({ store, state, model, now: () => market.openTime });
    engine.handleMarkets([market], market.openTime);
    const next = {
      ...market,
      ticker: 'KXBTC15M-NEXT',
      eventTicker: 'KXBTC15M-NEXT',
      openTime: market.closeTime,
      closeTime: market.closeTime + 900_000,
    };
    store.upsertMarket(next, next.openTime);
    engine.handleMarkets([next], next.openTime);
    assert.equal(state.prediction.marketTicker, next.ticker);
    assert.equal(state.prediction.status, 'analyzing');
    assert.deepEqual(state.prediction.independent, { up: null, down: null });
  } finally {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
