#!/usr/bin/env bash
# Deploy server-pilot + mail SPA to EC2 (SSM-friendly, run as ubuntu).
set -euo pipefail

REPO_ROOT="${REPO_ROOT:-/home/ubuntu/repos/zero}"
SERVER_PILOT="${REPO_ROOT}/apps/server-pilot"
MAIL_APP="${REPO_ROOT}/apps/mail"
WEB_ROOT="${WEB_ROOT:-/var/www/nava-mail}"
ENV_FILE="${ENV_FILE:-${REPO_ROOT}/apps/server-pilot/.env.production}"
if [ ! -f "$ENV_FILE" ] && [ -f /home/ubuntu/.env.production ]; then
  ENV_FILE=/home/ubuntu/.env.production
fi

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

echo "== nginx =="
NGINX_SITE="${NGINX_SITE:-/etc/nginx/sites-available/nava-zero}"
NGINX_SRC="${SERVER_PILOT}/deploy/nginx.conf"
if command -v nginx >/dev/null 2>&1; then
  sudo cp "$NGINX_SRC" "$NGINX_SITE"
  sudo ln -sf "$NGINX_SITE" /etc/nginx/sites-enabled/nava-zero
  sudo nginx -t && sudo systemctl reload nginx
else
  echo "nginx not installed; first-time setup required:"
  echo "  sudo apt install nginx"
  echo "  sudo mkdir -p /etc/nginx/ssl"
  echo "  # place nava.crt and nava.key in /etc/nginx/ssl/"
  echo "  sudo cp ${NGINX_SRC} ${NGINX_SITE}"
  echo "  sudo ln -sf ${NGINX_SITE} /etc/nginx/sites-enabled/nava-zero"
  echo "  sudo nginx -t && sudo systemctl enable --now nginx"
fi

echo "== pm2 =="
if command -v pm2 >/dev/null 2>&1; then
  pm2 startOrReload "${SERVER_PILOT}/deploy/pm2.config.cjs" --update-env
  pm2 save
  pm2 status
else
  echo "pm2 not installed; installing globally"
  npm install -g pm2
  pm2 startOrReload "${SERVER_PILOT}/deploy/pm2.config.cjs" --update-env
  pm2 save
  pm2 status
fi

echo "== health =="
sleep 2
curl -fsS http://127.0.0.1:8788/health || {
  echo "health check failed; pm2 logs http --lines 20"
  pm2 logs http --lines 20 --nostream || true
  exit 1
}
echo
echo "deploy ok"
