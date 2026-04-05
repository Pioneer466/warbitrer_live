# Live Risk Review

Date: 2026-04-05

This document captures the current live-risk review of the repository and is intended to remain the reference point during remediation work.

## Scope

- Live market data: Kalshi + Polymarket
- Execution and hedge flow
- Settlement, balances, and treasury behavior
- Postgres persistence and API/UI contracts
- Recovery / redeem flow
- VPS exposure and operational safety

## Validation Snapshot

- `npm run typecheck`: pass
- `npm test`: pass
- `npm run build`: pass

These checks only prove compile/build/test coherence. They do not prove correctness of live venue integration.

## Findings

### 1. High: execution can continue on non-authoritative fills

Severity rationale:
- This can cause wrong hedge decisions, wrong unwind behavior, and wrong settlement/P&L.

Evidence:
- `src/lib/polymarket.ts:303-315`
- `src/lib/engine.ts:385-426`
- `src/lib/engine.ts:486-499`
- `src/lib/engine.ts:831-852`
- `src/lib/settlement.ts:129-139`

Details:
- `placeOrder()` on Polymarket returns `filledSize: 0` and `averageFillPrice: null` even when the venue response is marked `filled`.
- The engine still treats `status === "filled"` as sufficient to proceed to hedge.
- The code attempts to patch real fill data later via recent trades.
- Fill aggregation overwrites the fill price with the last seen price instead of maintaining a weighted average.
- Settlement pays out based on persisted `filledSize`, so any drift in reconciliation directly corrupts final accounting.

Why this is dangerous:
- Primary leg may be treated as executed when persisted fill data is incomplete.
- Hedge or unwind can run on wrong size assumptions.
- Final P&L depends on reconciliation timing rather than venue-authoritative fills.

### 2. High: Kalshi fill accounting is incorrect for NO-side fills and ignores fees

Severity rationale:
- This directly corrupts fill records, P&L, and settlement on Kalshi legs.

Evidence:
- `src/lib/kalshi.ts:478-493`
- `src/lib/engine.ts:588-625`
- `src/lib/engine.ts:549-560`

Details:
- Kalshi fill mapping models `yes_price_dollars` only.
- Reconciliation persists `Number(fill.yes_price_dollars)` for all Kalshi fills.
- `feeUsd` is forced to `0` in fill persistence.
- Order reconciliation uses fee fields when reconciling orders, but fill persistence does not.

Why this is dangerous:
- A `NO` fill can be recorded with the wrong price basis.
- Fees are understated.
- Final intent accounting can diverge from venue reality.

### 3. High: `maxVenueExposureUsd` is declared but not enforced

Severity rationale:
- A risk limit that exists only in config/UI but not in execution is a false safeguard.

Evidence:
- `src/lib/types.ts:178`
- `src/lib/settings-schema.ts:18`
- `src/lib/constants.ts:39`
- `src/lib/engine.ts:180-227`

Details:
- The configuration includes `maxVenueExposureUsd`.
- It is validated and has a default value.
- The execution path never checks it before opening new intents.

Why this is dangerous:
- Operators may believe venue exposure is capped when it is not.
- This is especially problematic once multiple slots or recovery scenarios overlap.

### 4. High: Kalshi live path still depends heavily on REST fallback and does not guarantee true realtime execution data

Severity rationale:
- This affects the core trade/no-trade decision.

Evidence:
- `src/lib/env.ts:31-33`
- `src/lib/market-data.ts:658-673`
- `src/lib/market-data.ts:778-798`
- `src/lib/market-data.ts:1015-1038`

Details:
- The Kalshi websocket is not opened without Kalshi credentials.
- In that state, all channels fall back to REST.
- REST-refreshed orderbook data is treated as "fresh" for execution purposes for up to the blocked threshold window.
- This blurs the difference between real streaming microstructure and periodic snapshots.

Why this is dangerous:
- The UI can look healthy enough while execution still relies on stale or sparse REST refreshes.
- This is consistent with the operational complaints seen around Kalshi refresh lag.

### 5. Medium-high: security model depends entirely on reverse proxy discipline

Severity rationale:
- This is an ops risk that becomes severe if the service is started or exposed incorrectly.

Evidence:
- `src/app/api/settings/route.ts:22-39`
- `src/app/api/circuit-breakers/route.ts:22-53`
- `src/app/api/recovery/route.ts:21-35`
- `package.json:12-15`
- `deploy/vps/Caddyfile:1-22`
- `deploy/vps/warbitrer-web.service:14`

Details:
- Mutating API routes have no app-layer auth.
- The intended protection is Caddy `basicauth`.
- `start:web` binds to `127.0.0.1`, which is good for VPS.
- But `start` binds to `0.0.0.0`, and `start:all` uses `start`.

Why this is dangerous:
- If port 3000 is exposed or the wrong script is used, the app becomes directly reachable.
- Settings changes, kill-switch toggles, and redeem actions would then be unprotected.

### 6. Medium: dashboard/history is snapshot-driven, not feed-driven

Severity rationale:
- This creates divergence between what the engine knows in memory and what the operator sees.

Evidence:
- `src/lib/engine.ts:145-153`
- `src/lib/postgres-db.ts:982-999`
- `src/app/api/history/current-slot/route.ts:13-41`
- `src/components/dashboard-client.tsx:23-49`

Details:
- The worker stores snapshots during scan.
- The history API reads persisted snapshots from Postgres.
- The dashboard charts are rendered from those history points, not directly from the supervisor state.

Why this matters:
- If scan or DB writes lag, graphs freeze even if in-memory market state is fresher.
- This can mislead the operator while the worker continues to reason on a different state.

### 7. Medium: normal runtime does not strongly validate Polymarket signer/funder consistency

Severity rationale:
- This can produce coherent but wrong balances and positions.

Evidence:
- `src/lib/polymarket.ts:228-239`
- `src/lib/polymarket.ts:267-287`
- `src/lib/recovery.ts:159-220`

Details:
- Balance and positions are fetched for `POLY_FUNDER_ADDRESS`.
- Signer/funder consistency checks are implemented in the recovery/EOA validation path, not in the normal live path.

Why this matters:
- In `POLY_PROXY`, a misconfigured env can display and trade against the wrong account context.

### 8. Medium: readiness mixes trading safety with treasury-policy warnings

Severity rationale:
- It reduces operator clarity and can over-block or misclassify issues.

Evidence:
- `src/lib/engine.ts:259-290`
- `src/lib/engine.ts:293-341`

Details:
- Low Polymarket bridge balance degrades venue balance status.
- Global readiness aggregates venue balance statuses and feed statuses into one state.

Why this matters:
- "Feed stale", "credentials missing", and "bridge low-water warning" are not equivalent problems.
- The current UI/readiness model treats them as part of the same primary control surface.

### 9. Medium-low: reconcile has side effects that do not belong to order/state convergence

Severity rationale:
- This is a maintainability and predictability problem.

Evidence:
- `src/lib/engine.ts:243-253`

Details:
- Reconcile runs auto-redeem.
- Reconcile also opportunistically fetches bridge deposit addresses and writes a bridge transfer if none exists.

Why this matters:
- Trading convergence and ops discovery are mixed together.
- This makes the runtime harder to reason about and test.

### 10. Medium-low: worker timestamps can report success where a stage actually failed

Severity rationale:
- This weakens observability and incident diagnosis.

Evidence:
- `src/lib/engine.ts:100-121`

Details:
- `lastScanAt`, `lastExecuteAt`, and `lastReconcileAt` are all written at tick end, even if one stage threw.

Why this matters:
- Operators cannot reliably tell which phase last completed successfully.

### 11. Low: dead or redundant code remains from older quote-fetch architecture

Severity rationale:
- Not directly dangerous, but it increases cognitive load and slows safe iteration.

Evidence:
- `src/lib/kalshi.ts:141-197`
- `src/lib/polymarket.ts:70-127`
- `src/lib/polymarket.ts:347-374`
- `src/lib/kalshi.ts:746`
- `src/lib/polymarket.ts:517`
- `src/lib/engine.ts:64`
- `package.json:14-20`

Details:
- Old quote bootstrap functions still exist beside the realtime supervisor path.
- There are no-op helper wrappers and an unused settlement lookback constant.
- `worker` and `start:worker` duplicate the same command.

Why this matters:
- Debugging is harder because the real production path is obscured by stale code.

### 12. Low: test coverage is good for helpers, weak for the highest-risk live flows

Severity rationale:
- The repo is easier to break in exactly the areas that matter most in live trading.

Evidence:
- Existing tests are helper-heavy:
  - `tests/fees.test.ts`
  - `tests/settlement.test.ts`
  - `tests/signals.test.ts`
  - `tests/env.test.ts`
  - `tests/kalshi.test.ts`
  - `tests/market-data.test.ts`
  - `tests/polymarket.test.ts`
- No meaningful integration-style coverage was found for:
  - primary fill then hedge
  - delayed Polymarket trade reconciliation
  - Kalshi NO-side fill accounting
  - restart + reconcile + settlement consistency

Why this matters:
- The most dangerous regressions are lightly covered.

## Open Questions

1. Does the Polymarket client response for `createAndPostMarketOrder()` contain enough fill information to make the current post-trade patching unnecessary, and the code simply is not using it?
2. Does the Kalshi fills API return a dedicated NO-side price field in practice, or is the venue returning a YES-normalized price that must be explicitly converted?
3. Is `polyBridgeLowWaterUsdc` intended to be a hard trading gate or only an operational warning?
4. Is the target design for the UI to reflect persisted snapshots, or should the dashboard eventually consume a more direct live feed/state channel?

## Code Likely Safe to Simplify or Remove

- Old REST quote bootstrap functions that are no longer on the critical live path:
  - `src/lib/kalshi.ts:141-197`
  - `src/lib/polymarket.ts:70-127`
  - `src/lib/polymarket.ts:347-374`
- No-op feed health wrappers:
  - `src/lib/kalshi.ts:746`
  - `src/lib/polymarket.ts:517`
- Unused constant:
  - `src/lib/engine.ts:64`
- Redundant worker scripts:
  - `package.json:14`
  - `package.json:20`

These should only be removed after the authoritative live path is stabilized.

## Remediation Priorities

### Priority 1: make fills authoritative

- Do not hedge from a venue result that lacks authoritative fill size/price.
- Rework Polymarket order flow so the primary leg is only considered filled after authoritative reconciliation.
- Track weighted average fill price instead of overwriting with the last fill.

### Priority 2: fix Kalshi accounting

- Persist correct NO-side fill price semantics.
- Persist Kalshi fees on fills, not only on orders.
- Re-validate settlement and P&L after that correction.

### Priority 3: enforce real risk limits

- Enforce `maxVenueExposureUsd` in execution.
- Re-check exposure before each new intent.

### Priority 4: separate control planes

- Distinguish feed health, venue readiness, treasury warnings, and manual ops concerns.
- Remove bridge side effects from reconcile.
- Make worker timestamps reflect phase success truthfully.

### Priority 5: simplify the runtime

- Delete dead quote-fetch code once the realtime path is validated.
- Reduce duplicate script surfaces.
- Keep one obvious production path.

### Priority 6: improve tests where failures would be expensive

- Add integration-style tests for:
  - primary fill -> hedge -> settle
  - delayed or partial Polymarket reconciliation
  - Kalshi NO-side fill mapping
  - restart/reconcile consistency
  - readiness/feed/breaker interactions

## Practical Reading of Current State

The repo architecture is not fundamentally broken. The main pieces are in the right places:
- a worker loop
- a market data supervisor
- venue adapters
- centralized Postgres persistence
- an operator cockpit

The problem is the boundary between:
- displayed state
- executable state
- settled/accounted state

That boundary is still too weak for strong live confidence. The main remediation work should focus there, not on superficial refactors.
