#!/usr/bin/env bash
# Idempotent PM2 systemd startup for ubuntu + nava post-boot smoke unit.
# Run as ubuntu with nvm/node/pm2 on PATH (deploy-ec2.sh already sets PATH).
set -euo pipefail

REPO_ROOT="${REPO_ROOT:-/home/ubuntu/repos/zero}"
SERVER_PILOT="${REPO_ROOT}/apps/server-pilot"
UNIT_SRC="${SERVER_PILOT}/deploy/nava-post-boot-smoke.service"
UNIT_DST="/etc/systemd/system/nava-post-boot-smoke.service"
PM2_UNIT="/etc/systemd/system/pm2-ubuntu.service"

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

if [ ! -f "$PM2_UNIT" ]; then
  echo "== pm2-startup: installing systemd unit =="
  # Capture the sudo line pm2 prints; quote PATH for spaces safety.
  STARTUP_OUT="$(pm2 startup systemd -u ubuntu --hp /home/ubuntu 2>&1 || true)"
  echo "$STARTUP_OUT"
  SUDO_LINE="$(printf '%s\n' "$STARTUP_OUT" | grep -E '^sudo ' | tail -1 || true)"
  if [ -n "$SUDO_LINE" ]; then
    # Ensure PATH= value is quoted if pm2 emitted unquoted form with spaces risk
    eval "$SUDO_LINE"
  elif [ ! -f "$PM2_UNIT" ]; then
    echo "pm2-startup: failed to install pm2-ubuntu.service" >&2
    exit 1
  fi
else
  echo "== pm2-startup: pm2-ubuntu.service already present =="
fi

pm2 save

if [ -f "$UNIT_SRC" ]; then
  echo "== pm2-startup: install nava-post-boot-smoke.service =="
  sudo cp "$UNIT_SRC" "$UNIT_DST"
  sudo systemctl daemon-reload
  sudo systemctl enable nava-post-boot-smoke.service
fi

echo "pm2-startup ok"
