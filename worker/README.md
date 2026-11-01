# sendtoai refund hook

A 100-line Cloudflare Worker that closes the one gap in Lemon Squeezy's
licensing: **a refunded or charged-back order keeps a working license key**
until someone disables it by hand. This Worker does it automatically.

```
Lemon Squeezy ──order_refunded webhook──▶ Worker ──PATCH disabled:true──▶ Lemon Squeezy
```

The extension needs no change and holds no API key. Only the Worker talks to
the authenticated API.

## One-time setup

1. **Deploy** (from this folder):

   ```
   npm test
   npx wrangler@4 deploy
   ```

   Note the URL it prints, e.g. `https://sendtoai-refund-hook.<you>.workers.dev`.

2. **API key**: Lemon Squeezy → Settings → API → *Create API key* (live mode,
   Test mode toggle OFF). Copy it once, then:

   ```
   npx wrangler@4 secret put LS_API_KEY
   ```

3. **Webhook**: Lemon Squeezy → Settings → Webhooks → *Add endpoint*:
   - Callback URL: `https://sendtoai-refund-hook.<you>.workers.dev/webhook`
   - Signing secret: generate a long random string (6–40 chars) and keep it
   - Events: tick **order_refunded** and **dispute_created**
   
   Then store the same string:

   ```
   npx wrangler@4 secret put LS_WEBHOOK_SECRET
   ```

4. **Test it** with the Test mode toggle ON: create a test webhook with the same
   URL and secret, buy with the test card `4242 4242 4242 4242`, refund the
   order, then check the key shows *Disabled* and `npx wrangler@4 tail` shows
   `"status":"disabled"`.

## Behaviour

- Verifies `X-Signature` (HMAC-SHA256 hex of the raw body) in constant time;
  anything else gets `401` and is never processed.
- Only a **full** refund (`status: refunded`) disables keys. Partial refunds are
  acknowledged and ignored.
- Any API failure returns `500` so Lemon Squeezy retries (3 attempts).
- Logs one JSON line per event (visible in `wrangler tail` and the dashboard).

Chargebacks arrive the same way: Lemon Squeezy refunds the order on your
behalf, which fires `order_refunded`.
