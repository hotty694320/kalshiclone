const axios = require('axios');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const DEBUG_PORT = 9229;
const POLL_MS = 16;
const WATCHDOG_INTERVAL_MS = 1000;
const STALE_READ_MS = 8000;
const RESTART_COOLDOWN_MS = 10000;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function findBrowser() {
  const roots = [
    process.env.LOCALAPPDATA,
    process.env.PROGRAMFILES,
    process.env['PROGRAMFILES(X86)'],
  ].filter(Boolean);
  const candidates = roots.flatMap((root) => [
    path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ]);
  return candidates.find((file) => fs.existsSync(file)) || null;
}

class DemoKalshiNowPrice {
  constructor({
    profilePath,
    onPrice,
    onError,
    onRestart,
    staleReadMs = STALE_READ_MS,
    restartCooldownMs = RESTART_COOLDOWN_MS,
    restartDelayMs = 750,
  } = {}) {
    this.profilePath = profilePath || path.join(__dirname, '..', '.kalshibot-demo-browser');
    this.onPrice = onPrice || (() => {});
    this.onError = onError || (() => {});
    this.onRestart = onRestart || (() => {});
    this.staleReadMs = staleReadMs;
    this.restartCooldownMs = restartCooldownMs;
    this.restartDelayMs = restartDelayMs;
    this.ws = null;
    this.browserProcess = null;
    this.requestId = 0;
    this.pending = new Map();
    this.pollTimer = null;
    this.watchdogTimer = null;
    this.polling = false;
    this.restarting = false;
    this.currentUrl = null;
    this.lastPageUrl = null;
    this.lastPrice = null;
    this.lastStartAt = 0;
    this.lastSuccessfulReadAt = 0;
    this.lastRestartAt = 0;
    this.restartCount = 0;
  }

  async start(url) {
    if (!url || (url === this.currentUrl && this.ws?.readyState === WebSocket.OPEN && this.pollTimer)) return;
    this._setCurrentUrl(url);
    this.lastStartAt = Date.now();
    this._ensureWatchdog();
    try {
      await this._ensureConnected();
      await this._command('Page.navigate', { url });
      if (!this.pollTimer) this.pollTimer = setInterval(() => this._readNowPrice(), POLL_MS);
      await this._readNowPrice();
      console.log('[DemoKalshiNow] Reading the visible Demo Kalshi NOW price every 200ms');
    } catch (err) {
      this.onError(err);
    }
  }

  _setCurrentUrl(url) {
    if (url !== this.currentUrl) {
      this.currentUrl = url;
      // The same BTC value is still a new authoritative observation after a
      // market rollover and must be emitted for the new target.
      this.lastPrice = null;
      this.lastPageUrl = null;
      this.lastSuccessfulReadAt = 0;
    }
  }

  _ensureWatchdog() {
    if (this.watchdogTimer) return;
    this.watchdogTimer = setInterval(() => this._checkHealth(), WATCHDOG_INTERVAL_MS);
    this.watchdogTimer.unref?.();
  }

  _checkHealth(now = Date.now()) {
    if (!this.currentUrl || this.restarting) return false;
    const lastHealthyAt = Math.max(this.lastStartAt, this.lastSuccessfulReadAt);
    if (now - lastHealthyAt <= this.staleReadMs) return false;
    if (now - this.lastRestartAt < this.restartCooldownMs) return false;

    const expectedUrl = this.currentUrl;
    this.forceRestart(expectedUrl, 'stale_or_wrong_demo_page').catch((err) => this.onError(err));
    return true;
  }

  _disconnectTransport() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.polling = false;

    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Demo Kalshi browser restarting'));
    }
    this.pending.clear();

    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        this.ws.close();
      } catch {
        // The browser may already have closed the transport.
      }
    }
    this.ws = null;
  }

  async forceRestart(url = this.currentUrl, reason = 'manual_repair') {
    if (!url || this.restarting) return false;
    this.restarting = true;
    this.lastRestartAt = Date.now();
    this.restartCount += 1;
    this.onRestart({ url, reason, restartCount: this.restartCount });

    try {
      // This debugging browser is launched with Kalshibot's dedicated profile
      // and port. Browser.close repairs both a stuck page and a stuck renderer.
      if (this.ws?.readyState === WebSocket.OPEN) {
        try {
          this.ws.send(JSON.stringify({
            id: ++this.requestId,
            method: 'Browser.close',
            params: {},
          }));
        } catch {
          // Fall through to process termination/reconnection.
        }
      }

      const ownedProcess = this.browserProcess;
      this._disconnectTransport();
      if (ownedProcess && !ownedProcess.killed) {
        try {
          ownedProcess.kill();
        } catch {
          // Browser.close above is the primary shutdown path.
        }
      }
      this.browserProcess = null;
      this.currentUrl = null;
      this.lastPrice = null;
      this.lastPageUrl = null;
      this.lastSuccessfulReadAt = 0;

      await wait(this.restartDelayMs);
      await this.start(url);
      return true;
    } finally {
      this.restarting = false;
    }
  }

  status(now = Date.now()) {
    const staleForMs = this.lastSuccessfulReadAt > 0
      ? Math.max(0, now - this.lastSuccessfulReadAt)
      : null;
    return {
      expectedUrl: this.currentUrl,
      observedUrl: this.lastPageUrl,
      lastPrice: this.lastPrice,
      lastSuccessfulReadAt: this.lastSuccessfulReadAt || null,
      staleForMs,
      healthy: Boolean(
        this.currentUrl
        && this.lastSuccessfulReadAt > 0
        && staleForMs <= this.staleReadMs
        && !this.restarting
      ),
      restarting: this.restarting,
      restartCount: this.restartCount,
    };
  }

  async _ensureConnected() {
    if (this.ws?.readyState === WebSocket.OPEN) return;

    let pages = await this._debugPages();
    if (!pages) {
      const executable = findBrowser();
      if (!executable) throw new Error('Chrome or Microsoft Edge was not found');

      this.browserProcess = spawn(executable, [
        `--remote-debugging-port=${DEBUG_PORT}`,
        `--user-data-dir=${this.profilePath}`,
        '--new-window',
        'about:blank',
      ], { detached: true, stdio: 'ignore' });
      this.browserProcess.unref();

      for (let attempt = 0; attempt < 30 && !pages; attempt += 1) {
        await wait(250);
        pages = await this._debugPages();
      }
    }
    if (!pages) throw new Error('The Demo Kalshi browser did not become ready');

    let page = pages.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
    if (!page) throw new Error('No browser page is available for Demo Kalshi');

    await new Promise((resolve, reject) => {
      this.ws = new WebSocket(page.webSocketDebuggerUrl);
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
      this.ws.on('message', (raw) => this._handleMessage(raw));
      this.ws.on('close', () => { this.ws = null; });
    });
    await this._command('Page.enable');
    await this._command('Runtime.enable');
  }

  async _debugPages() {
    try {
      const response = await axios.get(`http://127.0.0.1:${DEBUG_PORT}/json/list`, { timeout: 500 });
      return response.data;
    } catch {
      return null;
    }
  }

  _handleMessage(raw) {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!message.id) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timeout);
    if (message.error) pending.reject(new Error(message.error.message || 'Browser command failed'));
    else pending.resolve(message.result);
  }

  _command(method, params = {}) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Demo Kalshi browser connection is unavailable'));
    }
    const id = ++this.requestId;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, 3000);
      this.pending.set(id, { resolve, reject, timeout });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async _readNowPrice() {
    if (this.polling || !this.ws) return;
    this.polling = true;
    try {
      // Deliberately read only the exact direct span the user identified in
      // Demo Kalshi's NOW panel. Do not infer a price from nearby labels,
      // other headings, charts, or an alternate market-data source.
      const expression = `(() => {
        const node = document.querySelector(
          'span.inline-flex.items-center > h2.m-0.font-kalshi-condensed.typ-headline-x10.typ-tabular.text-text-x10 > span'
        );
        return {
          href: location.href,
          text: node && node.textContent ? node.textContent.trim() : null,
        };
      })()`;
      const result = await this._command('Runtime.evaluate', {
        expression,
        returnByValue: true,
      });
      const pageValue = result?.result?.value;
      const pageUrl = String(pageValue?.href || '').replace(/\/$/, '').toLowerCase();
      const expectedUrl = String(this.currentUrl || '').replace(/\/$/, '').toLowerCase();
      this.lastPageUrl = pageUrl || null;
      if (!pageUrl || pageUrl !== expectedUrl) return;

      const text = pageValue?.text;
      const price = Number(String(text || '').replace(/[^0-9.]/g, ''));
      if (Number.isFinite(price) && price > 1000) {
        this.lastSuccessfulReadAt = Date.now();
        if (price !== this.lastPrice) {
          this.lastPrice = price;
          this.onPrice(price);
        }
      }
    } catch (err) {
      this.onError(err);
    } finally {
      this.polling = false;
    }
  }

  stop() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.watchdogTimer = null;
    if (this.ws) this.ws.close();
    this.ws = null;
  }
}

module.exports = DemoKalshiNowPrice;
