#!/usr/bin/env bash
# EC2 OpenVPN inventory + install gaps. Run via SSM as ubuntu (uses sudo).
# Writes /tmp/nava-vpn-preflight.env for vpn-safe-smoke.sh.
set -euo pipefail

PREFLIGHT_ENV="${PREFLIGHT_ENV:-/tmp/nava-vpn-preflight.env}"
NS_HELPER_DST="/usr/local/bin/namespaced-openvpn"
NS_HELPER_URL="${NS_HELPER_URL:-https://raw.githubusercontent.com/slingamn/namespaced-openvpn/master/namespaced-openvpn}"

echo "== nava-vpn-preflight start =="
hostname
whoami
date -u +%Y-%m-%dT%H:%M:%SZ

echo "== apt install (openvpn iproute2 netcat-openbsd dnsutils) =="
sudo apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y \
  openvpn iproute2 netcat-openbsd dnsutils coreutils curl ca-certificates

echo "== openvpn version =="
openvpn --version | head -n 3

HAS_NETNS=0
if openvpn --help 2>&1 | grep -qi netns; then
  HAS_NETNS=1
  echo "HAS_NATIVE_NETNS=1"
else
  echo "NO_NATIVE_NETNS"
fi

echo "== ip / nc / timeout =="
ip -V
command -v nc
command -v timeout
command -v curl

echo "== host default route =="
ip -4 route show default || true

HAS_NS_HELPER=0
if [ "$HAS_NETNS" -eq 0 ]; then
  echo "== namespaced-openvpn helper =="
  if [ -x "$NS_HELPER_DST" ]; then
    HAS_NS_HELPER=1
    echo "helper already at $NS_HELPER_DST"
  else
    # Prefer pull-filter path; helper is best-effort (network may block raw.githubusercontent).
    if sudo curl -fsSL --connect-timeout 15 --max-time 60 \
      "$NS_HELPER_URL" -o "$NS_HELPER_DST"; then
      sudo chmod 755 "$NS_HELPER_DST"
      HAS_NS_HELPER=1
      echo "installed $NS_HELPER_DST"
    else
      echo "NETNS_HELPER=none (curl failed — pull-filter-only is OK)"
      HAS_NS_HELPER=0
    fi
  fi
else
  echo "native --netns present; skip helper install"
fi

umask 077
cat >"$PREFLIGHT_ENV" <<EOF
HAS_NETNS=$HAS_NETNS
HAS_NS_HELPER=$HAS_NS_HELPER
PREFLIGHT_TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF
chmod 644 "$PREFLIGHT_ENV"

echo "== wrote $PREFLIGHT_ENV =="
cat "$PREFLIGHT_ENV"
echo "PREFLIGHT_OK"
echo "== nava-vpn-preflight done =="
