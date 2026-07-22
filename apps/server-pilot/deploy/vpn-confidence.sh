#!/usr/bin/env bash
# SSM-safe VPN confidence gate (route + resolv + STS + hotel + reconnect).
# Requires: /run/nava-vpn staged. On PASS leaves staged for vpn-install-always-on.sh.
# Does NOT enable systemd.
set -euo pipefail

VPN_DIR="${VPN_DIR:-/run/nava-vpn}"
OVPN="${VPN_DIR}/Nava.smoke.ovpn"
LOG="/tmp/nava-vpn-confidence.log"
STATUS_FILE="/tmp/nava-vpn-confidence.status"
CONFIDENCE_SECONDS="${CONFIDENCE_SECONDS:-180}"
# On PASS keep /run for promote; on FAIL always wipe.
KEEP_STAGED_ON_PASS="${KEEP_STAGED_ON_PASS:-1}"

HOSTS=(172.24.0.10 172.24.0.8 172.24.240.41)
PORTS=(25 587 993 443 8080 80)

if [ "$(id -u)" -ne 0 ]; then
  exec sudo -E bash "$0" "$@"
fi

: >"$LOG"
: >"$STATUS_FILE"
exec > >(tee -a "$LOG") 2>&1

echo "== nava-vpn-confidence start =="
date -u +%Y-%m-%dT%H:%M:%SZ
hostname

PASS=0
OVPN_PID=""

cleanup() {
  echo "== cleanup =="
  if [ -n "${OVPN_PID:-}" ]; then
    kill "$OVPN_PID" 2>/dev/null || true
    wait "$OVPN_PID" 2>/dev/null || true
  fi
  pkill -x openvpn 2>/dev/null || true
  sleep 1
  pkill -9 -x openvpn 2>/dev/null || true
  if [ "$PASS" -eq 1 ] && [ "$KEEP_STAGED_ON_PASS" -eq 1 ]; then
    echo "KEEP_STAGED /run/nava-vpn (promote next)"
  else
    rm -rf /run/nava-vpn
    mkdir -p /run/nava-vpn
    chmod 700 /run/nava-vpn
    echo "WIPED_STAGED"
  fi
  echo "CLEANUP_OK"
}
trap cleanup EXIT

fail() {
  local code="$1"
  local tag="$2"
  echo "FAIL $tag"
  echo "$tag" >"$STATUS_FILE"
  exit "$code"
}

if [ ! -f "$OVPN" ]; then
  fail 2 "CONFIDENCE_FAIL_MISSING_PROFILE"
fi

grep -q 'pull-filter ignore "redirect-gateway"' "$OVPN" \
  || fail 3 "CONFIDENCE_FAIL_OVPN"

DEFAULT_BEFORE="$(ip -4 route show default | head -n1 || true)"
echo "DEFAULT_BEFORE=$DEFAULT_BEFORE"
[ -n "$DEFAULT_BEFORE" ] || fail 4 "CONFIDENCE_FAIL_NO_DEFAULT"

RESOLV_BEFORE="$(sha256sum /etc/resolv.conf | awk '{print $1}')"
echo "RESOLV_BEFORE=$RESOLV_BEFORE"

cd "$VPN_DIR"
if [ -f nava-auth.txt ]; then
  tr -d '\r' <nava-auth.txt >nava-auth.txt.lf
  mv nava-auth.txt.lf nava-auth.txt
  chmod 600 nava-auth.txt
fi
tr -d '\r' <"$OVPN" >"${OVPN}.lf"
mv "${OVPN}.lf" "$OVPN"

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

wait_tun() {
  local pid="$1"
  local i
  for i in $(seq 1 60); do
    if ! kill -0 "$pid" 2>/dev/null; then
      return 1
    fi
    if ip -4 link show type tun 2>/dev/null | grep -q . \
      || ip addr show 2>/dev/null | grep -q 'tun[0-9]'; then
      echo "TUN_UP after ${i}s"
      return 0
    fi
    if ip -4 route | grep -q '172\.24\.0\.0/16'; then
      echo "ROUTE_17224_SEEN after ${i}s"
      return 0
    fi
    sleep 1
  done
  return 1
}

start_openvpn() {
  echo "== start openvpn (timeout ${CONFIDENCE_SECONDS}s) =="
  timeout --signal=TERM --kill-after=15 "$CONFIDENCE_SECONDS" \
    openvpn --config "$OVPN" --verb 3 &
  OVPN_PID=$!
  if ! wait_tun "$OVPN_PID"; then
    echo "FAIL no tun/route or openvpn exited"
    wait "$OVPN_PID" 2>/dev/null || true
    return 1
  fi
  return 0
}

stop_openvpn() {
  if [ -n "${OVPN_PID:-}" ]; then
    kill "$OVPN_PID" 2>/dev/null || true
    wait "$OVPN_PID" 2>/dev/null || true
    OVPN_PID=""
  fi
  pkill -x openvpn 2>/dev/null || true
  sleep 1
  pkill -9 -x openvpn 2>/dev/null || true
}

probe_hotel() {
  local host port any=0
  echo "== hotel TCP probes =="
  for host in "${HOSTS[@]}"; do
    local host_ok=0
    for port in "${PORTS[@]}"; do
      if timeout 3 nc -z -w 2 "$host" "$port" 2>/dev/null; then
        echo "PROBE_OK $host:$port"
        host_ok=1
        any=1
      fi
    done
    if [ "$host_ok" -eq 0 ]; then
      echo "PROBE_NONE $host (ports tried: ${PORTS[*]})"
    fi
  done
  return $((1 - any))
}

echo "mode=host-pull-filter confidence"
start_openvpn || fail 5 "CONFIDENCE_FAIL_CONNECT"

assert_host_route || fail 7 "CONFIDENCE_FAIL_HOST_ROUTE"
assert_resolv || fail 9 "CONFIDENCE_FAIL_RESOLV"

echo "== aws sts =="
aws sts get-caller-identity --region "${AWS_REGION:-af-south-1}" | tee /tmp/nava-vpn-sts.json
echo "STS_OK"

echo "== routes =="
ip -4 route | tee /tmp/nava-vpn-routes.txt
ROUTE_17224_OK=0
if ip -4 route | grep -qE '172\.24\.0\.0/16|172\.24\.'; then
  ROUTE_17224_OK=1
  echo "ROUTE_17224_OK"
else
  echo "ROUTE_17224_MISSING"
fi

PROBE_OK=0
if probe_hotel; then
  PROBE_OK=1
fi

assert_host_route || fail 7 "CONFIDENCE_FAIL_HOST_ROUTE"
assert_resolv || fail 9 "CONFIDENCE_FAIL_RESOLV"

if [ "$PROBE_OK" -ne 1 ] && [ "$ROUTE_17224_OK" -ne 1 ]; then
  fail 8 "CONFIDENCE_FAIL_NO_HOTEL_REACH"
fi

echo "== reconnect =="
stop_openvpn
sleep 2
start_openvpn || fail 5 "CONFIDENCE_FAIL_RECONNECT_CONNECT"
assert_host_route || fail 7 "CONFIDENCE_FAIL_HOST_ROUTE_AFTER_RECONNECT"
assert_resolv || fail 9 "CONFIDENCE_FAIL_RESOLV_AFTER_RECONNECT"
echo "RECONNECT_OK"

# Leave tunnel up briefly so install can see live state; stop before exit for clean promote
stop_openvpn

PASS=1
echo "CONFIDENCE_PASS"
echo "CONFIDENCE_PASS" >"$STATUS_FILE"
exit 0
