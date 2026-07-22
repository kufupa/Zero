#!/usr/bin/env bash
# Shared VPN health checks. HARD fails exit 1; hotel TCP is SOFT unless REQUIRE_HOTEL_PROBE=1.
set -euo pipefail

UNIT="${UNIT:-openvpn-client@nava}"
AWS_REGION="${AWS_REGION:-af-south-1}"
REQUIRE_HOTEL_PROBE="${REQUIRE_HOTEL_PROBE:-0}"

HOSTS=(172.24.0.10 172.24.0.8 172.24.240.41)
PORTS=(25 587 993 443 8080 80)

hard_fail() {
  echo "$1"
  exit 1
}

echo "== vpn-health-assert =="

if ! systemctl is-active --quiet "$UNIT"; then
  hard_fail "VPN_HARD_FAIL_UNIT"
fi

DEFAULT="$(ip -4 route show default | head -n1 || true)"
echo "DEFAULT_ROUTE=$DEFAULT"
if [ -z "$DEFAULT" ] || ! echo "$DEFAULT" | grep -q 'via 172\.31\.0\.1'; then
  hard_fail "VPN_HARD_FAIL_HOST_ROUTE"
fi
if echo "$DEFAULT" | grep -qE 'tun[0-9]+'; then
  hard_fail "VPN_HARD_FAIL_HOST_ROUTE"
fi

if ! ip -4 route | grep -qE '172\.24\.0\.0/16'; then
  hard_fail "VPN_HARD_FAIL_ROUTE_17224"
fi

if ! aws sts get-caller-identity --region "$AWS_REGION" >/tmp/nava-vpn-health-sts.json; then
  hard_fail "VPN_HARD_FAIL_STS"
fi

echo "VPN_HARD_OK"

hotel_ok=0
for h in "${HOSTS[@]}"; do
  for p in "${PORTS[@]}"; do
    if nc -z -w 2 "$h" "$p" 2>/dev/null; then
      hotel_ok=1
      echo "HOTEL_PROBE_OK $h:$p"
      break 2
    fi
  done
done

if [ "$hotel_ok" -eq 1 ]; then
  echo "VPN_HOTEL_OK"
else
  if [ "$REQUIRE_HOTEL_PROBE" = "1" ]; then
    hard_fail "VPN_HARD_FAIL_HOTEL"
  fi
  echo "VPN_SOFT_WARN_HOTEL"
fi

exit 0
