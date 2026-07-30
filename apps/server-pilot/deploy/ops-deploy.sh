#!/usr/bin/env bash
# Laptop entrypoint: ship new code to pilot EC2 (sync → optional migrate → deploy → health).
set -euo pipefail

: "${AWS_REGION:=af-south-1}"
: "${INSTANCE_ID:=i-008f737974a9ba9b3}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DO_MIGRATE=0
QUIESCED=0
for arg in "$@"; do
  case "$arg" in
    --migrate) DO_MIGRATE=1 ;;
    --quiesced) QUIESCED=1 ;;
    -h|--help)
      echo "usage: $0 [--migrate] [--quiesced]"
      echo "  sync git bundle → optional db:migrate → deploy-ec2.sh → health"
      echo "  --quiesced: deploy-ec2.sh --quiesced (no PM2/health); VPN assert retained"
      exit 0
      ;;
    *)
      echo "unknown arg: $arg (try --migrate / --quiesced)" >&2
      exit 2
      ;;
  esac
done

echo "== ops-deploy: sync bundle =="
bash "${SCRIPT_DIR}/sync-ec2-git-bundle.sh"

REMOTE_NVM='export NVM_DIR=/home/ubuntu/.nvm; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"; export PATH="$HOME/.local/share/pnpm:$PATH"'

if [ "$DO_MIGRATE" -eq 1 ]; then
  echo "== ops-deploy: migrate =="
  bash "${SCRIPT_DIR}/ssm-run-command.sh" \
    "${REMOTE_NVM}; cd /home/ubuntu/repos/zero/apps/server-pilot && set -a && source .env.production && set +a && pnpm db:migrate"
fi

if [ "$QUIESCED" = "1" ]; then
  echo "== ops-deploy: on-box quiesced deploy (no PM2 / no HTTP health) =="
  bash "${SCRIPT_DIR}/ssm-run-command.sh" \
    "${REMOTE_NVM}; cd /home/ubuntu/repos/zero && bash apps/server-pilot/deploy/deploy-ec2.sh --quiesced"
fi

if [ "$QUIESCED" != "1" ]; then
  echo "== ops-deploy: on-box deploy =="
  bash "${SCRIPT_DIR}/ssm-run-command.sh" \
    "${REMOTE_NVM}; cd /home/ubuntu/repos/zero && bash apps/server-pilot/deploy/deploy-ec2.sh"

  echo "== ops-deploy: health =="
  bash "${SCRIPT_DIR}/ssm-run-command.sh" \
    'curl -fsS http://127.0.0.1:8788/health'
fi

echo "== ops-deploy: VPN HARD assert =="
bash "${SCRIPT_DIR}/ssm-run-command.sh" \
  'bash /home/ubuntu/repos/zero/apps/server-pilot/deploy/vpn-health-assert.sh'

echo "ops-deploy ok"
