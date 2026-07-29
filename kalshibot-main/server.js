#!/usr/bin/env node

/**
 * Kalshibot Server — Agentic Architecture
 *
 * Entry point that creates the MasterAgent (which owns the Orchestrator,
 * SkillRegistry, and all sub-agent skills), wires up the Express/Socket.io
 * UI layer, and manages the bot lifecycle.
 *
 * Architecture:
 *   server.js → MasterAgent → Orchestrator → Skills
 *
 * The legacy BotEngine is preserved at `node kalshi-bot.js` for fallback.
 */

require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const { MasterAgent } = require('./agents');
const DemoKalshiNowPrice = require('./bot/demo-kalshi-now');
const { quote: buildOrderTicketQuote } = require('./public/order-ticket');
const {
  PERIOD_MS,
  buildKalshiPriceHistory,
  buildKnockoutHistoricalSeries,
  currentSecondPoints,
  eventTimeseriesPoints,
  mergeObservedPoints,
  overlayAuthoritativeTail,
} = require('./lib/kalshi-btc-history');
const { PredictionDatasetStore } = require('./lib/prediction-dataset-store');
const { PredictionEngine } = require('./lib/prediction-engine');

const PORT = process.env.PORT || 3333;

function readApiKeyFile(keyPath) {
  if (!keyPath) return null;
  try {
    return fs.readFileSync(keyPath, 'utf8').trim() || null;
  } catch (err) {
    throw new Error(`Unable to read KALSHI_API_KEY_PATH: ${err.message}`);
  }
}

// Build config from env
const config = {
  KALSHI_API_KEY: readApiKeyFile(process.env.KALSHI_API_KEY_PATH) || process.env.KALSHI_API_KEY,
  KALSHI_PRIVATE_KEY_PATH: process.env.KALSHI_PRIVATE_KEY_PATH_OVERRIDE || process.env.KALSHI_PRIVATE_KEY_PATH || 'REDACTED_KALSHI_PRIVATE_KEY_PATH',
  KALSHI_API_BASE: process.env.KALSHI_API_BASE || 'https://api.elections.kalshi.com',

  POLYMARKET_GAMMA_API: 'https://gamma-api.polymarket.com',
  POLYMARKET_CLOB_API: 'https://clob.polymarket.com',

  SERIES_TICKER: process.env.SERIES_TICKER || 'KXBTC15M',
  SLOT_DURATION: parseInt(process.env.SLOT_DURATION) || 900, // 15 min

  // Strategy thresholds
  MIN_EDGE: parseFloat(process.env.MIN_EDGE) || 10.0,
  // Backtest-optimized: higher threshold to filter overconfident signals
  MIN_DIVERGENCE: parseFloat(process.env.MIN_DIVERGENCE) || 15.0,
  TRADING_WINDOW: parseInt(process.env.TRADING_WINDOW) || 4, // minutes
  // Backtest-optimized: contracts above 65c have terrible payoff ratio
  MIN_CONTRACT_PRICE: parseInt(process.env.MIN_CONTRACT_PRICE) || 35, // cents
  MAX_CONTRACT_PRICE: parseInt(process.env.MAX_CONTRACT_PRICE) || 65, // cents

  // 1H Trend indicator
  TREND_ENABLED: process.env.TREND_ENABLED !== 'false',
  TREND_FAST_PERIOD: parseInt(process.env.TREND_FAST_PERIOD) || 720,     // 12 min
  TREND_SLOW_PERIOD: parseInt(process.env.TREND_SLOW_PERIOD) || 2700,    // 45 min
  TREND_ROC_WINDOW: parseInt(process.env.TREND_ROC_WINDOW) || 1800,      // 30 min
  TREND_ROC_THRESHOLD: parseFloat(process.env.TREND_ROC_THRESHOLD) || 0.02,
  TREND_BOOST: parseFloat(process.env.TREND_BOOST) || 0.25,
  TREND_PENALTY: parseFloat(process.env.TREND_PENALTY) || 0.40,

  // Position sizing
  // Backtest-optimized: conservative Kelly to survive binary option variance
  USE_KELLY_SIZING: process.env.USE_KELLY_SIZING !== 'false',
  KELLY_FRACTION: parseFloat(process.env.KELLY_FRACTION) || 0.08,
  MAX_POSITION_SIZE: parseFloat(process.env.MAX_POSITION_SIZE) || 5,
  MAX_POSITIONS_PER_CONTRACT: parseInt(process.env.MAX_POSITIONS_PER_CONTRACT) || 1,
  MAX_TOTAL_OPEN_POSITIONS: parseInt(process.env.MAX_TOTAL_OPEN_POSITIONS) || 10,
};

// Express + Socket.io
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
});
app.use(express.json({ limit: '8kb' }));

// Always serve the current dashboard build. This prevents browsers from
// retaining stale HTML, JavaScript, or CSS after KALSHIBOT is restarted.
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  lastModified: false,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  },
}));

// Create the MasterAgent
const agent = new MasterAgent(config);
const predictionDataset = new PredictionDatasetStore(
  process.env.PREDICTION_DATASET_PATH || undefined,
);
const predictionEngine = new PredictionEngine({
  store: predictionDataset,
  state: agent.state,
});
predictionEngine.start();
const demoNowHistory = [];
const KALSHI_HISTORY_URL = 'https://kalshi-public-docs-demo.s3.amazonaws.com/external/crypto/btc_history.json';
const KALSHI_CURRENT_URL = 'https://kalshi-public-docs-demo.s3.amazonaws.com/external/crypto/btc_current.json';
const KALSHI_DEMO_API_BASE = 'https://demo-api.kalshi.co/v1';
const KALSHI_DATA_CACHE_MS = 500;
const KALSHI_EVENT_HISTORY_CACHE_MS = 4500;
let kalshiBtcCache = null;
let kalshiEventHistoryCache = null;
let kalshiSecondHistory = [];

function harvestKalshiSeconds(currentPayload) {
  const now = Date.now();
  const maturity = Number(currentPayload?.maturity_ts_ms);
  kalshiSecondHistory = mergeObservedPoints(
    kalshiSecondHistory,
    currentSecondPoints(currentPayload),
  ).filter(point => Number.isFinite(maturity) && point.timestamp >= maturity - PERIOD_MS['1h']);
  predictionDataset.ingestTicks(
    currentSecondPoints(currentPayload),
    now,
    maturity,
  );
  predictionDataset.gradeSettlements(now);
  predictionEngine.tick(now);
}

async function getKalshiBtcData() {
  const now = Date.now();
  if (kalshiBtcCache && now - kalshiBtcCache.fetchedAt < KALSHI_DATA_CACHE_MS) {
    return kalshiBtcCache;
  }

  const [historyResponse, currentResponse] = await Promise.all([
    axios.get(KALSHI_HISTORY_URL, { timeout: 8000 }),
    axios.get(KALSHI_CURRENT_URL, { timeout: 8000 }),
  ]);
  kalshiBtcCache = {
    fetchedAt: now,
    history: historyResponse.data,
    current: currentResponse.data,
  };
  harvestKalshiSeconds(kalshiBtcCache.current);
  return kalshiBtcCache;
}

function activeKnockoutMarket() {
  const now = Date.now();
  return (agent.state.activeMarkets || [])
    .filter(market => (
      market?.eventTicker
      && market.status !== 'closed'
      && Number(market.closeTime) > now
    ))
    .sort((left, right) => Number(left.closeTime) - Number(right.closeTime))[0] || null;
}

async function getKalshiEventHistory(eventTicker) {
  const ticker = String(eventTicker || '').toUpperCase();
  if (!/^KXBTC15M-[A-Z0-9-]+$/.test(ticker)) {
    throw new Error('invalid KXBTC15M event ticker');
  }

  const now = Date.now();
  if (
    kalshiEventHistoryCache
    && kalshiEventHistoryCache.eventTicker === ticker
    && now - kalshiEventHistoryCache.fetchedAt < KALSHI_EVENT_HISTORY_CACHE_MS
  ) {
    return kalshiEventHistoryCache;
  }

  const response = await axios.get(
    `${KALSHI_DEMO_API_BASE}/live_data/events/${encodeURIComponent(ticker)}`,
    { timeout: 8000 },
  );
  kalshiEventHistoryCache = {
    eventTicker: ticker,
    fetchedAt: now,
    payload: response.data,
  };

  const exactPoints = eventTimeseriesPoints(response.data);
  if (exactPoints.length) {
    predictionDataset.ingestTicks(exactPoints, now, exactPoints.at(-1).timestamp);
    predictionDataset.gradeSettlements(now);
    predictionEngine.tick(now);
  }
  return kalshiEventHistoryCache;
}

// Collect continuously even when the user is viewing another tab. The public
// RTI payload updates once per second; 500 ms polling avoids missing boundary
// updates while timestamp de-duplication keeps one genuine point per second.
const kalshiHarvestTimer = setInterval(() => {
  getKalshiBtcData().catch(err => {
    if (process.env.NODE_ENV !== 'test') {
      console.warn(`[KalshiHistory] ${err.message}`);
    }
  });
}, KALSHI_DATA_CACHE_MS);
kalshiHarvestTimer.unref?.();

// A dedicated visible Demo Kalshi page supplies the displayed NOW price. It
// has no trading controls connected to this app; it is used only for reads.
const demoKalshiNow = new DemoKalshiNowPrice({
  onPrice: (price) => {
    const timestamp = Date.now();
    demoNowHistory.push({ timestamp, price });
    while (demoNowHistory.length && demoNowHistory[0].timestamp < timestamp - PERIOD_MS['1h']) {
      demoNowHistory.shift();
    }
    agent.state.updateKalshiNowPrice(price);
  },
  onError: (err) => {
    // The Binance WebSocket remains the dashboard fallback if the web page
    // cannot be reached or its layout changes.
    if (err?.message && !err.message.includes('timed out')) {
      console.warn(`[DemoKalshiNow] ${err.message}`);
    }
  },
  onRestart: ({ reason, restartCount }) => {
    // Fail closed during repair so the old contract's NOW cannot be shown
    // beside the new contract's target.
    agent.state.updateKalshiNowPrice(null);
    console.warn(`[DemoKalshiNow] Automatic browser repair #${restartCount}: ${reason}`);
  },
});

let demoKalshiEventTicker = null;

function startDemoKalshiNowReader(markets) {
  if (process.env.OPEN_DEMO_KALSHI_TAB === 'false') return;
  const now = Date.now();
  const market = (markets || [])
    .filter((item) => (
      item.status !== 'closed'
      && item.eventTicker
      && Number(item.closeTime) > now
    ))
    .sort((left, right) => Number(left.closeTime) - Number(right.closeTime))[0];
  if (!market) return;

  const eventTicker = String(market.eventTicker).toLowerCase();
  if (!/^kxbtc15m-[a-z0-9-]+$/.test(eventTicker)) return;

  if (eventTicker !== demoKalshiEventTicker) {
    demoKalshiEventTicker = eventTicker;
    // Never carry the expired contract's NOW value into the new target.
    agent.state.updateKalshiNowPrice(null);
  }

  const url = `https://demo.kalshi.co/markets/kxbtc15m/bitcoin-price-up-down/${eventTicker}`;
  demoKalshiNow.start(url);
}

agent.state.on('markets', startDemoKalshiNowReader);
agent.state.on('markets', (markets) => {
  const now = Date.now();
  for (const market of markets || []) predictionDataset.upsertMarket(market, now);
  predictionDataset.gradeSettlements(now);
  predictionEngine.handleMarkets(markets, now);
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    monitoring: agent.running,
    botRunning: agent.tradingEnabled,
    demoKalshiNow: demoKalshiNow.status(),
    predictionDataset: predictionDataset.status(),
  });
});

app.get('/api/prediction-dataset/status', (req, res) => {
  res.json(predictionDataset.status());
});

app.get('/api/prediction/current', (req, res) => {
  res.json(agent.state.prediction);
});

app.get('/api/price-history', async (req, res) => {
  const period = String(req.query.period || 'live').toLowerCase();
  if (!PERIOD_MS[period]) {
    return res.status(400).json({ error: 'period must be live, 5m, 15m, or 1h' });
  }

  try {
    const activeMarket = activeKnockoutMarket();
    if (period !== 'live' && activeMarket) {
      try {
        const eventHistory = await getKalshiEventHistory(activeMarket.eventTicker);
        const exactPoints = buildKnockoutHistoricalSeries(
          period,
          eventHistory.payload,
          activeMarket.closeTime,
        );
        if (exactPoints.length >= 2) {
          return res.json({
            period,
            source: 'kalshi-demo-event-live-data',
            eventTicker: eventHistory.eventTicker,
            maturityTimestamp: exactPoints.at(-1).timestamp,
            points: exactPoints,
          });
        }
      } catch (err) {
        if (process.env.NODE_ENV !== 'test') {
          console.warn(`[KalshiEventHistory] ${err.message}`);
        }
      }
    }

    const data = await getKalshiBtcData();
    const sourcePoints = buildKalshiPriceHistory(
      period,
      data.history,
      data.current,
      kalshiSecondHistory,
    );
    // The header's NOW value comes from the visible Kalshi Demo page. Use that
    // same authoritative stream for the recent chart tail so the endpoint,
    // target color, and time window cannot disagree with the displayed NOW.
    const points = overlayAuthoritativeTail(sourcePoints, demoNowHistory);
    res.json({
      period,
      eventTicker: activeMarket?.eventTicker ?? null,
      source: demoNowHistory.length
        ? 'kalshi-demo-now-with-cf-benchmarks-backfill'
        : 'kalshi-cf-benchmarks-rti',
      maturityTimestamp: data.current?.maturity_ts_ms ?? data.history?.maturity_ts_ms ?? null,
      points,
    });
  } catch (err) {
    const oldest = Date.now() - PERIOD_MS[period];
    const fallback = demoNowHistory.filter((point) => point.timestamp >= oldest);
    if (fallback.length) {
      return res.json({
        period,
        eventTicker: activeKnockoutMarket()?.eventTicker ?? null,
        source: 'kalshi-demo-now-fallback',
        degraded: true,
        points: fallback,
      });
    }
    res.status(502).json({ error: `Unable to fetch Kalshi BTC price history: ${err.message}` });
  }
});

app.post('/api/markets/refresh', async (req, res) => {
  if (!agent.running) {
    return res.status(503).json({ status: 'monitoring_not_ready', markets: [] });
  }

  const result = await agent.refreshMarketsNow();
  const markets = agent.state?.activeMarkets || [];
  return res.status(result?.success === false ? 502 : 200).json({
    status: result?.success === false ? 'refresh_failed' : 'refreshed',
    markets,
    error: result?.error,
  });
});

// Kalshi-style 1-Click ticket. This route is intentionally locked to a Demo
// API hostname, so copying the UI into a production configuration cannot place
// a real-money order.
app.post('/api/orders/1-click', async (req, res) => {
  let apiHost;
  try {
    apiHost = new URL(config.KALSHI_API_BASE).hostname.toLowerCase();
  } catch {
    return res.status(503).json({ error: 'The configured Kalshi API URL is invalid.' });
  }
  const demoHosts = new Set(['external-api.demo.kalshi.co', 'demo-api.kalshi.co']);
  if (!demoHosts.has(apiHost)) {
    return res.status(403).json({ error: '1-Click orders are locked to Kalshi Demo.' });
  }
  if (!agent.running || !agent.state) {
    return res.status(503).json({ error: 'Demo market monitoring is not ready yet.' });
  }

  const action = req.body?.action === 'sell' ? 'sell' : req.body?.action === 'buy' ? 'buy' : null;
  const side = req.body?.side === 'no' ? 'no' : req.body?.side === 'yes' ? 'yes' : null;
  const count = Number(req.body?.count);
  if (!action || !side || !Number.isSafeInteger(count) || count < 1 || count > 1000) {
    return res.status(400).json({ error: 'Action, outcome, and 1-1000 whole shares are required.' });
  }

  const market = activeKnockoutMarket();
  if (!market || req.body?.ticker !== market.ticker) {
    return res.status(409).json({ error: 'That 15-minute market is no longer active. Please retry.' });
  }

  const ticketQuote = buildOrderTicketQuote({
    mode: action,
    side,
    quantity: count,
    yesAsk: market.yesAsk,
    noAsk: market.noAsk,
    yesBid: market.yesBid,
    noBid: market.noBid,
  });
  if (!ticketQuote.valid) {
    return res.status(409).json({ error: 'A live price is not available for that order.' });
  }
  if (action === 'buy' && ticketQuote.total > Number(agent.state.balance?.available || 0)) {
    return res.status(409).json({ error: 'Not enough available demo balance.' });
  }
  if (action === 'sell') {
    const owned = (agent.state.openPositions || [])
      .filter(position => position.ticker === market.ticker && position.side === side)
      .reduce((total, position) => total + Number(position.filledContracts || position.contracts || 0), 0);
    if (count > owned) {
      return res.status(409).json({ error: `Only ${owned} matching demo shares are available to sell.` });
    }
  }

  try {
    const kalshiSkill = agent.registry.get('kalshi-market-data');
    const client = kalshiSkill?.getClient();
    if (!client) throw new Error('Kalshi Demo client is unavailable.');

    const clientOrderId = `ticket-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const priceCents = Math.round(ticketQuote.price * 1000) / 10;
    const orderData = {
      ticker: market.ticker,
      action,
      side,
      count,
      type: 'limit',
      client_order_id: clientOrderId,
      time_in_force: 'immediate_or_cancel',
      reduce_only: action === 'sell',
    };
    if (side === 'yes') orderData.yes_price = priceCents;
    else orderData.no_price = priceCents;

    const order = await client.placeOrder(orderData);
    agent.state.logTrade({
      type: 'ORDER',
      message: `${action.toUpperCase()} ${side.toUpperCase()} ${market.ticker} x${count} @ ${priceCents}¢ submitted from 1-Click`,
    });
    await client.fetchBalance();

    // Immediately crossed Demo orders normally fill at once. Reconcile shortly
    // after the response so the positions and Sell availability update without
    // starting the autonomous bot.
    setTimeout(async () => {
      try {
        await kalshiSkill.execute({ action: 'reconcile-positions', params: {} });
        await client.fetchBalance();
        io.emit('snapshot', agent.state.getSnapshot());
      } catch (err) {
        console.warn(`[1-Click] Post-order refresh failed: ${err.message}`);
      }
    }, 750).unref?.();

    return res.status(201).json({
      status: 'submitted',
      order: {
        order_id: order.order_id,
        status: order.status,
        fill_count: order.fill_count || 0,
      },
    });
  } catch (err) {
    const message = err.response?.data?.message || err.response?.data?.error || err.message;
    console.warn(`[1-Click] Demo order failed: ${message}`);
    return res.status(502).json({ error: message || 'Kalshi Demo rejected the order.' });
  }
});

// Bot control: start/stop
app.post('/api/bot/start', (req, res) => {
  if (agent.tradingEnabled) {
    return res.json({ status: 'already_running' });
  }
  // Respond immediately — start() is long-running (connects to feeds, waits for prices)
  if (agent.running) {
    agent.enableTrading();
    io.emit('bot:status', { running: true });
    return res.json({ status: 'started' });
  }
  res.json({ status: 'starting' });
  agent.start({ tradingEnabled: true })
    .then(() => {
      io.emit('bot:status', { running: true });
    })
    .catch((err) => {
      console.error('[Server] Bot start failed:', err.message);
      io.emit('bot:status', { running: false, error: err.message });
    });
});

app.post('/api/bot/stop', (req, res) => {
  if (!agent.tradingEnabled) {
    return res.json({ status: 'already_stopped' });
  }
  agent.disableTrading();
  io.emit('bot:status', { running: false });
  res.json({ status: 'stopped', monitoring: agent.running });
});

app.get('/api/bot/status', (req, res) => {
  res.json({ running: agent.tradingEnabled, monitoring: agent.running });
});

// API: get current state
app.get('/api/state', (req, res) => {
  if (agent && agent.state) {
    res.json(agent.state.getSnapshot());
  } else {
    res.json({ error: 'Agent not started' });
  }
});

// API: force save state to disk
app.post('/api/save', (req, res) => {
  if (agent && agent.state) {
    agent.state.saveNow();
    res.json({ status: 'saved' });
  } else {
    res.json({ error: 'Agent not started' });
  }
});

// API: ML pipeline status
app.get('/api/ml', (req, res) => {
  const mlScorer = agent.registry.get('ml-signal-scorer');
  if (mlScorer) {
    const mlPipeline = require('./lib/ml-pipeline');
    res.json(mlPipeline.describe());
  } else {
    res.json({ trained: false, note: 'ML scorer not initialized' });
  }
});

// API: get agent skill registry status
app.get('/api/skills', (req, res) => {
  res.json({
    skills: agent.registry.describeAll(),
    orchestrator: agent.orchestrator.describe(),
  });
});

// Socket.io: push updates to UI
io.on('connection', (socket) => {
  console.log(`[Server] UI connected: ${socket.id}`);

  // Send full snapshot on connect
  socket.emit('bot:status', { running: agent.tradingEnabled });
  if (agent.state) {
    socket.emit('snapshot', agent.state.getSnapshot());
  }

  // Forward state events to this socket
  const events = [
    'price:binance', 'price:redstone', 'price:kalshi-now', 'balance', 'markets',
    'intent', 'model', 'prediction', 'trade',
    'order:pending', 'order:removed',
    'position:open', 'position:close', 'position:updated',
    'stats', 'connection:kalshi', 'connection:polymarket', 'connection:binance',
  ];

  const handlers = {};
  for (const event of events) {
    handlers[event] = (data) => socket.emit(event, data);
    if (agent.state) {
      agent.state.on(event, handlers[event]);
    }
  }

  socket.on('disconnect', () => {
    console.log(`[Server] UI disconnected: ${socket.id}`);
    for (const event of events) {
      try {
        if (agent.state) {
          agent.state.removeListener(event, handlers[event]);
        }
      } catch (e) {
        // Ignore cleanup errors
      }
    }
  });
});

// Start server, then agent
server.listen(PORT, () => {
  console.log(`\n  KALSHIBOT MISSION CONTROL (Agentic Architecture)`);
  console.log(`  Dashboard:  http://localhost:${PORT}`);
  console.log(`  Skills API: http://localhost:${PORT}/api/skills`);
  console.log(`  Config: ${config.SERIES_TICKER} | MinEdge=${config.MIN_EDGE}% | MinDiv=${config.MIN_DIVERGENCE}% | MaxPos=$${config.MAX_POSITION_SIZE}\n`);

  // Bot does NOT auto-start — user controls via dashboard toggle
  console.log('  Starting market monitoring. Trading remains paused until enabled in the dashboard.\n');
  agent.start({ tradingEnabled: false })
    .then(() => {
      io.emit('bot:status', { running: false });
      io.emit('snapshot', agent.state.getSnapshot());
    })
    .catch((err) => console.error('[Server] Monitoring startup failed:', err.message));
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[Server] Shutting down...');
  demoKalshiNow.stop();
  predictionEngine.stop();
  predictionDataset.close();
  if (agent.state) agent.state.saveNow();
  agent.stop();
  server.close();
  process.exit(0);
});
