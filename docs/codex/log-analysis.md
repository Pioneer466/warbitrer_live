# Warbitrer - Log Analysis

## Service map

Analyze the service that owns the behavior:

- `warbitrer-web`: Next.js/API/auth/database read errors
- `warbitrer-asset@<asset>`: slot discovery, market data, signals, candidate execution
- `warbitrer-reconciler`: venue orders/fills/positions, settlements, P&L, recovery, maintenance
- `warbitrer-notifier`: Telegram delivery queue
- `warbitrer-postgres-backup.service`: database backup
- `caddy`: public routing, TLS, and proxy authentication

## First questions

1. Which server, service, asset, commit, and worker bundle produced the log?
2. Was the process restarted or redeployed immediately before the failure?
3. Is trading off, shadow, or live for that asset?
4. Is a circuit breaker active?
5. Is the error transport, authentication, market discovery, market data, strategy, execution, or reconciliation?
6. Are timestamps and slot keys aligned?

## Safe collection

```bash
sudo systemctl status warbitrer-asset@xrp --no-pager --full
sudo journalctl -u warbitrer-asset@xrp -n 250 --no-pager
sudo journalctl -u warbitrer-reconciler -n 250 --no-pager
sudo journalctl -u warbitrer-web -n 150 --no-pager
```

Before sharing output, remove credentials, authorization headers, database URLs, wallet/private-key values, passwords, signatures, and unrelated personal data.

## Market-data evidence

Look for:

- asset and slot key
- discovered market ticker/condition/token IDs
- REST endpoint/status and retry delay
- WS endpoint/environment
- connection open/error/close
- subscription command ID, channel, acknowledgement SID
- server error code/message
- message type and outer sequence
- snapshot/delta ordering
- feed source, last payload age, and REST sync age
- feed breaker activation/clear

`rest-bootstrap` means no accepted fresh WS data payload has established the normal realtime source for the slot. It is not merely a label saying REST ran once.

## Execution evidence

Group events by `intentId`, then reconstruct:

1. candidate and snapshot timestamp
2. readiness and breaker state
3. requested primary leg
4. persisted order attempt/client ID
5. venue response and immediate confirmation
6. fills and filled size
7. hedge request/result
8. rescue or unwind decisions
9. reconciliation truth
10. final intent state and P&L

Never infer zero fill from a timeout alone.

## Database evidence

Prefer the existing audit commands before ad hoc SQL:

```bash
npm run logs:events
npm run incident:report
npm run intent:audit -- --intent <intent-id>
npm run breaker:audit
npm run slot:audit -- --asset xrp
```

Run these as the `warbitrer` user with the production environment loaded. Review script behavior before use.

## Red flags

- live mode unexpectedly active
- missing or stale feed accepted as ready
- subscription acknowledgement treated as data freshness
- sequence gap without snapshot resync
- repeated primary submission with different client IDs
- timeout followed by a second order before venue truth
- hedge failure without breaker/manual state
- unresolved exposure while new intents continue
- root-owned files in the application directory
- `npm ci` killed but build/restart continued
- secrets in logs

## Reporting format

Produce:

1. Observed facts with timestamps/service names.
2. Most likely root cause and confidence.
3. Alternative hypotheses.
4. Immediate safety action.
5. Smallest diagnostic or code change.
6. Verification and rollback steps.

Clearly separate evidence from inference.
