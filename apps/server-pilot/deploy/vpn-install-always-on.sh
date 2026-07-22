#!/usr/bin/env bash
# Promote staged VPN profile → /etc/openvpn/client/ + enable openvpn-client@nava.
# Requires CONFIDENCE_PASS in /tmp/nava-vpn-confidence.status (or FORCE_INSTALL=1).
# On post-enable HOST_ROUTE fail → disable immediately.
set -euo pipefail

VPN_DIR="${VPN_DIR:-/run/nava-vpn}"
CLIENT_DIR="/etc/openvpn/client/nava"
CONF="/etc/openvpn/client/nava.conf"
STATUS_FILE="/tmp/nava-vpn-confidence.status"
UNIT="openvpn-client@nava"
LOG="/tmp/nava-vpn-install.log"
POST_STATUS="/tmp/nava-vpn-always-on.status"

HOSTS=(172.24.0.10 172.24.0.8 172.24.240.41)
PORTS=(25 587 993 443 8080 80)

if [ "$(id -u)" -ne 0 ]; then
  exec sudo -E bash "$0" "$@"
fi

: >"$LOG"
: >"$POST_STATUS"
exec > >(tee -a "$LOG") 2>&1

echo "== nava-vpn-install-always-on start =="
date -u +%Y-%m-%dT%H:%M:%SZ
hostname

fail() {
  local code="$1"
  local tag="$2"
  echo "FAIL $tag"
  echo "$tag" >"$POST_STATUS"
  exit "$code"
}

if [ "${FORCE_INSTALL:-0}" != "1" ]; then
  if [ ! -f "$STATUS_FILE" ] || ! grep -qx 'CONFIDENCE_PASS' "$STATUS_FILE"; then
    fail 2 "INSTALL_FAIL_NO_CONFIDENCE_PASS"
  fi
fi

for f in nava-auth.txt Nava-tls.key ca.crt client.crt client.key; do
  [ -f "$VPN_DIR/$f" ] || fail 3 "INSTALL_FAIL_MISSING_$f"
done

DEFAULT_BEFORE="$(ip -4 route show default | head -n1 || true)"
echo "DEFAULT_BEFORE=$DEFAULT_BEFORE"
[ -n "$DEFAULT_BEFORE" ] || fail 4 "INSTALL_FAIL_NO_DEFAULT"

RESOLV_BEFORE="$(sha256sum /etc/resolv.conf | awk '{print $1}')"
echo "RESOLV_BEFORE=$RESOLV_BEFORE"

echo "== install durable files =="
mkdir -p "$CLIENT_DIR"
chmod 700 "$CLIENT_DIR"
cp -f "$VPN_DIR/nava-auth.txt" "$CLIENT_DIR/nava-auth.txt"
cp -f "$VPN_DIR/Nava-tls.key" "$CLIENT_DIR/Nava-tls.key"
cp -f "$VPN_DIR/ca.crt" "$CLIENT_DIR/ca.crt"
cp -f "$VPN_DIR/client.crt" "$CLIENT_DIR/client.crt"
cp -f "$VPN_DIR/client.key" "$CLIENT_DIR/client.key"
# strip CRLF
tr -d '\r' <"$CLIENT_DIR/nava-auth.txt" >"$CLIENT_DIR/nava-auth.txt.lf"
mv "$CLIENT_DIR/nava-auth.txt.lf" "$CLIENT_DIR/nava-auth.txt"

{
  echo "dev tun"
  echo "persist-tun"
  echo "persist-key"
  echo "cipher AES-256-CBC"
  echo "data-ciphers AES-256-CBC:AES-256-GCM:AES-128-GCM:CHACHA20-POLY1305"
  echo "auth SHA256"
  echo "tls-client"
  echo "nobind"
  echo "client"
  echo "resolv-retry infinite"
  echo "remote 41.193.164.148 1203 udp"
  echo "auth-user-pass $CLIENT_DIR/nava-auth.txt"
  echo "ca $CLIENT_DIR/ca.crt"
  echo "cert $CLIENT_DIR/client.crt"
  echo "key $CLIENT_DIR/client.key"
  echo "tls-auth $CLIENT_DIR/Nava-tls.key 1"
  echo "remote-cert-tls server"
  echo "explicit-exit-notify"
  echo ""
  echo "# --- nava always-on safety ---"
  echo 'pull-filter ignore "redirect-gateway"'
  echo 'pull-filter ignore "dhcp-option DNS"'
  echo 'pull-filter ignore "dhcp-option DOMAIN"'
  echo "route 172.24.0.0 255.255.0.0"
  echo "script-security 1"
  echo "auth-nocache"
} >"$CONF"

grep -q 'pull-filter ignore "redirect-gateway"' "$CONF" \
  || fail 5 "INSTALL_FAIL_OVPN_NO_PULL_FILTER"

chmod 600 "$CLIENT_DIR"/* "$CONF"
chown root:root "$CLIENT_DIR"/* "$CONF"

disable_now() {
  echo "== emergency disable =="
  systemctl disable --now "$UNIT" 2>/dev/null || true
  echo "DISABLED_OK"
}

echo "== enable $UNIT =="
systemctl daemon-reload
systemctl enable "$UNIT"
systemctl restart "$UNIT"

# Wait for active + tun
ACTIVE_OK=0
for i in $(seq 1 60); do
  if systemctl is-active --quiet "$UNIT" \
    && { ip -4 link show type tun 2>/dev/null | grep -q . \
      || ip -4 route | grep -q '172\.24\.0\.0/16'; }; then
    ACTIVE_OK=1
    echo "UNIT_UP after ${i}s"
    break
  fi
  sleep 1
done

if [ "$ACTIVE_OK" -eq 0 ]; then
  systemctl status "$UNIT" --no-pager -l || true
  journalctl -u "$UNIT" -n 40 --no-pager || true
  disable_now
  fail 6 "INSTALL_FAIL_UNIT_NOT_UP"
fi

assert_host_route() {
  local now
  now="$(ip -4 route show default | head -n1 || true)"
  if [ "$now" != "$DEFAULT_BEFORE" ]; then
    echo "HOST_ROUTE_CHANGED before='$DEFAULT_BEFORE' after='$now'"
    return 1
  fi
  echo "HOST_ROUTE_OK"
  return 0
}

assert_resolv() {
  local now
  now="$(sha256sum /etc/resolv.conf | awk '{print $1}')"
  if [ "$now" != "$RESOLV_BEFORE" ]; then
    echo "RESOLV_CHANGED before='$RESOLV_BEFORE' after='$now'"
    return 1
  fi
  echo "RESOLV_OK"
  return 0
}

if ! assert_host_route; then
  disable_now
  fail 7 "INSTALL_FAIL_HOST_ROUTE"
fi
if ! assert_resolv; then
  disable_now
  fail 9 "INSTALL_FAIL_RESOLV"
fi

echo "== aws sts =="
aws sts get-caller-identity --region "${AWS_REGION:-af-south-1}" | tee /tmp/nava-vpn-sts-always-on.json
echo "STS_OK"

PROBE_OK=0
echo "== hotel TCP probes =="
for host in "${HOSTS[@]}"; do
  for port in "${PORTS[@]}"; do
    if timeout 3 nc -z -w 2 "$host" "$port" 2>/dev/null; then
      echo "PROBE_OK $host:$port"
      PROBE_OK=1
    fi
  done
done

if [ "$PROBE_OK" -ne 1 ]; then
  echo "WARN no hotel TCP after enable — route check"
  if ! ip -4 route | grep -qE '172\.24\.0\.0/16|172\.24\.'; then
    disable_now
    fail 8 "INSTALL_FAIL_NO_HOTEL"
  fi
  echo "ROUTE_17224_OK (probe soft)"
fi

echo "== reconnect gate =="
systemctl restart "$UNIT"
sleep 3
ACTIVE_OK=0
for i in $(seq 1 60); do
  if systemctl is-active --quiet "$UNIT" \
    && { ip -4 link show type tun 2>/dev/null | grep -q . \
      || ip -4 route | grep -q '172\.24\.0\.0/16'; }; then
    ACTIVE_OK=1
    echo "UNIT_UP_AFTER_RESTART after ${i}s"
    break
  fi
  sleep 1
done
if [ "$ACTIVE_OK" -eq 0 ]; then
  disable_now
  fail 6 "INSTALL_FAIL_RECONNECT"
fi
if ! assert_host_route; then
  disable_now
  fail 7 "INSTALL_FAIL_HOST_ROUTE_AFTER_RECONNECT"
fi
if ! assert_resolv; then
  disable_now
  fail 9 "INSTALL_FAIL_RESOLV_AFTER_RECONNECT"
fi
echo "RECONNECT_OK"

# Wipe ephemeral stage (durable copy remains)
rm -rf /run/nava-vpn
mkdir -p /run/nava-vpn
chmod 700 /run/nava-vpn
echo "WIPED_EPHEMERAL_STAGED"

systemctl is-enabled "$UNIT"
systemctl is-active "$UNIT"
echo "ALWAYS_ON_OK"
echo "ALWAYS_ON_OK" >"$POST_STATUS"
exit 0
