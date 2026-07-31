#!/usr/bin/env bash
# Real-mail Playwright UI gate. --read-only proves launch UI without mail mutation.
set -euo pipefail

READ_ONLY=0
case "${1:-}" in
  "")
    ;;
  --read-only)
    READ_ONLY=1
    ;;
  *)
    echo "usage: $0 [--read-only]" >&2
    exit 2
    ;;
esac

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

ENV_FILE="${ENV_FILE:-apps/server-pilot/.env.production}"
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

CANONICAL_ORIGIN="https://nava.legacyhotels.co.za"
: "${BETTER_AUTH_URL:?BETTER_AUTH_URL missing from production environment}"
case "$BETTER_AUTH_URL" in
  "$CANONICAL_ORIGIN"|"$CANONICAL_ORIGIN/")
    ;;
  *)
    echo "refusing: BETTER_AUTH_URL must be canonical HTTPS origin" >&2
    exit 2
    ;;
esac
if [ -n "${PLAYWRIGHT_BASE_URL:-}" ]; then
  case "$PLAYWRIGHT_BASE_URL" in
    "$CANONICAL_ORIGIN"|"$CANONICAL_ORIGIN/")
      ;;
    *)
      echo "refusing: PLAYWRIGHT_BASE_URL must be canonical HTTPS origin" >&2
      exit 2
      ;;
  esac
fi
if [ -n "${VITE_PUBLIC_BACKEND_URL:-}" ]; then
  case "$VITE_PUBLIC_BACKEND_URL" in
    "$CANONICAL_ORIGIN"|"$CANONICAL_ORIGIN/")
      ;;
    *)
      echo "refusing: VITE_PUBLIC_BACKEND_URL must be canonical HTTPS origin" >&2
      exit 2
      ;;
  esac
fi
export BETTER_AUTH_URL="$CANONICAL_ORIGIN"
export PLAYWRIGHT_BASE_URL="$CANONICAL_ORIGIN"
export VITE_PUBLIC_BACKEND_URL="$CANONICAL_ORIGIN"
export PLAYWRIGHT_COOKIE_PREFIX="${PLAYWRIGHT_COOKIE_PREFIX:-better-auth}"
if [ "${PLAYWRIGHT_IGNORE_HTTPS_ERRORS:-0}" = "1" ]; then
  echo "refusing: production Playwright cannot ignore HTTPS errors" >&2
  exit 2
fi
export PLAYWRIGHT_IGNORE_HTTPS_ERRORS=0
export PLAYWRIGHT_REAL_MAIL_USER="${PLAYWRIGHT_REAL_MAIL_USER:-navaai@legacyhotels.co.za}"

# Re-assert after sourcing production env (file may have demo flags — still refuse).
if [ "${ZERO_DEMO_FRONTEND_ONLY:-0}" = "1" ] || [ "${VITE_FRONTEND_ONLY:-0}" = "1" ]; then
  echo "refusing: frontend-only demo mode set in env file for real-mail gate" >&2
  exit 2
fi
export ZERO_DEMO_FRONTEND_ONLY=0
export VITE_FRONTEND_ONLY=0

# Read-only launch proof must run against day-one product config. Mutating loopback
# proof remains opt-in and keeps its immediate-send requirement.
if [ "$READ_ONLY" -eq 1 ]; then
  EXPECTED_UNDO_SEND_SECONDS=30
else
  EXPECTED_UNDO_SEND_SECONDS=0
fi

UNDO_VAL="${UNDO_SEND_SECONDS:-}"
if [ -z "$UNDO_VAL" ] && [ -f "$ENV_FILE" ]; then
  UNDO_VAL="$(grep -E '^UNDO_SEND_SECONDS=' "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d "\"'" || true)"
fi
if [ "${UNDO_VAL:-}" != "$EXPECTED_UNDO_SEND_SECONDS" ]; then
  echo "refusing: UNDO_SEND_SECONDS must be ${EXPECTED_UNDO_SEND_SECONDS} for this UI gate mode" >&2
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

BACKEND_URL="$CANONICAL_ORIGIN"

echo "pnpm install (playwright pin)"
pnpm install --frozen-lockfile

if ! curl --disable --noproxy '*' -fsS \
  "${BACKEND_URL%/}/health" >/dev/null; then
  echo "backend not reachable at ${BACKEND_URL}/health" >&2
  exit 1
fi

echo "using SPA at ${PLAYWRIGHT_BASE_URL}"
curl --disable --noproxy '*' -fsS "${PLAYWRIGHT_BASE_URL}/" >/dev/null || {
  echo "SPA not reachable at ${PLAYWRIGHT_BASE_URL}" >&2
  exit 1
}

echo "resolving navaai password from Secrets Manager (or env)"
if [ -z "${PLAYWRIGHT_REAL_MAIL_PASSWORD:-${PLAYWRIGHT_NAVA_PASSWORD:-}}" ]; then
  PLAYWRIGHT_REAL_MAIL_PASSWORD="$(
    aws secretsmanager get-secret-value \
      --region "${AWS_REGION:-af-south-1}" \
      --secret-id nava-zero/server-pilot/pilot-users \
      --query SecretString \
      --output text |
      node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const j=JSON.parse(s);const v=j["navaai@legacyhotels.co.za"];process.stdout.write(typeof v==="string"?v:v.password)})'
  )"
else
  PLAYWRIGHT_REAL_MAIL_PASSWORD="${PLAYWRIGHT_REAL_MAIL_PASSWORD:-$PLAYWRIGHT_NAVA_PASSWORD}"
fi
export PLAYWRIGHT_REAL_MAIL_PASSWORD

READ_ONLY_SPECS=(
  real-mail-browser-login
  real-mail-launch-readonly
)
MUTATING_SPECS=(
  real-mail-browser-login
  real-mail-compose-self-loopback
  real-mail-force-sync-loopback
  real-mail-reply-loopback
)
if [ "$READ_ONLY" -eq 1 ]; then
  SELECTED_SPECS=("${READ_ONLY_SPECS[@]}")
  export REAL_MAIL_READ_ONLY=1
else
  SELECTED_SPECS=("${MUTATING_SPECS[@]}")
  export REAL_MAIL_READ_ONLY=0
fi

cd packages/testing
export REAL_MAIL_UI_GATE=1
set +e
# testMatch=/real-mail-.*\.spec\.ts/ via REAL_MAIL_UI_GATE — pass name filters, not absolute paths
pnpm exec playwright test \
  --reporter=line \
  "${SELECTED_SPECS[@]}"
PW_EXIT=$?
set -e
exit "$PW_EXIT"
