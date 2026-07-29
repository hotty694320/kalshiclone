(function attachKalshiHeader(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.KalshiHeader = api;
}(typeof window !== 'undefined' ? window : globalThis, function createKalshiHeader() {
  'use strict';

  function finite(value) {
    if (value == null || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function formatPrice(value) {
    const number = finite(value);
    if (number == null) return '--';
    return '$' + number.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }

  function formatEtTime(timestamp) {
    const value = finite(timestamp);
    if (value == null || value <= 0) return '--';
    const time = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }).format(new Date(value)).replace(/\s/g, '').toLowerCase();
    return `${time} ET`;
  }

  function formatDelta(nowValue, targetValue) {
    const now = finite(nowValue);
    const target = finite(targetValue);
    if (now == null || target == null || target <= 0) {
      return { text: '--', direction: 'neutral' };
    }

    const delta = now - target;
    const percentage = delta / target * 100;
    const direction = delta > 0 ? 'positive' : delta < 0 ? 'negative' : 'neutral';
    const sign = delta > 0 ? '+' : delta < 0 ? '-' : '';
    const percentageSign = percentage > 0 ? '+' : percentage < 0 ? '-' : '';
    const money = '$' + Math.abs(delta).toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    return {
      text: `${sign}${money} (${percentageSign}${Math.abs(percentage).toFixed(3)}%)`,
      direction,
    };
  }

  return {
    formatDelta,
    formatEtTime,
    formatPrice,
  };
}));
