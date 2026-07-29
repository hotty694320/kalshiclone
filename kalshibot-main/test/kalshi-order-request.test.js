'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const KalshiClient = require('../bot/kalshi');

test('passes immediate-or-cancel and reduce-only through the V2 order adapter', async () => {
  const client = new KalshiClient({ KALSHI_API_BASE: 'https://external-api.demo.kalshi.co' }, {});
  let request;
  client.post = async (path, body) => {
    request = { path, body };
    return { data: { order: { order_id: 'demo-order', status: 'executed' } } };
  };

  const order = await client.placeOrder({
    ticker: 'KXBTC15M-TEST-UP',
    action: 'sell',
    side: 'yes',
    count: 2,
    yes_price: 49,
    client_order_id: 'ticket-test',
    time_in_force: 'immediate_or_cancel',
    reduce_only: true,
  });

  assert.equal(order.order_id, 'demo-order');
  assert.equal(request.path, '/trade-api/v2/portfolio/events/orders');
  assert.equal(request.body.side, 'ask');
  assert.equal(request.body.price, '0.4900');
  assert.equal(request.body.time_in_force, 'immediate_or_cancel');
  assert.equal(request.body.reduce_only, true);
});

test('autonomous bot orders retain good-till-canceled as the default', async () => {
  const client = new KalshiClient({ KALSHI_API_BASE: 'https://external-api.demo.kalshi.co' }, {});
  let requestBody;
  client.post = async (_path, body) => {
    requestBody = body;
    return { data: { order: { order_id: 'bot-order' } } };
  };

  await client.placeOrder({
    ticker: 'KXBTC15M-TEST-UP',
    action: 'buy',
    side: 'no',
    count: 1,
    no_price: 51,
    client_order_id: 'bot-test',
  });

  assert.equal(requestBody.time_in_force, 'good_till_canceled');
  assert.equal(requestBody.reduce_only, undefined);
});
