'use strict';

const DEFAULT_RETRY_MS = 500;
const DEFAULT_BOUNDARY_PADDING_MS = 25;

function finiteCloseTime(market) {
  const closeTime = Number(market?.closeTime);
  return Number.isFinite(closeTime) && closeTime > 0 ? closeTime : null;
}

function currentMarket(markets, now = Date.now()) {
  return (Array.isArray(markets) ? markets : [])
    .filter((market) => {
      const closeTime = finiteCloseTime(market);
      return closeTime != null
        && closeTime > now
        && market?.status !== 'closed';
    })
    .sort((left, right) => finiteCloseTime(left) - finiteCloseTime(right))[0] || null;
}

function marketKey(market) {
  if (!market) return null;
  return String(market.eventTicker || market.ticker || '') || null;
}

function rolloverDelay(
  markets,
  now = Date.now(),
  retryMs = DEFAULT_RETRY_MS,
  boundaryPaddingMs = DEFAULT_BOUNDARY_PADDING_MS,
) {
  const market = currentMarket(markets, now);
  if (!market) return retryMs;
  return Math.max(0, finiteCloseTime(market) - now + boundaryPaddingMs);
}

module.exports = {
  DEFAULT_RETRY_MS,
  currentMarket,
  marketKey,
  rolloverDelay,
};
