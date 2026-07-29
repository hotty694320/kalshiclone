'use strict';

const MODEL_NAME = 'settlement-bootstrap';
const MODEL_VERSION = 'structural-v1';
const HISTORY_WINDOW_MS = 10 * 60_000;
const MIN_USABLE_TICKS = 300;
const HEALTHY_COVERAGE = 0.95;
const HEALTHY_STALENESS_MS = 2_000;
const MAX_STALENESS_MS = 10_000;
const BLOCK_SIZE = 5;
const DEFAULT_PATHS = 20_000;

function finite(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clamp(value, lower, upper) {
  return Math.min(upper, Math.max(lower, value));
}

function roundProbability(value) {
  return Math.round(value * 1e8) / 1e8;
}

function fnv1a(value) {
  let hash = 0x811c9dc5;
  for (const char of String(value)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function seededRandom(seed) {
  let state = fnv1a(seed) || 0x6d2b79f5;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function variance(values) {
  if (!Array.isArray(values) || values.length < 2) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / (values.length - 1);
}

function logit(probability) {
  const p = clamp(probability, 1e-6, 1 - 1e-6);
  return Math.log(p / (1 - p));
}

function logistic(value) {
  if (value >= 0) {
    const exp = Math.exp(-value);
    return 1 / (1 + exp);
  }
  const exp = Math.exp(value);
  return exp / (1 + exp);
}

function marketProbability(market) {
  const bid = finite(market?.yesBid);
  const ask = finite(market?.yesAsk);
  if (
    bid == null || ask == null
    || bid < 0 || ask > 1 || bid > ask
  ) {
    return { probability: null, spread: null };
  }
  return {
    probability: clamp((bid + ask) / 2, 0.02, 0.98),
    spread: ask - bid,
  };
}

function blendProbabilities(independent, market) {
  if (finite(independent) == null) return null;
  if (finite(market) == null) return independent;
  return logistic((logit(independent) + logit(market)) / 2);
}

function normalizeTicks(ticks, cutoffTimestamp) {
  const bySecond = new Map();
  for (const tick of Array.isArray(ticks) ? ticks : []) {
    const sourceTimestamp = finite(tick?.source_ts_ms ?? tick?.sourceTimestamp ?? tick?.timestamp);
    const receivedTimestamp = finite(tick?.received_ts_ms ?? tick?.receivedTimestamp ?? sourceTimestamp);
    const price = finite(tick?.price);
    if (
      sourceTimestamp == null || receivedTimestamp == null || price == null || price <= 0
      || sourceTimestamp >= cutoffTimestamp || receivedTimestamp > cutoffTimestamp
    ) continue;
    const second = Math.floor(sourceTimestamp / 1000) * 1000;
    const previous = bySecond.get(second);
    if (!previous || sourceTimestamp >= previous.sourceTimestamp) {
      bySecond.set(second, { sourceTimestamp, receivedTimestamp, price });
    }
  }
  return [...bySecond.values()].sort((left, right) => left.sourceTimestamp - right.sourceTimestamp);
}

function buildReturnBlocks(ticks) {
  const returns = [];
  for (let index = 1; index < ticks.length; index += 1) {
    const previous = ticks[index - 1];
    const current = ticks[index];
    const gap = current.sourceTimestamp - previous.sourceTimestamp;
    returns.push(gap >= 500 && gap <= 1_500
      ? Math.log(current.price / previous.price)
      : null);
  }

  const validReturns = returns.filter(Number.isFinite);
  if (validReturns.length < MIN_USABLE_TICKS - 1) {
    return { blocks: [], scale: 1, returnCount: validReturns.length };
  }

  const mean = validReturns.reduce((sum, value) => sum + value, 0) / validReturns.length;
  const demeaned = returns.map(value => Number.isFinite(value) ? value - mean : null);
  const blocks = [];
  for (let start = 0; start <= demeaned.length - BLOCK_SIZE; start += 1) {
    const block = demeaned.slice(start, start + BLOCK_SIZE);
    if (block.every(Number.isFinite)) blocks.push(block);
  }

  const recent = validReturns.slice(-60);
  const longVariance = variance(validReturns);
  const recentVariance = variance(recent);
  const scale = longVariance > 0 && recentVariance > 0
    ? clamp(Math.sqrt(recentVariance / longVariance), 0.5, 2)
    : 1;
  return { blocks, scale, returnCount: validReturns.length };
}

function evaluateDataHealth(ticks, cutoffTimestamp, targetPrice) {
  if (finite(targetPrice) == null || targetPrice <= 0) {
    return {
      health: 'unavailable',
      reason: 'A valid Kalshi target is unavailable.',
      coverage: 0,
      stalenessMs: null,
    };
  }
  if (!ticks.length) {
    return {
      health: 'unavailable',
      reason: 'No cutoff-safe BRTI ticks are available.',
      coverage: 0,
      stalenessMs: null,
    };
  }

  const coverage = ticks.length / (HISTORY_WINDOW_MS / 1000);
  const latest = ticks[ticks.length - 1];
  const stalenessMs = cutoffTimestamp - latest.sourceTimestamp;
  if (ticks.length < MIN_USABLE_TICKS) {
    return {
      health: 'unavailable',
      reason: `Only ${ticks.length} valid BRTI seconds are available; at least ${MIN_USABLE_TICKS} are required.`,
      coverage,
      stalenessMs,
    };
  }
  if (stalenessMs > MAX_STALENESS_MS) {
    return {
      health: 'unavailable',
      reason: `The latest BRTI tick is ${Math.round(stalenessMs / 1000)} seconds stale.`,
      coverage,
      stalenessMs,
    };
  }
  if (coverage >= HEALTHY_COVERAGE && stalenessMs <= HEALTHY_STALENESS_MS) {
    return { health: 'healthy', reason: null, coverage, stalenessMs };
  }
  return {
    health: 'degraded',
    reason: 'The forecast used partial or slightly stale BRTI coverage.',
    coverage,
    stalenessMs,
  };
}

class SettlementProbabilityModel {
  constructor({ paths = DEFAULT_PATHS } = {}) {
    this.paths = paths;
    this.modelName = MODEL_NAME;
    this.modelVersion = MODEL_VERSION;
  }

  predict({
    marketTicker,
    targetPrice,
    closeTimestamp,
    cutoffTimestamp,
    ticks,
    marketQuote,
  }) {
    const cutoff = finite(cutoffTimestamp);
    const close = finite(closeTimestamp);
    const target = finite(targetPrice);
    if (cutoff == null || close == null || close <= cutoff) {
      return {
        status: 'unavailable',
        dataHealth: 'unavailable',
        reason: 'The market timing is invalid.',
      };
    }

    const normalized = normalizeTicks(ticks, cutoff);
    const health = evaluateDataHealth(normalized, cutoff, target);
    const latest = normalized.at(-1) || null;
    if (health.health === 'unavailable') {
      return {
        status: 'unavailable',
        dataHealth: health.health,
        reason: health.reason,
        latestSourceTimestamp: latest?.sourceTimestamp ?? null,
        latestReceivedTimestamp: latest?.receivedTimestamp ?? null,
        features: {
          tickCount: normalized.length,
          coverage: health.coverage,
          stalenessMs: health.stalenessMs,
        },
      };
    }

    const { blocks, scale, returnCount } = buildReturnBlocks(normalized);
    if (blocks.length < 40) {
      return {
        status: 'unavailable',
        dataHealth: 'unavailable',
        reason: 'Too few uninterrupted BRTI return blocks are available.',
        latestSourceTimestamp: latest?.sourceTimestamp ?? null,
        latestReceivedTimestamp: latest?.receivedTimestamp ?? null,
        features: {
          tickCount: normalized.length,
          returnCount,
          blockCount: blocks.length,
        },
      };
    }

    const futureSeconds = Math.round((close - cutoff) / 1000);
    const settlementStartSecond = futureSeconds - 60;
    if (futureSeconds < 61 || settlementStartSecond < 1) {
      return {
        status: 'unavailable',
        dataHealth: 'unavailable',
        reason: 'The cutoff does not leave a complete future settlement minute.',
      };
    }

    const random = seededRandom(`${marketTicker}:${cutoff}:${this.modelVersion}`);
    let upPaths = 0;
    for (let path = 0; path < this.paths; path += 1) {
      let price = latest.price;
      let settlementSum = 0;
      let settlementCount = 0;
      let block = null;
      for (let second = 1; second < futureSeconds; second += 1) {
        const blockIndex = (second - 1) % BLOCK_SIZE;
        if (blockIndex === 0) {
          block = blocks[Math.floor(random() * blocks.length)];
        }
        price *= Math.exp(block[blockIndex] * scale);
        if (second >= settlementStartSecond) {
          settlementSum += price;
          settlementCount += 1;
        }
      }
      if (settlementCount === 60 && settlementSum / settlementCount >= target) {
        upPaths += 1;
      }
    }

    const rawIndependent = (upPaths + 0.5) / (this.paths + 1);
    const probabilityBounds = health.health === 'healthy' ? [0.02, 0.98] : [0.10, 0.90];
    const independent = clamp(rawIndependent, ...probabilityBounds);
    const prior = marketProbability(marketQuote);
    const assisted = prior.probability == null
      ? null
      : clamp(blendProbabilities(independent, prior.probability), ...probabilityBounds);

    return {
      status: 'generated',
      dataHealth: health.health,
      reason: health.reason,
      independentProbabilityUp: roundProbability(independent),
      marketProbabilityUp: prior.probability == null ? null : roundProbability(prior.probability),
      assistedProbabilityUp: assisted == null ? null : roundProbability(assisted),
      latestSourceTimestamp: latest.sourceTimestamp,
      latestReceivedTimestamp: latest.receivedTimestamp,
      features: {
        tickCount: normalized.length,
        returnCount,
        blockCount: blocks.length,
        coverage: health.coverage,
        stalenessMs: health.stalenessMs,
        volatilityScale: scale,
        pathCount: this.paths,
        futureSeconds,
        settlementStartSecond,
        marketSpread: prior.spread,
        startPrice: latest.price,
        targetPrice: target,
      },
    };
  }
}

module.exports = {
  BLOCK_SIZE,
  DEFAULT_PATHS,
  HEALTHY_COVERAGE,
  HISTORY_WINDOW_MS,
  MAX_STALENESS_MS,
  MIN_USABLE_TICKS,
  MODEL_NAME,
  MODEL_VERSION,
  SettlementProbabilityModel,
  blendProbabilities,
  evaluateDataHealth,
  marketProbability,
  normalizeTicks,
  seededRandom,
};
