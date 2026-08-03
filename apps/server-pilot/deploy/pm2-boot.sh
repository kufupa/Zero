#!/usr/bin/env bash
# NVM-safe PM2 resurrect with startOrReload fallback. On-box / boot recovery.
# Never starts hms-ai-worker — ops-hms-shadow.sh start is the sole HMS starter.
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

export NAVA_BUILD_COMMIT="${NAVA_BUILD_COMMIT:-$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || true)}"

cd "$REPO_ROOT"

# Drop HMS worker before resurrect so dump cannot bring it back online alone.
pm2 delete hms-ai-worker 2>/dev/null || true
rm -f /opt/nava/shared/hms-reservation-canary-proof.v1.json \
  /opt/nava/shared/hms-reservation-shadow-proof.v1.json 2>/dev/null || true

if pm2 resurrect 2>/dev/null; then
  echo "pm2-boot: resurrected"
  # Resurrect may restore hms-ai-worker from an old dump — delete again.
  pm2 delete hms-ai-worker 2>/dev/null || true
  pm2 save 2>/dev/null || true
else
  echo "pm2-boot: resurrect failed; start default apps only (HMS off)"
  MODE="${MAIL_TRANSPORT_MODE:-fixture}"
  if [ "$MODE" = "fixture" ]; then
    pm2 start "${SERVER_PILOT}/deploy/pm2.config.cjs" --only http --update-env
    pm2 start "${SERVER_PILOT}/deploy/pm2.config.cjs" --only ai-worker --update-env
  else
    pm2 start "${SERVER_PILOT}/deploy/pm2.config.cjs" --only http --update-env
    pm2 start "${SERVER_PILOT}/deploy/pm2.config.cjs" --only worker --update-env
    pm2 start "${SERVER_PILOT}/deploy/pm2.config.cjs" --only ai-worker --update-env
  fi
  pm2 save
fi

pm2 status || true
