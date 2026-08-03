#!/usr/bin/env bash
# EC2 autonomous fixture loopback gate: vitest E2E + mail build after deploy.
# Never sources .env.production / .env into Vitest.
# Requires TEST_DATABASE_URL + CONFIRM_DISPOSABLE_TEST_DB=1 (disposable non-pilot).
#
# Usage (on instance):
#   CONFIRM_DISPOSABLE_TEST_DB=1 TEST_DATABASE_URL=... \
#     bash apps/server-pilot/deploy/fixture-loopback-gate.sh
#
# SSM (from laptop):
#   bash apps/server-pilot/deploy/ssm-run-command.sh \
#     'cd /home/ubuntu/repos/zero && CONFIRM_DISPOSABLE_TEST_DB=1 TEST_DATABASE_URL=... bash apps/server-pilot/deploy/fixture-loopback-gate.sh'
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_PILOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${SERVER_PILOT}/../.." && pwd)"
ENV_FILE="${ENV_FILE:-${SERVER_PILOT}/.env.production}"

echo "== fixture-loopback-gate: repo ${REPO_ROOT} =="
cd "$REPO_ROOT"

unset DATABASE_URL VITEST_ALLOW_PILOT_RDS

if [ -z "${TEST_DATABASE_URL:-}" ]; then
  echo "fixture-loopback-gate: TEST_DATABASE_URL must point to a disposable non-production DB" >&2
  exit 1
fi
if [ "${CONFIRM_DISPOSABLE_TEST_DB:-}" != "1" ]; then
  echo "fixture-loopback-gate: CONFIRM_DISPOSABLE_TEST_DB=1 required before DB Vitest" >&2
  exit 1
fi
case "${TEST_DATABASE_URL}" in
  *nava-zero-mail-pilot*)
    echo "fixture-loopback-gate: REFUSE TEST_DATABASE_URL pointing at pilot RDS" >&2
    exit 2
    ;;
esac

export NODE_ENV=test
export MAIL_TRANSPORT_MODE=fixture

export PATH="${HOME}/.local/share/pnpm:${HOME}/.nvm/versions/node/$(ls "${HOME}/.nvm/versions/node" 2>/dev/null | sort -V | tail -1)/bin:${PATH}"

echo "== pm2: stop worker =="
pm2 stop worker || true

echo "== vitest: fixture loopback suite =="
cd "$SERVER_PILOT"
DATABASE_URL="$TEST_DATABASE_URL" pnpm exec vitest run \
  tests/fixture-loopback-e2e.test.ts \
  tests/fixture-loopback.test.ts \
  tests/seed-contract.test.ts \
  tests/mail-send.test.ts \
  tests/ingest-store.test.ts \
  tests/pop3-worker.test.ts \
  --reporter=dot

echo "== build mail SPA =="
cd "$REPO_ROOT"
pnpm --filter @zero/mail build

echo "== pm2: start worker =="
# Restore worker only when production MAIL_TRANSPORT_MODE line says wire/real.
# Read that single non-secret line — never source the whole env file.
PROD_MAIL_MODE="fixture"
if [ -f "$ENV_FILE" ]; then
  PROD_MAIL_MODE="$(grep -E '^MAIL_TRANSPORT_MODE=' "$ENV_FILE" | tail -1 | cut -d= -f2- | tr -d "'\"" || true)"
  PROD_MAIL_MODE="${PROD_MAIL_MODE:-fixture}"
fi
if [ "$PROD_MAIL_MODE" = "wire" ] || [ "$PROD_MAIL_MODE" = "real" ]; then
  pm2 start worker 2>/dev/null || pm2 start "${SCRIPT_DIR}/pm2.config.cjs" --only worker --update-env 2>/dev/null || true
else
  pm2 start worker 2>/dev/null || true
fi

echo "fixture-loopback-gate: PASS"
