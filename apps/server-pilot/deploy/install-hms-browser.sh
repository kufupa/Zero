#!/usr/bin/env bash
# Bootstrap Playwright Chromium under /opt/nava for HMS shadow reads.
# Emits HMS_DEPENDENCIES_OK only after exact package + revision + headless smoke.
# Bare `playwright install` (unpinned) is forbidden — always pin chromium + path.
set -euo pipefail

REPO_ROOT="${REPO_ROOT:-/home/ubuntu/repos/zero}"
SERVER_PILOT="${REPO_ROOT}/apps/server-pilot"
NAVA_ROOT="${NAVA_ROOT:-/opt/nava}"
CHROMIUM_DIR="${NAVA_ROOT}/chromium"
BROWSERS_DIR="${NAVA_ROOT}/ms-playwright"
EXPECTED_PW="1.52.0"
EXPECTED_REV="1169"
DEPENDENCY_REVISION="playwright-${EXPECTED_PW}-chromium-${EXPECTED_REV}"

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
export PATH="${HOME}/.local/share/pnpm:${HOME}/.nvm/versions/node/$(ls "${HOME}/.nvm/versions/node" 2>/dev/null | sort -V | tail -1)/bin:${PATH}"

cd "$SERVER_PILOT"

PW_VER="$(node -e "const p=require('playwright/package.json'); process.stdout.write(p.version)")"
if [ "$PW_VER" != "$EXPECTED_PW" ]; then
  echo "HMS_FAIL code=DEPENDENCY_MISMATCH" >&2
  echo "expected playwright ${EXPECTED_PW} got ${PW_VER}" >&2
  exit 10
fi

sudo mkdir -p "$NAVA_ROOT" "$CHROMIUM_DIR" "$BROWSERS_DIR"
sudo chown -R ubuntu:ubuntu "$NAVA_ROOT"

export PLAYWRIGHT_BROWSERS_PATH="$BROWSERS_DIR"

# Pinned chromium only — never bare unscoped `playwright install`.
pnpm exec playwright install chromium

# Resolve installed chromium revision from Playwright's registry / path.
REV="$(
  node --input-type=module <<'EOF'
import { chromium } from 'playwright';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let rev = '';
try {
  const pw = require('playwright-core/lib/server/registry/index.js');
  const exe = chromium.executablePath();
  const m = String(exe).match(/chromium-(\d+)/i);
  if (m) rev = m[1];
  if (!rev && pw?.registry?.findExecutable) {
    const ex = pw.registry.findExecutable('chromium');
    if (ex?.revision) rev = String(ex.revision);
  }
  if (!rev) {
    const m2 = String(exe).match(/\/(\d+)\//);
    if (m2) rev = m2[1];
  }
} catch {
  /* fall through */
}
process.stdout.write(rev);
EOF
)"

if [ "$REV" != "$EXPECTED_REV" ]; then
  # Fallback: inspect browsers dir for chromium-<rev>
  if [ -z "$REV" ]; then
    REV="$(find "$BROWSERS_DIR" -maxdepth 2 -type d -name 'chromium-*' 2>/dev/null | head -1 | sed -n 's/.*chromium-\([0-9]*\).*/\1/p')"
  fi
fi

if [ "$REV" != "$EXPECTED_REV" ]; then
  echo "HMS_FAIL code=DEPENDENCY_MISMATCH" >&2
  echo "expected chromium revision ${EXPECTED_REV} got ${REV:-unknown}" >&2
  exit 10
fi

EXE="$(node -e "import('playwright').then(m=>process.stdout.write(m.chromium.executablePath()))")"
if [ ! -x "$EXE" ]; then
  echo "HMS_FAIL code=DEPENDENCY_MISMATCH" >&2
  exit 10
fi

# Stable symlink for HMS_CHROMIUM_EXECUTABLE_PATH
ln -sfn "$EXE" "${CHROMIUM_DIR}/chrome"

# Headless smoke — blank page only; no network to hotel.
node --input-type=module <<EOF
import { chromium } from 'playwright';
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_EXE || '${CHROMIUM_DIR}/chrome',
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage();
await page.setContent('<html><body>ok</body></html>');
const text = await page.innerText('body');
await browser.close();
if (text.trim() !== 'ok') {
  console.error('HMS_FAIL code=DEPENDENCY_MISMATCH');
  process.exit(10);
}
EOF

# Persist dependency stamp for status/canary gates (no secrets).
install -o ubuntu -g ubuntu -m 600 /dev/null "${NAVA_ROOT}/shared/hms-dependency-revision.txt" 2>/dev/null \
  || { sudo mkdir -p "${NAVA_ROOT}/shared"; sudo install -o ubuntu -g ubuntu -m 600 /dev/null "${NAVA_ROOT}/shared/hms-dependency-revision.txt"; }
printf '%s\n' "$DEPENDENCY_REVISION" > "${NAVA_ROOT}/shared/hms-dependency-revision.txt"
chmod 600 "${NAVA_ROOT}/shared/hms-dependency-revision.txt"

echo "HMS_DEPENDENCIES_OK"
echo "dependencyRevision=${DEPENDENCY_REVISION}"
