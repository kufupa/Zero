#!/usr/bin/env bash
# Pre-IT wire gate: Mailpit TCP + wire vitest on prod RDS. NOT run every deploy.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_PILOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${SERVER_PILOT}/../.." && pwd)"
ENV_FILE="${ENV_FILE:-${SERVER_PILOT}/.env.production}"

echo "== wire-gate: repo ${REPO_ROOT} =="
cd "$REPO_ROOT"

if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

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
pnpm test tests/mailpit-lifecycle.test.ts \
  tests/mail-wire-e2e.test.ts \
  tests/transport-mode.test.ts \
  --reporter=dot

echo "== pm2: start worker =="
pm2 start worker 2>/dev/null || pm2 start "${SCRIPT_DIR}/pm2.config.cjs" --only worker --update-env 2>/dev/null || true

echo "wire-gate: PASS"
