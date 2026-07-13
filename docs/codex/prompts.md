# Warbitrer - Codex Prompts

## Repository orientation

```text
Read AGENTS.md, README.md, README-CODEX-CONTEXT.md, docs/codex/project-overview.md, docs/codex/architecture.md, docs/codex/trading-safety.md, and docs/codex/session-handoff.md. Inspect Git status and relevant code. Summarize the current state and safest next step. Do not modify files or print secrets yet.
```

## Continue Kalshi WS diagnosis

```text
Continue the unresolved Kalshi WebSocket diagnosis from docs/codex/session-handoff.md. Keep live trading disabled. Separate REST discovery, WS handshake, subscription acknowledgement, data payload, sequence handling, and freshness. Use sanitized logs and full-envelope fixtures. Do not change execution logic.
```

## Review Kalshi logs

```text
Analyze these sanitized warbitrer-asset logs. Identify the exact Kalshi stage reached: market discovery, authenticated WS open, subscribe sent, subscribed ack, first data payload, stale fallback, error, or close. Distinguish facts from hypotheses and propose the smallest next diagnostic. Do not ask for secrets.
```

## Connector change

```text
Inspect the current connector and market-data implementation before editing. Check endpoint/environment, signing path, subscription shape, full WS envelope, sequence continuity, reconnect, stale fallback, rate limiting, and durable error visibility. Add deterministic fixture tests. Do not touch order execution.
```

## Trading safety review

```text
Review the proposed change as real-money trading code. Prioritize accidental live activation, stale data, duplicate orders, ambiguous fills, exposure limits, hedge failure, retry bounds, reconciliation, breaker behavior, and secret leakage. Lead with concrete findings and file references.
```

## Execution change

```text
Before modifying execution, trace the full intent lifecycle and relevant tests. State the financial risk and smallest safe change. Preserve stable client IDs, persisted order attempts, ambiguous-truth handling, exposure blockers, reconciliation, and dry/shadow behavior. Add failure-path tests and run typecheck, full tests, and both builds.
```

## Postgres change

```text
Inspect src/lib/postgres-db.ts and every caller affected by this schema/query change. Account for multiple worker processes, advisory locks, existing production data, idempotent startup, rollback, retention, and backups. Do not run destructive SQL or assume a versioned migration tool exists.
```

## VPS deployment

```text
Use docs/codex/deployment.md and deploy/vps service files. This repository does not use Docker. Confirm branch, commit, ownership, npm install completion, web build, worker build, split systemd services, Postgres backup, authentication, breakers, and scan-only mode. Do not use deploy/vps/deploy.sh blindly and do not print secrets.
```

## Test request

```text
Add the smallest deterministic tests for the modified behavior. Prefer complete sanitized WS/API fixtures. Do not call live venues. Run the targeted test first, then npm run typecheck and npm test; run both production builds for connector, database, API, or execution changes.
```

## Code review

```text
Review this diff for defects and regressions. Findings first, ordered by severity, with file/line references. Focus on real-money safety, market-data freshness, order truth, concurrency, Postgres compatibility, API authorization, deployment behavior, and missing tests.
```

## Update handoff

```text
Update docs/codex/session-handoff.md with the objective, current commit/state, files changed, commands/checks, blockers, decisions, and safest next steps. Keep it concise and include no secrets or raw credentials.
```
