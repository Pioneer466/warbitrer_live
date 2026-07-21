#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/warbitrer-live/app}"
APP_USER="${APP_USER:-warbitrer}"
ENV_FILE="${ENV_FILE:-/etc/warbitrer/warbitrer.env}"
DEPLOY_LOCK_FILE="${DEPLOY_LOCK_FILE:-/run/lock/warbitrer-deploy.lock}"
SERVICE_UNITS=(
  warbitrer-web.service
  warbitrer-asset@btc.service
  warbitrer-asset@eth.service
  warbitrer-asset@sol.service
  warbitrer-asset@xrp.service
  warbitrer-asset@doge.service
  warbitrer-reconciler.service
  warbitrer-notifier.service
)
UNIT_FILES=(
  warbitrer-web.service
  warbitrer-asset@.service
  warbitrer-reconciler.service
  warbitrer-notifier.service
  warbitrer-postgres-backup.service
  warbitrer-postgres-backup.timer
)
LEGACY_UNIT="warbitrer-worker.service"

exec 9>"$DEPLOY_LOCK_FILE"
if ! flock --nonblock 9; then
  echo "Another Warbitrer deployment already holds $DEPLOY_LOCK_FILE." >&2
  exit 1
fi

run_as_app() {
  sudo -u "$APP_USER" -H "$@"
}

run_db_script() {
  sudo systemd-run \
    --quiet \
    --wait \
    --pipe \
    --collect \
    --uid="$APP_USER" \
    --working-directory="$APP_DIR" \
    --property="EnvironmentFile=$ENV_FILE" \
    /usr/bin/node --import tsx "$1"
}

startup_validation_active=0
stop_partially_started_services() {
  local status=$?
  if [[ "$startup_validation_active" -eq 1 ]]; then
    echo "Deployment startup validation failed; stopping every application service." >&2
    sudo systemctl stop "${SERVICE_UNITS[@]}" || true
  fi
  exit "$status"
}

assert_service_stable() {
  local unit="$1"
  local active_state sub_state main_pid restarts
  active_state="$(sudo systemctl show "$unit" --property=ActiveState --value)"
  sub_state="$(sudo systemctl show "$unit" --property=SubState --value)"
  main_pid="$(sudo systemctl show "$unit" --property=MainPID --value)"
  restarts="$(sudo systemctl show "$unit" --property=NRestarts --value)"
  if [[ "$active_state" != "active" || "$sub_state" != "running" || ! "$main_pid" =~ ^[1-9][0-9]*$ || "$restarts" != "0" ]]; then
    sudo systemctl status "$unit" --no-pager || true
    echo "Deployment failed because $unit is not stably running (active=$active_state, sub=$sub_state, pid=$main_pid, restarts=$restarts)." >&2
    return 1
  fi
}

cd "$APP_DIR"

if [[ ! -r "$ENV_FILE" ]]; then
  echo "Environment file is not readable: $ENV_FILE" >&2
  exit 1
fi

if [[ -n "$(run_as_app git status --short)" ]]; then
  echo "Refusing to deploy a dirty working tree." >&2
  exit 1
fi

for unit in "${UNIT_FILES[@]}"; do
  if [[ ! -r "$APP_DIR/deploy/vps/$unit" ]]; then
    echo "Canonical systemd unit is missing: $APP_DIR/deploy/vps/$unit" >&2
    exit 1
  fi
done

if sudo systemctl is-active --quiet "$LEGACY_UNIT"; then
  echo "Refusing to deploy while the legacy $LEGACY_UNIT is active." >&2
  exit 1
fi
if sudo systemctl is-enabled --quiet "$LEGACY_UNIT" 2>/dev/null; then
  echo "Refusing to deploy while the legacy $LEGACY_UNIT is enabled." >&2
  exit 1
fi

run_db_script scripts/deploy-preflight.ts

sudo systemctl stop "${SERVICE_UNITS[@]}"
for unit in "${SERVICE_UNITS[@]}"; do
  if sudo systemctl is-active --quiet "$unit"; then
    echo "Refusing to continue because $unit is still active after stop." >&2
    exit 1
  fi
done

# Close the preflight/stop race, then take a quiescent database backup.
run_db_script scripts/deploy-preflight.ts
sudo systemctl start --wait warbitrer-postgres-backup.service

run_as_app npm ci
run_as_app npm run audit:prod
run_as_app npm run lint
run_as_app npm run format:check
run_as_app npm run typecheck
run_as_app npm test
run_as_app npm run build
run_as_app npm run build:worker
run_db_script scripts/db-migrate.ts
run_db_script scripts/db-status.ts
# Migrations can surface or create blocking durable state (notably accounting backlog).
run_db_script scripts/deploy-preflight.ts

for unit in "${UNIT_FILES[@]}"; do
  sudo install -o root -g root -m 0644 \
    "$APP_DIR/deploy/vps/$unit" "/etc/systemd/system/$unit"
done
sudo systemctl daemon-reload
sudo systemctl enable "${SERVICE_UNITS[@]}" warbitrer-postgres-backup.timer
startup_validation_active=1
trap stop_partially_started_services EXIT
sudo systemctl start "${SERVICE_UNITS[@]}"
sudo systemctl start warbitrer-postgres-backup.timer
for validation_round in 1 2 3 4; do
  sleep 5
  for unit in "${SERVICE_UNITS[@]}"; do
    assert_service_stable "$unit"
  done
done
if ! sudo systemctl is-active --quiet warbitrer-postgres-backup.timer; then
  sudo systemctl status warbitrer-postgres-backup.timer --no-pager || true
  echo "Deployment failed because warbitrer-postgres-backup.timer is not active." >&2
  exit 1
fi
curl --fail --silent --show-error --max-time 10 \
  http://127.0.0.1:3000/api/liveness >/dev/null
sudo systemctl status "${SERVICE_UNITS[@]}" --no-pager
sudo systemctl status warbitrer-postgres-backup.timer --no-pager
startup_validation_active=0
trap - EXIT
