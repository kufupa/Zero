#!/usr/bin/env bash
# Laptop entrypoint: bounce PM2 apps without OS reboot (no rebuild).
set -euo pipefail

: "${AWS_REGION:=af-south-1}"
: "${INSTANCE_ID:=i-008f737974a9ba9b3}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

for arg in "$@"; do
  case "$arg" in
    -h|--help)
      echo "usage: $0"
      echo "  SSM: pm2 delete+start (env refresh) + health (no code sync/build)"
      exit 0
      ;;
    *)
      echo "unknown arg: $arg" >&2
      exit 2
      ;;
  esac
done

echo "== ops-restart: pm2 delete+start (env refresh) =="
bash "${SCRIPT_DIR}/ssm-run-command.sh" \
  'export NVM_DIR=/home/ubuntu/.nvm; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"; export PATH="$HOME/.local/share/pnpm:$PATH"; cd /home/ubuntu/repos/zero; ENV_FILE=apps/server-pilot/.env.production; [ -f "$ENV_FILE" ] || ENV_FILE=/home/ubuntu/.env.production; set -a; source "$ENV_FILE"; set +a; MODE="${MAIL_TRANSPORT_MODE:-fixture}"; if [ "$MODE" = "fixture" ]; then pm2 delete worker 2>/dev/null || true; pm2 delete http ai-worker 2>/dev/null || true; pm2 start apps/server-pilot/deploy/pm2.config.cjs --only http --update-env; pm2 start apps/server-pilot/deploy/pm2.config.cjs --only ai-worker --update-env; else pm2 delete http worker ai-worker 2>/dev/null || true; pm2 start apps/server-pilot/deploy/pm2.config.cjs --update-env; fi; pm2 save; curl -fsS http://127.0.0.1:8788/health'

echo
echo "ops-restart ok"
