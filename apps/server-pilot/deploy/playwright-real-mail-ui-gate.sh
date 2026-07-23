#!/usr/bin/env bash
# Real-mail Playwright UI gate (AE1 login, AE7 compose, AE8 reply, AE9 forceSync).
# Reuses mint/nginx patterns from playwright-ec2-gate.sh but REFUSES frontend-only demo.
# EC2 run is Task 12 — this script is SSM-runnable when SPA + real transport are up.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${REPO_ROOT:-$(cd "${SCRIPT_DIR}/../../.." && pwd)}"
cd "$REPO_ROOT"

# HARD REFUSE demo mode (do not poison real-mail proof).
if [ "${ZERO_DEMO_FRONTEND_ONLY:-0}" = "1" ] || [ "${VITE_FRONTEND_ONLY:-0}" = "1" ]; then
  echo "refusing: frontend-only demo mode on for real-mail gate" >&2
  exit 2
fi
export ZERO_DEMO_FRONTEND_ONLY=0
export VITE_FRONTEND_ONLY=0
export ZERO_AUTO_START_BACKEND=0

export PATH="${HOME}/.local/share/pnpm:${HOME}/.nvm/versions/node/$(ls "${HOME}/.nvm/versions/node" 2>/dev/null | sort -V | tail -1)/bin:${PATH}"
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/nava/playwright-browsers}"
if [ -f /opt/nava/ec2-playwright-chromium/env.sh ]; then
  # shellcheck disable=SC1091
  source /opt/nava/ec2-playwright-chromium/env.sh
fi

export PLAYWRIGHT_BASE_URL="${PLAYWRIGHT_BASE_URL:-https://127.0.0.1}"
export PLAYWRIGHT_COOKIE_PREFIX="${PLAYWRIGHT_COOKIE_PREFIX:-better-auth}"
export PLAYWRIGHT_IGNORE_HTTPS_ERRORS="${PLAYWRIGHT_IGNORE_HTTPS_ERRORS:-1}"
export PLAYWRIGHT_REAL_MAIL_USER="${PLAYWRIGHT_REAL_MAIL_USER:-navaai@legacyhotels.co.za}"

ENV_FILE="${ENV_FILE:-apps/server-pilot/.env.production}"
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

# Re-assert after sourcing production env (file may have demo flags — still refuse).
if [ "${ZERO_DEMO_FRONTEND_ONLY:-0}" = "1" ] || [ "${VITE_FRONTEND_ONLY:-0}" = "1" ]; then
  echo "refusing: frontend-only demo mode set in env file for real-mail gate" >&2
  exit 2
fi
export ZERO_DEMO_FRONTEND_ONLY=0
export VITE_FRONTEND_ONLY=0

# UNDO_SEND_SECONDS=0 required so Send flushes immediately (KTD10).
UNDO_VAL="${UNDO_SEND_SECONDS:-}"
if [ -z "$UNDO_VAL" ] && [ -f "$ENV_FILE" ]; then
  UNDO_VAL="$(grep -E '^UNDO_SEND_SECONDS=' "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"' || true)"
fi
if [ "${UNDO_VAL:-}" != "0" ]; then
  echo "refusing: UNDO_SEND_SECONDS must be 0 for real-mail UI gate (got '${UNDO_VAL:-unset}')" >&2
  echo "hint: set UNDO_SEND_SECONDS=0 in ${ENV_FILE} then bash apps/server-pilot/deploy/ops-restart.sh" >&2
  exit 2
fi

# SPA freshness (KTD16): warn if build index stale; hard-fail only when missing and no nginx.
INDEX_HTML="${SPA_INDEX_HTML:-apps/mail/build/client/index.html}"
if [ -f "$INDEX_HTML" ]; then
  if stat -c %Y "$INDEX_HTML" >/dev/null 2>&1; then
    MTIME="$(stat -c %Y "$INDEX_HTML")"
  else
    MTIME="$(stat -f %m "$INDEX_HTML")"
  fi
  AGE=$(( $(date +%s) - MTIME ))
  if [ "$AGE" -gt 86400 ]; then
    echo "warning: SPA index.html mtime age ${AGE}s (>24h) — may be stale; continue" >&2
  else
    echo "SPA index.html age ${AGE}s (ok)"
  fi
else
  echo "warning: ${INDEX_HTML} missing — relying on nginx-deployed SPA" >&2
fi

BACKEND_URL="${VITE_PUBLIC_BACKEND_URL:-}"
if [ -z "$BACKEND_URL" ]; then
  if [[ "$PLAYWRIGHT_BASE_URL" == https://* ]] || [[ "$PLAYWRIGHT_BASE_URL" == http://* ]]; then
    BACKEND_URL="$PLAYWRIGHT_BASE_URL"
  else
    BACKEND_URL="http://127.0.0.1:8788"
  fi
fi
export VITE_PUBLIC_BACKEND_URL="$BACKEND_URL"

echo "pnpm install (playwright pin)"
pnpm install --frozen-lockfile

if ! curl -skf "${BACKEND_URL%/}/health" >/dev/null; then
  echo "backend not reachable at ${BACKEND_URL}/health" >&2
  exit 1
fi

echo "using SPA at ${PLAYWRIGHT_BASE_URL}"
curl -skf "${PLAYWRIGHT_BASE_URL}/" >/dev/null || {
  echo "SPA not reachable at ${PLAYWRIGHT_BASE_URL}" >&2
  exit 1
}

echo "resolving navaai password from Secrets Manager (or env)"
if [ -z "${PLAYWRIGHT_REAL_MAIL_PASSWORD:-${PLAYWRIGHT_NAVA_PASSWORD:-}}" ]; then
  SECRET=$(aws secretsmanager get-secret-value --region "${AWS_REGION:-af-south-1}" --secret-id nava-zero/server-pilot/pilot-users --query SecretString --output text)
  PLAYWRIGHT_REAL_MAIL_PASSWORD=$(node -e 'const j=JSON.parse(process.argv[1]);const v=j["navaai@legacyhotels.co.za"];console.log(typeof v==="string"?v:v.password)' "$SECRET")
else
  PLAYWRIGHT_REAL_MAIL_PASSWORD="${PLAYWRIGHT_REAL_MAIL_PASSWORD:-$PLAYWRIGHT_NAVA_PASSWORD}"
fi
export PLAYWRIGHT_REAL_MAIL_PASSWORD

# Mint optional cookies for non-login specs; login.spec MUST use UI form (AE1).
echo "minting session via ${BACKEND_URL} (compose/forceSync assist only)"
RESP=$(curl -ski -X POST "${BACKEND_URL%/}/api/auth/sign-in/email" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"${PLAYWRIGHT_REAL_MAIL_USER}\",\"password\":\"${PLAYWRIGHT_REAL_MAIL_PASSWORD}\"}")
PLAYWRIGHT_SESSION_TOKEN=$(node -e 'const r=process.argv[1];const m=r.match(/better-auth\.session_token=([^;\r\n]+)/);if(!m)process.exit(1);console.log(decodeURIComponent(m[1]))' "$RESP")
PLAYWRIGHT_SESSION_DATA=$(node -e 'const r=process.argv[1];const m=r.match(/better-auth\.session_data=([^;\r\n]+)/);if(!m)process.exit(1);console.log(m[1])' "$RESP")
export PLAYWRIGHT_SESSION_TOKEN PLAYWRIGHT_SESSION_DATA

cd packages/testing
export REAL_MAIL_UI_GATE=1
set +e
# testMatch=/real-mail-.*\.spec\.ts/ via REAL_MAIL_UI_GATE — pass name filters, not absolute paths
pnpm exec playwright test \
  --reporter=line \
  real-mail-browser-login \
  real-mail-compose-self-loopback \
  real-mail-force-sync-loopback \
  real-mail-reply-loopback
PW_EXIT=$?
set -e
exit "$PW_EXIT"
