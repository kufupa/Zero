#!/usr/bin/env bash
# Mint pilot session, ensure mail dev FE on :3000, run Playwright E2E on EC2.
set -euo pipefail

REPO_ROOT="${REPO_ROOT:-/home/ubuntu/repos/zero}"
cd "$REPO_ROOT"

echo "pnpm install (playwright pin)"
pnpm install --frozen-lockfile

export PATH="${HOME}/.local/share/pnpm:${HOME}/.nvm/versions/node/$(ls "${HOME}/.nvm/versions/node" 2>/dev/null | sort -V | tail -1)/bin:${PATH}"
export PLAYWRIGHT_BROWSERS_PATH=/opt/nava/playwright-browsers
if [ -f /opt/nava/ec2-playwright-chromium/env.sh ]; then
  # shellcheck disable=SC1091
  source /opt/nava/ec2-playwright-chromium/env.sh
fi
export PLAYWRIGHT_BASE_URL="${PLAYWRIGHT_BASE_URL:-http://localhost:3000}"
export PLAYWRIGHT_COOKIE_PREFIX="${PLAYWRIGHT_COOKIE_PREFIX:-better-auth}"
export VITE_PUBLIC_BACKEND_URL="${VITE_PUBLIC_BACKEND_URL:-http://127.0.0.1:8788}"
export ZERO_AUTO_START_BACKEND=0
export EMAIL="${EMAIL:-guest@example.com}"

cleanup() {
  if [ -n "${FE_PID:-}" ]; then
    kill "$FE_PID" 2>/dev/null || true
  fi
  pkill -f "react-router dev" 2>/dev/null || true
}
trap cleanup EXIT

if ! curl -sf "${VITE_PUBLIC_BACKEND_URL%/}/health" >/dev/null; then
  echo "backend not reachable at ${VITE_PUBLIC_BACKEND_URL}" >&2
  exit 1
fi

if ! curl -sf "${PLAYWRIGHT_BASE_URL}/" >/dev/null 2>&1; then
  echo "starting frontend dev on ${PLAYWRIGHT_BASE_URL}"
  pkill -f "react-router dev" 2>/dev/null || true
  sleep 1
  nohup env \
    VITE_PUBLIC_BACKEND_URL="$VITE_PUBLIC_BACKEND_URL" \
    VITE_DISABLE_SENTRY=1 \
    ZERO_DEMO_MODE=1 \
    ZERO_DEMO_FRONTEND_ONLY=1 \
    VITE_ZERO_DEMO_MODE=1 \
    VITE_FRONTEND_ONLY=1 \
    pnpm --dir apps/mail run dev > /tmp/fe-dev.log 2>&1 &
  FE_PID=$!
  for _ in $(seq 1 90); do
    if curl -sf "${PLAYWRIGHT_BASE_URL}/" >/dev/null 2>&1; then
      echo "frontend up"
      break
    fi
    if ! kill -0 "$FE_PID" 2>/dev/null; then
      tail -80 /tmp/fe-dev.log >&2 || true
      exit 1
    fi
    sleep 2
  done
  curl -sf "${PLAYWRIGHT_BASE_URL}/" >/dev/null || {
    echo "frontend never became ready" >&2
    tail -80 /tmp/fe-dev.log >&2 || true
    exit 1
  }
fi

echo "minting session"
SECRET=$(aws secretsmanager get-secret-value --region af-south-1 --secret-id nava-zero/server-pilot/pilot-users --query SecretString --output text)
PW=$(node -e 'const j=JSON.parse(process.argv[1]);const v=j["manager@legacyhotel.com"];console.log(typeof v==="string"?v:v.password)' "$SECRET")
RESP=$(curl -si -X POST "${VITE_PUBLIC_BACKEND_URL%/}/api/auth/sign-in/email" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"manager@legacyhotel.com\",\"password\":\"$PW\"}")
export PLAYWRIGHT_SESSION_TOKEN=$(node -e 'const r=process.argv[1];const m=r.match(/better-auth\.session_token=([^;\r\n]+)/);if(!m)process.exit(1);console.log(decodeURIComponent(m[1]))' "$RESP")
export PLAYWRIGHT_SESSION_DATA=$(node -e 'const r=process.argv[1];const m=r.match(/better-auth\.session_data=([^;\r\n]+)/);if(!m)process.exit(1);console.log(m[1])' "$RESP")

cd packages/testing
pnpm exec playwright test --reporter=line
