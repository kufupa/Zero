#!/usr/bin/env bash
# EC2 autonomous fixture loopback gate: vitest E2E + mail build after deploy.
# Run on EC2 as ubuntu with apps/server-pilot/.env.production present.
#
# Usage (on instance):
#   bash apps/server-pilot/deploy/fixture-loopback-gate.sh
#
# SSM (from laptop):
#   bash apps/server-pilot/deploy/ssm-run-command.sh \
#     'cd /home/ubuntu/repos/zero && bash apps/server-pilot/deploy/fixture-loopback-gate.sh'
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_PILOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${SERVER_PILOT}/../.." && pwd)"
ENV_FILE="${ENV_FILE:-${SERVER_PILOT}/.env.production}"

echo "== fixture-loopback-gate: repo ${REPO_ROOT} =="
cd "$REPO_ROOT"

if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
elif [ -f /home/ubuntu/.env.production ]; then
  set -a
  # shellcheck disable=SC1090
  source /home/ubuntu/.env.production
  set +a
fi

export NODE_ENV=test
export MAIL_TRANSPORT_MODE=fixture

export PATH="${HOME}/.local/share/pnpm:${HOME}/.nvm/versions/node/$(ls "${HOME}/.nvm/versions/node" 2>/dev/null | sort -V | tail -1)/bin:${PATH}"

echo "== pm2: stop worker =="
pm2 stop worker || true

echo "== vitest: fixture loopback suite =="
cd "$SERVER_PILOT"
pnpm test tests/fixture-loopback-e2e.test.ts \
  tests/fixture-loopback.test.ts \
  tests/seed-contract.test.ts \
  tests/mail-send.test.ts \
  tests/ingest-store.test.ts \
  tests/pop3-worker.test.ts

echo "== build mail SPA =="
cd "$REPO_ROOT"
pnpm --filter @zero/mail build

echo "== pm2: start worker =="
pm2 start worker

echo "fixture-loopback-gate: PASS"
