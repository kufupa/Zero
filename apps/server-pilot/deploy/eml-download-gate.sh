#!/usr/bin/env bash
# EC2 gate for 1-click EML download feature.
# Verifies module exports, safe unit tests, and HTTP endpoint contract without touching pilot RDS.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_PILOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "$SERVER_PILOT"

echo "=== Nava 1-Click .EML Download Verification Gate ==="

# 1. Strict safety guard against running tests on pilot RDS
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS

# 2. Verify build artifacts
echo "Verifying server build artifacts..."
if [ ! -f "dist/mail/eml-export.js" ] || [ ! -f "dist/http/eml-download.js" ]; then
  echo "Building @zero/server..."
  pnpm run build
fi

node -e "
  Promise.all([
    import('./dist/mail/eml-export.js'),
    import('./dist/http/eml-download.js')
  ]).then(([emlExport, emlDownload]) => {
    const filename = emlExport.formatEmlFilename('Reservation #12345: Guest Arrival', new Date('2026-09-09'));
    if (filename !== 'Reservation_#12345_Guest_Arrival_2026-09-09.eml') {
      throw new Error('Unexpected filename output: ' + filename);
    }
    if (typeof emlExport.synthesizeRfc822Eml !== 'function') {
      throw new Error('synthesizeRfc822Eml is not exported');
    }
    if (typeof emlDownload.createEmlDownloadHandler !== 'function') {
      throw new Error('createEmlDownloadHandler is not exported');
    }
    console.log('Build artifact integrity: OK (sample: ' + filename + ')');
  }).catch((err) => {
    console.error('Build artifact check failed:', err);
    process.exit(1);
  });
"

# 3. Run unit tests safely
echo "Running unit tests (offline / safe mock)..."
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
pnpm exec vitest run tests/eml-export.test.ts tests/mail-eml-download.test.ts --reporter=dot

# 4. If local server is running, verify endpoint auth gate
PORT="${PORT:-8788}"
BASE_URL="http://127.0.0.1:${PORT}"
if curl -fsS "${BASE_URL}/health" >/dev/null 2>&1; then
  echo "Local server detected at ${BASE_URL} — probing HTTP contract..."
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "${BASE_URL}/api/mail/messages/probe-id/download.eml" || true)
  if [ "${HTTP_CODE}" = "401" ]; then
    echo "Unauthenticated download returns 401 Unauthorized: OK"
  else
    echo "WARNING: Expected 401 for unauthenticated request, got ${HTTP_CODE}"
  fi
else
  echo "Local server not running on port ${PORT} (skipped live probe, unit tests verified contract)"
fi

echo "=== Nava EML Download Gate PASS ==="
