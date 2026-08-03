#!/usr/bin/env bash
# Pre-IT wire gate: Mailpit TCP + wire vitest on disposable DB. NOT run every deploy.
# Never sources .env.production / .env into Vitest.
# Post-test worker restore reads only MAIL_TRANSPORT_MODE line from env file.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_PILOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${SERVER_PILOT}/../.." && pwd)"
ENV_FILE="${ENV_FILE:-${SERVER_PILOT}/.env.production}"

echo "== wire-gate: repo ${REPO_ROOT} =="
cd "$REPO_ROOT"

unset DATABASE_URL VITEST_ALLOW_PILOT_RDS

if [ -z "${TEST_DATABASE_URL:-}" ]; then
  echo "wire-gate: TEST_DATABASE_URL must point to a disposable non-production DB" >&2
  exit 1
fi
if [ "${CONFIRM_DISPOSABLE_TEST_DB:-}" != "1" ]; then
  echo "wire-gate: CONFIRM_DISPOSABLE_TEST_DB=1 required before DB Vitest" >&2
  exit 1
fi
case "${TEST_DATABASE_URL}" in
  *nava-zero-mail-pilot*)
    echo "wire-gate: REFUSE TEST_DATABASE_URL pointing at pilot RDS" >&2
    exit 2
    ;;
esac

export PATH="${HOME}/.local/share/pnpm:${HOME}/.nvm/versions/node/$(ls "${HOME}/.nvm/versions/node" 2>/dev/null | sort -V | tail -1)/bin:${PATH}"

if [ ! -x /usr/local/bin/mailpit ]; then
  echo "== install mailpit =="
  bash "${SCRIPT_DIR}/install-mailpit.sh"
fi

echo "== pm2: ensure mailpit sidecar =="
pm2 delete mailpit 2>/dev/null || true
pm2 delete mailpit.ecosystem 2>/dev/null || true
if pm2 describe mailpit >/dev/null 2>&1; then
  pm2 restart mailpit --update-env
else
  MP_POP3_AUTH='ingest@wire.test:wire-test-pass' \
    pm2 start /usr/local/bin/mailpit \
      --name mailpit \
      --interpreter none \
      -- \
      --smtp=127.0.0.1:11025 \
      --pop3=127.0.0.1:11110 \
      --listen=127.0.0.1:18025
fi
pm2 save || true

echo "== wait for mailpit HTTP =="
for i in $(seq 1 40); do
  if curl -fsS "http://127.0.0.1:18025/api/v1/info" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done
if ! curl -fsS "http://127.0.0.1:18025/api/v1/info" >/dev/null 2>&1; then
  echo "wire-gate: mailpit not ready on 127.0.0.1:18025" >&2
  pm2 logs mailpit --lines 30 --nostream || true
  exit 1
fi

export MAILPIT_HTTP_URL="http://127.0.0.1:18025"
export NODE_ENV=test
export MAIL_TRANSPORT_MODE=wire
export SMTP_HOST=127.0.0.1
export SMTP_PORT=11025
export SMTP_SECURE=false
export POP3_HOST=127.0.0.1
export POP3_PORT=11110
export POP3_TLS=false
export POP3_USER=ingest@wire.test
export POP3_PASSWORD=wire-test-pass

echo "== pm2: stop worker (avoid POP3 race) =="
pm2 stop worker || true

echo "== vitest: wire suite =="
cd "$SERVER_PILOT"
DATABASE_URL="$TEST_DATABASE_URL" pnpm exec vitest run \
  tests/mailpit-lifecycle.test.ts \
  tests/mail-wire-e2e.test.ts \
  tests/transport-mode.test.ts \
  --reporter=dot

echo "== pm2: start worker (wire/real pilot only) =="
# Read only the non-secret MAIL_TRANSPORT_MODE line — never source the file.
PROD_MAIL_MODE="fixture"
if [ -f "$ENV_FILE" ]; then
  PROD_MAIL_MODE="$(grep -E '^MAIL_TRANSPORT_MODE=' "$ENV_FILE" | tail -1 | cut -d= -f2- | tr -d "'\"" || true)"
  PROD_MAIL_MODE="${PROD_MAIL_MODE:-fixture}"
fi
if [ "$PROD_MAIL_MODE" = "wire" ] || [ "$PROD_MAIL_MODE" = "real" ]; then
  pm2 start worker 2>/dev/null || pm2 start "${SCRIPT_DIR}/pm2.config.cjs" --only worker --update-env 2>/dev/null || true
else
  pm2 delete worker 2>/dev/null || true
fi

echo "wire-gate: PASS"
