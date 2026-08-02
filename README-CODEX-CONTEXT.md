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
- Database changes are checksummed forward-only migrations V1-V10; runtime services verify schema compatibility and never apply DDL.
- Real execution is fail-closed behind effective live settings, `LIVE_EXECUTION_ALLOWED=true`, and Polygon mainnet receipt access for exact Polymarket accounting.
- Production application access requires Basic Auth; mutation routes authenticate independently and reject cross-site browser requests. Caddy remains a separate external defense.
- The global code and trading-safety review is complete locally; its final repository score and evidence are recorded in `docs/reviews/global-2026-07/iteration-07-final.md`. No deployment is implied by review or test work, and live trading stays disabled until the reviewed commit, feeds, reconciled venue truth, and operational state are verified.
- The canonical VPS topology has seven isolated asset workers and no combined `warbitrer-worker` service. The legacy combined role is only for the non-production Render preview.
- Password-based VPS SSH access must remain available. Repository scripts must not change `sshd` or impose key-only login; SSH keys are optional.

The detailed, date-specific state belongs in `docs/codex/session-handoff.md`.
