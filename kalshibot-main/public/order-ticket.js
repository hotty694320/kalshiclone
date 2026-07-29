'use strict';

(function exposeOrderTicket(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.KalshiOrderTicket = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createOrderTicket() {
  const TAKER_FEE_RATE = 0.07;

  function normalizePrice(value) {
    const price = Number(value);
    return Number.isFinite(price) && price > 0 && price < 1 ? price : null;
  }

  function normalizeQuantity(value) {
    const quantity = Math.floor(Number(value));
    return Number.isFinite(quantity) && quantity > 0 ? quantity : 0;
  }

  function tradingFee(quantity, price, rate = TAKER_FEE_RATE) {
    const count = normalizeQuantity(quantity);
    const normalizedPrice = normalizePrice(price);
    if (!count || normalizedPrice == null) return 0;
    const rawFee = rate * count * normalizedPrice * (1 - normalizedPrice);
    return Math.ceil((rawFee * 100) - Number.EPSILON) / 100;
  }

  function quote({
    mode = 'buy',
    side = 'yes',
    quantity = 0,
    yesAsk,
    noAsk,
    yesBid,
    noBid,
  } = {}) {
    const action = mode === 'sell' ? 'sell' : 'buy';
    const outcome = side === 'no' ? 'no' : 'yes';
    const count = normalizeQuantity(quantity);
    const rawPrice = action === 'buy'
      ? (outcome === 'yes' ? yesAsk : noAsk)
      : (outcome === 'yes' ? yesBid : noBid);
    const price = normalizePrice(rawPrice);

    if (!count || price == null) {
      return {
        mode: action,
        side: outcome,
        quantity: count,
        price,
        fee: 0,
        gross: 0,
        total: 0,
        payout: action === 'buy' ? count : 0,
        profit: 0,
        valid: false,
      };
    }

    const gross = count * price;
    const fee = tradingFee(count, price);
    const total = action === 'buy' ? gross + fee : Math.max(0, gross - fee);
    const payout = action === 'buy' ? count : 0;
    const profit = action === 'buy' ? payout - total : total;

    return {
      mode: action,
      side: outcome,
      quantity: count,
      price,
      fee,
      gross,
      total,
      payout,
      profit,
      valid: true,
    };
  }

  function formatCents(price) {
    const normalizedPrice = normalizePrice(price);
    if (normalizedPrice == null) return '--';
    const cents = Math.round(normalizedPrice * 1000) / 10;
    return `${Number.isInteger(cents) ? cents.toFixed(0) : cents.toFixed(1)}¢`;
  }

  function formatMoney(value) {
    const amount = Number(value);
    return Number.isFinite(amount) ? `$${amount.toFixed(2)}` : '--';
  }

  function formatSignedMoney(value) {
    const amount = Number(value);
    if (!Number.isFinite(amount)) return '--';
    return `${amount >= 0 ? '+' : '-'}$${Math.abs(amount).toFixed(2)}`;
  }

  return {
    TAKER_FEE_RATE,
    formatCents,
    formatMoney,
    formatSignedMoney,
    normalizePrice,
    normalizeQuantity,
    quote,
    tradingFee,
  };
});
