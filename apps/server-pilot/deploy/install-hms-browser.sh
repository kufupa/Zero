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
ARTIFACT_DIR="${NAVA_ROOT}/shared/hms-browser-artifacts"
RUNTIME_DIR="${NAVA_ROOT}/shared/hms-runtime"
ROLE_PROOF_DIR="/etc/nava"
ROLE_PROOF_PATH="${ROLE_PROOF_DIR}/hms-read-role-proof.v1.json"
LEGACY_ROLE_PROOF_PATH="${NAVA_ROOT}/shared/hms-read-role-proof.v1.json"
EXPECTED_PW="1.63.0"
EXPECTED_REV="1243"
EXPECTED_NODE="v22.23.1"
EXPECTED_PNPM="10.15.0"
DEPENDENCY_REVISION="playwright-${EXPECTED_PW}-chromium-${EXPECTED_REV}"

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
export PATH="${HOME}/.local/share/pnpm:${HOME}/.nvm/versions/node/$(ls "${HOME}/.nvm/versions/node" 2>/dev/null | sort -V | tail -1)/bin:${PATH}"

cd "$SERVER_PILOT"

NODE_VER="$(node --version 2>/dev/null || true)"
PNPM_VER="$(pnpm --version 2>/dev/null || true)"
if [ "$NODE_VER" != "$EXPECTED_NODE" ] || [ "$PNPM_VER" != "$EXPECTED_PNPM" ]; then
  echo "HMS_FAIL code=DEPENDENCY_MISMATCH" >&2
  echo "expected node ${EXPECTED_NODE} / pnpm ${EXPECTED_PNPM}; got ${NODE_VER:-missing} / ${PNPM_VER:-missing}" >&2
  exit 10
fi

PW_VER="$(node -e "const p=require('playwright/package.json'); process.stdout.write(p.version)")"
if [ "$PW_VER" != "$EXPECTED_PW" ]; then
  echo "HMS_FAIL code=DEPENDENCY_MISMATCH" >&2
  echo "expected playwright ${EXPECTED_PW} got ${PW_VER}" >&2
  exit 10
fi

for path in \
  "$NAVA_ROOT" \
  "${NAVA_ROOT}/shared" \
  "$CHROMIUM_DIR" \
  "$BROWSERS_DIR" \
  "$ARTIFACT_DIR" \
  "$RUNTIME_DIR" \
  "$ROLE_PROOF_DIR"; do
  if [ -L "$path" ]; then
    echo "HMS_FAIL code=ROLE_SCOPE_INVALID" >&2
    exit 10
  fi
done
sudo install -d -o root -g root -m 0755 \
  "$NAVA_ROOT" \
  "${NAVA_ROOT}/shared" \
  "$ROLE_PROOF_DIR"
sudo install -d -o ubuntu -g ubuntu -m 0700 \
  "$CHROMIUM_DIR" \
  "$BROWSERS_DIR" \
  "$ARTIFACT_DIR" \
  "$RUNTIME_DIR"
sudo chown -R ubuntu:ubuntu \
  "$CHROMIUM_DIR" \
  "$BROWSERS_DIR"
sudo chmod -R u+rwX "$CHROMIUM_DIR" "$BROWSERS_DIR"
sudo chown ubuntu:ubuntu \
  "$ARTIFACT_DIR" \
  "$RUNTIME_DIR"
sudo chown root:root "$NAVA_ROOT" "${NAVA_ROOT}/shared"
sudo chmod 755 "$NAVA_ROOT" "${NAVA_ROOT}/shared"
sudo chmod 700 "$ARTIFACT_DIR"
sudo chmod 700 "$RUNTIME_DIR"
if [ -L "${NAVA_ROOT}/shared/hms-shadow-disabled" ]; then
  echo "HMS_FAIL code=ROLE_SCOPE_INVALID" >&2
  exit 10
fi
if [ -e "${NAVA_ROOT}/shared/hms-shadow-disabled" ]; then
  sudo install -o ubuntu -g ubuntu -m 0600 /dev/null \
    "${RUNTIME_DIR}/hms-shadow-disabled"
fi
sudo rm -f \
  "${NAVA_ROOT}/shared/hms-shadow-disabled" \
  "${NAVA_ROOT}/shared/hms-reservation-canary-proof.v1.json" \
  "${NAVA_ROOT}/shared/hms-reservation-shadow-proof.v1.json" \
  "${NAVA_ROOT}/shared/hms-phase-a-gate.v1.json"
sudo chown root:root "$ROLE_PROOF_DIR"
sudo chmod 755 "$ROLE_PROOF_DIR"
if [ -e "$LEGACY_ROLE_PROOF_PATH" ] || [ -L "$LEGACY_ROLE_PROOF_PATH" ]; then
  echo "HMS_FAIL code=ROLE_SCOPE_INVALID" >&2
  echo "refusing app-writable legacy role proof; stage operator proof at ${ROLE_PROOF_PATH}" >&2
  exit 10
fi
if [ -L "$ROLE_PROOF_PATH" ]; then
  echo "HMS_FAIL code=ROLE_SCOPE_INVALID" >&2
  exit 10
fi
if [ -f "$ROLE_PROOF_PATH" ]; then
  ROLE_MODE="$(stat -c '%U:%G:%a' "$ROLE_PROOF_PATH")"
  if [ "$ROLE_MODE" != "root:root:444" ]; then
    echo "HMS_FAIL code=ROLE_SCOPE_INVALID" >&2
    exit 10
  fi
fi

export PLAYWRIGHT_BROWSERS_PATH="$BROWSERS_DIR"

# Pinned chromium only — never bare unscoped `playwright install`.
pnpm exec playwright install chromium

# Resolve the installed revision once from Playwright's public executable path.
if ! EXE="$(node --input-type=module -e \
  "import { chromium } from 'playwright'; process.stdout.write(chromium.executablePath())")"; then
  echo "HMS_FAIL code=DEPENDENCY_MISMATCH" >&2
  exit 10
fi
if [ ! -x "$EXE" ]; then
  echo "HMS_FAIL code=DEPENDENCY_MISMATCH" >&2
  exit 10
fi
REV="$(node -e \
  'const m=process.argv[1].match(/(?:^|[\\/])chromium-(\d+)(?:[\\/]|$)/i); if(!m)process.exit(1); process.stdout.write(m[1])' \
  "$EXE")" || {
  echo "HMS_FAIL code=DEPENDENCY_MISMATCH" >&2
  echo "unable to resolve chromium revision from executable path" >&2
  exit 10
}

if [ "$REV" != "$EXPECTED_REV" ]; then
  echo "HMS_FAIL code=DEPENDENCY_MISMATCH" >&2
  echo "expected chromium revision ${EXPECTED_REV} got ${REV:-unknown}" >&2
  exit 10
fi
case "$EXE" in
  "${BROWSERS_DIR}/chromium-${EXPECTED_REV}/"*) ;;
  *)
    echo "HMS_FAIL code=DEPENDENCY_MISMATCH" >&2
    echo "chromium executable is outside expected browser directory" >&2
    exit 10
    ;;
esac
if [ -L "$EXE" ]; then
  echo "HMS_FAIL code=DEPENDENCY_MISMATCH" >&2
  exit 10
fi
# Stable symlink for HMS_CHROMIUM_EXECUTABLE_PATH
ln -sfn "$EXE" "${CHROMIUM_DIR}/chrome"

# Headless + video smoke — blank page only; no network to hotel.
VIDEO_SMOKE_DIR="$(mktemp -d /tmp/nava-hms-video-smoke.XXXXXX)"
trap 'rm -rf "$VIDEO_SMOKE_DIR"' EXIT
export VIDEO_SMOKE_DIR
node --input-type=module <<EOF
import { stat } from 'node:fs/promises';
import { chromium } from 'playwright';
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_EXE || '${CHROMIUM_DIR}/chrome',
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const context = await browser.newContext({
  recordVideo: {
    dir: process.env.VIDEO_SMOKE_DIR,
    size: { width: 320, height: 240 },
  },
});
const page = await context.newPage();
const video = page.video();
await page.setContent('<html><body>ok</body></html>');
const text = await page.innerText('body');
await new Promise((resolve) => setTimeout(resolve, 1000));
await context.close();
const videoPath = await video?.path();
await browser.close();
if (text.trim() !== 'ok' || !videoPath || (await stat(videoPath)).size <= 0) {
  console.error('HMS_FAIL code=DEPENDENCY_MISMATCH');
  process.exit(10);
}
EOF
if ! command -v unzip >/dev/null 2>&1; then
  echo "HMS_FAIL code=DEPENDENCY_MISMATCH" >&2
  exit 10
fi

# Runtime may execute dependencies but cannot rewrite proof substrate.
sudo chown -R root:root "$CHROMIUM_DIR" "$BROWSERS_DIR"
sudo chmod -R a-w "$CHROMIUM_DIR" "$BROWSERS_DIR"
sudo chmod 0555 "$CHROMIUM_DIR" "$BROWSERS_DIR"

# Persist root-owned dependency stamp for status/canary gates (no secrets).
STAMP_TMP="$(sudo mktemp --tmpdir="${NAVA_ROOT}/shared" .hms-dependency-revision.XXXXXX)"
printf '%s\n' "$DEPENDENCY_REVISION" | sudo tee "$STAMP_TMP" >/dev/null
sudo chown root:root "$STAMP_TMP"
sudo chmod 0444 "$STAMP_TMP"
sudo mv -T "$STAMP_TMP" "${NAVA_ROOT}/shared/hms-dependency-revision.txt"

# Pinned process-replacing asm-exec (PM2 owns Node PID after execvpe).
# Vendor SRC is CRLF-pinned; install strips CR so Linux shebang works.
# Installed bytes are LF — pin separately (tr -d '\r' < vendor/asm-exec | sha256sum).
ASM_EXEC_SRC="${SERVER_PILOT}/deploy/vendor/asm-exec"
ASM_EXEC_PIN="5f0c7f82827fe4eb89db0ba177aec694cd4cbf3acff003b09d1b545ea8595b7f"
ASM_EXEC_INSTALLED_SHA256="81fd29e1f039209282bc8cbe482cda033d331f07284533a46f990368228a7e65"
if [ ! -f "$ASM_EXEC_SRC" ]; then
  echo "HMS_FAIL code=DEPENDENCY_MISMATCH" >&2
  echo "missing vendored asm-exec" >&2
  exit 10
fi
printf '%s  %s\n' "$ASM_EXEC_PIN" "$ASM_EXEC_SRC" | sha256sum -c - >/dev/null || {
  echo "HMS_FAIL code=DEPENDENCY_MISMATCH" >&2
  exit 10
}
ASM_EXEC_TMP="$(sudo mktemp /tmp/asm-exec.XXXXXX)"
tr -d '\r' <"$ASM_EXEC_SRC" | sudo tee "$ASM_EXEC_TMP" >/dev/null
sudo install -o root -g root -m 0755 "$ASM_EXEC_TMP" /usr/local/bin/asm-exec
sudo rm -f "$ASM_EXEC_TMP"
printf '%s  %s\n' "$ASM_EXEC_INSTALLED_SHA256" /usr/local/bin/asm-exec | sha256sum -c - >/dev/null || {
  echo "HMS_FAIL code=DEPENDENCY_MISMATCH" >&2
  exit 10
}
grep -q 'os.execvpe' /usr/local/bin/asm-exec || {
  echo "HMS_FAIL code=DEPENDENCY_MISMATCH" >&2
  exit 10
}

# Durable hourly retention: root-owned code, unprivileged purge process.
NODE_BIN="$(command -v node)"
PURGE_LIB_DIR="/usr/local/lib/nava"
PURGE_RUNNER="${PURGE_LIB_DIR}/hms-artifact-purge.mjs"
PURGE_MODULE="${PURGE_LIB_DIR}/browser-artifacts.mjs"
PURGE_SERVICE="/etc/systemd/system/nava-hms-artifact-purge.service"
PURGE_TIMER="/etc/systemd/system/nava-hms-artifact-purge.timer"
sudo install -d -o root -g root -m 0755 "$PURGE_LIB_DIR"
sudo install -o root -g root -m 0644 \
  "${SERVER_PILOT}/dist/hms/browser-artifacts.js" \
  "$PURGE_MODULE"
sudo tee "$PURGE_RUNNER" >/dev/null <<EOF
import { purgeExpiredHmsBrowserArtifacts } from 'file://${PURGE_MODULE}';
const removed = await purgeExpiredHmsBrowserArtifacts('${ARTIFACT_DIR}');
process.stdout.write(\`HMS_ARTIFACT_PURGE_OK removed=\${removed}\\n\`);
EOF
sudo chown root:root "$PURGE_RUNNER"
sudo chmod 0644 "$PURGE_RUNNER"
sudo tee "$PURGE_SERVICE" >/dev/null <<EOF
[Unit]
Description=Nava HMS credential-grade artifact purge
After=local-fs.target

[Service]
Type=oneshot
User=ubuntu
Group=ubuntu
Environment=HOME=/home/ubuntu
ExecStart=${NODE_BIN} ${PURGE_RUNNER}
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=${ARTIFACT_DIR}
EOF
sudo tee "$PURGE_TIMER" >/dev/null <<'EOF'
[Unit]
Description=Run Nava HMS artifact purge hourly

[Timer]
OnBootSec=5min
OnUnitActiveSec=1h
Persistent=true
Unit=nava-hms-artifact-purge.service

[Install]
WantedBy=timers.target
EOF
sudo chown root:root "$PURGE_SERVICE" "$PURGE_TIMER"
sudo chmod 0644 "$PURGE_SERVICE" "$PURGE_TIMER"
sudo systemctl daemon-reload
sudo systemctl enable --now nava-hms-artifact-purge.timer
sudo systemctl start nava-hms-artifact-purge.service
sudo systemctl is-enabled --quiet nava-hms-artifact-purge.timer
sudo systemctl is-active --quiet nava-hms-artifact-purge.timer

echo "HMS_DEPENDENCIES_OK"
echo "dependencyRevision=${DEPENDENCY_REVISION}"
