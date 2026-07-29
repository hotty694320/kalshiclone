const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');

// Kalshi migrated market prices from integer cent fields to *_dollars fields.
// Keep the legacy fallback so the client remains compatible with older/demo
// responses while preferring the current API shape.
function priceDollars(market, dollarsField, centsField) {
  const dollars = market[dollarsField];
  if (dollars !== undefined && dollars !== null && dollars !== '') {
    const value = Number(dollars);
    if (Number.isFinite(value)) return value;
  }

  const cents = market[centsField];
  if (cents !== undefined && cents !== null && cents !== '') {
    const value = Number(cents);
    if (Number.isFinite(value)) return value / 100;
  }

  return null;
}

function normalizedMarket(m) {
  const yesBid = priceDollars(m, 'yes_bid_dollars', 'yes_bid');
  const yesAsk = priceDollars(m, 'yes_ask_dollars', 'yes_ask');
  const noBid = priceDollars(m, 'no_bid_dollars', 'no_bid');
  const noAsk = priceDollars(m, 'no_ask_dollars', 'no_ask');
  const lastPrice = priceDollars(m, 'last_price_dollars', 'last_price');

  return {
    ticker: m.ticker,
    status: m.status,
    result: m.result,
    yesBid,
    yesAsk,
    noBid,
    noAsk,
    lastPrice,
    yesBidCents: yesBid == null ? null : Math.round(yesBid * 100),
    yesAskCents: yesAsk == null ? null : Math.round(yesAsk * 100),
    noBidCents: noBid == null ? null : Math.round(noBid * 100),
    noAskCents: noAsk == null ? null : Math.round(noAsk * 100),
    openTime: m.open_time ? new Date(m.open_time).getTime() : undefined,
    closeTime: m.close_time ? new Date(m.close_time).getTime() : undefined,
  };
}

function bestBid(levels) {
  if (!Array.isArray(levels) || levels.length === 0) return null;
  const prices = levels
    .map((level) => Number(Array.isArray(level) ? level[0] : undefined))
    .filter((price) => Number.isFinite(price) && price >= 0 && price <= 1);
  return prices.length ? Math.max(...prices) : null;
}

function applyOrderbookQuotes(market, orderbook) {
  const book = orderbook?.orderbook_fp;
  if (!book) return market;

  // Kalshi's order-book endpoint exposes bids for each side. In a binary
  // market, a NO bid at x is the executable YES ask at (1 - x), and vice
  // versa. This endpoint matches the live trading UI more reliably than the
  // cached top-of-book fields on GET /markets.
  const yesBid = bestBid(book.yes_dollars);
  const noBid = bestBid(book.no_dollars);
  const yesAsk = noBid == null ? null : 1 - noBid;
  const noAsk = yesBid == null ? null : 1 - yesBid;

  return {
    ...market,
    yesBid,
    noBid,
    yesAsk,
    noAsk,
    yesBidCents: yesBid == null ? null : Math.round(yesBid * 100),
    noBidCents: noBid == null ? null : Math.round(noBid * 100),
    yesAskCents: yesAsk == null ? null : Math.round(yesAsk * 100),
    noAskCents: noAsk == null ? null : Math.round(noAsk * 100),
  };
}

class KalshiClient {
  constructor(config, state) {
    this.config = config;
    this.state = state;
    this.privateKeyPem = null;
    this.baseUrl = config.KALSHI_API_BASE || 'https://api.elections.kalshi.com';
  }

  loadPrivateKey() {
    if (!this.privateKeyPem) {
      // Support base64-encoded key from env var (for Vercel/serverless)
      if (process.env.KALSHI_PRIVATE_KEY_BASE64) {
        this.privateKeyPem = Buffer.from(process.env.KALSHI_PRIVATE_KEY_BASE64, 'base64').toString('utf8');
      } else {
        const keyPath = this.config.KALSHI_PRIVATE_KEY_PATH || 'REDACTED_KALSHI_PRIVATE_KEY_PATH';
        if (!fs.existsSync(keyPath)) {
          throw new Error(`Private key not found: ${keyPath}. Set KALSHI_PRIVATE_KEY_BASE64 env var for serverless deployments.`);
        }
        this.privateKeyPem = fs.readFileSync(keyPath, 'utf8');
      }
    }
    return this.privateKeyPem;
  }

  generateAuth(method, apiPath) {
    const pem = this.loadPrivateKey();
    const timestampMs = Date.now().toString();
    const pathWithoutQuery = apiPath.split('?')[0];
    const message = timestampMs + method + pathWithoutQuery;

    const sign = crypto.createSign('RSA-SHA256');
    sign.update(message);
    sign.end();

    const signature = sign.sign({
      key: pem,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
    }, 'base64');

    return {
      headers: {
        'Content-Type': 'application/json',
        'KALSHI-ACCESS-KEY': this.config.KALSHI_API_KEY,
        'KALSHI-ACCESS-SIGNATURE': signature,
        'KALSHI-ACCESS-TIMESTAMP': timestampMs,
      },
    };
  }

  async get(apiPath) {
    const auth = this.generateAuth('GET', apiPath);
    return axios.get(`${this.baseUrl}${apiPath}`, { ...auth, timeout: 8000 });
  }

  async post(apiPath, body) {
    const auth = this.generateAuth('POST', apiPath);
    return axios.post(`${this.baseUrl}${apiPath}`, body, { ...auth, timeout: 8000 });
  }

  async delete(apiPath) {
    const auth = this.generateAuth('DELETE', apiPath);
    return axios.delete(`${this.baseUrl}${apiPath}`, { ...auth, timeout: 8000 });
  }

  async fetchBalance() {
    try {
      const resp = await this.get('/trade-api/v2/portfolio/balance');
      const totalCents = resp.data.balance;
      const reservedCents = resp.data.payout || 0;

      const balance = {
        total: totalCents / 100,
        available: (totalCents - reservedCents) / 100,
        reserved: reservedCents / 100,
      };

      this.state.updateBalance(balance);
      this.state.updateKalshiConnection(true);
      return balance;
    } catch (error) {
      this.state.updateKalshiConnection(false);
      throw error;
    }
  }

  async discoverMarkets(seriesTicker) {
    const apiPath = `/trade-api/v2/markets?series_ticker=${seriesTicker}&limit=20&status=open`;
    const resp = await this.get(apiPath);
    return resp.data.markets || [];
  }

  async fetchMarket(ticker) {
    try {
      const [marketResp, orderbookResp] = await Promise.all([
        this.get(`/trade-api/v2/markets/${ticker}`),
        this.get(`/trade-api/v2/markets/${ticker}/orderbook`),
      ]);
      return applyOrderbookQuotes(
        normalizedMarket(marketResp.data.market),
        orderbookResp.data
      );
    } catch (error) {
      if (error.response?.status === 404) return null;
      throw error;
    }
  }

  async placeOrder(orderData) {
    const { ticker, action, side, count, client_order_id: clientOrderId } = orderData;
    const cents = side === 'yes' ? orderData.yes_price : orderData.no_price;
    const outcomePrice = Number(cents) / 100;
    const supportedTimeInForce = new Set([
      'fill_or_kill',
      'good_till_canceled',
      'immediate_or_cancel',
    ]);
    const timeInForce = supportedTimeInForce.has(orderData.time_in_force)
      ? orderData.time_in_force
      : 'good_till_canceled';

    if (!ticker || !clientOrderId || !Number.isFinite(outcomePrice) || outcomePrice <= 0 || outcomePrice >= 1) {
      throw new Error('Invalid order data: ticker, client order ID, side, and a 1-99 cent limit price are required');
    }

    // V2 uses one YES-side book. Buying NO is an ASK for YES at (1 - NO price).
    const yesBookPrice = (action === 'buy' && side === 'yes') || (action === 'sell' && side === 'yes')
      ? outcomePrice
      : 1 - outcomePrice;
    const bookSide = (action === 'buy' && side === 'yes') || (action === 'sell' && side === 'no')
      ? 'bid'
      : 'ask';

    const body = {
      ticker,
      client_order_id: clientOrderId,
      side: bookSide,
      count: String(count),
      price: yesBookPrice.toFixed(4),
      time_in_force: timeInForce,
      self_trade_prevention_type: 'taker_at_cross',
    };
    if (orderData.reduce_only === true) body.reduce_only = true;

    const resp = await this.post('/trade-api/v2/portfolio/events/orders', body);
    return resp.data.order || resp.data;
  }

  async getOrder(orderId) {
    const resp = await this.get(`/trade-api/v2/portfolio/orders/${orderId}`);
    return resp.data.order;
  }

  async cancelOrder(orderId) {
    const resp = await this.delete(`/trade-api/v2/portfolio/orders/${orderId}`);
    return resp.data;
  }

  // Fetch actual positions from Kalshi (for reconciliation on startup)
  async fetchPositions(seriesTicker) {
    try {
      // Fetch ALL unsettled positions (ticker filter requires exact market ticker, not series)
      const apiPath = `/trade-api/v2/portfolio/positions?settlement_status=unsettled&limit=200`;
      const resp = await this.get(apiPath);
      const all = resp.data.market_positions || [];
      // Filter client-side to our series only
      return all.filter(p => p.ticker && p.ticker.startsWith(seriesTicker));
    } catch (error) {
      console.error('[Kalshi] Failed to fetch positions:', error.message);
      return [];
    }
  }

  // Sell existing position (for take-profit before settlement)
  async sellPosition(ticker, side, count, priceCents) {
    const orderData = {
      ticker,
      action: 'sell',
      side,
      count,
      type: 'limit',
      client_order_id: `sell-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
    };

    if (side === 'yes') orderData.yes_price = priceCents;
    else orderData.no_price = priceCents;

    return this.placeOrder(orderData);
  }
}

module.exports = KalshiClient;
