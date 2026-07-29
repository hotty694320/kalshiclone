(function attachKalshiCountdown(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.KalshiCountdown = api;
}(typeof window !== 'undefined' ? window : globalThis, function createKalshiCountdown() {
  'use strict';

  function finiteTimestamp(value) {
    if (value == null || value === '') return null;
    const timestamp = Number(value);
    return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null;
  }

  function formatCountdown(closeTime, now = Date.now()) {
    const closeTimestamp = finiteTimestamp(closeTime);
    const nowTimestamp = finiteTimestamp(now);
    if (closeTimestamp == null || nowTimestamp == null) return '--:--';

    // Ceil keeps the final second visible and prevents an early 00:00.
    const totalSeconds = Math.max(0, Math.ceil((closeTimestamp - nowTimestamp) / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  function marketKey(market) {
    if (!market) return null;
    return String(market.eventTicker || market.ticker || '') || null;
  }

  function currentMarket(markets, now = Date.now()) {
    return (Array.isArray(markets) ? markets : [])
      .filter((market) => {
        const closeTime = finiteTimestamp(market?.closeTime);
        return closeTime != null
          && closeTime > now
          && market?.status !== 'closed';
      })
      .sort((left, right) => Number(left.closeTime) - Number(right.closeTime))[0] || null;
  }

  return { currentMarket, formatCountdown, marketKey };
}));
