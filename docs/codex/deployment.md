# Warbitrer - VPS Deployment

## Canonical architecture

```text
Caddy :80/:443
    -> Next.js 127.0.0.1:3000

systemd:
  warbitrer-web
  warbitrer-asset@btc
  warbitrer-asset@eth
  warbitrer-asset@sol
  warbitrer-asset@xrp
  warbitrer-asset@doge
  warbitrer-reconciler
  warbitrer-notifier
  warbitrer-postgres-backup.timer

Postgres on the VPS/private host
```

There is no Docker deployment.

## Paths and ownership

- Repository: `/opt/warbitrer-live/app`
- Service user/group: `warbitrer`
- Environment: `/etc/warbitrer/warbitrer.env`
- Kalshi key: `/etc/warbitrer/kalshi-private-key.pem`
- Polymarket key: `/etc/warbitrer/polymarket-private-key.txt`
- Backups: `/opt/warbitrer-live/backups/postgres` by default

`PG_POOL_MAX` must be at least 2 because advisory-lock callbacks can need a second application connection. The default split topology has eight app processes, so `PG_POOL_MAX=3` budgets up to 24 app connections; leave additional Postgres capacity for migrations, backups, and operator sessions. Never run the legacy worker alongside the split topology.

Run `git` and `npm` as `warbitrer`. Running them as root creates ownership failures in `.git`, `node_modules`, `.next`, and `dist`.

## Deployment gates

Before changing the deployed commit:

1. Set every active asset to scan-only and keep `LIVE_EXECUTION_ALLOWED=false`.
2. Confirm there is no non-terminal live intent, live order attempt, venue order, or capital exposure.
3. Reconcile any ambiguous venue truth; never close or rewrite operational rows directly in Postgres to make a deployment pass.
4. Confirm the working tree is clean and the intended commit is reviewed.
5. Confirm application Basic Auth, Caddy protection, Postgres backup, and restore access.

The zero-in-flight requirement is mandatory when client-order-ID generation changes. Deploying a new identifier scheme while an old submission remains recoverable can cause the two versions to address the same economic action with different venue identifiers.

## Versioned schema

The schema is managed by checksummed, forward-only migrations V1-V8 defined in `src/lib/postgres-db.ts`. Applied migration source is immutable: add a new migration instead of editing an existing one.

- `npm run db:migrate` serializes and applies pending migrations.
- `npm run db:status` verifies the exact version, name, order, and checksum history without applying DDL.
- Runtime services run `db:status` before startup and fail closed against a pending, unknown, reordered, or modified history.

Keep every application service stopped while migrations run. Do not restart until status is ready at V8.

## Safe update

`deploy/vps/deploy.sh` is the canonical updater for an already-cloned repository. It does not fetch or pull Git changes. First update the approved branch as `warbitrer`:

```bash
cd /opt/warbitrer-live/app
sudo -u warbitrer -H git status --short --branch
sudo -u warbitrer -H git pull --ff-only origin main
sudo bash deploy/vps/deploy.sh
```

The script refuses a dirty tree, verifies the protected environment file, rejects an active legacy worker, and runs a read-only live-state preflight before stopping services. It repeats the preflight after all services are stopped, waits for a quiescent Postgres backup, then runs `npm ci`, the production audit, lint, formatting, typecheck, tests, the Next.js build, the worker build, `db:migrate`, `db:status`, and a final post-migration preflight. Finally, it starts the split topology and requires every process and the backup timer to remain stable through four validation rounds.

Do not continue after a failed or killed command. The script does not replace the live-state, venue-truth, authentication, backup-readability, or restore checks above.

Never install or start `warbitrer-worker.service` on the VPS. The combined legacy role is reserved for the non-production Render preview and must not run alongside the split topology.

When upgrading an old installation, first disable the legacy unit, remove `/etc/systemd/system/warbitrer-worker.service`, and run `systemctl daemon-reload`. Do not remove any split unit.

## Health verification

Use local authenticated access without placing credentials in shell history when possible. Confirm:

- expected commit deployed
- worker bundle rebuilt after that commit
- all services active
- Postgres reachable
- schema ready at V8 with the expected checksums
- current snapshots for every active asset
- both venue feeds fresh
- `POLYGON_RPC_URL` connected to Polygon mainnet chain ID 137 with receipt access
- no unexpected breaker
- no unresolved Polymarket on-chain accounting evidence incident
- no unresolved intent/order/exposure
- trading still disabled or shadow-only

Inspect service-specific logs:

```bash
sudo journalctl -u warbitrer-asset@xrp -n 200 --no-pager
sudo journalctl -u warbitrer-reconciler -n 200 --no-pager
sudo journalctl -u warbitrer-web -n 100 --no-pager
```

Sanitize logs before sharing them.

## Database backups

The daily timer calls `deploy/vps/backup-postgres.sh`. Verify it explicitly:

```bash
sudo systemctl status warbitrer-postgres-backup.timer --no-pager
sudo systemctl start warbitrer-postgres-backup.service
sudo systemctl status warbitrer-postgres-backup.service --no-pager
```

Before schema-sensitive or destructive work, confirm a recent readable backup and a tested restore procedure. No historical restore archive is present in the current workspace.

## Exposure

Prefer HTTPS through Caddy, Tailscale, or an SSH tunnel. Never expose port 3000 directly.

Production application access fails closed unless both `APP_BASIC_AUTH_USER` and `APP_BASIC_AUTH_PASSWORD` are configured. Mutation routes authenticate independently and reject cross-site browser requests. Keep Caddy Basic Auth as an external defense; it does not replace the application checks.

Password-based SSH access remains available to the operator. The repository and deployment scripts do not edit `sshd`, `PasswordAuthentication`, system passwords, `authorized_keys`, or private keys, and do not require key-only login. An SSH key is optional and can coexist with password authentication.

## Rollback

Rollback requires an operator-approved known-good commit and awareness of database compatibility. Do not use destructive Git commands or roll the application backward across unknown schema changes.

A cautious rollback is:

1. Disable trading and activate the global breaker.
2. Preserve logs and database state.
3. Identify a known-good commit/build.
4. Confirm its database compatibility.
5. Build and restart the same split service topology.
6. Verify health in scan-only mode.

## Render

`render.yaml` starts Next.js and the legacy combined worker in one service. It is suitable only for preview/observation. Sleep, shared process lifetime, and free database limits make it unsuitable for dependable live execution.
