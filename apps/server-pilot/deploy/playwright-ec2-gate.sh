#!/usr/bin/env bash
# Mint pilot session, hit production nginx SPA, run Playwright E2E on EC2.
# Use canonical nginx TLS so cookies and API requests remain same-origin.
set -euo pipefail

REPO_ROOT="${REPO_ROOT:-/home/ubuntu/repos/zero}"
cd "$REPO_ROOT"

export PATH="${HOME}/.local/share/pnpm:${HOME}/.nvm/versions/node/$(ls "${HOME}/.nvm/versions/node" 2>/dev/null | sort -V | tail -1)/bin:${PATH}"
export PLAYWRIGHT_BROWSERS_PATH=/opt/nava/playwright-browsers
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
export ZERO_DEMO_FRONTEND_ONLY="${ZERO_DEMO_FRONTEND_ONLY:-1}"
export VITE_FRONTEND_ONLY="${VITE_FRONTEND_ONLY:-1}"
export ZERO_AUTO_START_BACKEND=0
export EMAIL="${EMAIL:-guest@example.com}"

echo "pnpm install (playwright pin)"
pnpm install --frozen-lockfile

# Backend for session mint + health. Same-origin via canonical nginx TLS by default.
BACKEND_URL="$CANONICAL_ORIGIN"

if ! curl --disable --noproxy '*' -fsS \
  "${BACKEND_URL%/}/health" >/dev/null; then
  echo "backend not reachable at ${BACKEND_URL}/health" >&2
  exit 1
fi

echo "using nginx SPA at ${PLAYWRIGHT_BASE_URL}"
curl --disable --noproxy '*' -fsS "${PLAYWRIGHT_BASE_URL}/" >/dev/null || {
  echo "nginx SPA not reachable at ${PLAYWRIGHT_BASE_URL}" >&2
  exit 1
}

echo "minting session via ${BACKEND_URL}"
SECRET=$(aws secretsmanager get-secret-value --region af-south-1 --secret-id nava-zero/server-pilot/pilot-users --query SecretString --output text)
PW=$(node -e 'const j=JSON.parse(process.argv[1]);const v=j["navaai@legacyhotels.co.za"];console.log(typeof v==="string"?v:v.password)' "$SECRET")
RESP=$(curl --disable --noproxy '*' -sSi \
  -X POST "${BACKEND_URL%/}/api/auth/sign-in/email" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"navaai@legacyhotels.co.za\",\"password\":\"$PW\"}")
export PLAYWRIGHT_SESSION_TOKEN=$(node -e 'const r=process.argv[1];const m=r.match(/better-auth\.session_token=([^;\r\n]+)/);if(!m)process.exit(1);console.log(decodeURIComponent(m[1]))' "$RESP")
export PLAYWRIGHT_SESSION_DATA=$(node -e 'const r=process.argv[1];const m=r.match(/better-auth\.session_data=([^;\r\n]+)/);if(!m)process.exit(1);console.log(m[1])' "$RESP")

cd packages/testing
set +e
if [ -n "${PLAYWRIGHT_INCLUDE_SPECS:-}" ]; then
  pnpm exec playwright test "${PLAYWRIGHT_INCLUDE_SPECS}" --reporter=line
else
  pnpm exec playwright test --reporter=line
fi
PW_EXIT=$?
set -e
exit "$PW_EXIT"
