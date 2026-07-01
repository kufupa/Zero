#!/usr/bin/env bash
# Deploy server-pilot + mail SPA to EC2 (SSM-friendly, run as ubuntu).
set -euo pipefail

REPO_ROOT="${REPO_ROOT:-/home/ubuntu/repos/zero}"
SERVER_PILOT="${REPO_ROOT}/apps/server-pilot"
MAIL_APP="${REPO_ROOT}/apps/mail"
WEB_ROOT="${WEB_ROOT:-/var/www/nava-mail}"
ENV_FILE="${ENV_FILE:-/home/ubuntu/.env.production}"

echo "== deploy: repo ${REPO_ROOT} =="
cd "$REPO_ROOT"

if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

export PATH="${HOME}/.local/share/pnpm:${HOME}/.nvm/versions/node/$(ls "${HOME}/.nvm/versions/node" 2>/dev/null | tail -1)/bin:${PATH}"

echo "== pnpm install =="
pnpm install --frozen-lockfile

echo "== build server-pilot =="
pnpm --filter @zero/server build

echo "== build mail SPA =="
pnpm --filter @zero/mail build

echo "== sync SPA to ${WEB_ROOT} =="
sudo mkdir -p "$WEB_ROOT"
sudo rsync -a --delete "${MAIL_APP}/build/client/" "${WEB_ROOT}/"

echo "== pm2 =="
if command -v pm2 >/dev/null 2>&1; then
  pm2 startOrReload "${SERVER_PILOT}/deploy/pm2.config.cjs" --update-env
  pm2 save
  pm2 status
else
  echo "pm2 not installed; starting http in foreground for smoke only"
  node "${SERVER_PILOT}/dist/main.js" &
  HTTP_PID=$!
  sleep 3
  curl -fsS http://127.0.0.1:8788/health
  kill "$HTTP_PID" || true
fi

echo "== health =="
curl -fsS http://127.0.0.1:8788/health
echo
echo "deploy ok"
