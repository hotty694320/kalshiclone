'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

test('dashboard exposes locked prediction surfaces without replacing tradable prices', () => {
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
  assert.match(html, /id="prediction-independent"/);
  assert.match(html, /id="prediction-assisted"/);
  assert.match(html, /id="ticket-forecast-primary"/);
  assert.match(html, /id="ticket-up-price"/);
  assert.match(html, /id="ticket-down-price"/);
  assert.match(app, /socket\.on\('prediction'/);
  assert.match(app, /prediction\.status === 'analyzing'/);
  assert.match(app, /prediction\.status === 'finalized'/);
  assert.match(app, /market\.yesAsk/);
  assert.match(app, /market\.noAsk/);
});

test('server exposes prediction read-only and never wires it into order submission', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const orderRoute = server.slice(
    server.indexOf("app.post('/api/orders/1-click'"),
    server.indexOf("app.post('/api/bot/start'"),
  );
  assert.match(server, /app\.get\('\/api\/prediction\/current'/);
  assert.match(server, /'prediction'/);
  assert.doesNotMatch(orderRoute, /predictionEngine|state\.prediction/);
});
