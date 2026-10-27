#!/usr/bin/env bash
# Hourly retention for private quote traces and durable HMS screenshots.
set -euo pipefail

REPO_ROOT="${REPO_ROOT:-/home/ubuntu/repos/zero}"
SERVER_PILOT="${SERVER_PILOT:-${REPO_ROOT}/apps/server-pilot}"
QUOTE_DIR="${REPO_ROOT}/.private/playwright-quote"
SHOTS_DIR="/var/lib/nava/hms-shots"
NODE_BIN="$(command -v node)"
: "${NODE_BIN:?node not on PATH}"

[[ "$REPO_ROOT" == /* && -d "$REPO_ROOT" && ! -L "$REPO_ROOT" ]] || {
  echo "unsafe repository root; refusing timer installation" >&2
  exit 1
}
for path in "${REPO_ROOT}/.private" "$QUOTE_DIR" /var/lib/nava "$SHOTS_DIR"; do
  if [[ -L "$path" ]]; then
    echo "unsafe retention path; refusing timer installation" >&2
    exit 1
  fi
done

sudo install -d -o root -g root -m 0755 /var/lib/nava
sudo install -d -o ubuntu -g ubuntu -m 0700 "$QUOTE_DIR" "$SHOTS_DIR"
PURGE_LIB_DIR="/usr/local/lib/nava"
PURGE_MODULE="${PURGE_LIB_DIR}/playwright-quote-purge.mjs"
PURGE_RUNNER="${PURGE_LIB_DIR}/playwright-quote-purge-run.mjs"
PURGE_SOURCE="${SERVER_PILOT}/dist/ops/playwright-quote-purge.js"
PURGE_SERVICE="/etc/systemd/system/nava-playwright-quote-purge.service"
PURGE_TIMER="/etc/systemd/system/nava-playwright-quote-purge.timer"

[[ -f "$PURGE_SOURCE" && ! -L "$PURGE_SOURCE" ]] || {
  echo "compiled disk retention module is missing; refusing timer installation" >&2
  exit 1
}
sudo install -d -o root -g root -m 0755 "$PURGE_LIB_DIR"
sudo install -o root -g root -m 0644 "$PURGE_SOURCE" "$PURGE_MODULE"
sudo tee "$PURGE_RUNNER" >/dev/null <<'EOF'
import {
  purgeExpiredHmsShots,
  purgeExpiredPlaywrightQuoteZips,
  readDiskUsedPercent,
} from 'file:///usr/local/lib/nava/playwright-quote-purge.mjs';

const usedPercent = await readDiskUsedPercent('/');
const quoteRoot = process.env.NAVA_QUOTE_DIR;
const shotsRoot = process.env.NAVA_SHOTS_DIR;
if (!quoteRoot || !shotsRoot) throw new Error('Retention directories are not configured.');
const [traces, screenshots] = await Promise.all([
  purgeExpiredPlaywrightQuoteZips(quoteRoot),
  purgeExpiredHmsShots(shotsRoot),
]);
const disk = usedPercent === null ? 'unknown' : String(Math.ceil(usedPercent));
const pressure = usedPercent !== null && usedPercent >= 75 ? 1 : 0;
process.stdout.write(
  `NAVA_DISK_PURGE_OK disk_used_percent=${disk} trace_pressure=${pressure} trace_zips_removed=${traces.removed} trace_bytes_removed=${traces.bytes} screenshots_removed=${screenshots.removed} screenshot_bytes_removed=${screenshots.bytes}\n`,
);
EOF
sudo chown root:root "$PURGE_RUNNER"
sudo chmod 0644 "$PURGE_RUNNER"
sudo tee "$PURGE_SERVICE" >/dev/null <<EOF
[Unit]
Description=Nava quote trace and HMS screenshot retention
After=local-fs.target

[Service]
Type=oneshot
User=ubuntu
Group=ubuntu
Environment=HOME=/home/ubuntu
Environment=NAVA_QUOTE_DIR=${QUOTE_DIR}
Environment=NAVA_SHOTS_DIR=${SHOTS_DIR}
ExecStartPre=/usr/bin/df -P /
ExecStart=${NODE_BIN} ${PURGE_RUNNER}
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=${QUOTE_DIR} ${SHOTS_DIR}
StandardOutput=journal
StandardError=journal
EOF
sudo tee "$PURGE_TIMER" >/dev/null <<'EOF'
[Unit]
Description=Run Nava quote trace and HMS screenshot retention hourly

[Timer]
OnBootSec=5min
OnUnitActiveSec=1h
Persistent=true
Unit=nava-playwright-quote-purge.service

[Install]
WantedBy=timers.target
EOF
sudo chown root:root "$PURGE_SERVICE" "$PURGE_TIMER"
sudo chmod 0644 "$PURGE_SERVICE" "$PURGE_TIMER"
sudo systemctl daemon-reload
sudo systemctl enable --now nava-playwright-quote-purge.timer
sudo systemctl start nava-playwright-quote-purge.service
sudo systemctl is-enabled --quiet nava-playwright-quote-purge.timer
sudo systemctl is-active --quiet nava-playwright-quote-purge.timer
echo NAVA_DISK_RETENTION_TIMER_OK
