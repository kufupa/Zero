#!/usr/bin/env bash
# NVM-safe PM2 resurrect with startOrReload fallback. On-box / boot recovery.
set -euo pipefail

REPO_ROOT="${REPO_ROOT:-/home/ubuntu/repos/zero}"
SERVER_PILOT="${REPO_ROOT}/apps/server-pilot"
ENV_FILE="${ENV_FILE:-${SERVER_PILOT}/.env.production}"
if [ ! -f "$ENV_FILE" ] && [ -f /home/ubuntu/.env.production ]; then
  ENV_FILE=/home/ubuntu/.env.production
fi

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

export PATH="${HOME}/.local/share/pnpm:${HOME}/.nvm/versions/node/$(ls "${HOME}/.nvm/versions/node" 2>/dev/null | sort -V | tail -1)/bin:${PATH}"

if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

cd "$REPO_ROOT"

if pm2 resurrect 2>/dev/null; then
  echo "pm2-boot: resurrected"
else
  echo "pm2-boot: resurrect failed; startOrReload"
  pm2 startOrReload "${SERVER_PILOT}/deploy/pm2.config.cjs" --update-env
  pm2 save
fi

pm2 status || true
