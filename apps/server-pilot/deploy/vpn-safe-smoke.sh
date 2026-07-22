#!/usr/bin/env bash
# SSM-safe ephemeral OpenVPN smoke (≤300s). Run on EC2 as root (or ubuntu+sudo).
# Requires: /run/nava-vpn staged; prefer prior vpn-ec2-preflight.sh.
set -euo pipefail

VPN_DIR="${VPN_DIR:-/run/nava-vpn}"
PREFLIGHT_ENV="${PREFLIGHT_ENV:-/tmp/nava-vpn-preflight.env}"
SMOKE_SECONDS="${SMOKE_SECONDS:-300}"
OVPN="${VPN_DIR}/Nava.smoke.ovpn"
LOG="/tmp/nava-vpn-smoke.log"
STATUS_FILE="/tmp/nava-vpn-smoke.status"

HOSTS=(172.24.0.10 172.24.0.8 172.24.240.41)
PORTS=(25 587 993 443 8080 80)

if [ "$(id -u)" -ne 0 ]; then
  exec sudo -E bash "$0" "$@"
fi

: >"$LOG"
: >"$STATUS_FILE"
exec > >(tee -a "$LOG") 2>&1

echo "== nava-vpn-safe-smoke start =="
date -u +%Y-%m-%dT%H:%M:%SZ
hostname

cleanup() {
  echo "== cleanup =="
  pkill -x openvpn 2>/dev/null || true
  sleep 1
  pkill -9 -x openvpn 2>/dev/null || true
  rm -rf /run/nava-vpn
  mkdir -p /run/nava-vpn
  chmod 700 /run/nava-vpn
  echo "CLEANUP_OK"
}
trap cleanup EXIT

if [ ! -f "$OVPN" ]; then
  echo "FAIL missing $OVPN — run vpn-stage-to-ec2.sh first"
  echo "SMOKE_FAIL_MISSING_PROFILE" | tee "$STATUS_FILE"
  exit 2
fi

if [ -f "$PREFLIGHT_ENV" ]; then
  # shellcheck disable=SC1090
  source "$PREFLIGHT_ENV"
  echo "preflight HAS_NETNS=${HAS_NETNS:-?} HAS_NS_HELPER=${HAS_NS_HELPER:-?}"
else
  echo "WARN no $PREFLIGHT_ENV — pull-filter-only"
  HAS_NETNS=0
  HAS_NS_HELPER=0
fi

# Safety assert on staged ovpn
grep -q 'pull-filter ignore "redirect-gateway"' "$OVPN" \
  || { echo "FAIL ovpn missing pull-filter"; echo "SMOKE_FAIL_OVPN" >"$STATUS_FILE"; exit 3; }

DEFAULT_BEFORE="$(ip -4 route show default | head -n1 || true)"
echo "DEFAULT_BEFORE=$DEFAULT_BEFORE"
if [ -z "$DEFAULT_BEFORE" ]; then
  echo "FAIL no host default route before VPN"
  echo "SMOKE_FAIL_NO_DEFAULT" >"$STATUS_FILE"
  exit 4
fi

cd "$VPN_DIR"

# Host + pull-filter only for this smoke. Native --netns would put routes in
# another namespace and host nc probes would miss hotel LAN (false FAIL).
# Preflight still records HAS_NETNS for a later always-on design.
echo "mode=host-pull-filter (HAS_NETNS=${HAS_NETNS:-0} HAS_NS_HELPER=${HAS_NS_HELPER:-0} noted)"
OPENVPN_CMD=(openvpn --config "$OVPN" --verb 3)

echo "== start openvpn (timeout ${SMOKE_SECONDS}s) =="
timeout --signal=TERM --kill-after=15 "$SMOKE_SECONDS" \
  "${OPENVPN_CMD[@]}" &
OVPN_PID=$!

# Wait for tun or fail early
TUN_OK=0
for i in $(seq 1 60); do
  if ! kill -0 "$OVPN_PID" 2>/dev/null; then
    echo "FAIL openvpn exited early"
    wait "$OVPN_PID" || true
    echo "SMOKE_FAIL_CONNECT" >"$STATUS_FILE"
    exit 5
  fi
  if ip -4 link show type tun 2>/dev/null | grep -q . \
    || ip addr show 2>/dev/null | grep -q 'tun[0-9]'; then
    TUN_OK=1
    echo "TUN_UP after ${i}s"
    break
  fi
  # Also accept route appearance
  if ip -4 route | grep -q '172\.24\.0\.0/16'; then
    TUN_OK=1
    echo "ROUTE_17224_SEEN after ${i}s"
    break
  fi
  sleep 1
done

if [ "$TUN_OK" -eq 0 ]; then
  echo "FAIL no tun/route within 60s — check allowlist / auth / P12"
  tail -n 80 "$LOG" || true
  # dump openvpn child log if any
  echo "SMOKE_FAIL_NO_TUN" >"$STATUS_FILE"
  kill "$OVPN_PID" 2>/dev/null || true
  exit 6
fi

assert_host_route() {
  local now
  now="$(ip -4 route show default | head -n1 || true)"
  if [ "$now" != "$DEFAULT_BEFORE" ]; then
    echo "HOST_ROUTE_CHANGED before='$DEFAULT_BEFORE' after='$now'"
    echo "SMOKE_FAIL_HOST_ROUTE" >"$STATUS_FILE"
    kill "$OVPN_PID" 2>/dev/null || true
    return 1
  fi
  echo "HOST_ROUTE_OK"
  return 0
}

assert_host_route || exit 7

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

echo "== hotel TCP probes =="
PROBE_OK=0
for host in "${HOSTS[@]}"; do
  for port in "${PORTS[@]}"; do
    if timeout 3 nc -z -w 2 "$host" "$port" 2>/dev/null; then
      echo "PROBE_OK $host:$port"
      PROBE_OK=1
    fi
  done
  # one best-effort any-port summary line
  if [ "$PROBE_OK" -eq 0 ]; then
    echo "PROBE_NONE $host (ports tried: ${PORTS[*]})"
  fi
done

assert_host_route || exit 7

PASS=0
if [ "$PROBE_OK" -eq 1 ] || [ "$ROUTE_17224_OK" -eq 1 ]; then
  PASS=1
fi

# Stop openvpn before trap (trap still wipes secrets)
kill "$OVPN_PID" 2>/dev/null || true
wait "$OVPN_PID" 2>/dev/null || true

if [ "$PASS" -eq 1 ]; then
  echo "SMOKE_PASS"
  echo "SMOKE_PASS" >"$STATUS_FILE"
  exit 0
fi

echo "SMOKE_FAIL_NO_HOTEL_REACH"
echo "SMOKE_FAIL_NO_HOTEL_REACH" >"$STATUS_FILE"
exit 8
