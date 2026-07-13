# Warbitrer Codex Context

This file is the entry point for AI-assisted work in this repository. The context pack is already present at the repository root; there is no ZIP to extract and no upload step required for local Codex access.

## Read first

Use this order:

1. `AGENTS.md`
2. `README.md`
3. `docs/codex/project-overview.md`
4. `docs/codex/architecture.md`
5. `docs/codex/trading-safety.md`
6. `docs/codex/session-handoff.md`
The previous raw discussion has been removed after its durable, non-sensitive context was consolidated into `docs/codex/session-handoff.md`.

## Canonical context files

```text
AGENTS.md
README.md
README-CODEX-CONTEXT.md
docs/codex/
  project-overview.md
  architecture.md
  trading-safety.md
  runbook.md
  deployment.md
  testing-strategy.md
  websocket-debugging.md
  log-analysis.md
  session-handoff.md
  prompts.md
  codex-usage.md
```

## Current high-level state

- Next.js operator cockpit and long-running TypeScript workers.
- Postgres is mandatory; Docker is not used.
- Production uses per-asset `systemd` workers plus reconciler and notifier services.
- The current blocker is unreliable Kalshi WebSocket market data on the VPS.
- Live trading must stay disabled until feed health and deployment state are verified.

The detailed, date-specific state belongs in `docs/codex/session-handoff.md`.
