// sendtoai refund hook — Cloudflare Worker
//
// Lemon Squeezy does NOT disable a license key when its order is refunded or
// charged back (chargebacks are processed as refunds on the seller's behalf).
// This Worker receives the `order_refunded` webhook, looks up the license keys
// that belong to that order, and disables them through the main API.
//
// Required secrets (set with `npx wrangler secret put <NAME>`):
//   LS_WEBHOOK_SECRET  the "Signing secret" you typed when creating the webhook
//   LS_API_KEY         a Lemon Squeezy API key (Settings » API) — live mode
//
// Endpoints:
//   GET  /         health check
//   POST /webhook  Lemon Squeezy webhook receiver

const LS_API = 'https://api.lemonsqueezy.com/v1';

const encoder = new TextEncoder();

function toHex(buf) {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqualHex(a, b) {
  if (a.length !== b.length) { return false; }
  let diff = 0;
  for (let i = 0; i < a.length; i++) { diff |= a.charCodeAt(i) ^ b.charCodeAt(i); }
  return diff === 0;
}

/** HMAC-SHA256 hex over the RAW request body, compared in constant time. */
export async function verifySignature(secret, rawBody, signatureHex) {
  if (!secret || !signatureHex) { return false; }
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(rawBody));
  return timingSafeEqualHex(toHex(mac), signatureHex.trim().toLowerCase());
}

/** Disable every license key attached to an order. Returns one result per key. */
export async function disableKeysForOrder(orderId, apiKey, fetchImpl = fetch) {
  if (!orderId) { throw new Error('missing order id'); }
  if (!apiKey) { throw new Error('LS_API_KEY secret is not set'); }
  const headers = {
    'Authorization': `Bearer ${apiKey}`,
    'Accept': 'application/vnd.api+json',
    'Content-Type': 'application/vnd.api+json',
  };

  const list = await fetchImpl(`${LS_API}/license-keys?filter[order_id]=${encodeURIComponent(orderId)}`, { headers });
  if (!list.ok) { throw new Error(`list license keys: HTTP ${list.status}`); }
  const { data = [] } = await list.json();

  const results = [];
  for (const key of data) {
    if (key.attributes?.disabled) { results.push({ id: key.id, status: 'already-disabled' }); continue; }
    const res = await fetchImpl(`${LS_API}/license-keys/${key.id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ data: { type: 'license-keys', id: String(key.id), attributes: { disabled: true } } }),
    });
    // A key that is still enabled is a failure of the whole webhook, so the
    // caller returns 500 and Lemon Squeezy retries instead of moving on.
    if (!res.ok) { throw new Error(`disable license key ${key.id}: HTTP ${res.status}`); }
    results.push({ id: key.id, status: 'disabled' });
  }
  return results;
}

/** Only a FULL refund revokes the key; a partial refund is a goodwill gesture. */
export function isFullRefund(payload) {
  return payload?.data?.attributes?.status === 'refunded';
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/') {
      return new Response('sendtoai refund hook is up. POST Lemon Squeezy webhooks to /webhook.', { status: 200 });
    }
    if (request.method !== 'POST' || url.pathname !== '/webhook') {
      return new Response('Not found', { status: 404 });
    }

    const raw = await request.text();
    const ok = await verifySignature(env.LS_WEBHOOK_SECRET, raw, request.headers.get('X-Signature'));
    if (!ok) { return new Response('Invalid signature', { status: 401 }); }

    let payload;
    try { payload = JSON.parse(raw); } catch { return json({ ok: false, error: 'bad json' }, 400); }

    const event = payload?.meta?.event_name ?? request.headers.get('X-Event-Name') ?? '';
    const orderId = payload?.data?.id;
    const testMode = payload?.meta?.test_mode ?? payload?.data?.attributes?.test_mode ?? null;

    // dispute_created: a chargeback was opened. Lemon Squeezy will refund on
    // your behalf and charge the $15 fee either way, so revoke immediately.
    if (event === 'dispute_created') {
      const disputedOrder = payload?.data?.attributes?.order_id;
      if (!disputedOrder) {
        // Never fall back to the dispute's own id: that is not an order id.
        console.error(JSON.stringify({ event, testMode, error: 'dispute payload has no order_id' }));
        return json({ ok: false, error: 'dispute payload has no order_id' }, 400);
      }
      try {
        const results = await disableKeysForOrder(disputedOrder, env.LS_API_KEY);
        console.log(JSON.stringify({ event, orderId: disputedOrder, testMode, results }));
        return json({ ok: true, event, orderId: disputedOrder, results });
      } catch (e) {
        console.error(JSON.stringify({ event, orderId: disputedOrder, testMode, error: String(e) }));
        return json({ ok: false, error: String(e) }, 500);
      }
    }

    if (event !== 'order_refunded') {
      return json({ ok: true, ignored: event });
    }
    if (!isFullRefund(payload)) {
      console.log(JSON.stringify({ event, orderId, testMode, action: 'partial-refund-ignored' }));
      return json({ ok: true, ignored: 'partial refund' });
    }

    try {
      const results = await disableKeysForOrder(orderId, env.LS_API_KEY);
      console.log(JSON.stringify({ event, orderId, testMode, results }));
      return json({ ok: true, event, orderId, results });
    } catch (e) {
      // Non-200 makes Lemon Squeezy retry (3 times, exponential backoff).
      console.error(JSON.stringify({ event, orderId, testMode, error: String(e) }));
      return json({ ok: false, error: String(e) }, 500);
    }
  },
};
