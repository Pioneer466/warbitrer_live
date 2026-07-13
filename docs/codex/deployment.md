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

Run `git` and `npm` as `warbitrer`. Running them as root creates ownership failures in `.git`, `node_modules`, `.next`, and `dist`.

## Current deployment caveat

`deploy/vps/deploy.sh` is stale: it does not run `build:worker` and restarts the legacy `warbitrer-worker` service instead of the split services. Do not use it until corrected.

## Safe manual update

Keep trading disabled before deployment. From the VPS:

```bash
cd /opt/warbitrer-live/app
sudo -u warbitrer -H git status --short --branch
sudo -u warbitrer -H git pull --ff-only origin main
sudo -u warbitrer -H npm ci --no-audit --no-fund
sudo -u warbitrer -H npm run typecheck
sudo -u warbitrer -H npm test
sudo -u warbitrer -H npm run build
sudo -u warbitrer -H npm run build:worker
```

Do not continue after a failed or killed command.

Restart the current topology:

```bash
sudo systemctl restart \
  warbitrer-web \
  warbitrer-asset@btc \
  warbitrer-asset@eth \
  warbitrer-asset@sol \
  warbitrer-asset@xrp \
  warbitrer-asset@doge \
  warbitrer-reconciler \
  warbitrer-notifier
```

Verify every unit rather than only the web process:

```bash
sudo systemctl --no-pager --full status \
  warbitrer-web \
  warbitrer-asset@btc \
  warbitrer-asset@eth \
  warbitrer-asset@sol \
  warbitrer-asset@xrp \
  warbitrer-asset@doge \
  warbitrer-reconciler \
  warbitrer-notifier
```

## Health verification

Use local authenticated access without placing credentials in shell history when possible. Confirm:

- expected commit deployed
- worker bundle rebuilt after that commit
- all services active
- Postgres reachable
- current snapshots for every active asset
- both venue feeds fresh
- no unexpected breaker
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

Prefer HTTPS through Caddy, Tailscale, or an SSH tunnel. Never expose port 3000 directly. Basic Auth is only active when both application variables are set; verify this rather than assuming it.

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
