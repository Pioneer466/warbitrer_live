# Warbitrer - Codex Usage

## Start from the repository root

```bash
cd /Users/ethanwolff/LOCAL_CODE/warbitrer-live
codex
```

## Required context

At the start of a session, ask Codex to read:

```text
AGENTS.md
README.md
README-CODEX-CONTEXT.md
docs/codex/project-overview.md
docs/codex/architecture.md
docs/codex/trading-safety.md
docs/codex/session-handoff.md
```

## Recommended first prompt

```text
Read the repository context files in the order defined by AGENTS.md. Inspect the current Git state and the relevant implementation. Summarize current behavior, risks, and the smallest safe next step. Do not print secrets or enable live trading.
```

## Working rules

- Inspect code and tests before editing.
- Keep real-money behavior disabled during diagnosis.
- Preserve unrelated working-tree changes.
- Do not assume Docker, Python, or a migration framework exists.
- Prefer fixture-based connector tests over live API calls.
- Treat deployment, breaker clearing, recovery, database restore, commit, and push as explicit operator actions.
- Update `docs/codex/session-handoff.md` after significant work.

## Session continuity

The handoff is the canonical date-specific summary. It should contain:

- current objective and commit
- effective topology
- work completed
- checks run
- unresolved blockers
- safety decisions
- next steps

Do not turn the handoff into a raw transcript. Preserve decisions, evidence, and blockers without credentials or unnecessary conversation history.

## Context files and Git

Updating context files locally does not upload them to GitHub. Review for secrets before explicitly adding, committing, and pushing them.

## Useful prompts

See `docs/codex/prompts.md` for repository-specific prompts covering Kalshi WS, execution review, deployment, tests, and handoff updates.
