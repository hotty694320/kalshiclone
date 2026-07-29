'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const DemoKalshiNowPrice = require('../bot/demo-kalshi-now');

test('market navigation resets price de-duplication for the new contract', () => {
  const reader = new DemoKalshiNowPrice();
  reader.currentUrl = 'https://demo.kalshi.co/old';
  reader.lastPrice = 64_000;

  reader._setCurrentUrl('https://demo.kalshi.co/new');

  assert.equal(reader.currentUrl, 'https://demo.kalshi.co/new');
  assert.equal(reader.lastPrice, null);
});

test('an in-flight read from the expired Demo page cannot update the new market', async () => {
  const prices = [];
  const reader = new DemoKalshiNowPrice({ onPrice: (price) => prices.push(price) });
  reader.currentUrl = 'https://demo.kalshi.co/new';
  reader.ws = {};
  reader._command = async () => ({
    result: {
      value: {
        href: 'https://demo.kalshi.co/old',
        text: '$64,000.00',
      },
    },
  });

  await reader._readNowPrice();

  assert.deepEqual(prices, []);
  assert.equal(reader.lastPrice, null);
});

test('a valid unchanged price keeps the Demo reader healthy without duplicate price events', async () => {
  const prices = [];
  const url = 'https://demo.kalshi.co/current';
  const reader = new DemoKalshiNowPrice({ onPrice: (price) => prices.push(price) });
  reader.currentUrl = url;
  reader.lastPrice = 64_000;
  reader.ws = {};
  reader._command = async () => ({
    result: {
      value: {
        href: url,
        text: '$64,000.00',
      },
    },
  });

  await reader._readNowPrice();

  assert.deepEqual(prices, []);
  assert.ok(reader.lastSuccessfulReadAt > 0);
  assert.equal(reader.status(reader.lastSuccessfulReadAt).healthy, true);
});

test('the watchdog force-restarts a stale Demo browser on the expected market URL', () => {
  const restarts = [];
  const reader = new DemoKalshiNowPrice({
    staleReadMs: 8000,
    restartCooldownMs: 10000,
  });
  reader.currentUrl = 'https://demo.kalshi.co/current';
  reader.lastStartAt = 1000;
  reader.lastSuccessfulReadAt = 1000;
  reader.lastRestartAt = 0;
  reader.forceRestart = async (url, reason) => {
    restarts.push({ url, reason });
    return true;
  };

  assert.equal(reader._checkHealth(11_001), true);
  assert.deepEqual(restarts, [{
    url: 'https://demo.kalshi.co/current',
    reason: 'stale_or_wrong_demo_page',
  }]);
});

test('the watchdog leaves a fresh Demo reader alone', () => {
  let restarted = false;
  const reader = new DemoKalshiNowPrice();
  reader.currentUrl = 'https://demo.kalshi.co/current';
  reader.lastStartAt = 10_000;
  reader.lastSuccessfulReadAt = 15_000;
  reader.forceRestart = async () => {
    restarted = true;
    return true;
  };

  assert.equal(reader._checkHealth(20_000), false);
  assert.equal(restarted, false);
});

test('forceRestart closes the owned browser and relaunches the expected market', async () => {
  const restartEvents = [];
  let killed = false;
  let startedUrl = null;
  const reader = new DemoKalshiNowPrice({
    restartDelayMs: 0,
    onRestart: (event) => restartEvents.push(event),
  });
  reader.currentUrl = 'https://demo.kalshi.co/current';
  reader.lastPrice = 64_000;
  reader.browserProcess = {
    killed: false,
    kill: () => { killed = true; },
  };
  reader.start = async (url) => {
    startedUrl = url;
    reader._setCurrentUrl(url);
  };

  const restarted = await reader.forceRestart(reader.currentUrl, 'test_stale_page');

  assert.equal(restarted, true);
  assert.equal(killed, true);
  assert.equal(startedUrl, 'https://demo.kalshi.co/current');
  assert.equal(reader.restartCount, 1);
  assert.equal(reader.restarting, false);
  assert.deepEqual(restartEvents, [{
    url: 'https://demo.kalshi.co/current',
    reason: 'test_stale_page',
    restartCount: 1,
  }]);
});
