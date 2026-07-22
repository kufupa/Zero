#!/usr/bin/env bash
# Laptop → S3 stage of hotel OpenVPN profile (no secrets in git).
# Then SSM sync on EC2 into /run/nava-vpn.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
VPN_DIR="${VPN_DIR:-$REPO_ROOT/live real data connection}"

: "${AWS_REGION:=af-south-1}"
: "${INSTANCE_ID:=i-008f737974a9ba9b3}"
: "${BOOTSTRAP_BUCKET:=nava-zero-bootstrap-845242190536}"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
S3_PREFIX="s3://${BOOTSTRAP_BUCKET}/vpn-nava/${STAMP}"
STAGE_TMP="$(mktemp -d "${TMPDIR:-/tmp}/nava-vpn-stage.XXXXXX")"
cleanup_local() { rm -rf "$STAGE_TMP"; }
trap cleanup_local EXIT

need() {
  local f="$1"
  if [ ! -f "$VPN_DIR/$f" ]; then
    echo "missing: $VPN_DIR/$f" >&2
    exit 2
  fi
}

need Nava.p12
need Nava-tls.key
need nava-auth.txt
need Nava.ovpn

if grep -q 'REPLACE_WITH_OPENVPN' "$VPN_DIR/nava-auth.txt"; then
  echo "nava-auth.txt still has placeholders — fill username/password first" >&2
  exit 2
fi

# Generate smoke ovpn: safety directives, no askpass (P12 attempt 1 = empty passphrase).
{
  grep -vE '^(askpass|# P12 passphrase|# Creds:)' "$VPN_DIR/Nava.ovpn" || true
  echo ""
  echo "# --- nava smoke safety (generated; do not commit secrets) ---"
  echo 'pull-filter ignore "redirect-gateway"'
  echo 'pull-filter ignore "dhcp-option DNS"'
  echo 'pull-filter ignore "dhcp-option DOMAIN"'
  echo "route 172.24.0.0 255.255.0.0"
  echo "script-security 1"
  echo "auth-nocache"
} >"$STAGE_TMP/Nava.smoke.ovpn"

# Self-check (laptop, no network)
grep -q 'pull-filter ignore "redirect-gateway"' "$STAGE_TMP/Nava.smoke.ovpn" \
  || { echo "generated ovpn missing pull-filter" >&2; exit 3; }
grep -q 'route 172.24.0.0 255.255.0.0' "$STAGE_TMP/Nava.smoke.ovpn" \
  || { echo "generated ovpn missing 172.24 route" >&2; exit 3; }
grep -qE '^askpass' "$STAGE_TMP/Nava.smoke.ovpn" \
  && { echo "generated ovpn still has askpass — refuse" >&2; exit 3; }

cp "$VPN_DIR/Nava.p12" "$STAGE_TMP/"
cp "$VPN_DIR/Nava-tls.key" "$STAGE_TMP/"
cp "$VPN_DIR/nava-auth.txt" "$STAGE_TMP/"
# Normalize line endings for Linux openvpn
if command -v sed >/dev/null 2>&1; then
  sed -i 's/\r$//' "$STAGE_TMP/nava-auth.txt" "$STAGE_TMP/Nava.smoke.ovpn" 2>/dev/null \
    || sed -i.bak 's/\r$//' "$STAGE_TMP/nava-auth.txt" "$STAGE_TMP/Nava.smoke.ovpn"
fi

chmod 600 "$STAGE_TMP"/*

echo "== upload $S3_PREFIX =="
aws s3 sync "$STAGE_TMP/" "$S3_PREFIX/" \
  --region "$AWS_REGION" \
  --only-show-errors

echo "$S3_PREFIX" >"$STAGE_TMP/../nava-vpn-last-s3-prefix.txt" 2>/dev/null || true
echo "$S3_PREFIX" >"${TMPDIR:-/tmp}/nava-vpn-last-s3-prefix.txt"

echo "== SSM sync into /run/nava-vpn =="
# shellcheck disable=SC2016
SYNC_CMD=$(cat <<EOF
set -euo pipefail
S3_PREFIX='$S3_PREFIX'
AWS_REGION='$AWS_REGION'
sudo mkdir -p /run/nava-vpn
sudo chmod 700 /run/nava-vpn
sudo rm -rf /run/nava-vpn/*
sudo aws s3 sync "\$S3_PREFIX/" /run/nava-vpn/ --region "\$AWS_REGION" --only-show-errors
sudo chmod 600 /run/nava-vpn/*
sudo chown root:root /run/nava-vpn/*
echo "STAGED_OK"
sudo ls -la /run/nava-vpn
EOF
)

bash "$SCRIPT_DIR/ssm-run-command.sh" "$SYNC_CMD"

echo "STAGE_OK s3=$S3_PREFIX"
echo "Next: bash apps/server-pilot/deploy/ssm-run-command.sh 'sudo bash /home/ubuntu/repos/zero/apps/server-pilot/deploy/vpn-safe-smoke.sh'"
