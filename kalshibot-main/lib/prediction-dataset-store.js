'use strict';

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DEFAULT_PATH = path.join(__dirname, '..', 'data', 'prediction-dataset.db');
const SETTLEMENT_WINDOW_MS = 60_000;
const REQUIRED_SETTLEMENT_TICKS = 60;
const SCHEMA_VERSION = 2;

function finite(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function roundedSettlement(ticks) {
  const average = ticks.reduce((sum, tick) => sum + tick.price, 0) / ticks.length;
  return Math.round(average * 100) / 100;
}

function scoring(probability, actualOutcome) {
  const raw = finite(probability);
  if (raw == null) return { brier: null, logLoss: null };
  const y = actualOutcome === 'up' ? 1 : 0;
  const p = Math.min(1 - 1e-15, Math.max(1e-15, raw));
  return {
    brier: (p - y) ** 2,
    logLoss: -(y * Math.log(p) + (1 - y) * Math.log(1 - p)),
  };
}

class PredictionDatasetStore {
  constructor(dbPath = DEFAULT_PATH) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = FULL');
    this.db.pragma('foreign_keys = ON');
    this._createSchema();
    this._prepare();
  }

  _predictionTableSql(tableName = 'opening_predictions') {
    return `
      CREATE TABLE ${tableName} (
        id                          INTEGER PRIMARY KEY AUTOINCREMENT,
        market_ticker               TEXT NOT NULL REFERENCES prediction_markets(market_ticker),
        prediction_ts_ms            INTEGER NOT NULL,
        prediction_offset_ms        INTEGER NOT NULL,
        checkpoint_label            TEXT NOT NULL,
        feature_cutoff_ts_ms        INTEGER NOT NULL,
        latest_source_ts_ms         INTEGER,
        latest_received_ts_ms       INTEGER,
        market_quote_ts_ms          INTEGER,
        leakage_safe                INTEGER NOT NULL CHECK(leakage_safe IN (0, 1)),
        status                      TEXT NOT NULL
          CHECK(status IN ('generated', 'unavailable', 'missed')),
        data_health                 TEXT NOT NULL
          CHECK(data_health IN ('healthy', 'degraded', 'unavailable', 'unknown')),
        model_name                  TEXT NOT NULL,
        model_version               TEXT NOT NULL,
        independent_probability_up  REAL
          CHECK(independent_probability_up IS NULL OR
            (independent_probability_up >= 0 AND independent_probability_up <= 1)),
        market_probability_up       REAL
          CHECK(market_probability_up IS NULL OR
            (market_probability_up >= 0 AND market_probability_up <= 1)),
        probability_up              REAL
          CHECK(probability_up IS NULL OR (probability_up >= 0 AND probability_up <= 1)),
        predicted_outcome           TEXT CHECK(predicted_outcome IN ('up', 'down')),
        reason                      TEXT,
        features_json               TEXT,
        immutable_finalized         INTEGER NOT NULL DEFAULT 0
          CHECK(immutable_finalized IN (0, 1)),
        actual_outcome              TEXT CHECK(actual_outcome IN ('up', 'down')),
        correct                     INTEGER CHECK(correct IN (0, 1)),
        brier_loss                  REAL,
        log_loss                    REAL,
        independent_brier_loss      REAL,
        independent_log_loss        REAL,
        market_brier_loss           REAL,
        market_log_loss             REAL,
        graded_ts_ms                INTEGER,
        UNIQUE(market_ticker, model_name, model_version, prediction_offset_ms)
      )
    `;
  }

  _createSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS brti_ticks (
        source_ts_ms       INTEGER PRIMARY KEY,
        price              REAL NOT NULL CHECK(price > 0),
        received_ts_ms     INTEGER NOT NULL,
        payload_maturity_ms INTEGER,
        source             TEXT NOT NULL DEFAULT 'kalshi_cf_benchmarks_rti'
      ) WITHOUT ROWID;

      CREATE TABLE IF NOT EXISTS prediction_markets (
        market_ticker       TEXT PRIMARY KEY,
        event_ticker        TEXT,
        open_ts_ms          INTEGER NOT NULL,
        close_ts_ms         INTEGER NOT NULL,
        target_price        REAL NOT NULL CHECK(target_price > 0),
        target_source       TEXT,
        first_seen_ts_ms    INTEGER NOT NULL,
        last_seen_ts_ms     INTEGER NOT NULL,
        settlement_value    REAL,
        actual_outcome      TEXT CHECK(actual_outcome IN ('up', 'down')),
        settlement_tick_count INTEGER,
        label_status        TEXT NOT NULL DEFAULT 'pending'
          CHECK(label_status IN ('pending', 'incomplete', 'final')),
        label_computed_ts_ms INTEGER
      );
    `);

    const predictionTable = this.db.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'opening_predictions'
    `).get();
    if (!predictionTable) {
      this.db.exec(this._predictionTableSql());
    } else {
      const columns = new Set(
        this.db.prepare('PRAGMA table_info(opening_predictions)').all().map(column => column.name),
      );
      if (!columns.has('checkpoint_label') || !columns.has('independent_probability_up')) {
        this._migrateLegacyPredictions();
      }
    }

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_ticks_received ON brti_ticks(received_ts_ms);
      CREATE INDEX IF NOT EXISTS idx_markets_close_status
        ON prediction_markets(close_ts_ms, label_status);
      CREATE INDEX IF NOT EXISTS idx_predictions_training
        ON opening_predictions(leakage_safe, status, graded_ts_ms);
      CREATE INDEX IF NOT EXISTS idx_predictions_market_offset
        ON opening_predictions(market_ticker, prediction_offset_ms);
    `);
    this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
  }

  _migrateLegacyPredictions() {
    this.db.pragma('foreign_keys = OFF');
    try {
      const migrate = this.db.transaction(() => {
        this.db.exec('ALTER TABLE opening_predictions RENAME TO opening_predictions_legacy');
        this.db.exec(this._predictionTableSql());
        this.db.exec(`
          INSERT INTO opening_predictions (
            id, market_ticker, prediction_ts_ms, prediction_offset_ms,
            checkpoint_label, feature_cutoff_ts_ms, leakage_safe, status, data_health,
            model_name, model_version, independent_probability_up, probability_up,
            predicted_outcome, features_json, immutable_finalized, actual_outcome,
            correct, brier_loss, log_loss, independent_brier_loss,
            independent_log_loss, graded_ts_ms
          )
          SELECT
            id, market_ticker, prediction_ts_ms, prediction_offset_ms,
            'legacy', prediction_ts_ms, leakage_safe, 'generated', 'unknown',
            model_name, model_version, probability_up, probability_up,
            predicted_outcome, features_json, 0, actual_outcome,
            correct, brier_loss, log_loss, brier_loss, log_loss, graded_ts_ms
          FROM opening_predictions_legacy
        `);
        this.db.exec('DROP TABLE opening_predictions_legacy');
      });
      migrate();
    } finally {
      this.db.pragma('foreign_keys = ON');
    }
  }

  _prepare() {
    this.insertTick = this.db.prepare(`
      INSERT INTO brti_ticks
        (source_ts_ms, price, received_ts_ms, payload_maturity_ms)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(source_ts_ms) DO NOTHING
    `);
    this.upsertMarketStatement = this.db.prepare(`
      INSERT INTO prediction_markets (
        market_ticker, event_ticker, open_ts_ms, close_ts_ms, target_price,
        target_source, first_seen_ts_ms, last_seen_ts_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(market_ticker) DO UPDATE SET
        event_ticker = excluded.event_ticker,
        open_ts_ms = excluded.open_ts_ms,
        close_ts_ms = excluded.close_ts_ms,
        target_price = excluded.target_price,
        target_source = excluded.target_source,
        last_seen_ts_ms = excluded.last_seen_ts_ms
    `);
    this.insertPrediction = this.db.prepare(`
      INSERT INTO opening_predictions (
        market_ticker, prediction_ts_ms, prediction_offset_ms, checkpoint_label,
        feature_cutoff_ts_ms, latest_source_ts_ms, latest_received_ts_ms,
        market_quote_ts_ms, leakage_safe, status, data_health, model_name,
        model_version, independent_probability_up, market_probability_up,
        probability_up, predicted_outcome, reason, features_json, immutable_finalized
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(market_ticker, model_name, model_version, prediction_offset_ms) DO NOTHING
    `);
    this.pendingMarkets = this.db.prepare(`
      SELECT * FROM prediction_markets
      WHERE close_ts_ms <= ? AND label_status != 'final'
      ORDER BY close_ts_ms
    `);
    this.settlementTicks = this.db.prepare(`
      SELECT source_ts_ms, price FROM brti_ticks
      WHERE source_ts_ms >= ? AND source_ts_ms < ?
      ORDER BY source_ts_ms
    `);
    this.predictionTicks = this.db.prepare(`
      SELECT source_ts_ms, price, received_ts_ms FROM brti_ticks
      WHERE source_ts_ms >= ? AND source_ts_ms < ? AND received_ts_ms <= ?
      ORDER BY source_ts_ms
    `);
    this.markIncomplete = this.db.prepare(`
      UPDATE prediction_markets
      SET label_status = 'incomplete', settlement_tick_count = ?, label_computed_ts_ms = ?
      WHERE market_ticker = ?
    `);
    this.finalizeMarket = this.db.prepare(`
      UPDATE prediction_markets
      SET settlement_value = ?, actual_outcome = ?, settlement_tick_count = ?,
          label_status = 'final', label_computed_ts_ms = ?
      WHERE market_ticker = ?
    `);
    this.predictionsForMarket = this.db.prepare(`
      SELECT id, probability_up, independent_probability_up, market_probability_up,
             predicted_outcome
      FROM opening_predictions
      WHERE market_ticker = ? AND status = 'generated' AND graded_ts_ms IS NULL
    `);
    this.gradePrediction = this.db.prepare(`
      UPDATE opening_predictions
      SET actual_outcome = ?, correct = ?, brier_loss = ?, log_loss = ?,
          independent_brier_loss = ?, independent_log_loss = ?,
          market_brier_loss = ?, market_log_loss = ?, graded_ts_ms = ?
      WHERE id = ?
    `);
    this.findPrediction = this.db.prepare(`
      SELECT * FROM opening_predictions
      WHERE market_ticker = ? AND model_name = ? AND model_version = ?
        AND prediction_offset_ms = ?
    `);
    this.offsetsForModel = this.db.prepare(`
      SELECT prediction_offset_ms FROM opening_predictions
      WHERE market_ticker = ? AND model_name = ? AND model_version = ?
      ORDER BY prediction_offset_ms
    `);
  }

  ingestTicks(points, receivedTs = Date.now(), payloadMaturity = null) {
    const insertMany = this.db.transaction((rows) => {
      let written = 0;
      for (const point of rows || []) {
        const timestamp = finite(point?.timestamp);
        const price = finite(point?.price);
        if (timestamp == null || price == null || price <= 0) continue;
        written += this.insertTick.run(
          timestamp,
          price,
          receivedTs,
          finite(payloadMaturity),
        ).changes;
      }
      return written;
    });
    return insertMany(points);
  }

  ticksForPrediction(startTimestamp, endTimestamp, receivedCutoff = endTimestamp) {
    return this.predictionTicks.all(
      finite(startTimestamp),
      finite(endTimestamp),
      finite(receivedCutoff),
    );
  }

  upsertMarket(market, seenTs = Date.now()) {
    const ticker = String(market?.ticker || '');
    const openTime = finite(market?.openTime);
    const closeTime = finite(market?.closeTime);
    const targetPrice = finite(market?.targetPrice);
    if (!ticker || openTime == null || closeTime == null || targetPrice == null || targetPrice <= 0) {
      return false;
    }
    this.upsertMarketStatement.run(
      ticker,
      market.eventTicker || null,
      openTime,
      closeTime,
      targetPrice,
      market.targetSource || null,
      seenTs,
      seenTs,
    );
    return true;
  }

  recordPrediction(prediction) {
    const market = this.db.prepare(`
      SELECT open_ts_ms, close_ts_ms FROM prediction_markets WHERE market_ticker = ?
    `).get(prediction.marketTicker);
    if (!market) throw new Error('market must be stored before its prediction');

    const predictionTs = finite(prediction.predictionTimestamp);
    const explicitOffset = finite(prediction.checkpointOffsetMs);
    const offset = explicitOffset ?? (predictionTs == null ? null : predictionTs - market.open_ts_ms);
    const cutoff = finite(prediction.featureCutoffTimestamp)
      ?? (offset == null ? null : market.open_ts_ms + offset);
    if (predictionTs == null || offset == null || cutoff == null || offset < 0) {
      throw new Error('prediction timestamp, checkpoint offset, and feature cutoff are required');
    }

    const status = ['generated', 'unavailable', 'missed'].includes(prediction.status)
      ? prediction.status
      : 'generated';
    const dataHealth = ['healthy', 'degraded', 'unavailable', 'unknown'].includes(prediction.dataHealth)
      ? prediction.dataHealth
      : 'unknown';
    const independent = finite(prediction.independentProbabilityUp ?? prediction.probabilityUp);
    const marketProbability = finite(prediction.marketProbabilityUp);
    const probability = finite(prediction.probabilityUp ?? independent);
    for (const [name, value] of [
      ['independent_probability_up', independent],
      ['market_probability_up', marketProbability],
      ['probability_up', probability],
    ]) {
      if (value != null && (value < 0 || value > 1)) {
        throw new Error(`${name} must be in [0,1]`);
      }
    }
    if (status === 'generated' && (independent == null || probability == null)) {
      throw new Error('generated predictions require independent and final probabilities');
    }

    const latestSource = finite(prediction.latestSourceTimestamp);
    const latestReceived = finite(prediction.latestReceivedTimestamp);
    const quoteTimestamp = finite(prediction.marketQuoteTimestamp);
    const beforeSettlement = cutoff < market.close_ts_ms - SETTLEMENT_WINDOW_MS;
    const inputsSafe = (
      latestSource != null && latestSource <= cutoff
      && latestReceived != null && latestReceived <= cutoff
      && (quoteTimestamp == null || quoteTimestamp <= cutoff)
    );
    const leakageSafe = status === 'generated' && beforeSettlement && inputsSafe ? 1 : 0;
    const outcome = probability == null ? null : (probability >= 0.5 ? 'up' : 'down');
    const modelName = String(prediction.modelName || 'unknown');
    const modelVersion = String(prediction.modelVersion || 'unknown');
    const result = this.insertPrediction.run(
      prediction.marketTicker,
      predictionTs,
      offset,
      String(prediction.checkpointLabel || `${Math.round(offset / 1000)}s`),
      cutoff,
      latestSource,
      latestReceived,
      quoteTimestamp,
      leakageSafe,
      status,
      dataHealth,
      modelName,
      modelVersion,
      independent,
      marketProbability,
      probability,
      outcome,
      prediction.reason == null ? null : String(prediction.reason),
      prediction.features == null ? null : JSON.stringify(prediction.features),
      prediction.immutableFinalized ? 1 : 0,
    );
    const record = this.getPrediction(
      prediction.marketTicker,
      modelName,
      modelVersion,
      offset,
    );
    return {
      id: record?.id ?? null,
      inserted: result.changes === 1,
      leakageSafe: !!record?.leakage_safe,
      offset,
      record,
    };
  }

  getPrediction(marketTicker, modelName, modelVersion, offsetMs) {
    return this.findPrediction.get(marketTicker, modelName, modelVersion, offsetMs) || null;
  }

  predictionOffsets(marketTicker, modelName, modelVersion) {
    return this.offsetsForModel
      .all(marketTicker, modelName, modelVersion)
      .map(row => row.prediction_offset_ms);
  }

  gradeSettlements(now = Date.now()) {
    const gradeAll = this.db.transaction(() => {
      const results = [];
      for (const market of this.pendingMarkets.all(now)) {
        const ticks = this.settlementTicks.all(
          market.close_ts_ms - SETTLEMENT_WINDOW_MS,
          market.close_ts_ms,
        );
        if (ticks.length !== REQUIRED_SETTLEMENT_TICKS) {
          this.markIncomplete.run(ticks.length, now, market.market_ticker);
          results.push({ marketTicker: market.market_ticker, status: 'incomplete', ticks: ticks.length });
          continue;
        }

        const settlement = roundedSettlement(ticks);
        const actualOutcome = settlement >= market.target_price ? 'up' : 'down';
        this.finalizeMarket.run(
          settlement,
          actualOutcome,
          ticks.length,
          now,
          market.market_ticker,
        );

        for (const prediction of this.predictionsForMarket.all(market.market_ticker)) {
          const finalScore = scoring(prediction.probability_up, actualOutcome);
          const independentScore = scoring(prediction.independent_probability_up, actualOutcome);
          const marketScore = scoring(prediction.market_probability_up, actualOutcome);
          const correct = prediction.predicted_outcome === actualOutcome ? 1 : 0;
          this.gradePrediction.run(
            actualOutcome,
            correct,
            finalScore.brier,
            finalScore.logLoss,
            independentScore.brier,
            independentScore.logLoss,
            marketScore.brier,
            marketScore.logLoss,
            now,
            prediction.id,
          );
        }
        results.push({
          marketTicker: market.market_ticker,
          status: 'final',
          ticks: ticks.length,
          settlement,
          actualOutcome,
        });
      }
      return results;
    });
    return gradeAll();
  }

  status() {
    return {
      ticks: this.db.prepare('SELECT COUNT(*) count FROM brti_ticks').get().count,
      markets: this.db.prepare('SELECT COUNT(*) count FROM prediction_markets').get().count,
      finalMarkets: this.db.prepare(
        "SELECT COUNT(*) count FROM prediction_markets WHERE label_status = 'final'",
      ).get().count,
      predictions: this.db.prepare('SELECT COUNT(*) count FROM opening_predictions').get().count,
      gradedPredictions: this.db.prepare(
        'SELECT COUNT(*) count FROM opening_predictions WHERE graded_ts_ms IS NOT NULL',
      ).get().count,
      failedPredictions: this.db.prepare(
        'SELECT COUNT(*) count FROM opening_predictions WHERE correct = 0',
      ).get().count,
    };
  }

  close() {
    this.db.close();
  }
}

module.exports = {
  DEFAULT_PATH,
  REQUIRED_SETTLEMENT_TICKS,
  SCHEMA_VERSION,
  SETTLEMENT_WINDOW_MS,
  PredictionDatasetStore,
  roundedSettlement,
  scoring,
};
