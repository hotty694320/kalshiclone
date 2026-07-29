'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  PERIOD_MS,
  buildKalshiPriceHistory,
  buildKnockoutHistoricalSeries,
  eventTimeseriesPoints,
  normaliseSecondPoints,
  overlayAuthoritativeTail,
} = require('../lib/kalshi-btc-history');

function fixtures() {
  const start = Date.UTC(2026, 6, 29, 15, 0, 0);
  const candles = Array.from({ length: 61 }, (_, index) => ({
    open_ts_ms: start + index * 60_000,
    open: 64_000 + index,
    high: 64_004 + index,
    low: 63_996 + index,
    close: 64_001 + index,
  }));
  const maturity = start + 61 * 60_000;
  return {
    history: {
      maturity_ts_ms: maturity,
      timeseries: Array.from({ length: 60 }, (_, index) => 64_000 + index / 10),
      candlesticks: { '1M': candles },
    },
    current: {
      maturity_ts_ms: maturity,
      timeseries: {
        second: Array.from({ length: 60 }, (_, index) => 64_100 + index / 10),
      },
      candlesticks: {
        '1M': { ...candles[candles.length - 1], close: 64_099.25 },
      },
    },
  };
}

test('LIVE uses Kalshi current one-second RTI values and timestamps', () => {
  const { history, current } = fixtures();
  const points = buildKalshiPriceHistory('live', history, current);
  assert.equal(points.length, 60);
  assert.equal(points[0].timestamp, current.maturity_ts_ms - 59_000);
  assert.equal(points.at(-1).timestamp, current.maturity_ts_ms);
  assert.equal(points.at(-1).price, 64_105.9);
});

for (const period of ['5m', '15m', '1h']) {
  test(`${period} stays inside its Kalshi one-minute candle window`, () => {
    const { history, current } = fixtures();
    const points = buildKalshiPriceHistory(period, history, current);
    assert.ok(points.length >= 2);
    assert.ok(points.every(point => point.timestamp >= current.maturity_ts_ms - PERIOD_MS[period]));
    assert.ok(points.every(point => point.timestamp <= current.maturity_ts_ms));
    assert.equal(points.at(-1).timestamp, current.maturity_ts_ms);
    assert.equal(points.at(-1).price, 64_105.9);
  });
}

test('historical endpoint uses the latest second, never a conflicting candle close', () => {
  const { history, current } = fixtures();
  current.candlesticks['1M'].close = 65_000;
  for (const period of ['5m', '15m', '1h']) {
    const points = buildKalshiPriceHistory(period, history, current);
    assert.equal(points.at(-1).timestamp, current.maturity_ts_ms);
    assert.equal(points.at(-1).price, current.timeseries.second.at(-1));
    assert.notEqual(points.at(-1).price, current.candlesticks['1M'].close);
  }
});

test('all periods retain every genuine harvested second without synthetic points', () => {
  const { history, current } = fixtures();
  const harvested = Array.from({ length: 3601 }, (_, index) => ({
    timestamp: current.maturity_ts_ms - (3600 - index) * 1000,
    price: 63_000 + index / 100,
  }));
  for (const period of ['live', '5m', '15m', '1h']) {
    const points = buildKalshiPriceHistory(period, history, current, harvested);
    const expectedMinimum = Math.floor(PERIOD_MS[period] / 1000);
    assert.ok(points.length >= expectedMinimum);
    assert.equal(points.at(-1).timestamp, current.maturity_ts_ms);
    assert.ok(points.every((point, index) => (
      index === 0 || point.timestamp > points[index - 1].timestamp
    )));
  }
});

test('chart tail ends on the same authoritative NOW stream used by the header', () => {
  const now = Date.UTC(2026, 6, 29, 17, 16, 0);
  const base = [
    { timestamp: now - 300_000, price: 63_700 },
    { timestamp: now, price: 63_750 },
  ];
  const demoNow = [
    { timestamp: now - 240_000, price: 63_710 },
    { timestamp: now - 1_000, price: 63_768.21 },
  ];
  const points = overlayAuthoritativeTail(base, demoNow, now);
  assert.deepEqual(points, [
    { timestamp: now - 300_000, price: 63_700 },
    ...demoNow,
  ]);
  assert.equal(points.at(-1).price, 63_768.21);
});

test('stale demo NOW history cannot replace a fresh source tail', () => {
  const now = Date.UTC(2026, 6, 29, 17, 16, 0);
  const base = [{ timestamp: now, price: 63_750 }];
  const stale = [{ timestamp: now - 31_000, price: 99_999 }];
  assert.deepEqual(overlayAuthoritativeTail(base, stale, now), base);
});

test('sub-second Demo updates collapse to the last genuine value each second', () => {
  const second = Date.UTC(2026, 6, 29, 17, 19, 10);
  assert.deepEqual(normaliseSecondPoints([
    { timestamp: second + 15, price: 63_697.4 },
    { timestamp: second + 250, price: 63_696.9 },
    { timestamp: second + 980, price: 63_696.5 },
    { timestamp: second + 1_010, price: 63_696.4 },
  ]), [
    { timestamp: second, price: 63_696.5 },
    { timestamp: second + 1_000, price: 63_696.4 },
  ]);
});

test('Demo event timeseries is normalized, sorted, and de-duplicated', () => {
  assert.deepEqual(eventTimeseriesPoints({
    live_data: {
      details: {
        timeseries: [
          { t: 2, v: 20 },
          { t: 1, v: 10 },
          { t: 2, v: 21 },
          { t: 'bad', v: 30 },
        ],
      },
    },
  }), [
    { timestamp: 1, price: 10 },
    { timestamp: 2, price: 21 },
  ]);
});

test('historical periods use Kalshi exact 300-point event bucketing', () => {
  const now = Date.UTC(2026, 6, 29, 18, 30, 0);
  const raw = Array.from({ length: 3600 }, (_, index) => ({
    t: now - 3_600_000 + index * 1000,
    v: 63_000 + index,
  }));
  const payload = { live_data: { details: { timeseries: raw } } };

  const fiveMinutes = buildKnockoutHistoricalSeries('5m', payload, now + 900_000, now);
  assert.equal(fiveMinutes.length, 300);
  assert.equal(fiveMinutes[0].timestamp, now - 300_000);
  assert.equal(fiveMinutes.at(-1).timestamp, now - 1000);

  const fifteenMinutes = buildKnockoutHistoricalSeries('15m', payload, now + 900_000, now);
  assert.equal(fifteenMinutes.length, 300);
  assert.equal(fifteenMinutes[0].timestamp, now - 898_000);
  assert.equal(fifteenMinutes[0].price, (63_000 + 2700 + 63_000 + 2701 + 63_000 + 2702) / 3);
  assert.deepEqual(fifteenMinutes.at(-1), {
    timestamp: now - 1000,
    price: 63_000 + 3599,
  });

  const oneHour = buildKnockoutHistoricalSeries('1h', payload, now + 900_000, now);
  assert.equal(oneHour.length, 300);
  assert.equal(oneHour[0].timestamp, now - 3_589_000);
  assert.deepEqual(oneHour.at(-1), {
    timestamp: now - 1000,
    price: 63_000 + 3599,
  });
});

test('Demo event historical window includes its start and excludes its end', () => {
  const now = Date.UTC(2026, 6, 29, 18, 30, 0);
  const payload = {
    details: {
      timeseries: [
        { t: now - PERIOD_MS['5m'] - 1, v: 1 },
        { t: now - PERIOD_MS['5m'], v: 2 },
        { t: now - 1, v: 3 },
        { t: now, v: 4 },
      ],
    },
  };
  assert.deepEqual(buildKnockoutHistoricalSeries('5m', payload, now, now), [
    { timestamp: now - PERIOD_MS['5m'], price: 2 },
    { timestamp: now - 1, price: 3 },
  ]);
});

test('unsupported periods fail closed', () => {
  const { history, current } = fixtures();
  assert.throws(
    () => buildKalshiPriceHistory('6h', history, current),
    /period must be live, 5m, 15m, or 1h/,
  );
});
