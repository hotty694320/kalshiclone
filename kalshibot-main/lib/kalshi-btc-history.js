'use strict';

const PERIOD_MS = Object.freeze({
  live: 30 * 1000,
  '5m': 5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
  '1h': 60 * 60 * 1000,
});

function asFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normaliseCandles(historyPayload, currentPayload) {
  const history = Array.isArray(historyPayload?.candlesticks?.['1M'])
    ? historyPayload.candlesticks['1M']
    : [];
  const current = currentPayload?.candlesticks?.['1M'];
  const byOpenTime = new Map();

  for (const candle of history) {
    const timestamp = asFiniteNumber(candle?.open_ts_ms);
    const price = asFiniteNumber(candle?.close);
    if (timestamp != null && price != null) byOpenTime.set(timestamp, { timestamp, price });
  }

  const currentOpen = asFiniteNumber(current?.open_ts_ms);
  const currentClose = asFiniteNumber(current?.close);
  if (currentOpen != null && currentClose != null) {
    byOpenTime.set(currentOpen, { timestamp: currentOpen, price: currentClose });
  }

  return [...byOpenTime.values()].sort((a, b) => a.timestamp - b.timestamp);
}

function currentSecondPoints(currentPayload) {
  const values = Array.isArray(currentPayload?.timeseries?.second)
    ? currentPayload.timeseries.second
    : [];
  const maturity = asFiniteNumber(currentPayload?.maturity_ts_ms);
  if (maturity == null) return [];
  return values
    .map((value, index) => ({
      timestamp: maturity - (values.length - 1 - index) * 1000,
      price: asFiniteNumber(value),
    }))
    .filter(point => point.price != null);
}

function mergeObservedPoints(...series) {
  const byTimestamp = new Map();
  for (const points of series) {
    for (const point of Array.isArray(points) ? points : []) {
      const timestamp = asFiniteNumber(point?.timestamp);
      const price = asFiniteNumber(point?.price);
      if (timestamp != null && price != null) byTimestamp.set(timestamp, { timestamp, price });
    }
  }
  return [...byTimestamp.values()].sort((a, b) => a.timestamp - b.timestamp);
}

function eventTimeseriesPoints(payload) {
  const values = payload?.live_data?.details?.timeseries
    ?? payload?.details?.timeseries
    ?? payload?.timeseries
    ?? [];
  const byTimestamp = new Map();
  for (const value of Array.isArray(values) ? values : []) {
    const timestamp = asFiniteNumber(value?.t);
    const price = asFiniteNumber(value?.v);
    if (timestamp != null && price != null) {
      byTimestamp.set(timestamp, { timestamp, price });
    }
  }
  return [...byTimestamp.values()].sort((a, b) => a.timestamp - b.timestamp);
}

function bucketKnockoutPoints(points, durationMs) {
  const sorted = mergeObservedPoints(points);
  const durationSeconds = durationMs / 1000;
  const bucketSeconds = durationSeconds > 300
    ? Math.ceil(durationSeconds / 300)
    : null;
  if (!bucketSeconds || !sorted.length) return sorted;

  const bucketMs = bucketSeconds * 1000;
  const buckets = new Map();
  for (const point of sorted) {
    const key = Math.floor(point.timestamp / bucketMs) * bucketMs;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(point);
    else buckets.set(key, [point]);
  }

  const result = [...buckets.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, bucket]) => ({
      timestamp: bucket[bucket.length - 1].timestamp,
      price: bucket.reduce((sum, point) => sum + point.price, 0) / bucket.length,
    }));

  // Kalshi replaces the final aggregate with the newest genuine observation.
  if (result.length) result[result.length - 1] = sorted[sorted.length - 1];
  return result;
}

function buildKnockoutHistoricalSeries(period, payload, closeTimestamp, now = Date.now()) {
  const duration = PERIOD_MS[period];
  if (!duration || period === 'live') return [];

  const close = asFiniteNumber(closeTimestamp);
  const endTimestamp = Math.min(close ?? now, now);
  const startTimestamp = endTimestamp - duration;
  const points = eventTimeseriesPoints(payload)
    .filter(point => point.timestamp >= startTimestamp && point.timestamp < endTimestamp);
  return bucketKnockoutPoints(points, duration);
}

function normaliseSecondPoints(points) {
  const bySecond = new Map();
  for (const point of mergeObservedPoints(points)) {
    const timestamp = Math.floor(point.timestamp / 1000) * 1000;
    // Keep the last genuine observation received inside each source second.
    bySecond.set(timestamp, { timestamp, price: point.price });
  }
  return [...bySecond.values()].sort((a, b) => a.timestamp - b.timestamp);
}

function overlayAuthoritativeTail(basePoints, authoritativePoints, now = Date.now()) {
  const tail = normaliseSecondPoints(authoritativePoints);
  if (!tail.length || now - tail[tail.length - 1].timestamp > 30_000) {
    return mergeObservedPoints(basePoints);
  }
  const firstTailTimestamp = tail[0].timestamp;
  const history = mergeObservedPoints(basePoints)
    .filter(point => point.timestamp < firstTailTimestamp);
  return mergeObservedPoints(history, tail);
}

function buildLiveSeries(historyPayload, currentPayload, observedPoints = []) {
  const currentPoints = currentSecondPoints(currentPayload);
  if (currentPoints.length) return mergeObservedPoints(observedPoints, currentPoints);
  const values = Array.isArray(historyPayload?.timeseries) ? historyPayload.timeseries : [];
  const maturity = asFiniteNumber(currentPayload?.maturity_ts_ms)
    ?? asFiniteNumber(historyPayload?.maturity_ts_ms)
    ?? Date.now();

  return values
    .map((value, index) => ({
      timestamp: maturity - (values.length - 1 - index) * 1000,
      price: asFiniteNumber(value),
    }))
    .filter((point) => point.price != null);
}

function buildHistoricalSeries(period, historyPayload, currentPayload, observedPoints = []) {
  const duration = PERIOD_MS[period];
  if (!duration || period === 'live') return [];

  const maturity = asFiniteNumber(currentPayload?.maturity_ts_ms)
    ?? asFiniteNumber(historyPayload?.maturity_ts_ms)
    ?? Date.now();
  const oldest = maturity - duration;
  // Minute closes are genuine aggregate observations and provide the initial
  // backfill. Every harvested one-second RTI value replaces that coarse
  // coverage as the collector runs; no synthetic high/low timestamps are used.
  const candleCloses = normaliseCandles(historyPayload, currentPayload)
    .map(point => ({ ...point, timestamp: point.timestamp + 59_000 }));
  const points = mergeObservedPoints(candleCloses, observedPoints, currentSecondPoints(currentPayload))
    .filter(point => point.timestamp >= oldest && point.timestamp <= maturity);

  return points;
}

function buildKalshiPriceHistory(period, historyPayload, currentPayload, observedPoints = []) {
  if (!Object.prototype.hasOwnProperty.call(PERIOD_MS, period)) {
    throw new Error('period must be live, 5m, 15m, or 1h');
  }
  return period === 'live'
    ? buildLiveSeries(historyPayload, currentPayload, observedPoints)
      .filter(point => point.timestamp >= (
        (asFiniteNumber(currentPayload?.maturity_ts_ms) ?? Date.now()) - 59_000
      ))
    : buildHistoricalSeries(period, historyPayload, currentPayload, observedPoints);
}

module.exports = {
  PERIOD_MS,
  bucketKnockoutPoints,
  buildKalshiPriceHistory,
  buildKnockoutHistoricalSeries,
  buildLiveSeries,
  buildHistoricalSeries,
  currentSecondPoints,
  eventTimeseriesPoints,
  mergeObservedPoints,
  normaliseCandles,
  normaliseSecondPoints,
  overlayAuthoritativeTail,
};
