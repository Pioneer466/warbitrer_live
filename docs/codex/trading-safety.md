# Warbitrer - Trading Safety

## Scope

Warbitrer can submit real orders to Kalshi and Polymarket. Settings, admission, execution, reconciliation, recovery, balances, positions, settlements, accounting, and circuit breakers can all expose or misstate capital.

## Execution authorization

Per-asset strategy settings are versioned in Postgres:

```text
enableTrading=false                         scan only
enableTrading=true + shadowMode=true        synthetic execution
enableTrading=true + shadowMode=false       requests live execution
```

The third state is necessary but not sufficient. New live entry also requires `LIVE_EXECUTION_ALLOWED=true`, `KALSHI_ENV=prod`, a Polygon mainnet `POLYGON_RPC_URL`, an active asset worker, exact fresh venue evidence, compatible configuration revisions, no relevant blocking incidents, and no unresolved live admission or accounting blocker.

The environment gate is fail closed and is rechecked before submission. Keep it false during migration, deployment, uncertain feed state, or reconciliation. Disabling new entry must not disable hedge, unwind, settlement, or recovery work for capital already exposed.

## Operator access

Production application access fails closed unless both `APP_BASIC_AUTH_USER` and `APP_BASIC_AUTH_PASSWORD` are configured. Mutating routes authenticate independently before parsing a request body and reject cross-site browser requests. Caddy Basic Auth and HTTPS remain a separate external defense.

Application HTTP authentication is unrelated to VPS login. Repository code and deployment scripts must not edit `sshd`, change `PasswordAuthentication`, rotate system passwords, or require key-only login. Password-based SSH access must remain available; an SSH key is optional.

## Required live posture

Before any real execution:

- Verify the intended server, branch, commit, builds, and split worker topology.
- Verify `npm run db:status` reports the exact V1-V9 migration history.
- Verify application authentication, Caddy, HTTPS, and localhost-only Next.js binding.
- Verify credentials by presence and readability without printing their values.
- Verify `POLYGON_RPC_URL` resolves Polygon mainnet chain ID 137 and can read transaction receipts.
- Verify Kalshi and Polymarket feeds are fresh, aligned, WebSocket-backed, and on the exact canonical slot.
- Verify venue order books are fresh, exact, within the allowed pair skew, and use authoritative ticks.
- Verify no active global, asset, or slot incident blocks execution.
- Verify no unresolved live intent, order attempt, venue order, fill ambiguity, position, or accounting backlog.
- Verify balances, allowances, notional limits, daily loss cap, slippage, depth, minimum sizes, and fee-inclusive recovery bounds.
- Verify Postgres backup and tested rollback procedures.
- Start with scan-only, then shadow, and only then consider a tightly bounded live canary after explicit operator approval.

Tests, review scores, or a successful build do not authorize deployment or live trading.

## Implemented safeguards

### Configuration and entry

- revision-checked strategy and global-risk configuration
- atomic seven-asset bulk updates and append-only audit events
- serialization between configuration mutations and live admission
- independent environment authorization for new live entries
- exact final market, slot, outcome, token, tick, and feed identity validation
- fresh WebSocket feed and book requirements with bounded pair skew
- entry cutoff and immutable submission budget
- global live reservation and separate shadow reservation
- mode-aware reentry checks using durable admission history
- accounting and breaker gates inside the admission transaction

### Economics and market risk

- maximum pair notional and leg capital share
- venue exposure and balance reservations
- executable multi-level depth and minimum-order checks
- projected net profit, net return, and worst-case profit thresholds
- fee-aware balanced sizing and recovery limits
- adaptive slippage capped by `maxSlippageBps`
- mismatch/dead-zone guards and execution-time rechecks
- fail-closed mismatch enforcement when the model is unavailable or uncalibrated
- daily realized-loss incident

### Submission and venue truth

- stable client order identifiers and canonical request hashes
- durable `planned` attempt committed with live admission
- one-shot `planned -> submitting` claim
- database-clock deadline checks at claim and immediately before the network request
- monotone attempt revisions and parent-stage guards
- `truth_pending` for transport or confirmation ambiguity
- no blind resubmission when a venue may have accepted the order
- bounded confirmation, cancel, rescue, unwind, and reconciliation paths
- fresh orders, fills, trades, and positions required before destructive repair
- Polymarket resolved and Kalshi finalized truth required for settlement

### Recovery

- exact original intent, leg, venue, market, token, and slot proof
- fresh WebSocket market and book evidence for recovery orders
- authoritative tick movement for recovery prices
- explicit fee provenance and fee-inclusive maximum-loss validation
- manual intervention when exposure or submission truth cannot be proved safe

### Circuit breakers

- independent append-only incidents at global, asset, and slot scope
- stable incident identity, owner, revision, impact, and resolution policy
- separate causes coexist instead of overwriting one mutable scope row
- unresolved exposure elevates an incident to blocking impact
- owner-only automatic recovery with durable proof
- exact operator acknowledgement for operator-owned incidents
- cooldowns enforced from database time

### Accounting

- V7 accounting heads for every intent
- immutable leg, fill, settlement, and version evidence
- deterministic fixed-unit calculations and proof hashes
- idempotent mutation request records
- explicit no-exposure closures
- exact zero-exposure parent projection enforced at commit
- quarantine for late or conflicting facts
- mandatory atomic accounting ingestion for every fill inserted after V8, including on legacy parents
- stable fills linked to the current accounting version
- append-only realized-P&L deltas for stable projections
- exact Polymarket V2 `OrderFilled` receipt evidence for order identity, token, side, size, price, and fee
- on-chain-derived Polymarket fill identities that deduplicate repeated CLOB representations of one event

Confirmed CLOB status alone is not final accounting evidence. If the Polygon receipt is unavailable, failed, emitted by an untrusted exchange, or inconsistent with the CLOB trade, the fill is not inserted and an execution incident blocks new entry. Schema presence alone is not operational proof. Before live use, verify that current intents and the current UTC risk day have no `legacy_pending`, `quarantined`, or otherwise unstable accounting state.

## Order truth

An order submission timeout, network error, or ambiguous venue response does not prove zero fill. Preserve:

- the exact canonical request and stable client order ID
- the persisted attempt before dispatch
- the immutable submission deadline
- the point at which network submission began
- bounded immediate confirmation
- later order, trade, fill, and position reconciliation
- `truth_pending` while venue truth is ambiguous
- a blocking incident and manual intervention when exposure cannot be proved safe

Do not mark an intent failed, clear a reservation, or resubmit simply to clean the UI. A terminal state is an assertion about venue truth and capital exposure.

## Accounting truth

Do not treat a mutable intent field or one balance snapshot as a ledger. Stable realized P&L requires immutable final fill evidence, authoritative settlement facts, a versioned proof, and an append-only delta. A late fill or conflicting identity must quarantine the accounting head until deterministic re-accounting or explicit no-exposure evidence resolves it.

Daily loss checks and live admission must consume stable financial truth. Historical migration debt must remain visible and must not contaminate the current UTC risk day.

## Market data safety

- Do not trade from `rest-bootstrap`, `rest-fallback`, or `unavailable` sources.
- Preserve full WebSocket envelopes when sequence numbers or subscription IDs are outside `msg`.
- Require a new order-book snapshot before accepting deltas after a sequence gap.
- A subscription acknowledgement is not quote freshness.
- Close and resubscribe unhealthy sessions with bounded backoff.
- Do not increase REST polling in response to rate limiting.
- Do not carry market or book identity across a slot rollover.

## Secrets

Never log or commit:

- Kalshi private keys or paired API key identifiers
- Polymarket private keys, L2 credentials, or relayer credentials
- database passwords or full connection URLs
- application or Caddy Basic Auth passwords
- complete authorization headers, cookies, backup archives, or database dumps

Operational transcripts must be sanitized before publication. Check that a secret exists without printing it.

## Review requirements

Execution-related changes require deterministic tests for the intended transition, a failure or ambiguity path, replay behavior, and relevant Postgres concurrency or rollback behavior. Run the smallest focused check first, then broaden to:

```bash
npm run audit:prod
npm run lint
npm run typecheck
npm test
npm run test:coverage
npm run build
npm run build:worker
npm run db:status
```

Use fixture venue messages. Do not make live connector calls in automated tests and do not enable live trading as a validation technique.
