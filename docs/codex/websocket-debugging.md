# Warbitrer - WebSocket Debugging

## Current feeds

### Kalshi

- Production REST: `https://external-api.kalshi.com/trade-api/v2`
- Production WS: `wss://external-api-ws.kalshi.com/trade-api/ws/v2`
- Production WS fallback: `wss://api.elections.kalshi.com/trade-api/ws/v2`
- Channels: `ticker`, `orderbook_delta`, `trade`
- Handshake: Kalshi API key ID plus RSA-PSS signature over `timestamp + GET + /trade-api/ws/v2`
- REST: market discovery, bootstrap, resync, and fallback

### Polymarket

- Market WS: CLOB market channel
- User WS: authenticated order/fill events
- RTDS WS: Chainlink reference price
- REST/CLOB: market discovery, books, orders, trades, balances, and fallback

## Meaning of feed sources

- `ws`: accepted fresh WS data payload
- `rest-bootstrap`: initial data exists but fresh WS data has not been accepted
- `rest-fallback`: WS is unavailable/stale and recent REST data is being retained
- `unavailable`: no usable data

A `subscribed` acknowledgement alone must not make the aggregate feed fresh.

## Current Kalshi incident

The last VPS discussion reports Kalshi staying on REST bootstrap/fallback, originally with HTTP 429 during broad market discovery. Commit `01b3ae0` introduced targeted discovery and honest source selection, but the reported WS problem persisted.

The exact final VPS diagnostic attachment is not stored in this repository. Do not claim a confirmed auth root cause without the sanitized payload/log.

Implemented locally on 2026-07-14, pending VPS verification:

- `source=ws` now requires a valid orderbook snapshot; ACK/ticker-only sessions remain `rest-bootstrap`.
- Protocol errors, missing snapshots, heartbeat timeouts, and transport failures close the session and reconnect with backoff.
- Initialization failures alternate between the dedicated and shared supported Kalshi WS hosts.
- Lifecycle events are emitted to `journalctl` with sanitized endpoint/ticker/command/close context.
- Orderbook snapshot and delta sequence numbers are read from the outer WS envelope.
- A sequence gap invalidates the book, closes the session, and requires a fresh snapshot.

Remaining concerns:

- The fix has unit/build coverage but has not yet completed a live authenticated VPS WS handshake.
- Multiple asset workers independently bootstrap their own series/market and can still create synchronized REST pressure at rollover.
- A targeted market query that misses falls back to broad pagination.

## Safe diagnosis order

1. Confirm deployed commit and rebuild time for `dist/worker/index.mjs`.
2. Confirm the worker service is the split `warbitrer-asset@<asset>` service.
3. Confirm `KALSHI_ENV` and credential/key readability without printing values.
4. Confirm REST authentication separately from WS behavior.
5. Capture `[kalshi-ws]` open, subscription command IDs, acknowledgements, `orderbook-ready`, error payloads, and close code/reason.
6. Confirm the discovered market ticker belongs to the current slot/environment.
7. Confirm receipt of an actual `ticker`, `orderbook_snapshot`, `orderbook_delta`, or `trade` payload.
8. Confirm source/freshness in `/api/health` and the persisted snapshot.

## Safe presence checks

On the VPS, check only presence and readability:

```bash
sudo -u warbitrer -H bash -lc '
  set -a
  source /etc/warbitrer/warbitrer.env
  echo "KALSHI_ENV=${KALSHI_ENV:-missing}"
  test -n "${KALSHI_API_KEY_ID:-}" && echo "key id set" || echo "key id missing"
  test -r "${KALSHI_PRIVATE_KEY_PATH:-/missing}" && echo "private key readable" || echo "private key unreadable"
'
```

Do not echo key IDs, signatures, private-key contents, or environment files.

## Logs

```bash
sudo journalctl -u warbitrer-asset@xrp -n 250 --no-pager
```

Useful evidence includes:

- endpoint/environment
- open/error/close lifecycle
- close code and reason
- command ID and channel
- subscribed SID
- WS error code/message
- current market ticker and slot key
- message type and outer sequence
- last payload age and REST sync age

Expected successful lifecycle:

```text
open -> subscribe-sent -> subscribed -> orderbook-ready
```

If `orderbook-ready` is absent, the following `session-failed` or `close` entry is the primary diagnosis. Do not infer success from `subscribed` alone.

## Sequence rules

For orderbooks:

1. Accept a snapshot.
2. Store its outer sequence.
3. Require each delta sequence to be the previous sequence plus one.
4. On a gap, mark the book out of sync and stop using deltas.
5. Obtain a fresh snapshot before resuming.

Tests must represent the actual outer envelope shape.

## Rate limiting

Do not solve HTTP 429 by increasing polling frequency. Prefer targeted discovery, per-operation backoff, cache reuse, rollover jitter, and durable WS operation. Trading must remain blocked when freshness cannot be established.
