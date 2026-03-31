#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/warbitrer-live/app}"

cd "$APP_DIR"
npm ci
npm run typecheck
npm test
npm run build
sudo systemctl restart warbitrer-web
sudo systemctl restart warbitrer-worker
sudo systemctl status warbitrer-web --no-pager
sudo systemctl status warbitrer-worker --no-pager
