# Live Risk Review

Date: 2026-04-23

This document reflects the current live-risk review of the repository after the latest guardrail and execution hardening work.

## Scope

- Live market data: Kalshi + Polymarket
- Entry / hedge / unwind execution
- Settlement and post-slot handling
- Venue balances, exposure controls, and recovery
- Worker/runtime operational safety

## Validation Snapshot

- `npm run typecheck`: pass
- `npm test`: pass
- `npm run build`: pass

These checks prove compile/build/test coherence only. They do not prove live venue correctness under latency, outages, or abnormal market microstructure.

## Current Strengths

- Kalshi remains the deterministic primary venue and Polymarket remains the hedge path.
- Entry execution is taker-only and immediate (`FOK` / `FAK` / `IOC`) with confirmation polling and reduce-only unwinds.
- Polymarket fill aggregation relies on confirmed trades rather than trusting optimistic order responses.
- Venue exposure is enforced before entry.
- Mismatch guard is slot-level, fail-closed, and now time-bucketed.
- Soft primary Kalshi no-fills now lock the slot and do not get overwritten by feed-health breaker sync.

## Remediated Since The Prior Review

### 1. Primary Kalshi no-fill retry and slot lock are now materially better

State:
- `softNoFill` on Kalshi primary now gets a dedicated retry plan via `primaryRetryAttempts` and `primaryRetryDelayMs`.
- Each retry re-fetches and re-validates the full live pair before re-submission.
- If the primary still does not fill, the slot is locked so the engine does not spam the same slot repeatedly.

Code:
- `src/lib/engine.ts`
- `src/lib/constants.ts`
- `src/lib/settings-schema.ts`

### 2. Feed-health breaker sync no longer clears execution slot locks

State:
- Slot breakers created for execution protection are no longer accidentally cleared by the feed-health breaker sync path.

Code:
- `src/lib/engine.ts`

### 3. Polymarket confirmation is safer on terminal-order / lagged-trade edges

State:
- When Polymarket returns a terminal order state but only pending trades are visible, confirmation now stays `pending` rather than collapsing immediately to terminal failure.
- Immediate `FOK` confirmation that remains `live` after timeout now triggers a best-effort cancel and one final confirmation pass.

Code:
- `src/lib/polymarket.ts`
- `src/lib/engine.ts`

### 4. Kalshi seq gaps now fail closed during resync

State:
- A Kalshi orderbook sequence gap now marks the orderbook as out-of-sync until resync completes.
- During that window, feed readiness blocks trading rather than letting the engine act on a torn book.

Code:
- `src/lib/market-data.ts`

### 5. Winning Polymarket legs are no longer force-sold post-slot

State:
- When settlement already knows the Polymarket winning outcome, the engine now keeps the winning leg for resolution instead of trying to exit it on-market.
- This removes the worst case where a winning claim could be sold below redemption value just because the slot ended.

Code:
- `src/lib/engine.ts`

### 6. Worker fatal restart loop has minimal backoff

State:
- Fatal worker exits now wait briefly before terminating, which reduces restart thrash under persistent upstream failures.

Code:
- `src/worker/index.ts`

## Open Findings

### 1. Medium-high: post-slot Polymarket exit is still too permissive for losing or unresolved legs

Severity rationale:
- This can still realize unnecessary losses after slot end.

Details:
- Winning Polymarket legs are now held for resolution.
- But losing or unresolved Polymarket legs can still be exited with `sellPrice - executionPriceBuffer`.
- On a thin or stale book, that can still realize materially worse prices than simply waiting for a deterministic resolution path where applicable.

Code:
- `src/lib/engine.ts`

Recommendation:
- Restrict slot-end market exits to cases where liquidation is actually necessary.
- For hedged and already-resolvable intents, prefer resolution / redeem paths over market sale whenever the leg can still settle deterministically.

### 2. Medium: Polymarket confirmation still depends on confirmed trade visibility

Severity rationale:
- This no longer fails in the simplistic timeout => unwind way, but latency on CONFIRMED trades can still delay or distort final state convergence.

Details:
- The confirmation path now correctly preserves `pending` when only pending trades are visible.
- That is safer than a false failure, but it also means intents can stay in mid-state longer during CLOB / data lag.
- The system still has no dedicated widened second-pass confirmation layer before certain downstream recovery paths.

Code:
- `src/lib/polymarket.ts`
- `src/lib/engine.ts`

Recommendation:
- Add a second-stage authoritative confirmation pass for old `pending` intents before any irreversible unwind decision.

### 3. Medium: reserved balance accounting still excludes `hedging` and `unwind_required`

Severity rationale:
- This is a real accounting gap, even though entry-blocking logic reduces the blast radius.

Details:
- Venue balance reservation only counts legs in `pending` or `submitted`.
- Intents in `hedging` or `unwind_required` do not contribute to reserved balance.
- The engine already blocks new entries while unresolved intents exist, so this is bounded operationally, but the balance view is still looser than the true state.

Code:
- `src/lib/risk.ts`
- `src/lib/engine.ts`

Recommendation:
- Extend reserved balance accounting to mid-state intents, or expose unresolved-intent reservations separately in the dashboard and readiness notes.

### 4. Medium: Polymarket `best_bid_ask` updates can still let the in-memory book shape drift

Severity rationale:
- This is primarily a quote-quality and observability risk.

Details:
- `best_bid_ask` updates refresh the tracked top-of-book values but do not fully reconcile the underlying level maps.
- The serialized book path masks some of this by injecting the current top level back into the quote, but the full depth representation can still drift over time.

Code:
- `src/lib/market-data.ts`

Recommendation:
- Reconcile or prune level maps when top-of-book moves in a direction that implies the previous top level was removed.

### 5. Medium: app-layer auth still depends on reverse-proxy discipline

Severity rationale:
- This remains an operational footgun if the wrong start mode or exposure path is used.

Details:
- Mutating API routes still rely on proxy-layer protection rather than in-app auth.
- This is acceptable on the intended VPS deployment, but remains fragile if the app is started or exposed incorrectly.

Recommendation:
- Keep `127.0.0.1`-only binding in production and add a lightweight app-layer secret or session check for mutating routes.

### 6. Low-medium: `polyBridgeLowWaterUsdc` remains informational only

Severity rationale:
- This does not create wrong trades directly, but it leaves treasury remediation manual.

Details:
- Low Polymarket balance is surfaced in notes/readiness.
- There is still no automatic top-up or bridge orchestration path behind that threshold.

Code:
- `src/lib/engine.ts`
- `src/lib/recovery.ts`

### 7. Low: dead or weakly exercised execution branches still exist

Details:
- `canSafelyLeadWithPolymarket()` is still effectively dormant because primary venue selection is hardcoded to Kalshi.
- This is not dangerous today, but it means the alternate path is not production-exercised.

Code:
- `src/lib/signals.ts`
- `src/lib/engine.ts`

## Priority Recommendations

1. Tighten slot-end Polymarket exit logic further so deterministic resolution beats discretionary market-sale whenever possible.
2. Add a second-stage confirmation pass for old Polymarket `pending` intents before any irreversible recovery action.
3. Extend reserved-balance accounting to `hedging` / `unwind_required` or surface that gap explicitly.
4. Reconcile Polymarket level maps more aggressively on `best_bid_ask` events.
5. Add minimal app-layer auth to mutating API routes instead of relying exclusively on the reverse proxy.

## Summary

The repo is in materially better shape than earlier iterations. The biggest false-positive execution issue on Kalshi primary no-fills is now addressed, orderbook seq gaps fail closed, and post-slot handling no longer force-sells a winning Polymarket leg. The main remaining risks are no longer "engine obviously wrong" class bugs; they are live-ops and microstructure edge cases: slow Polymarket confirmation, permissive losing-leg exits, incomplete reservation accounting, and a few operational safeguards that still live outside the app.
