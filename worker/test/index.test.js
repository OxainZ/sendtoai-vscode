import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import worker, { verifySignature, disableKeysForOrder, isFullRefund } from '../src/index.js';

const SECRET = 'test-signing-secret';
const sign = (body) => createHmac('sha256', SECRET).update(body).digest('hex');

test('verifySignature accepts the HMAC-SHA256 hex of the raw body', async () => {
  const body = '{"meta":{"event_name":"order_refunded"}}';
  assert.equal(await verifySignature(SECRET, body, sign(body)), true);
  assert.equal(await verifySignature(SECRET, body, sign(body).toUpperCase()), true);
});

test('verifySignature rejects a tampered body, wrong secret, or missing header', async () => {
  const body = '{"a":1}';
  assert.equal(await verifySignature(SECRET, body + ' ', sign(body)), false);
  assert.equal(await verifySignature('other', body, sign(body)), false);
  assert.equal(await verifySignature(SECRET, body, ''), false);
  assert.equal(await verifySignature('', body, sign(body)), false);
});

test('isFullRefund distinguishes full from partial refunds', () => {
  assert.equal(isFullRefund({ data: { attributes: { status: 'refunded' } } }), true);
  assert.equal(isFullRefund({ data: { attributes: { status: 'partial_refund', refunded: false } } }), false);
  assert.equal(isFullRefund({}), false);
});

test('disableKeysForOrder lists keys by order and PATCHes each enabled one', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? 'GET', body: init.body, auth: init.headers?.Authorization });
    if (url.includes('/license-keys?')) {
      return { ok: true, status: 200, json: async () => ({ data: [
        { id: '11', attributes: { disabled: false } },
        { id: '12', attributes: { disabled: true } },
      ] }) };
    }
    return { ok: true, status: 200 };
  };
  const results = await disableKeysForOrder(3238752, 'api-key', fetchImpl);
  assert.deepEqual(results, [{ id: '11', status: 'disabled' }, { id: '12', status: 'already-disabled' }]);
  assert.equal(calls[0].url, 'https://api.lemonsqueezy.com/v1/license-keys?filter[order_id]=3238752');
  assert.equal(calls[0].auth, 'Bearer api-key');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].method, 'PATCH');
  assert.deepEqual(JSON.parse(calls[1].body), { data: { type: 'license-keys', id: '11', attributes: { disabled: true } } });
});

test('disableKeysForOrder surfaces an API failure so the webhook returns 500 and is retried', async () => {
  const fetchImpl = async () => ({ ok: false, status: 503 });
  await assert.rejects(() => disableKeysForOrder(1, 'k', fetchImpl), /HTTP 503/);
});

test('fetch handler: dispute_created revokes the keys of the disputed order', async () => {
  const env = { LS_WEBHOOK_SECRET: SECRET, LS_API_KEY: 'k' };
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? 'GET' });
    if (url.includes('/license-keys?')) { return { ok: true, status: 200, json: async () => ({ data: [{ id: '7', attributes: { disabled: false } }] }) }; }
    return { ok: true, status: 200 };
  };
  try {
    const body = JSON.stringify({ meta: { event_name: 'dispute_created' }, data: { id: 555, attributes: { order_id: 3238752 } } });
    const res = await worker.fetch(new Request('https://x/webhook', { method: 'POST', body, headers: { 'X-Signature': sign(body) } }), env);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, event: 'dispute_created', orderId: 3238752, results: [{ id: '7', status: 'disabled' }] });
    assert.ok(calls[0].url.endsWith('filter[order_id]=3238752'));
  } finally { globalThis.fetch = realFetch; }
});

test('fetch handler: bad signature is 401, other events are acknowledged and ignored', async () => {
  const env = { LS_WEBHOOK_SECRET: SECRET, LS_API_KEY: 'k' };
  const body = JSON.stringify({ meta: { event_name: 'order_created' }, data: { id: 1, attributes: {} } });

  const bad = await worker.fetch(new Request('https://x/webhook', { method: 'POST', body, headers: { 'X-Signature': 'deadbeef' } }), env);
  assert.equal(bad.status, 401);

  const ok = await worker.fetch(new Request('https://x/webhook', { method: 'POST', body, headers: { 'X-Signature': sign(body) } }), env);
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true, ignored: 'order_created' });

  const health = await worker.fetch(new Request('https://x/', { method: 'GET' }), env);
  assert.equal(health.status, 200);
});
