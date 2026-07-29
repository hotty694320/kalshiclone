(function attachKalshiChart(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.KalshiChart = api;
}(typeof window !== 'undefined' ? window : globalThis, function createKalshiChart() {
  'use strict';

  const HEIGHT = 290;
  const FONT = 'Arial, Helvetica, sans-serif';
  const COLORS = Object.freeze({
    surface: '#090c0e',
    grid: '#394145',
    text: '#879093',
    textStrong: '#e8ecec',
    green: '#0ac285',
    red: '#d9163b',
    orange: '#F7931A',
  });
  const PERIOD_MS = Object.freeze({
    live: 30 * 1000,
    '5m': 5 * 60 * 1000,
    '15m': 15 * 60 * 1000,
    '1h': 60 * 60 * 1000,
  });
  const LIVE_BUFFER_MS = 4 * 1000;
  const LIVE_HISTORY_MS = (30 + 10) * 1000;
  const LIVE_STALE_MS = 30 * 1000;
  const LIVE_PRICE_EASING_MS = 150;
  const LIVE_SCALE_EASING_MS = 220;
  const LIVE_TAIL_BRIDGE_MS = 1500;
  const LIVE_TICK_TRANSITION_MS = 280;
  const LIVE_VISUAL_TAIL_MS = 3000;
  const livePriceStates = new WeakMap();
  const liveScaleStates = new WeakMap();
  const liveTickStates = new WeakMap();

  function finite(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function normalisePoints(points) {
    const byTimestamp = new Map();
    for (const point of Array.isArray(points) ? points : []) {
      const timestamp = finite(point?.timestamp);
      const price = finite(point?.price);
      if (timestamp != null && price != null) byTimestamp.set(timestamp, { timestamp, price });
    }
    return [...byTimestamp.values()].sort((a, b) => a.timestamp - b.timestamp);
  }

  function buildRealtimePoints(inputPoints, now = Date.now()) {
    const points = normalisePoints(inputPoints);
    if (points.length < 2) return points;

    const latest = points[points.length - 1];
    if (now - latest.timestamp > LIVE_STALE_MS) return [];

    // Kalshi's buffer controls the scrolling window; it does not hide a newer
    // genuine observation. Always keep the freshest point when it is ahead of
    // the buffered clock so the marker and percentage remain current.
    const frameTimestamp = Math.max(now - LIVE_BUFFER_MS, latest.timestamp);
    let rightIndex = points.findIndex(point => point.timestamp >= frameTimestamp);
    if (rightIndex < 0) rightIndex = points.length - 1;
    const leftIndex = points[rightIndex].timestamp === frameTimestamp
      ? rightIndex
      : rightIndex - 1;
    if (leftIndex < 0) return [];

    const left = points[leftIndex];
    const right = points[rightIndex];
    const interval = right.timestamp - left.timestamp;
    const ratio = interval <= 0
      ? 0
      : Math.max(0, Math.min(1, (frameTimestamp - left.timestamp) / interval));
    const framePrice = leftIndex === rightIndex
      ? left.price
      : left.price + (right.price - left.price) * ratio;
    const oldestTimestamp = frameTimestamp - LIVE_HISTORY_MS;
    const visible = points
      .filter(point => (
        point.timestamp >= oldestTimestamp
        && point.timestamp <= frameTimestamp
      ));

    if (!visible.length || visible[visible.length - 1].timestamp !== frameTimestamp) {
      visible.push({ timestamp: frameTimestamp, price: framePrice });
    } else {
      visible[visible.length - 1] = { timestamp: frameTimestamp, price: framePrice };
    }
    return visible;
  }

  function formatPrice(value) {
    return '$' + value.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }

  function formatClock(timestamp, withSeconds) {
    const options = withSeconds
      ? { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }
      : { hour: 'numeric', minute: '2-digit' };
    return new Date(timestamp).toLocaleTimeString('en-US', options)
      .replace(/\s/g, '')
      .toLowerCase();
  }

  function niceStep(rawStep) {
    if (!Number.isFinite(rawStep) || rawStep <= 0) return 1;
    const power = Math.pow(10, Math.floor(Math.log10(rawStep)));
    const fraction = rawStep / power;
    const niceFraction = fraction <= 1 ? 1
      : fraction <= 2 ? 2
        : fraction <= 2.5 ? 2.5
          : fraction <= 5 ? 5
            : 10;
    return niceFraction * power;
  }

  function buildScale(values, tickTarget, paddingRatio, minimumRange) {
    const clean = values.map(finite).filter(value => value != null);
    let rawMin = clean.length ? Math.min(...clean) : 0;
    let rawMax = clean.length ? Math.max(...clean) : 1;
    const observedRange = Math.max(rawMax - rawMin, minimumRange);
    rawMin -= observedRange * paddingRatio;
    rawMax += observedRange * paddingRatio;
    const step = niceStep((rawMax - rawMin) / Math.max(1, tickTarget - 1));
    const min = Math.floor(rawMin / step) * step;
    const max = Math.ceil(rawMax / step) * step;
    const ticks = [];
    for (let value = min; value <= max + step * 0.25 && ticks.length < 9; value += step) {
      ticks.push(Number(value.toFixed(8)));
    }
    return { min, max, range: Math.max(max - min, minimumRange), ticks };
  }

  function yTicksFromRangeAndCount(min, max, count, cap) {
    if (count < 3 || min >= max) return [min, max];
    const minimumStep = (max - min) / (count - (count > 3 ? 3 : 2));
    const averageStep = (max - min) / (count - 1);
    const exponent = Math.floor(Math.log10(minimumStep));

    for (let power = exponent; power > -10; power -= 1) {
      for (const multiplier of [10, 5, 2.5, 2]) {
        const increment = multiplier * (10 ** power);
        let candidate = Math.floor(averageStep / increment) * increment;
        while (candidate + increment < minimumStep) {
          candidate += increment;
          if (Math.ceil((max - (min - min % candidate)) / candidate) !== count - 1) {
            continue;
          }
          const ticks = Array.from(
            { length: count },
            (_, index) => min - min % candidate + index * candidate,
          );
          if (!cap || ticks[ticks.length - 1] <= cap) return ticks;
        }
      }
    }
    return [min, max];
  }

  function smoothLiveScale(key, desiredScale, now = Date.now()) {
    if (!key || !desiredScale) return desiredScale;
    const prior = liveScaleStates.get(key);
    if (!prior || now - prior.lastAt > 2000 || now < prior.lastAt) {
      const initial = {
        min: desiredScale.min,
        max: desiredScale.max,
        lastAt: now,
      };
      liveScaleStates.set(key, initial);
      return {
        ...desiredScale,
        range: Math.max(initial.max - initial.min, 0.01),
      };
    }

    const elapsed = Math.max(0, Math.min(250, now - prior.lastAt));
    const progress = 1 - Math.exp(-elapsed / LIVE_SCALE_EASING_MS);
    const min = prior.min + (desiredScale.min - prior.min) * progress;
    const max = prior.max + (desiredScale.max - prior.max) * progress;
    const next = {
      min: Math.abs(min - desiredScale.min) < 0.0001 ? desiredScale.min : min,
      max: Math.abs(max - desiredScale.max) < 0.0001 ? desiredScale.max : max,
      lastAt: now,
    };
    liveScaleStates.set(key, next);
    return {
      min: next.min,
      max: next.max,
      range: Math.max(next.max - next.min, 0.01),
      ticks: desiredScale.ticks,
    };
  }

  function smoothLivePrice(key, targetPrice, now = Date.now()) {
    const target = finite(targetPrice);
    if (!key || target == null) return { price: target, tail: [] };
    const prior = livePriceStates.get(key);
    if (!prior || now - prior.lastAt > 2000 || now <= prior.lastAt) {
      const initial = {
        price: target,
        lastAt: now,
        tail: [{ timestamp: now, price: target }],
      };
      livePriceStates.set(key, initial);
      return { price: target, tail: initial.tail.slice() };
    }

    const elapsed = Math.max(0, Math.min(250, now - prior.lastAt));
    const progress = 1 - Math.exp(-elapsed / LIVE_PRICE_EASING_MS);
    const price = prior.price + (target - prior.price) * progress;
    const tail = prior.tail
      .filter(point => point.timestamp >= now - LIVE_VISUAL_TAIL_MS);
    const point = { timestamp: now, price };
    if (tail.length && now - tail[tail.length - 1].timestamp < 16) {
      tail[tail.length - 1] = point;
    } else {
      tail.push(point);
    }
    livePriceStates.set(key, {
      price,
      lastAt: now,
      tail,
    });
    return { price, tail: tail.slice() };
  }

  function smoothLiveTicks(key, desiredTicks, now = Date.now()) {
    const target = Array.isArray(desiredTicks) ? desiredTicks : [];
    if (!key) return target.map(value => ({ value, opacity: 1 }));
    const signature = target.join('|');
    const prior = liveTickStates.get(key);
    if (!prior || now - prior.lastAt > 2000 || now < prior.lastAt) {
      const initial = {
        from: target,
        to: target,
        signature,
        startedAt: now,
        lastAt: now,
      };
      liveTickStates.set(key, initial);
      return target.map(value => ({ value, opacity: 1 }));
    }

    let state = prior;
    if (signature !== prior.signature) {
      state = {
        from: prior.to,
        to: target,
        signature,
        startedAt: now,
        lastAt: now,
      };
    } else {
      state.lastAt = now;
    }

    if (state.from.join('|') === state.to.join('|')) {
      liveTickStates.set(key, state);
      return state.to.map(value => ({ value, opacity: 1 }));
    }

    const progress = Math.max(
      0,
      Math.min(1, (now - state.startedAt) / LIVE_TICK_TRANSITION_MS),
    );
    if (progress >= 1) {
      state.from = state.to;
      state.startedAt = now;
      liveTickStates.set(key, state);
      return state.to.map(value => ({ value, opacity: 1 }));
    }

    const blended = new Map();
    for (const value of state.from) {
      blended.set(value, Math.min(1, (blended.get(value) || 0) + 1 - progress));
    }
    for (const value of state.to) {
      blended.set(value, Math.min(1, (blended.get(value) || 0) + progress));
    }
    liveTickStates.set(key, state);
    return [...blended.entries()].map(([value, opacity]) => ({ value, opacity }));
  }

  function mergeLiveVisualTail(inputPoints, visualTail) {
    if (!Array.isArray(visualTail) || !visualTail.length) return inputPoints;
    const cutoff = visualTail[0].timestamp - LIVE_TAIL_BRIDGE_MS;
    return [
      ...inputPoints.filter(point => point.timestamp < cutoff),
      ...visualTail,
    ];
  }

  function linePath(nodes) {
    if (!nodes.length) return '';
    if (nodes.length === 1) return `M${(nodes[0].x - 0.1).toFixed(3)},${nodes[0].y.toFixed(3)}L${nodes[0].x.toFixed(3)},${nodes[0].y.toFixed(3)}`;
    return nodes.map((node, index) => `${index ? 'L' : 'M'}${node.x.toFixed(3)},${node.y.toFixed(3)}`).join('');
  }

  function monotonePath(nodes) {
    if (nodes.length < 3) return linePath(nodes);
    const slopes = [];
    const tangents = [];
    for (let index = 0; index < nodes.length - 1; index += 1) {
      const dx = Math.max(0.001, nodes[index + 1].x - nodes[index].x);
      slopes.push((nodes[index + 1].y - nodes[index].y) / dx);
    }
    tangents[0] = slopes[0];
    tangents[nodes.length - 1] = slopes[slopes.length - 1];
    for (let index = 1; index < nodes.length - 1; index += 1) {
      tangents[index] = slopes[index - 1] * slopes[index] <= 0
        ? 0
        : (slopes[index - 1] + slopes[index]) / 2;
    }
    let path = `M${nodes[0].x.toFixed(3)},${nodes[0].y.toFixed(3)}`;
    for (let index = 0; index < nodes.length - 1; index += 1) {
      const current = nodes[index];
      const next = nodes[index + 1];
      const dx = (next.x - current.x) / 3;
      path += `C${(current.x + dx).toFixed(3)},${(current.y + tangents[index] * dx).toFixed(3)},`;
      path += `${(next.x - dx).toFixed(3)},${(next.y - tangents[index + 1] * dx).toFixed(3)},`;
      path += `${next.x.toFixed(3)},${next.y.toFixed(3)}`;
    }
    return path;
  }

  function dimensions(svg) {
    const parentWidth = finite(svg?.parentElement?.clientWidth);
    const ownWidth = finite(svg?.clientWidth);
    const attributeWidth = finite(svg?.getAttribute?.('width'));
    const width = Math.max(280, parentWidth || ownWidth || attributeWidth || 800);
    return { width, compact: width <= 480 };
  }

  function renderEmpty(svg, width) {
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(HEIGHT));
    svg.setAttribute('viewBox', `0 0 ${width} ${HEIGHT}`);
    svg.innerHTML = `<text x="${width / 2}" y="${HEIGHT / 2}" text-anchor="middle" fill="${COLORS.text}" font-size="11" font-family="${FONT}">Waiting for Kalshi price history</text>`;
  }

  function renderLive(svg, inputPoints, target, width, compact, currentPrice, now = Date.now()) {
    const plotWidth = Math.max(180, width - 88);
    const plotHeight = 254;
    const authoritativePrice = finite(currentPrice);
    const motion = authoritativePrice == null
      ? null
      : smoothLivePrice(svg, authoritativePrice, now);
    const renderPoints = motion == null
      ? inputPoints
      : mergeLiveVisualTail(inputPoints, motion.tail);
    const latest = renderPoints[renderPoints.length - 1];
    const endTime = latest.timestamp + 1200;
    const startTime = endTime - PERIOD_MS.live;
    const visible = renderPoints.filter(point => point.timestamp >= startTime - 10 * 1000);
    const desiredScaleValues = visible.map(point => point.price);
    if (authoritativePrice != null) desiredScaleValues.push(authoritativePrice);
    const desiredScale = buildScale(desiredScaleValues, 5, 0.15, 0.01);
    const scale = smoothLiveScale(svg, desiredScale, now);
    const xFor = timestamp => (timestamp - startTime) / (endTime - startTime) * plotWidth;
    const yFor = price => Math.max(
      0,
      Math.min(plotHeight, (scale.max - price) / scale.range * plotHeight),
    );
    const nodes = visible.map(point => ({ x: xFor(point.timestamp), y: yFor(point.price) }));
    const path = monotonePath(nodes);
    const latestNode = nodes[nodes.length - 1];
    const threshold = finite(target);
    const targetY = threshold == null ? null : Math.max(0, Math.min(plotHeight, yFor(threshold)));
    const actualPrice = authoritativePrice ?? latest.price;
    const isUp = threshold == null || actualPrice >= threshold;
    const currentColor = isUp ? COLORS.green : COLORS.red;
    const move = threshold == null ? 0 : (actualPrice - threshold) / threshold * 100;
    const axisTicks = smoothLiveTicks(svg, desiredScale.ticks, now);
    const grid = axisTicks.map(({ value, opacity }) => {
      const y = yFor(value);
      if (y < -0.5 || y > plotHeight + 0.5) return '';
      return `<g class="visx-group visx-axis-tick" opacity="${opacity.toFixed(3)}"><line x1="0" x2="${width + 24}" y1="${y.toFixed(3)}" y2="${y.toFixed(3)}" stroke="${COLORS.grid}" stroke-width="1" stroke-dasharray="1,4"/><text x="${(plotWidth + 68).toFixed(3)}" y="${y.toFixed(3)}" text-anchor="end" dominant-baseline="central" font-size="11" font-family="${FONT}" fill="${COLORS.text}" stroke="${COLORS.surface}" stroke-width="4" paint-order="stroke">${formatPrice(value)}</text></g>`;
    }).join('');
    const tickInterval = compact ? 10 * 1000 : 5 * 1000;
    const firstTick = Math.ceil(startTime / tickInterval) * tickInterval;
    const xTicks = [];
    for (let timestamp = firstTick; timestamp <= endTime; timestamp += tickInterval) {
      const x = xFor(timestamp);
      xTicks.push(`<g class="visx-group" transform="translate(${x.toFixed(3)}, 0)"><line y1="0" y2="5" stroke="${COLORS.grid}" stroke-width="1"/><text y="16" text-anchor="middle" dominant-baseline="middle" font-size="10" font-family="${FONT}" fill="${COLORS.text}">${formatClock(timestamp, true)}</text></g>`);
    }
    let targetMarkup = '';
    if (threshold != null) {
      const center = width / 2;
      const halfGap = Math.min(72, width * 0.2);
      targetMarkup = `<g class="kalshi-target"><line x1="0" x2="${(center - halfGap).toFixed(3)}" y1="${targetY.toFixed(3)}" y2="${targetY.toFixed(3)}" stroke="${COLORS.textStrong}" stroke-opacity="0.9" stroke-width="1"/><line x1="${(center + halfGap).toFixed(3)}" x2="${width.toFixed(3)}" y1="${targetY.toFixed(3)}" y2="${targetY.toFixed(3)}" stroke="${COLORS.textStrong}" stroke-opacity="0.9" stroke-width="1"/><text x="${center.toFixed(3)}" y="${targetY.toFixed(3)}" text-anchor="middle" dominant-baseline="central" font-size="12" font-weight="500" font-family="${FONT}" fill="${COLORS.textStrong}" stroke="${COLORS.surface}" stroke-width="4" paint-order="stroke">${formatPrice(threshold)} target</text><path d="M${(center + halfGap - 18).toFixed(3)},${(targetY - 5).toFixed(3)}L${(center + halfGap - 14).toFixed(3)},${(targetY - 1).toFixed(3)}L${(center + halfGap - 10).toFixed(3)},${(targetY - 5).toFixed(3)}M${(center + halfGap - 18).toFixed(3)},${(targetY + 1).toFixed(3)}L${(center + halfGap - 14).toFixed(3)},${(targetY + 5).toFixed(3)}L${(center + halfGap - 10).toFixed(3)},${(targetY + 1).toFixed(3)}" fill="none" stroke="${COLORS.textStrong}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></g>`;
    }

    svg.setAttribute('data-period', 'live');
    svg.setAttribute('data-testid', 'knockout-chart-ready');
    svg.innerHTML = `<defs><clipPath id="kalshi-live-y"><rect x="0" y="0" width="${width}" height="${plotHeight}"/></clipPath><clipPath id="kalshi-live-content"><rect x="0" y="0" width="${plotWidth}" height="${plotHeight}"/></clipPath><clipPath id="kalshi-live-x"><rect x="0" y="0" width="${width}" height="36"/></clipPath></defs><g class="visx-group" transform="translate(0, 8)"><g clip-path="url(#kalshi-live-y)">${grid}</g>${targetMarkup}<g clip-path="url(#kalshi-live-content)"><path stroke-width="2.5" fill="none" d="${path}" stroke="${COLORS.surface}"/><path stroke-width="2" fill="none" d="${path}" stroke="${COLORS.orange}"/></g><g clip-path="url(#kalshi-live-y)"><line x1="0" x2="${plotWidth}" y1="${latestNode.y.toFixed(3)}" y2="${latestNode.y.toFixed(3)}" stroke="${currentColor}" stroke-width="1.5" stroke-dasharray="2,4" stroke-linecap="round"/><text x="${(plotWidth + 4).toFixed(3)}" y="${latestNode.y.toFixed(3)}" text-anchor="start" dominant-baseline="central" font-size="11" font-weight="600" font-family="${FONT}" fill="${currentColor}" stroke="${COLORS.surface}" stroke-width="3" paint-order="stroke">${move >= 0 ? '+' : ''}${move.toFixed(3)}%</text><circle cx="${latestNode.x.toFixed(3)}" cy="${latestNode.y.toFixed(3)}" r="4" fill="${COLORS.orange}"/><circle cx="${latestNode.x.toFixed(3)}" cy="${latestNode.y.toFixed(3)}" r="3" fill="none" stroke="${COLORS.orange}" stroke-width="1.5"><animate attributeName="r" from="3" to="14" dur="1.5s" repeatCount="indefinite"/><animate attributeName="stroke-opacity" from="0.7" to="0" dur="1.5s" repeatCount="indefinite"/></circle></g><g class="visx-group" transform="translate(0, ${plotHeight})" clip-path="url(#kalshi-live-x)">${xTicks.join('')}<line x1="0" x2="${plotWidth}" y1="0" y2="0" stroke="${COLORS.grid}" stroke-width="1"/></g></g>`;
  }

  function renderHistorical(svg, period, inputPoints, target, width, compact) {
    const left = compact ? 0 : 24;
    const right = Math.max(left + 120, width - 122);
    const plotHeight = compact ? 266 : 240;
    const latest = inputPoints[inputPoints.length - 1];
    const endTime = latest.timestamp;
    const startTime = endTime - PERIOD_MS[period];
    const windowPoints = inputPoints.filter(point => point.timestamp >= startTime);
    const threshold = finite(target);
    const scaleValues = windowPoints.map(point => point.price);
    const rawMin = Math.min(...scaleValues);
    const rawMax = Math.max(...scaleValues);
    const ticks = yTicksFromRangeAndCount(rawMin, rawMax, 5);
    const scale = {
      min: Math.min(rawMin, ticks[0]),
      max: Math.max(rawMax, ticks[ticks.length - 1]),
      ticks,
    };
    scale.range = Math.max(scale.max - scale.min, 0.01);
    const step = (right - left) / Math.max(1, windowPoints.length);
    const yFor = price => 8 + (scale.max - price) / scale.range * (plotHeight - 8);
    const nodes = windowPoints.map((point, index) => ({
      x: left + index * step,
      y: yFor(point.price),
    }));
    const path = linePath(nodes);
    const latestNode = nodes[nodes.length - 1];
    const targetY = threshold == null ? null : Math.max(8, Math.min(plotHeight, yFor(threshold)));
    const grid = scale.ticks.map(value => {
      const y = yFor(value);
      if (y < 7.5 || y > plotHeight + 0.5) return '';
      return `<line class="visx-line" x1="${left}" y1="${y.toFixed(3)}" x2="${right}" y2="${y.toFixed(3)}" fill="transparent" shape-rendering="crispEdges" stroke="${COLORS.grid}" stroke-width="1" stroke-dasharray="1,4"/>`;
    }).join('');
    const yAxis = scale.ticks.map(value => {
      const y = yFor(value);
      if (y < 7.5 || y > plotHeight + 0.5) return '';
      return `<g class="visx-group visx-axis-tick"><text x="${(right + 28).toFixed(3)}" y="${y.toFixed(3)}" stroke-width="4" stroke="${COLORS.surface}" fill="${COLORS.text}" paint-order="stroke" font-size="11" font-family="${FONT}" text-anchor="start" dominant-baseline="central">${formatPrice(value)}</text></g>`;
    }).join('');
    const xAxis = compact ? '' : Array.from({ length: 5 }, (_, index) => {
      const fraction = index / 4;
      const pointIndex = Math.floor((windowPoints.length - 1) * fraction);
      const x = left + pointIndex * step;
      const timestamp = windowPoints[pointIndex]?.timestamp ?? startTime;
      const anchor = index === 0 ? 'start' : index === 4 ? 'end' : 'middle';
      return `<g class="visx-group visx-axis-tick"><text x="${x.toFixed(3)}" y="268" fill="${COLORS.text}" font-size="11" font-family="${FONT}" text-anchor="${anchor}">${formatClock(timestamp, false)}</text></g>`;
    }).join('');
    const lineEnd = compact ? width : right;
    const targetMarkup = threshold == null ? '' : `<g class="kalshi-target"><path stroke-width="1" fill="none" d="M${left},${targetY.toFixed(3)}L${lineEnd.toFixed(3)},${targetY.toFixed(3)}" stroke="${COLORS.green}" stroke-opacity="0.7"/><text x="${((left + lineEnd) / 2).toFixed(3)}" y="${targetY.toFixed(3)}" font-size="13" font-weight="500" fill="${COLORS.green}" stroke="${COLORS.surface}" stroke-width="4" text-anchor="middle" dominant-baseline="central" paint-order="stroke" font-family="${FONT}">${formatPrice(threshold)} target</text></g>`;
    const pointColor = threshold == null || latest.price >= threshold ? COLORS.green : COLORS.textStrong;
    const thresholdFilter = targetY == null ? '' : `<filter id="kalshi-threshold-color"><feFlood flood-color="${COLORS.green}" flood-opacity="1" x="0" y="0" height="${targetY.toFixed(3)}" width="${right.toFixed(3)}" result="A"/><feComposite operator="in" in2="SourceGraphic" in="A" result="B"/><feColorMatrix type="hueRotate" in="B" result="C" values="0"/><feComposite operator="over" in2="SourceGraphic" in="C"/></filter>`;
    const thresholdFilterAttribute = targetY == null
      ? ''
      : ' filter="url(#kalshi-threshold-color)"';

    svg.setAttribute('data-period', period);
    svg.removeAttribute('data-testid');
    svg.innerHTML = `<g class="visx-group" transform="translate(0, 16)"><defs>${thresholdFilter}<clipPath id="kalshi-history-content"><rect x="${left}" y="0" width="${right - left}" height="${plotHeight}"/></clipPath></defs>${grid}<g clip-path="url(#kalshi-history-content)"><path class="kalshi-history-halo" stroke-width="2.5" fill="none"${thresholdFilterAttribute} d="${path}" stroke="${COLORS.surface}"/><path class="kalshi-history-line" stroke-width="2" fill="none"${thresholdFilterAttribute} d="${path}" stroke="${COLORS.textStrong}"/></g>${targetMarkup}<g class="visx-group visx-axis visx-axis-bottom">${xAxis}</g><g class="visx-group visx-axis visx-axis-right">${yAxis}</g><circle class="kalshi-history-last" cx="${latestNode.x.toFixed(3)}" cy="${latestNode.y.toFixed(3)}" fill="${pointColor}" r="4" stroke="${pointColor}" stroke-opacity="0.1"><animate attributeName="r" values="4;5;4" dur="3s" repeatCount="indefinite"/></circle></g>`;
  }

  function render(options) {
    const svg = options?.svg;
    if (!svg) return;
    const period = Object.prototype.hasOwnProperty.call(PERIOD_MS, options.period)
      ? options.period
      : 'live';
    const points = normalisePoints(options.points);
    const { width, compact } = dimensions(svg);
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(HEIGHT));
    svg.setAttribute('viewBox', `0 0 ${width} ${HEIGHT}`);
    svg.setAttribute('aria-label', `${period === 'live' ? 'Live' : period.toUpperCase()} Bitcoin price chart`);
    if (!points.length) return renderEmpty(svg, width);
    if (period === 'live') {
      return renderLive(
        svg,
        points,
        options.target,
        width,
        compact,
        options.currentPrice,
        finite(options.now) ?? Date.now(),
      );
    }
    return renderHistorical(svg, period, points, options.target, width, compact);
  }

  function reset(svg) {
    if (!svg) return;
    livePriceStates.delete(svg);
    liveScaleStates.delete(svg);
    liveTickStates.delete(svg);
    svg.innerHTML = '';
    svg.removeAttribute?.('data-period');
  }

  return {
    COLORS,
    LIVE_BUFFER_MS,
    LIVE_HISTORY_MS,
    LIVE_PRICE_EASING_MS,
    LIVE_SCALE_EASING_MS,
    LIVE_STALE_MS,
    LIVE_TAIL_BRIDGE_MS,
    LIVE_TICK_TRANSITION_MS,
    LIVE_VISUAL_TAIL_MS,
    PERIOD_MS,
    buildScale,
    buildRealtimePoints,
    formatClock,
    linePath,
    monotonePath,
    mergeLiveVisualTail,
    normalisePoints,
    render,
    reset,
    smoothLivePrice,
    smoothLiveScale,
    smoothLiveTicks,
    yTicksFromRangeAndCount,
  };
}));
