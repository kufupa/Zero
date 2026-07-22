#!/usr/bin/env bash
# Laptop → S3 stage of hotel OpenVPN profile (no secrets in git).
# Then SSM cp on EC2 into /run/nava-vpn.
#
# PKCS#12 uses legacy RC2; OpenVPN/OpenSSL 3 on Ubuntu hangs on P12 password
# prompts. We extract PEM on the laptop with `openssl pkcs12 -legacy` and ship
# ca/cert/key instead.
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

echo "== extract PKCS#12 → PEM (openssl -legacy, empty pass) =="
if ! openssl pkcs12 -legacy -in "$VPN_DIR/Nava.p12" -nokeys -clcerts -passin pass: \
  -out "$STAGE_TMP/client.crt" 2>/dev/null; then
  echo "P12 extract failed (empty pass). If P12 has a passphrase, fill nava-p12-pass.txt and re-run with P12_PASS." >&2
  exit 4
fi
openssl pkcs12 -legacy -in "$VPN_DIR/Nava.p12" -nocerts -nodes -passin pass: \
  -out "$STAGE_TMP/client.key"
openssl pkcs12 -legacy -in "$VPN_DIR/Nava.p12" -cacerts -nokeys -passin pass: \
  -out "$STAGE_TMP/ca.crt"
# Some exports put CA only in -nokeys dump; ensure ca.crt non-empty
if [ ! -s "$STAGE_TMP/ca.crt" ]; then
  openssl pkcs12 -legacy -in "$VPN_DIR/Nava.p12" -nokeys -passin pass: \
    -out "$STAGE_TMP/all-certs.pem"
  # take last cert as CA heuristic
  awk 'BEGIN{c=0} /BEGIN CERTIFICATE/{c++; f=sprintf("%s/cert%d.pem", ENVIRON["STAGE_TMP"], c)} {print > f}' \
    STAGE_TMP="$STAGE_TMP" "$STAGE_TMP/all-certs.pem" || true
fi
grep -q 'BEGIN CERTIFICATE' "$STAGE_TMP/client.crt" || { echo "no client cert" >&2; exit 4; }
grep -q 'BEGIN.*PRIVATE KEY' "$STAGE_TMP/client.key" || { echo "no client key" >&2; exit 4; }
grep -q 'BEGIN CERTIFICATE' "$STAGE_TMP/ca.crt" || { echo "no CA cert in P12" >&2; exit 4; }

cp "$VPN_DIR/Nava-tls.key" "$STAGE_TMP/Nava-tls.key"
tr -d '\r' <"$VPN_DIR/nava-auth.txt" >"$STAGE_TMP/nava-auth.txt"
awk 'NF{print; if(++n==2) exit}' "$STAGE_TMP/nava-auth.txt" >"$STAGE_TMP/nava-auth.txt.2"
mv "$STAGE_TMP/nava-auth.txt.2" "$STAGE_TMP/nava-auth.txt"

# Generate smoke ovpn: PEM paths + safety; no pkcs12/askpass
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
  echo "auth-user-pass /run/nava-vpn/nava-auth.txt"
  echo "ca /run/nava-vpn/ca.crt"
  echo "cert /run/nava-vpn/client.crt"
  echo "key /run/nava-vpn/client.key"
  echo "tls-auth /run/nava-vpn/Nava-tls.key 1"
  echo "remote-cert-tls server"
  echo "explicit-exit-notify"
  echo ""
  echo "# --- nava smoke safety (generated; do not commit secrets) ---"
  echo 'pull-filter ignore "redirect-gateway"'
  echo 'pull-filter ignore "dhcp-option DNS"'
  echo 'pull-filter ignore "dhcp-option DOMAIN"'
  echo "route 172.24.0.0 255.255.0.0"
  echo "script-security 1"
  echo "auth-nocache"
} >"$STAGE_TMP/Nava.smoke.ovpn"
tr -d '\r' <"$STAGE_TMP/Nava.smoke.ovpn" >"$STAGE_TMP/Nava.smoke.ovpn.lf"
mv "$STAGE_TMP/Nava.smoke.ovpn.lf" "$STAGE_TMP/Nava.smoke.ovpn"

grep -q 'pull-filter ignore "redirect-gateway"' "$STAGE_TMP/Nava.smoke.ovpn" \
  || { echo "generated ovpn missing pull-filter" >&2; exit 3; }
grep -q 'route 172.24.0.0 255.255.0.0' "$STAGE_TMP/Nava.smoke.ovpn" \
  || { echo "generated ovpn missing 172.24 route" >&2; exit 3; }
grep -qE '^(askpass|pkcs12)' "$STAGE_TMP/Nava.smoke.ovpn" \
  && { echo "generated ovpn still has askpass/pkcs12 — refuse" >&2; exit 3; }

chmod 600 "$STAGE_TMP"/*

echo "== upload $S3_PREFIX =="
aws s3 sync "$STAGE_TMP/" "$S3_PREFIX/" \
  --region "$AWS_REGION" \
  --only-show-errors

echo "$S3_PREFIX" >"${TMPDIR:-/tmp}/nava-vpn-last-s3-prefix.txt"

FILES="Nava.smoke.ovpn nava-auth.txt Nava-tls.key ca.crt client.crt client.key"
echo "== SSM cp into /run/nava-vpn =="
# Glob under /run/nava-vpn fails as ubuntu (dir 700 root) — sudo bash -c for chmod.
# shellcheck disable=SC2016
SYNC_CMD=$(cat <<EOF
set -euo pipefail
S3_PREFIX='$S3_PREFIX'
AWS_REGION='$AWS_REGION'
sudo mkdir -p /run/nava-vpn
sudo chmod 700 /run/nava-vpn
sudo rm -rf /run/nava-vpn
sudo mkdir -p /run/nava-vpn
sudo chmod 700 /run/nava-vpn
for f in $FILES; do
  sudo aws s3 cp "\$S3_PREFIX/\$f" "/run/nava-vpn/\$f" --region "\$AWS_REGION" --only-show-errors
done
sudo bash -c 'chmod 600 /run/nava-vpn/*; chown root:root /run/nava-vpn/*'
echo "STAGED_OK"
sudo ls -la /run/nava-vpn
EOF
)

bash "$SCRIPT_DIR/ssm-run-command.sh" "$SYNC_CMD"

echo "STAGE_OK s3=$S3_PREFIX"
echo "Next: bash apps/server-pilot/deploy/ssm-run-command.sh 'bash /home/ubuntu/repos/zero/apps/server-pilot/deploy/vpn-safe-smoke.sh'"
