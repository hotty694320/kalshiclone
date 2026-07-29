'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const chart = require('../public/kalshi-chart');

function fakeSvg(width = 912) {
  const attributes = new Map([['width', String(width)]]);
  return {
    parentElement: { clientWidth: width },
    clientWidth: width,
    innerHTML: '',
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute(name) { return attributes.get(name) ?? null; },
    removeAttribute(name) { attributes.delete(name); },
  };
}

function points(minutes = 60) {
  const end = Date.UTC(2026, 6, 29, 15, 45, 0);
  return Array.from({ length: minutes + 1 }, (_, index) => ({
    timestamp: end - (minutes - index) * 60_000,
    price: 64_000 + Math.sin(index / 4) * 80 - index / 3,
  }));
}

test('LIVE renders the Kalshi knockout chart contract', () => {
  const svg = fakeSvg();
  const livePoints = Array.from({ length: 40 }, (_, index) => ({
    timestamp: Date.UTC(2026, 6, 29, 15, 44, 20 + index),
    price: 64_000 + Math.sin(index / 4) * 4,
  }));
  chart.render({ svg, period: 'live', points: livePoints, target: 64_000.51 });

  assert.equal(svg.getAttribute('data-period'), 'live');
  assert.equal(svg.getAttribute('data-testid'), 'knockout-chart-ready');
  assert.match(svg.innerHTML, /stroke="#F7931A"/);
  assert.match(svg.innerHTML, /stroke-dasharray="2,4"/);
  assert.match(svg.innerHTML, /\$64,000\.51 target/);
  assert.match(svg.innerHTML, /%<\/text>/);
  assert.match(svg.innerHTML, /C[\d.-]+,[\d.-]+/);
});

test('LIVE keeps the newest genuine point ahead of the buffered clock', () => {
  const end = Date.UTC(2026, 6, 29, 15, 45, 0);
  const source = Array.from({ length: 60 }, (_, index) => ({
    timestamp: end - (59 - index) * 1000,
    price: 64_000 + index,
  }));
  const frame = chart.buildRealtimePoints(source, end);

  assert.equal(frame.at(-1).timestamp, end);
  assert.equal(frame.at(-1).price, 64_059);
  assert.ok(frame.length >= 39);
  assert.ok(frame.every((point, index) => (
    index === 0 || point.timestamp - frame[index - 1].timestamp <= 1000
  )));
});

test('LIVE frame fails closed when Kalshi data is stale', () => {
  const end = Date.UTC(2026, 6, 29, 15, 45, 0);
  const source = [
    { timestamp: end - 1000, price: 64_000 },
    { timestamp: end, price: 64_001 },
  ];
  assert.deepEqual(chart.buildRealtimePoints(source, end + chart.LIVE_STALE_MS + 1), []);
});

test('LIVE frame uses timestamps for irregular updates and preserves its tail', () => {
  const now = Date.UTC(2026, 6, 29, 17, 19, 20);
  const irregular = [
    { timestamp: now - 40_000, price: 63_700 },
    { timestamp: now - 15_250, price: 63_698 },
    { timestamp: now - 9_900, price: 63_697.4 },
    { timestamp: now - 9_100, price: 63_696.5 },
    { timestamp: now - 3_000, price: 63_696.2 },
  ];
  const framed = chart.buildRealtimePoints(irregular, now);
  assert.ok(framed.length >= 4);
  assert.equal(framed[0].timestamp, now - 40_000);
  assert.equal(framed.at(-1).timestamp, now - 3_000);
  assert.ok(framed.every((point, index) => (
    index === 0 || point.timestamp > framed[index - 1].timestamp
  )));
  assert.equal(framed.at(-1).price, 63_696.2);
});

test('LIVE marker percentage uses the same authoritative NOW value as the header', () => {
  const svg = fakeSvg();
  const end = Date.UTC(2026, 6, 29, 15, 45, 0);
  chart.render({
    svg,
    period: 'live',
    points: [
      { timestamp: end - 1000, price: 103 },
      { timestamp: end, price: 104 },
    ],
    target: 100,
    currentPrice: 105,
    now: end,
  });

  assert.match(svg.innerHTML, />\+5\.000%<\/text>/);
  const pathEndY = svg.innerHTML
    .match(/stroke="#F7931A"\/><\/g><g[^>]*><line[^>]+y1="([\d.]+)"/)?.[1];
  const markerY = svg.innerHTML
    .match(/<circle cx="[\d.]+" cy="([\d.]+)" r="4"/)?.[1];
  assert.ok(pathEndY);
  assert.equal(pathEndY, markerY);
});

test('LIVE vertical scale eases between gray-axis range changes', () => {
  const chartKey = {};
  const initial = chart.smoothLiveScale(chartKey, {
    min: 100,
    max: 110,
    range: 10,
    ticks: [100, 102.5, 105, 107.5, 110],
  }, 1000);
  const changed = chart.smoothLiveScale(chartKey, {
    min: 90,
    max: 130,
    range: 40,
    ticks: [90, 100, 110, 120, 130],
  }, 1033);
  const nextFrame = chart.smoothLiveScale(chartKey, {
    min: 90,
    max: 130,
    range: 40,
    ticks: [90, 100, 110, 120, 130],
  }, 1066);

  assert.equal(initial.min, 100);
  assert.equal(initial.max, 110);
  assert.ok(changed.min < 100 && changed.min > 90);
  assert.ok(changed.max > 110 && changed.max < 130);
  assert.ok(nextFrame.min < changed.min);
  assert.ok(nextFrame.max > changed.max);
});

test('LIVE orange endpoint eases between authoritative price updates', () => {
  const chartKey = {};
  const initial = chart.smoothLivePrice(chartKey, 100, 1000);
  const changed = chart.smoothLivePrice(chartKey, 120, 1033);
  const nextFrame = chart.smoothLivePrice(chartKey, 120, 1066);

  assert.equal(initial.price, 100);
  assert.ok(changed.price > 100 && changed.price < 120);
  assert.ok(nextFrame.price > changed.price && nextFrame.price < 120);
  assert.ok(changed.price - initial.price < 20);
  assert.equal(nextFrame.tail.at(-1).timestamp, 1066);
});

test('LIVE visual tail removes raw seam points that create a notch', () => {
  const visualStart = 10_000;
  const merged = chart.mergeLiveVisualTail([
    { timestamp: 7000, price: 100 },
    { timestamp: 8500, price: 103 },
    { timestamp: 9000, price: 99 },
    { timestamp: 9500, price: 102 },
  ], [
    { timestamp: visualStart, price: 100 },
    { timestamp: 10_033, price: 99.8 },
  ]);

  assert.deepEqual(merged, [
    { timestamp: 7000, price: 100 },
    { timestamp: visualStart, price: 100 },
    { timestamp: 10_033, price: 99.8 },
  ]);
});

test('LIVE gray-axis labels crossfade instead of teleporting', () => {
  const chartKey = {};
  const initial = chart.smoothLiveTicks(chartKey, [100, 110, 120], 1000);
  const unchanged = chart.smoothLiveTicks(chartKey, [100, 110, 120], 1033);
  const transitionStart = chart.smoothLiveTicks(chartKey, [110, 120, 130], 1066);
  const midpoint = chart.smoothLiveTicks(chartKey, [110, 120, 130], 1206);
  const completed = chart.smoothLiveTicks(chartKey, [110, 120, 130], 1400);

  assert.ok(initial.every(tick => tick.opacity === 1));
  assert.ok(unchanged.every(tick => tick.opacity === 1));
  assert.equal(transitionStart.find(tick => tick.value === 100).opacity, 1);
  assert.equal(transitionStart.find(tick => tick.value === 130).opacity, 0);
  assert.equal(midpoint.find(tick => tick.value === 100).opacity, 0.5);
  assert.equal(midpoint.find(tick => tick.value === 110).opacity, 1);
  assert.equal(midpoint.find(tick => tick.value === 130).opacity, 0.5);
  assert.deepEqual(completed, [
    { value: 110, opacity: 1 },
    { value: 120, opacity: 1 },
    { value: 130, opacity: 1 },
  ]);
});

for (const period of ['5m', '15m', '1h']) {
  test(`${period} renders the shared Kalshi historical chart contract`, () => {
    const svg = fakeSvg();
    chart.render({ svg, period, points: points(), target: 64_000.51 });

    assert.equal(svg.getAttribute('data-period'), period);
    assert.equal(svg.getAttribute('data-testid'), null);
    assert.match(svg.innerHTML, /kalshi-threshold-color/);
    assert.match(svg.innerHTML, /class="visx-line"/);
    assert.match(svg.innerHTML, /kalshi-history-last/);
    assert.match(svg.innerHTML, /class="kalshi-history-line"[^>]+d="M[^"]*L/);
    assert.doesNotMatch(svg.innerHTML, /class="kalshi-history-line"[^>]+d="M[^"]*C/);
    assert.match(svg.innerHTML, /\$64,000\.51 target/);
    assert.match(svg.innerHTML, /am|pm/);
  });
}

test('historical charts use Kalshi scale-band point spacing and right margin', () => {
  const svg = fakeSvg(856);
  const end = Date.UTC(2026, 6, 29, 15, 45, 0);
  chart.render({
    svg,
    period: '5m',
    points: [
      { timestamp: end - 2000, price: 63_700 },
      { timestamp: end - 1000, price: 63_701 },
      { timestamp: end, price: 63_702 },
    ],
    target: 63_701,
  });
  const path = svg.innerHTML.match(/class="kalshi-history-line"[^>]+d="([^"]+)"/)?.[1];
  assert.ok(path);
  assert.match(path, /^M24\.000,[\d.]+L260\.667,[\d.]+L497\.333,[\d.]+$/);
});

test('historical axis range is derived from prices, not the target', () => {
  const svg = fakeSvg(856);
  const end = Date.UTC(2026, 6, 29, 15, 45, 0);
  chart.render({
    svg,
    period: '5m',
    points: [
      { timestamp: end - 1000, price: 100 },
      { timestamp: end, price: 101 },
    ],
    target: 200,
  });
  assert.equal((svg.innerHTML.match(/\$200\.00/g) || []).length, 1);
});

test('historical green overlay ends at the exact target-line coordinate', () => {
  const svg = fakeSvg(856);
  const end = Date.UTC(2026, 6, 29, 15, 45, 0);
  chart.render({
    svg,
    period: '15m',
    points: [
      { timestamp: end - 3000, price: 100 },
      { timestamp: end - 2000, price: 120 },
      { timestamp: end - 1000, price: 80 },
      { timestamp: end, price: 110 },
    ],
    target: 105,
  });

  const filterHeight = svg.innerHTML
    .match(/<feFlood[^>]+height="([\d.]+)"/)?.[1];
  const targetY = svg.innerHTML
    .match(/class="kalshi-target"><path[^>]+d="M24,([\d.]+)L/)?.[1];
  assert.ok(filterHeight);
  assert.equal(filterHeight, targetY);
  assert.doesNotMatch(svg.innerHTML, /linearGradient|kalshi-threshold-line/);
  assert.match(
    svg.innerHTML,
    /class="kalshi-history-line"[^>]+filter="url\(#kalshi-threshold-color\)"[^>]+stroke="#e8ecec"/,
  );
});

test('historical charts collapse time labels at Kalshi mobile width', () => {
  const svg = fakeSvg(350.390625);
  chart.render({ svg, period: '15m', points: points(15), target: 64_000.51 });
  assert.doesNotMatch(svg.innerHTML, /\d{1,2}:\d{2}(am|pm)/);
  assert.match(svg.innerHTML, /y1="266\.000"|y2="266\.000"/);
});

test('point normalisation sorts and deduplicates updates', () => {
  assert.deepEqual(chart.normalisePoints([
    { timestamp: 2, price: 20 },
    { timestamp: 1, price: 10 },
    { timestamp: 2, price: 21 },
    { timestamp: 'bad', price: 30 },
  ]), [
    { timestamp: 1, price: 10 },
    { timestamp: 2, price: 21 },
  ]);
});

test('historical tick selection matches Kalshi knockout charts', () => {
  assert.deepEqual(chart.yTicksFromRangeAndCount(63_640, 63_770, 5), [
    63_600,
    63_650,
    63_700,
    63_750,
    63_800,
  ]);
});

test('market rollover clears LIVE smoothing state from the expired contract', () => {
  const svg = fakeSvg();
  assert.equal(chart.smoothLivePrice(svg, 100, 1000).price, 100);
  assert.ok(chart.smoothLivePrice(svg, 200, 1100).price < 200);
  chart.reset(svg);
  assert.equal(chart.smoothLivePrice(svg, 200, 1100).price, 200);
});
