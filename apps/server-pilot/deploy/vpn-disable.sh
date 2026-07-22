#!/usr/bin/env bash
# Disable always-on hotel OpenVPN client. Optional: WIPE_CLIENT=1 removes durable files.
set -euo pipefail

UNIT="openvpn-client@nava"
CLIENT_DIR="/etc/openvpn/client/nava"
CONF="/etc/openvpn/client/nava.conf"

if [ "$(id -u)" -ne 0 ]; then
  exec sudo -E bash "$0" "$@"
fi

echo "== nava-vpn-disable =="
date -u +%Y-%m-%dT%H:%M:%SZ

systemctl disable --now "$UNIT" 2>/dev/null || true
# Also kill any stray openvpn from smoke/confidence
pkill -x openvpn 2>/dev/null || true
sleep 1
pkill -9 -x openvpn 2>/dev/null || true

if [ "${WIPE_CLIENT:-0}" = "1" ]; then
  rm -rf "$CLIENT_DIR"
  rm -f "$CONF"
  echo "WIPED_CLIENT"
fi

echo "DEFAULT_ROUTE=$(ip -4 route show default | head -n1 || true)"
echo "DISABLE_OK"
