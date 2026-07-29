// KALSHIBOT Mission Control - Frontend

const socket = io();
let dashboardServerDisconnected = false;

// A server restart means the files may have changed. Reload automatically as
// soon as Socket.IO reconnects so the user never needs a forced refresh.
socket.on('disconnect', () => {
  dashboardServerDisconnected = true;
});
socket.io.on('reconnect', () => {
  if (dashboardServerDisconnected) window.location.reload();
});

// ========== State ==========
let state = {
  connections: {},
  btcPrice: {},
  balance: {},
  activeMarkets: [],
  openPositions: [],
  tradeLog: [],
  pnlHistory: [],
  intent: {},
  stats: {},
  model: {},
  prediction: {},
};

let startTime = null; // Set from server's persistent startTime
let liveSourcePoints = [];
const chartSeriesByPeriod = {
  '5m': [],
  '15m': [],
  '1h': [],
};
let selectedChartPeriod = 'live';
let marketTargetPrice = null;
let activeMarketCloseTime = null;
let activeMarketKey = null;
let activeTicketMarket = null;
let currentNowPrice = null;
let chartRenderQueued = false;
let chartRefreshTimer = null;
let chartRequestGeneration = 0;
let lastChartFrameAt = 0;
let marketRolloverRequestInFlight = false;
let lastMarketRolloverRequestAt = 0;
const CHART_POLL_INTERVAL_MS = 500;
const CHART_FRAME_INTERVAL_MS = Math.floor(1000 / 30);

// ========== Restore from localStorage ==========
try {
  const savedPnl = localStorage.getItem('kalshibot_pnlHistory');
  if (savedPnl) {
    const parsed = JSON.parse(savedPnl);
    if (Array.isArray(parsed) && parsed.length > 0) {
      state.pnlHistory = parsed;
    }
  }
  const savedStart = localStorage.getItem('kalshibot_startTime');
  if (savedStart) startTime = parseInt(savedStart, 10);
} catch (e) {
  // Ignore localStorage errors
}

// ========== DOM Elements ==========
const el = (id) => document.getElementById(id);

// ========== Kalshi-style SVG Market Chart ==========
const marketChart = el('market-chart');

// Render chart from restored localStorage data on load
if (state.pnlHistory.length > 0) {
  updateChart(state.pnlHistory);
}

// ========== Update Functions ==========
function updateConnections(conns) {
  const dots = {
    binance: 'dot-binance',
    polymarket: 'dot-polymarket',
    kalshi: 'dot-kalshi',
    redstone: 'dot-redstone',
  };
  for (const [key, dotId] of Object.entries(dots)) {
    const dot = el(dotId);
    if (dot) {
      dot.classList.toggle('active', !!conns[key]);
    }
  }
}

function updateBtcPrice(price) {
  const btcEl = el('btc-price');
  if (!price) return;

  const liveNow = Number(price.kalshiNow);
  if (Number.isFinite(liveNow) && liveNow > 0) {
    currentNowPrice = liveNow;
    btcEl.textContent = window.KalshiHeader.formatPrice(liveNow);
  } else {
    currentNowPrice = null;
    btcEl.textContent = '--';
  }
  updateHeaderDelta();
}

function updateHeaderDelta() {
  if (!window.KalshiHeader) return;
  const delta = window.KalshiHeader.formatDelta(currentNowPrice, marketTargetPrice);
  const deltaEl = el('btc-delta');
  const valueEl = el('btc-price-wrap');
  deltaEl.textContent = delta.text;
  deltaEl.classList.remove('positive', 'negative');
  valueEl.classList.remove('positive', 'negative');
  if (delta.direction !== 'neutral') {
    deltaEl.classList.add(delta.direction);
    valueEl.classList.add(delta.direction);
  }
}

function renderableChartPoints() {
  if (selectedChartPeriod !== 'live') return chartSeriesByPeriod[selectedChartPeriod] || [];
  if (!window.KalshiChart) return liveSourcePoints;
  return window.KalshiChart.buildRealtimePoints(liveSourcePoints, Date.now());
}

function queueSpotRender() {
  if (chartRenderQueued) return;
  chartRenderQueued = true;
  requestAnimationFrame(() => {
    chartRenderQueued = false;
    renderSpotSeries(renderableChartPoints());
  });
}

function renderSpotSeries(points) {
  if (!marketChart || !window.KalshiChart) return;
  window.KalshiChart.render({
    svg: marketChart,
    period: selectedChartPeriod,
    points,
    target: marketTargetPrice,
    currentPrice: currentNowPrice,
  });
}

async function refreshChartPeriod(period, generation) {
  const requestedMarketKey = activeMarketKey;
  try {
    const response = await fetch(`/api/price-history?period=${encodeURIComponent(period)}`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'price history unavailable');
    if (generation !== chartRequestGeneration || period !== selectedChartPeriod) return;
    if (requestedMarketKey !== activeMarketKey) return;
    if (requestedMarketKey && payload.eventTicker !== requestedMarketKey) return;

    const points = window.KalshiChart.normalisePoints(payload.points || []);
    if (period === 'live') liveSourcePoints = points;
    else chartSeriesByPeriod[period] = points;
    queueSpotRender();
  } catch (err) {
    if (generation === chartRequestGeneration) {
      console.warn('Price history unavailable:', err.message);
      queueSpotRender();
    }
  } finally {
    if (generation === chartRequestGeneration && period === selectedChartPeriod) {
      chartRefreshTimer = setTimeout(
        () => refreshChartPeriod(period, generation),
        CHART_POLL_INTERVAL_MS,
      );
    }
  }
}

function loadChartPeriod(period) {
  selectedChartPeriod = period;
  chartRequestGeneration += 1;
  const generation = chartRequestGeneration;
  if (chartRefreshTimer) clearTimeout(chartRefreshTimer);
  document.querySelectorAll('.chart-tab').forEach(tab => {
    const selected = tab.dataset.period === period;
    tab.classList.toggle('active', selected);
    tab.setAttribute('aria-selected', String(selected));
  });

  queueSpotRender();
  refreshChartPeriod(period, generation);
}

document.querySelectorAll('.chart-tab').forEach(tab => {
  tab.addEventListener('click', () => loadChartPeriod(tab.dataset.period));
});

loadChartPeriod('live');

function animateLiveChart(frameTime) {
  if (selectedChartPeriod === 'live' && frameTime - lastChartFrameAt >= CHART_FRAME_INTERVAL_MS) {
    lastChartFrameAt = frameTime;
    renderSpotSeries(renderableChartPoints());
  }
  requestAnimationFrame(animateLiveChart);
}
requestAnimationFrame(animateLiveChart);

if (marketChart && typeof ResizeObserver !== 'undefined') {
  const chartResizeObserver = new ResizeObserver(() => queueSpotRender());
  chartResizeObserver.observe(marketChart.parentElement);
}

function updatePnL(stats) {
  const pnlEl = el('total-pnl');
  const pnl = stats.totalPnL || 0;
  pnlEl.textContent = (pnl >= 0 ? '+' : '') + '$' + pnl.toFixed(2);
  pnlEl.className = 'metric-value ' + (pnl >= 0 ? 'positive' : 'negative');

  el('win-loss').textContent = `${stats.wins || 0}W / ${stats.losses || 0}L`;

  // ROI
  const volume = stats.volumeTraded || 1;
  const roi = (pnl / volume) * 100;
  const roiEl = el('roi-value');
  roiEl.textContent = (roi >= 0 ? '+' : '') + roi.toFixed(1) + '%';
  roiEl.className = 'metric-value ' + (roi >= 0 ? 'positive' : 'negative');

  el('trades-per-hour').textContent = (stats.tradesPerHour || 0).toFixed(1) + ' trades/hr';
}

function updateBalance(bal) {
  if (!bal) return;
  const available = el('ticket-account-available');
  if (available) available.textContent = '$' + (bal.available || 0).toFixed(2) + ' available';
  renderOrderTicket();
}

function updateIntent(intent) {
  if (!intent) return;

  const message = el('intent-message');
  if (message) message.textContent = intent.message || '--';
  const probability = el('intent-prob');
  if (probability) {
    probability.textContent = intent.modelProbability != null
      ? (intent.modelProbability * 100).toFixed(1) + '%'
      : '--';
  }
  const edge = el('intent-edge');
  if (edge) {
    edge.textContent = intent.currentEdge != null
      ? intent.currentEdge.toFixed(1) + '%'
      : '--';
  }
}

function updateModel(model) {
  if (!model) return;

  const move = el('intent-move');
  if (move) {
    move.textContent = model.spotMovePct != null
      ? (model.spotMovePct >= 0 ? '+' : '') + model.spotMovePct.toFixed(4) + '%'
      : '--';
  }
  const volatility = el('intent-vol');
  if (volatility) {
    volatility.textContent = model.volatility != null
      ? (model.volatility * 100).toFixed(3) + '%'
      : '--';
  }
  // Color the move
  const moveEl = el('intent-move');
  if (moveEl && model.spotMovePct > 0) moveEl.classList.add('positive');
  else if (moveEl && model.spotMovePct < 0) moveEl.classList.add('negative');

  // 1H Trend indicator
  const trendEl = el('intent-trend');
  if (trendEl) {
    if (!model.trendWarmup) {
      trendEl.textContent = 'WARMING UP';
      trendEl.className = 'detail-value trend-warmup';
    } else {
      const arrow = model.trend === 'BULLISH' ? '\u2191' : model.trend === 'BEARISH' ? '\u2193' : '\u2194';
      const rocStr = model.trendROC != null ? ' (' + (model.trendROC >= 0 ? '+' : '') + model.trendROC.toFixed(3) + '%)' : '';
      trendEl.textContent = arrow + ' ' + model.trend + rocStr;
      trendEl.className = 'detail-value trend-' + model.trend.toLowerCase();
    }
  }
}

function formatPredictionPair(pair) {
  const up = Number(pair?.up);
  const down = Number(pair?.down);
  if (!Number.isFinite(up) || !Number.isFinite(down)) return '--';
  return `UP ${(up * 100).toFixed(1)}% · DOWN ${(down * 100).toFixed(1)}%`;
}

function predictionTimeRemaining(now = Date.now()) {
  const finalizeAt = Number(state.prediction?.finalizeAt);
  if (!Number.isFinite(finalizeAt)) return null;
  return Math.max(0, finalizeAt - now);
}

function formatPredictionCountdown(milliseconds) {
  if (!Number.isFinite(milliseconds)) return '--:--';
  const totalSeconds = Math.ceil(milliseconds / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function renderTicketPrediction(now = Date.now()) {
  const primary = el('ticket-forecast-primary');
  const assisted = el('ticket-forecast-assisted');
  const forecast = el('ticket-forecast');
  if (!primary || !assisted || !forecast) return;

  const prediction = state.prediction || {};
  forecast.dataset.status = prediction.status || 'unavailable';
  forecast.dataset.health = prediction.dataHealth || 'unavailable';
  if (prediction.status === 'analyzing') {
    primary.textContent = `ANALYZING · ${formatPredictionCountdown(predictionTimeRemaining(now))} TO LOCK`;
    assisted.textContent = 'Probabilities appear when the 12-minute forecast locks.';
  } else if (prediction.status === 'finalized') {
    primary.textContent = formatPredictionPair(prediction.independent);
    assisted.textContent = `Market-assisted · ${formatPredictionPair(prediction.marketAssisted)} · LOCKED`;
  } else {
    primary.textContent = String(prediction.status || 'unavailable').toUpperCase();
    assisted.textContent = prediction.reason || 'Waiting for a valid forecast.';
  }
}

function updatePrediction(prediction) {
  state.prediction = prediction || {};
  const independent = el('prediction-independent');
  const assisted = el('prediction-assisted');
  const status = el('prediction-status');
  const countdown = el('prediction-countdown');
  if (!independent || !assisted || !status || !countdown) return;

  if (state.prediction.status === 'finalized') {
    independent.textContent = formatPredictionPair(state.prediction.independent);
    assisted.textContent = formatPredictionPair(state.prediction.marketAssisted);
    status.textContent = state.prediction.dataHealth === 'degraded'
      ? 'LOCKED · DEGRADED'
      : 'LOCKED';
    status.className = state.prediction.dataHealth === 'degraded' ? 'prediction-degraded' : 'positive';
    countdown.textContent = '12:00';
  } else if (state.prediction.status === 'analyzing') {
    independent.textContent = '--';
    assisted.textContent = '--';
    status.textContent = 'ANALYZING';
    status.className = 'prediction-analyzing';
    countdown.textContent = formatPredictionCountdown(predictionTimeRemaining());
  } else {
    independent.textContent = '--';
    assisted.textContent = '--';
    status.textContent = String(state.prediction.status || 'waiting').toUpperCase();
    status.className = 'negative';
    countdown.textContent = '--:--';
  }
  renderTicketPrediction();
}

function updatePredictionCountdown(now = Date.now()) {
  if (state.prediction?.status !== 'analyzing') return;
  const countdown = el('prediction-countdown');
  if (countdown) countdown.textContent = formatPredictionCountdown(predictionTimeRemaining(now));
  renderTicketPrediction(now);
}

function updatePositions(positions) {
  const list = el('positions-list');
  el('pos-count').textContent = positions.length;
  el('stat-open').textContent = positions.length;

  if (positions.length === 0) {
    list.innerHTML = '<div class="empty-state">No open positions</div>';
    renderOrderTicket();
    return;
  }

  list.innerHTML = positions.map(p => `
    <div class="position-card">
      <span class="pos-ticker" title="${p.ticker}">${p.ticker.split('-').slice(-2).join('-')}</span>
      <span class="pos-side ${p.side}">${p.side.toUpperCase()}</span>
      <span class="pos-info">x${p.filledContracts || p.contracts} @ ${p.priceCents}¢</span>
      <span class="pos-info">$${(p.totalCost || 0).toFixed(2)}</span>
      <span class="pos-edge">${p.edge ? p.edge.toFixed(1) + '%' : '--'}</span>
      <span class="pos-info">${p.type || ''}</span>
    </div>
  `).join('');
  renderOrderTicket();
}

function updateMarkets(markets) {
  const body = el('markets-body');
  el('market-count').textContent = markets.length;

  const market = window.KalshiCountdown.currentMarket(markets, Date.now());
  if (!market) {
    activeTicketMarket = null;
    renderOrderTicket();
    updateMarketCountdown();
    body.innerHTML = '<tr><td colspan="6" class="empty-state">Waiting for the next 15-minute market</td></tr>';
    return;
  }
  activeTicketMarket = market;

  const nextMarketKey = window.KalshiCountdown.marketKey(market);
  const previousMarketKey = activeMarketKey;
  const marketChanged = nextMarketKey !== previousMarketKey;
  activeMarketKey = nextMarketKey;
  if (marketChanged && previousMarketKey != null) {
    currentNowPrice = null;
    el('btc-price').textContent = '--';
  }
  activeMarketCloseTime = Number(market.closeTime);
  if (!Number.isFinite(activeMarketCloseTime) || activeMarketCloseTime <= 0) {
    activeMarketCloseTime = null;
  }
  updateMarketCountdown();
  const targetPrice = Number(market.targetPrice);
  if (Number.isFinite(targetPrice) && targetPrice > 0) {
    marketTargetPrice = targetPrice;
    const target = el('market-target');
    if (target) {
      target.textContent = window.KalshiHeader.formatPrice(marketTargetPrice);
    }
    const closeTime = el('market-close-time');
    if (closeTime) closeTime.textContent = window.KalshiHeader.formatEtTime(market.closeTime);
    updateHeaderDelta();
    queueSpotRender();
  }

  if (marketChanged) {
    lastMarketRolloverRequestAt = 0;
    liveSourcePoints = [];
    for (const period of Object.keys(chartSeriesByPeriod)) chartSeriesByPeriod[period] = [];
    window.KalshiChart?.reset?.(marketChart);
    loadChartPeriod(selectedChartPeriod);
  }

  renderOrderTicket();

  const dollarTotal = (price) => price == null ? '--' : '$' + price.toFixed(2);
  body.innerHTML = `
    <tr><td>ASKS</td><td>${cents(market.yesAsk)}</td><td>Best offer</td><td>${dollarTotal(market.yesAsk)}</td></tr>
    <tr><td>LAST TRADE</td><td>${cents(market.lastPrice)}</td><td>${market.status || 'active'}</td><td>--</td></tr>
    <tr><td>BIDS</td><td>${cents(market.yesBid)}</td><td>Best bid</td><td>${dollarTotal(market.yesBid)}</td></tr>
  `;
  return;

  body.innerHTML = markets.map(m => {
    const combined = (m.yesAsk || 0) + (m.noAsk || 0);
    const combinedClass = combined < 0.98 ? 'combined-good' : 'combined-bad';
    const timeStr = m.secondsUntilClose != null
      ? formatTime(m.secondsUntilClose)
      : (m.minutesUntilClose || '?') + 'm';

    return `
      <tr>
        <td style="color: var(--accent)">${m.ticker.split('-').slice(-2).join('-')}</td>
        <td>${cents(m.yesBid)} / ${cents(m.yesAsk)}</td>
        <td>${cents(m.noBid)} / ${cents(m.noAsk)}</td>
        <td class="${combinedClass}">${(combined * 100).toFixed(0)}¢</td>
        <td>${timeStr}</td>
        <td style="color: var(--green)">${m.status || 'open'}</td>
      </tr>
    `;
  }).join('');
}

function updateTradeLog(log) {
  const logEl = el('trade-log');
  el('log-count').textContent = log.length;

  if (log.length === 0) {
    logEl.innerHTML = '<div class="empty-state">No trades yet</div>';
    return;
  }

  // Show only last 30 entries for performance
  const recent = log.slice(0, 30);

  logEl.innerHTML = recent.map(entry => {
    const time = new Date(entry.timestamp).toLocaleTimeString('en-US', { hour12: false });
    let typeClass = entry.type || 'LOG';
    let msg = '';

    if (entry.type === 'TRADE') {
      typeClass = entry.action || 'BUY';
      msg = `${entry.side?.toUpperCase() || ''} ${shortTicker(entry.ticker)} x${entry.contracts || 0} @ ${entry.price || 0}¢`;
      if (entry.pnl != null) msg += ` | P&L: ${entry.pnl >= 0 ? '+' : ''}$${entry.pnl.toFixed(2)}`;
      if (entry.edge) msg += ` | Edge: ${entry.edge.toFixed(1)}%`;
    } else if (entry.type === 'SETTLEMENT') {
      typeClass = entry.action || 'WIN';
      msg = `${shortTicker(entry.ticker)} ${entry.side?.toUpperCase()} x${entry.contracts} | P&L: ${entry.pnl >= 0 ? '+' : ''}$${entry.pnl.toFixed(2)}`;
    } else {
      msg = entry.message || '';
    }

    return `
      <div class="log-entry">
        <span class="log-time">${time}</span>
        <span class="log-type ${typeClass}">${typeClass}</span>
        <span class="log-msg">${msg}</span>
      </div>
    `;
  }).join('');
}

function updateStats(stats) {
  el('stat-trades').textContent = stats.totalTrades || 0;

  const total = (stats.wins || 0) + (stats.losses || 0);
  const winRate = total > 0 ? ((stats.wins / total) * 100).toFixed(1) : '0';
  el('stat-winrate').textContent = winRate + '%';

  el('stat-avgedge').textContent = (stats.avgEdge || 0).toFixed(1) + '%';

  const bestEl = el('stat-best');
  bestEl.textContent = '+$' + (stats.bestTrade || 0).toFixed(2);
  bestEl.className = 'stat-value positive';

  const worstEl = el('stat-worst');
  worstEl.textContent = (stats.worstTrade < 0 ? '-' : '') + '$' + Math.abs(stats.worstTrade || 0).toFixed(2);
  worstEl.className = 'stat-value ' + (stats.worstTrade < 0 ? 'negative' : 'neutral');

  el('stat-volume').textContent = '$' + (stats.volumeTraded || 0).toFixed(2);
  el('stat-tph').textContent = (stats.tradesPerHour || 0).toFixed(1);

  // Profit factor
  const pfEl = el('stat-profitfactor');
  if (pfEl) {
    const pf = (stats.grossLosses || 0) > 0
      ? (stats.grossWins / stats.grossLosses)
      : (stats.grossWins > 0 ? Infinity : 0);
    pfEl.textContent = pf === Infinity ? 'INF' : pf.toFixed(2);
    pfEl.className = 'stat-value ' + (pf >= 1 ? 'positive' : 'negative');
  }

  // Avg win / avg loss
  const avgWinEl = el('stat-avgwin');
  if (avgWinEl) {
    const avgWin = (stats.wins || 0) > 0 ? (stats.grossWins || 0) / stats.wins : 0;
    avgWinEl.textContent = '+$' + avgWin.toFixed(2);
  }
  const avgLossEl = el('stat-avgloss');
  if (avgLossEl) {
    const avgLoss = (stats.losses || 0) > 0 ? (stats.grossLosses || 0) / stats.losses : 0;
    avgLossEl.textContent = '-$' + avgLoss.toFixed(2);
  }

  // Streak
  const streakEl = el('stat-streak');
  if (streakEl) {
    const streak = stats.streak || 0;
    streakEl.textContent = (streak > 0 ? '+' : '') + streak;
    streakEl.className = 'stat-value ' + (streak > 0 ? 'positive' : streak < 0 ? 'negative' : 'neutral');
  }

  // Unrealized P&L
  const unrealizedEl = el('stat-unrealized');
  if (unrealizedEl) {
    const uPnl = stats.unrealizedPnL || 0;
    unrealizedEl.textContent = (uPnl >= 0 ? '+' : '') + '$' + uPnl.toFixed(2);
    unrealizedEl.className = 'stat-value ' + (uPnl >= 0 ? 'positive' : 'negative');
  }

  // Strategy breakdown
  const stratEl = el('stat-strategy');
  if (stratEl && stats.strategyStats) {
    const parts = Object.entries(stats.strategyStats).map(([k, v]) => {
      const short = k.replace('DIRECTIONAL', 'DIR').replace('POLY_ARB', 'POLY').replace('DUAL_SIDE', 'DUAL');
      return `${short}: ${v.wins}W/${v.losses}L`;
    });
    stratEl.textContent = parts.length > 0 ? parts.join(' | ') : '--';
  }
}

function updateChart(pnlHistory) {
  // The primary chart is now the live BTC series. P&L remains available in
  // the compact summary without replacing that market view.
  const lastEntry = pnlHistory && pnlHistory[pnlHistory.length - 1];
  const summaryPnl = lastEntry?.cumulative || 0;
  el('chart-total').textContent = (summaryPnl >= 0 ? '+' : '') + '$' + summaryPnl.toFixed(2);
}

// ========== Utilities ==========
function cents(val) {
  if (val == null) return '--';
  return Math.round(val * 100) + '¢';
}

function shortTicker(ticker) {
  if (!ticker) return '';
  const parts = ticker.split('-');
  return parts.length > 2 ? parts.slice(-2).join('-') : ticker;
}

function formatTime(seconds) {
  if (seconds < 0) return '0s';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

// ========== Active Market Countdown ==========
async function requestMarketRollover(now = Date.now()) {
  if (
    marketRolloverRequestInFlight
    || now - lastMarketRolloverRequestAt < 500
  ) return;

  marketRolloverRequestInFlight = true;
  lastMarketRolloverRequestAt = now;
  try {
    const response = await fetch('/api/markets/refresh', { method: 'POST' });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || payload.status || 'market refresh failed');
    if (Array.isArray(payload.markets) && payload.markets.length > 0) {
      state.activeMarkets = payload.markets;
      updateMarkets(payload.markets);
    }
  } catch (err) {
    console.warn('Market rollover refresh unavailable:', err.message);
  } finally {
    marketRolloverRequestInFlight = false;
  }
}

function updateMarketCountdown(now = Date.now()) {
  const countdown = el('market-countdown');
  if (!countdown) return;
  countdown.textContent = window.KalshiCountdown.formatCountdown(activeMarketCloseTime, now);
  updatePredictionCountdown(now);
  if (activeMarketCloseTime != null && now >= activeMarketCloseTime) {
    requestMarketRollover(now);
  }
}

setInterval(updateMarketCountdown, 250);

// ========== Uptime Timer ==========
setInterval(() => {
  if (!startTime) {
    el('uptime').textContent = '00:00:00';
    return;
  }
  const elapsed = Math.floor((Date.now() - startTime) / 1000);
  const h = String(Math.floor(elapsed / 3600)).padStart(2, '0');
  const m = String(Math.floor((elapsed % 3600) / 60)).padStart(2, '0');
  const s = String(elapsed % 60).padStart(2, '0');
  el('uptime').textContent = `${h}:${m}:${s}`;
}, 1000);

// ========== Kalshi-style Buy/Sell Ticket ==========
let botRunning = false;
let ticketMode = 'buy';
let ticketSide = 'yes';
let ticketSubmitting = false;

function ticketQuantity() {
  return window.KalshiOrderTicket.normalizeQuantity(el('ticket-quantity')?.value);
}

function ownedTicketShares() {
  if (!activeTicketMarket) return 0;
  return (state.openPositions || [])
    .filter(position => position.ticker === activeTicketMarket.ticker && position.side === ticketSide)
    .reduce((total, position) => total + Number(position.filledContracts || position.contracts || 0), 0);
}

function currentTicketQuote() {
  const market = activeTicketMarket || {};
  return window.KalshiOrderTicket.quote({
    mode: ticketMode,
    side: ticketSide,
    quantity: ticketQuantity(),
    yesAsk: market.yesAsk,
    noAsk: market.noAsk,
    yesBid: market.yesBid,
    noBid: market.noBid,
  });
}

function ticketSettlementDate() {
  const closeTime = Number(activeTicketMarket?.closeTime);
  if (!Number.isFinite(closeTime) || closeTime <= 0) return '--';
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(closeTime));
}

function setTicketFeedback(message = '', isError = false) {
  const feedback = el('ticket-feedback');
  if (!feedback) return;
  feedback.textContent = message;
  feedback.classList.toggle('error', isError);
}

function renderOrderTicket() {
  if (!window.KalshiOrderTicket || !el('order-ticket')) return;

  const ticket = el('order-ticket');
  const market = activeTicketMarket || {};
  const quote = currentTicketQuote();
  const quantity = ticketQuantity();
  const owned = ownedTicketShares();
  const available = Number(state.balance?.available || 0);
  const buyMode = ticketMode === 'buy';

  ticket.dataset.mode = ticketMode;
  ticket.dataset.side = ticketSide;

  el('ticket-buy-tab').classList.toggle('active', buyMode);
  el('ticket-buy-tab').setAttribute('aria-selected', String(buyMode));
  el('ticket-sell-tab').classList.toggle('active', !buyMode);
  el('ticket-sell-tab').setAttribute('aria-selected', String(!buyMode));

  el('ticket-up').classList.toggle('active', ticketSide === 'yes');
  el('ticket-up').setAttribute('aria-checked', String(ticketSide === 'yes'));
  el('ticket-down').classList.toggle('active', ticketSide === 'no');
  el('ticket-down').setAttribute('aria-checked', String(ticketSide === 'no'));

  el('ticket-side-prefix').textContent = buyMode ? '' : (ticketSide === 'yes' ? 'Up' : 'Down');
  el('ticket-market-target').textContent = Number.isFinite(Number(market.targetPrice))
    ? window.KalshiHeader.formatPrice(Number(market.targetPrice))
    : '--';
  el('ticket-up-price').textContent = window.KalshiOrderTicket.formatCents(market.yesAsk);
  el('ticket-down-price').textContent = window.KalshiOrderTicket.formatCents(market.noAsk);

  el('ticket-average-price').textContent = window.KalshiOrderTicket.formatCents(quote.price);
  el('ticket-cost').textContent = quote.valid
    ? window.KalshiOrderTicket.formatMoney(quote.total)
    : '--';
  el('ticket-max-payout').textContent = window.KalshiOrderTicket.formatMoney(quote.payout);
  el('ticket-pnl').textContent = quote.valid
    ? window.KalshiOrderTicket.formatSignedMoney(quote.profit)
    : '';
  el('ticket-pnl').classList.toggle('negative', quote.profit < 0);
  el('ticket-settlement-date').textContent = ticketSettlementDate();
  el('ticket-submit-label').textContent = `${buyMode ? 'Buy' : 'Sell'} with 1-Click`;
  renderTicketPrediction();

  const insufficientBalance = buyMode && quote.valid && quote.total > available;
  const insufficientShares = !buyMode && quantity > owned;
  const submit = el('ticket-submit');
  submit.disabled = ticketSubmitting || !quote.valid || insufficientBalance || insufficientShares;
  submit.classList.toggle('pending', ticketSubmitting);

  if (insufficientBalance) {
    setTicketFeedback('Not enough available demo balance.', true);
  } else if (insufficientShares) {
    setTicketFeedback(`Only ${owned} ${ticketSide === 'yes' ? 'Up' : 'Down'} shares available to sell.`, true);
  }
}

el('ticket-buy-tab').addEventListener('click', () => {
  ticketMode = 'buy';
  setTicketFeedback();
  renderOrderTicket();
});

el('ticket-sell-tab').addEventListener('click', () => {
  ticketMode = 'sell';
  setTicketFeedback();
  renderOrderTicket();
});

el('ticket-up').addEventListener('click', () => {
  ticketSide = 'yes';
  setTicketFeedback();
  renderOrderTicket();
});

el('ticket-down').addEventListener('click', () => {
  ticketSide = 'no';
  setTicketFeedback();
  renderOrderTicket();
});

el('ticket-quantity').addEventListener('input', (event) => {
  const normalized = String(event.target.value).replace(/[^\d]/g, '');
  if (event.target.value !== normalized) event.target.value = normalized;
  setTicketFeedback();
  renderOrderTicket();
});

el('ticket-quantity').addEventListener('blur', (event) => {
  event.target.value = String(ticketQuantity());
  renderOrderTicket();
});

el('ticket-submit').addEventListener('click', async () => {
  const quote = currentTicketQuote();
  if (!quote.valid || !activeTicketMarket || ticketSubmitting) return;

  ticketSubmitting = true;
  setTicketFeedback('Submitting demo order…');
  renderOrderTicket();

  try {
    const response = await fetch('/api/orders/1-click', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ticker: activeTicketMarket.ticker,
        action: ticketMode,
        side: ticketSide,
        count: quote.quantity,
      }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Order could not be submitted');

    el('ticket-quantity').value = '0';
    const orderStatus = String(result.order?.status || 'accepted').replace(/_/g, ' ');
    setTicketFeedback(`Demo order ${orderStatus}.`);
  } catch (err) {
    setTicketFeedback(err.message || 'Order could not be submitted.', true);
  } finally {
    ticketSubmitting = false;
    renderOrderTicket();
  }
});

renderOrderTicket();

// ========== Socket.io Handlers ==========
socket.on('connect', () => {
  console.log('Connected to Kalshibot server');
});

socket.on('snapshot', (data) => {
  // Merge P&L history: keep whichever is longer/more complete
  if (state.pnlHistory && state.pnlHistory.length > 0 && data.pnlHistory) {
    if (data.pnlHistory.length >= state.pnlHistory.length) {
      state.pnlHistory = data.pnlHistory;
    }
    // else: keep client's existing pnlHistory (accumulated during session)
  } else {
    state.pnlHistory = data.pnlHistory || [];
  }

  // Always take authoritative data from server
  state.connections = data.connections;
  state.btcPrice = data.btcPrice;
  state.balance = data.balance;
  state.activeMarkets = data.activeMarkets || [];
  state.openPositions = data.openPositions || [];
  state.tradeLog = data.tradeLog || [];
  state.intent = data.intent || {};
  state.stats = data.stats || {};
  state.model = data.model || {};
  state.prediction = data.prediction || {};

  // Reconcile: if server stats show $0 P&L but pnlHistory has data, use pnlHistory's cumulative
  if ((!state.stats.totalPnL || state.stats.totalPnL === 0) && state.pnlHistory.length > 0) {
    const lastEntry = state.pnlHistory[state.pnlHistory.length - 1];
    if (lastEntry && lastEntry.cumulative && lastEntry.cumulative !== 0) {
      state.stats.totalPnL = lastEntry.cumulative;
      // Also reconstruct win/loss counts from pnlHistory if stats are stale
      if (!state.stats.totalTrades || state.stats.totalTrades === 0) {
        let wins = 0, losses = 0;
        for (const entry of state.pnlHistory) {
          if (entry.pnl > 0) wins++;
          else if (entry.pnl < 0) losses++;
        }
        state.stats.totalTrades = state.pnlHistory.length;
        state.stats.wins = wins;
        state.stats.losses = losses;
      }
    }
  }

  // Use persistent startTime from server (original session start)
  startTime = data.startTime || data.stats?.startTime || startTime;
  if (startTime) {
    try { localStorage.setItem('kalshibot_startTime', String(startTime)); } catch(e) {}
  }

  updateConnections(data.connections);
  updateBtcPrice(data.btcPrice);
  updatePnL(state.stats);
  updateBalance(data.balance);
  updateIntent(data.intent);
  updateModel(data.model);
  updatePrediction(state.prediction);
  updatePositions(state.openPositions);
  updateMarkets(state.activeMarkets);
  updateTradeLog(state.tradeLog);
  updateStats(state.stats);
  updateChart(state.pnlHistory);
});

socket.on('price:binance', (data) => {
  state.btcPrice = { ...state.btcPrice, binance: data.mid, binanceBid: data.bid, binanceAsk: data.ask };
  state.connections.binance = true;
  updateBtcPrice(state.btcPrice);
  updateConnections(state.connections);
});

socket.on('price:kalshi-now', (data) => {
  state.btcPrice = { ...state.btcPrice, kalshiNow: data.price, kalshiNowUpdate: data.timestamp };
  updateBtcPrice(state.btcPrice);
});

socket.on('price:redstone', (data) => {
  state.btcPrice = { ...state.btcPrice, redstone: data.price };
  updateBtcPrice(state.btcPrice);
  updateConnections({ ...state.connections, redstone: true });
});

socket.on('balance', (data) => {
  state.balance = data;
  updateBalance(data);
});

socket.on('markets', (data) => {
  state.activeMarkets = data;
  updateMarkets(data);
  // Markets refreshed = Kalshi connection alive
  if (data && data.length > 0) {
    state.connections.kalshi = true;
    updateConnections(state.connections);
  }
});

socket.on('intent', (data) => {
  state.intent = data;
  updateIntent(data);
});

socket.on('model', (data) => {
  state.model = data;
  updateModel(data);
});

socket.on('prediction', (data) => {
  updatePrediction(data);
});

socket.on('trade', (data) => {
  state.tradeLog.unshift(data);
  if (state.tradeLog.length > 50) state.tradeLog.pop();
  updateTradeLog(state.tradeLog);
});

socket.on('position:open', (data) => {
  state.openPositions.push(data);
  updatePositions(state.openPositions);
});

socket.on('position:close', (data) => {
  state.openPositions = state.openPositions.filter(p => p.orderId !== data.orderId);
  updatePositions(state.openPositions);
  state.pnlHistory.push({ timestamp: Date.now(), pnl: data.pnl, cumulative: (state.stats?.totalPnL || 0) });
  updateChart(state.pnlHistory);
});

socket.on('stats', (data) => {
  state.stats = data;
  updatePnL(data);
  updateStats(data);
});

socket.on('connection:kalshi', (connected) => {
  state.connections = { ...state.connections, kalshi: connected };
  updateConnections(state.connections);
});

socket.on('connection:polymarket', (connected) => {
  state.connections = { ...state.connections, polymarket: connected };
  updateConnections(state.connections);
});

socket.on('connection:binance', (connected) => {
  state.connections = { ...state.connections, binance: connected };
  updateConnections(state.connections);
});

socket.on('bot:status', (data) => {
  // Preserve the bot backend lifecycle state even though its control surface
  // is being relocated out of this order ticket.
  botRunning = !!data.running;
});

socket.on('disconnect', () => {
  console.log('Disconnected from server');
  botRunning = false;
  updateConnections({ binance: false, polymarket: false, kalshi: false, redstone: false });
});
