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

export PATH="${HOME}/.local/share/pnpm:${HOME}/.nvm/versions/node/$(ls "${HOME}/.nvm/versions/node" 2>/dev/null | sort -V | tail -1)/bin:${PATH}"

echo "== pnpm install =="
pnpm install --frozen-lockfile

echo "== build server-pilot =="
pnpm --filter @zero/server build

echo "== build mail SPA =="
# Empty string = same-origin /api via nginx. Unset becomes literal "undefined" in the bundle.
export VITE_PUBLIC_BACKEND_URL="${VITE_PUBLIC_BACKEND_URL-}"
# Absolute app origin for RR redirects / metadata. Unset → literal "undefined/login" 404s.
export VITE_PUBLIC_APP_URL="${VITE_PUBLIC_APP_URL:-https://nava.legacy.local}"
pnpm --filter @zero/mail build

echo "== sync SPA to ${WEB_ROOT} =="
sudo mkdir -p "$WEB_ROOT"
sudo rsync -a --delete "${MAIL_APP}/build/client/" "${WEB_ROOT}/"

echo "== hosts: nava.legacy.local =="
# SPA + cert use this name; without it Chromium on-box gets ERR_NAME_NOT_RESOLVED.
if ! grep -qE '(^|[[:space:]])nava\.legacy\.local([[:space:]]|$)' /etc/hosts; then
  echo '127.0.0.1 nava.legacy.local' | sudo tee -a /etc/hosts >/dev/null
fi

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
# Fixture prod: do not keep a broken POP3 worker in the dump after reboot.
TRANSPORT_MODE="${MAIL_TRANSPORT_MODE:-fixture}"
if [ "$TRANSPORT_MODE" = "fixture" ]; then
  echo "== pm2: fixture mode — delete worker if present =="
  pm2 delete worker 2>/dev/null || true
fi

if command -v pm2 >/dev/null 2>&1; then
  if [ "$TRANSPORT_MODE" = "fixture" ]; then
    pm2 delete worker 2>/dev/null || true
    # delete+start so --update-env actually replaces process env (reload keeps stale).
    pm2 delete http ai-worker 2>/dev/null || true
    pm2 start "${SERVER_PILOT}/deploy/pm2.config.cjs" --only http --update-env
    pm2 start "${SERVER_PILOT}/deploy/pm2.config.cjs" --only ai-worker --update-env
  else
    pm2 delete http worker ai-worker 2>/dev/null || true
    pm2 start "${SERVER_PILOT}/deploy/pm2.config.cjs" --update-env
  fi
  pm2 save
  bash "${SERVER_PILOT}/deploy/pm2-startup.sh"
  pm2 status
else
  echo "pm2 not installed; installing globally"
  npm install -g pm2
  if [ "$TRANSPORT_MODE" = "fixture" ]; then
    pm2 delete worker 2>/dev/null || true
    pm2 delete http ai-worker 2>/dev/null || true
    pm2 start "${SERVER_PILOT}/deploy/pm2.config.cjs" --only http --update-env
    pm2 start "${SERVER_PILOT}/deploy/pm2.config.cjs" --only ai-worker --update-env
  else
    pm2 delete http worker ai-worker 2>/dev/null || true
    pm2 start "${SERVER_PILOT}/deploy/pm2.config.cjs" --update-env
  fi
  pm2 save
  bash "${SERVER_PILOT}/deploy/pm2-startup.sh"
  pm2 status
fi

echo "== health =="
HEALTH_URL="http://127.0.0.1:8788/health"
for attempt in $(seq 1 10); do
  if curl -fsS "$HEALTH_URL"; then
    echo
    echo "deploy ok"
    exit 0
  fi
  echo "health attempt ${attempt}/10 failed; retry in ${attempt}s"
  sleep "$attempt"
done
echo "health check failed after retries; pm2 logs http --lines 20"
pm2 logs http --lines 20 --nostream || true
exit 1
