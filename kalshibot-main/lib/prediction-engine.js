'use strict';

const {
  HISTORY_WINDOW_MS,
  MODEL_NAME,
  MODEL_VERSION,
  SettlementProbabilityModel,
} = require('./settlement-probability-model');

const FINAL_OFFSET_MS = 12 * 60_000;
const SETTLEMENT_WINDOW_MS = 60_000;
const CHECKPOINTS = Object.freeze([
  { label: '00:30', offsetMs: 30_000 },
  { label: '02:00', offsetMs: 120_000 },
  { label: '05:00', offsetMs: 300_000 },
  { label: '08:00', offsetMs: 480_000 },
  { label: '10:00', offsetMs: 600_000 },
  { label: '11:30', offsetMs: 690_000 },
  { label: '12:00', offsetMs: FINAL_OFFSET_MS, final: true },
]);
const TIMER_INTERVAL_MS = 250;
const CHECKPOINT_GRACE_MS = 2_000;
const QUOTE_HISTORY_MS = 30_000;
const MAX_QUOTE_STALENESS_MS = 10_000;

function finite(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function currentMarket(markets, now) {
  return (Array.isArray(markets) ? markets : [])
    .filter(market => (
      market?.ticker
      && market.status !== 'closed'
      && finite(market.openTime) != null
      && finite(market.closeTime) > now
    ))
    .sort((left, right) => left.closeTime - right.closeTime)[0] || null;
}

function probabilityPair(up) {
  if (finite(up) == null) return { up: null, down: null };
  return {
    up,
    down: Math.round((1 - up) * 1e8) / 1e8,
  };
}

function baseState(market, status, reason = null) {
  const open = finite(market?.openTime);
  return {
    marketTicker: market?.ticker || null,
    status,
    finalizeAt: open == null ? null : open + FINAL_OFFSET_MS,
    finalizedAt: null,
    independent: probabilityPair(null),
    marketAssisted: probabilityPair(null),
    dataHealth: status === 'analyzing' ? 'unavailable' : status,
    reason,
    modelVersion: MODEL_VERSION,
  };
}

class PredictionEngine {
  constructor({
    store,
    state,
    model = new SettlementProbabilityModel(),
    now = () => Date.now(),
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
  }) {
    if (!store) throw new Error('PredictionEngine requires a dataset store');
    if (!state || typeof state.updatePrediction !== 'function') {
      throw new Error('PredictionEngine requires prediction-capable state');
    }
    this.store = store;
    this.state = state;
    this.model = model;
    this.now = now;
    this.setIntervalFn = setIntervalFn;
    this.clearIntervalFn = clearIntervalFn;
    this.market = null;
    this.processedOffsets = new Set();
    this.quoteHistory = [];
    this.timer = null;
  }

  start() {
    if (this.timer) return;
    this.timer = this.setIntervalFn(() => this.tick(), TIMER_INTERVAL_MS);
    this.timer?.unref?.();
  }

  stop() {
    if (this.timer) this.clearIntervalFn(this.timer);
    this.timer = null;
  }

  handleMarkets(markets, observedAt = this.now()) {
    const market = currentMarket(markets, observedAt);
    if (!market) return;
    if (this.market?.ticker !== market.ticker) {
      this._activateMarket(market, observedAt);
    } else {
      this.market = { ...this.market, ...market };
    }
    this._rememberQuote(market, observedAt);
    this.tick(observedAt);
  }

  _rememberQuote(market, observedAt) {
    const yesBid = finite(market?.yesBid);
    const yesAsk = finite(market?.yesAsk);
    if (yesBid != null && yesAsk != null) {
      this.quoteHistory.push({ observedAt, yesBid, yesAsk });
    }
    this.quoteHistory = this.quoteHistory.filter(
      quote => quote.observedAt >= observedAt - QUOTE_HISTORY_MS,
    );
  }

  _activateMarket(market, observedAt) {
    this.market = { ...market };
    this.processedOffsets = new Set(
      this.store.predictionOffsets(
        market.ticker,
        MODEL_NAME,
        MODEL_VERSION,
      ),
    );
    this.quoteHistory = [];

    const final = this.store.getPrediction(
      market.ticker,
      MODEL_NAME,
      MODEL_VERSION,
      FINAL_OFFSET_MS,
    );
    if (final) {
      this.state.updatePrediction(this._publicStateFromRecord(market, final));
      return;
    }

    const deadline = finite(market.openTime) + FINAL_OFFSET_MS;
    if (observedAt > deadline + CHECKPOINT_GRACE_MS) {
      this.tick(observedAt);
      return;
    }
    this.state.updatePrediction(baseState(market, 'analyzing'));
  }

  tick(timestamp = this.now()) {
    const market = this.market;
    if (!market) return;

    const open = finite(market.openTime);
    const close = finite(market.closeTime);
    if (open == null || close == null) return;

    for (const checkpoint of CHECKPOINTS) {
      if (this.processedOffsets.has(checkpoint.offsetMs)) continue;
      const cutoff = open + checkpoint.offsetMs;
      if (timestamp < cutoff) continue;
      if (timestamp > cutoff + CHECKPOINT_GRACE_MS) {
        this.processedOffsets.add(checkpoint.offsetMs);
        if (checkpoint.final) {
          this._markMissed(market, timestamp);
        } else {
          this._recordMissedCheckpoint(market, checkpoint, timestamp);
        }
        continue;
      }
      this._runCheckpoint(market, checkpoint, cutoff, timestamp);
    }
  }

  _quoteAt(cutoff) {
    return this.quoteHistory
      .filter(quote => (
        quote.observedAt <= cutoff
        && quote.observedAt >= cutoff - MAX_QUOTE_STALENESS_MS
      ))
      .sort((left, right) => right.observedAt - left.observedAt)[0] || null;
  }

  _runCheckpoint(market, checkpoint, cutoff, finalizedAt) {
    this.processedOffsets.add(checkpoint.offsetMs);
    const ticks = this.store.ticksForPrediction(
      cutoff - HISTORY_WINDOW_MS,
      cutoff,
      cutoff,
    );
    const quote = this._quoteAt(cutoff);
    const result = this.model.predict({
      marketTicker: market.ticker,
      targetPrice: market.targetPrice,
      closeTimestamp: market.closeTime,
      cutoffTimestamp: cutoff,
      ticks,
      marketQuote: quote,
    });

    const record = this.store.recordPrediction({
      marketTicker: market.ticker,
      predictionTimestamp: finalizedAt,
      checkpointLabel: checkpoint.label,
      checkpointOffsetMs: checkpoint.offsetMs,
      featureCutoffTimestamp: cutoff,
      latestSourceTimestamp: result.latestSourceTimestamp,
      latestReceivedTimestamp: result.latestReceivedTimestamp,
      marketQuoteTimestamp: quote?.observedAt ?? null,
      modelName: MODEL_NAME,
      modelVersion: MODEL_VERSION,
      status: result.status,
      dataHealth: result.dataHealth,
      independentProbabilityUp: result.independentProbabilityUp,
      marketProbabilityUp: result.marketProbabilityUp,
      probabilityUp: result.assistedProbabilityUp ?? result.independentProbabilityUp,
      immutableFinalized: !!checkpoint.final,
      reason: result.reason,
      features: result.features,
    });

    if (!checkpoint.final) return;
    const stored = this.store.getPrediction(
      market.ticker,
      MODEL_NAME,
      MODEL_VERSION,
      FINAL_OFFSET_MS,
    ) || record.record;
    this.state.updatePrediction(this._publicStateFromRecord(market, stored));
  }

  _markMissed(market, timestamp) {
    if (this.processedOffsets.has(FINAL_OFFSET_MS)) {
      const existing = this.store.getPrediction(
        market.ticker,
        MODEL_NAME,
        MODEL_VERSION,
        FINAL_OFFSET_MS,
      );
      if (existing) {
        this.state.updatePrediction(this._publicStateFromRecord(market, existing));
        return;
      }
    }
    this.processedOffsets.add(FINAL_OFFSET_MS);
    const record = this.store.recordPrediction({
      marketTicker: market.ticker,
      predictionTimestamp: timestamp,
      checkpointLabel: '12:00',
      checkpointOffsetMs: FINAL_OFFSET_MS,
      featureCutoffTimestamp: finite(market.openTime) + FINAL_OFFSET_MS,
      modelName: MODEL_NAME,
      modelVersion: MODEL_VERSION,
      status: 'missed',
      dataHealth: 'unavailable',
      immutableFinalized: true,
      reason: 'The 12-minute prediction deadline was missed.',
    });
    this.state.updatePrediction(this._publicStateFromRecord(market, record.record));
  }

  _recordMissedCheckpoint(market, checkpoint, timestamp) {
    this.store.recordPrediction({
      marketTicker: market.ticker,
      predictionTimestamp: timestamp,
      checkpointLabel: checkpoint.label,
      checkpointOffsetMs: checkpoint.offsetMs,
      featureCutoffTimestamp: finite(market.openTime) + checkpoint.offsetMs,
      modelName: MODEL_NAME,
      modelVersion: MODEL_VERSION,
      status: 'missed',
      dataHealth: 'unavailable',
      immutableFinalized: false,
      reason: `The ${checkpoint.label} research checkpoint was missed.`,
    });
  }

  _publicStateFromRecord(market, record) {
    if (!record) return baseState(market, 'unavailable', 'No prediction record is available.');
    if (record.status === 'missed') {
      return {
        ...baseState(market, 'missed', record.reason),
        finalizedAt: record.prediction_ts_ms,
      };
    }
    if (record.status !== 'generated' || finite(record.independent_probability_up) == null) {
      return {
        ...baseState(market, 'unavailable', record.reason || 'A valid forecast was unavailable.'),
        finalizedAt: record.prediction_ts_ms,
        dataHealth: record.data_health || 'unavailable',
      };
    }
    return {
      marketTicker: market.ticker,
      status: 'finalized',
      finalizeAt: finite(market.openTime) + FINAL_OFFSET_MS,
      finalizedAt: record.prediction_ts_ms,
      independent: probabilityPair(record.independent_probability_up),
      marketAssisted: record.market_probability_up == null
        ? probabilityPair(null)
        : probabilityPair(record.probability_up),
      dataHealth: record.data_health,
      reason: record.reason || null,
      modelVersion: record.model_version,
    };
  }
}

module.exports = {
  CHECKPOINTS,
  CHECKPOINT_GRACE_MS,
  FINAL_OFFSET_MS,
  MAX_QUOTE_STALENESS_MS,
  PredictionEngine,
  SETTLEMENT_WINDOW_MS,
  baseState,
  currentMarket,
  probabilityPair,
};
