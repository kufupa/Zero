#!/usr/bin/env bash
# Laptop → S3 stage of navaai mailbox password (no secrets in git).
# Then SSM cp on EC2 into /run/nava-mail/password (mode 600 root).
# Password never appears in SSM argv — only S3 URI + install path.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
MAIL_DIR="${MAIL_DIR:-$REPO_ROOT/live real data connection}"

: "${AWS_REGION:=af-south-1}"
: "${INSTANCE_ID:=i-008f737974a9ba9b3}"
: "${BOOTSTRAP_BUCKET:=nava-zero-bootstrap-845242190536}"

PASS_FILE="$MAIL_DIR/navaai-mail-pass.txt"

if [ ! -f "$PASS_FILE" ]; then
  echo "missing: $PASS_FILE" >&2
  exit 2
fi

if grep -q 'REPLACE_' "$PASS_FILE"; then
  echo "navaai-mail-pass.txt still has placeholders — fill password first" >&2
  exit 2
fi

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
S3_PREFIX="s3://${BOOTSTRAP_BUCKET}/mail-navaai/${STAMP}"
STAGE_TMP="$(mktemp -d "${TMPDIR:-/tmp}/nava-mail-stage.XXXXXX")"
cleanup_local() { rm -rf "$STAGE_TMP"; }
trap cleanup_local EXIT

# Strip CR; first non-empty line only. Never echo this value.
tr -d '\r' <"$PASS_FILE" | awk 'NF{print; exit}' >"$STAGE_TMP/password"
chmod 600 "$STAGE_TMP/password"

if [ ! -s "$STAGE_TMP/password" ]; then
  echo "navaai-mail-pass.txt empty" >&2
  exit 2
fi

echo "== upload $S3_PREFIX/password =="
aws s3 cp "$STAGE_TMP/password" "$S3_PREFIX/password" \
  --region "$AWS_REGION" \
  --only-show-errors

echo "$S3_PREFIX" >"${TMPDIR:-/tmp}/nava-mail-last-s3-prefix.txt"

echo "== SSM cp into /run/nava-mail/password =="
# Download as ubuntu (instance-role IMDS). sudo aws drops role → 403 HeadObject.
# shellcheck disable=SC2016
SYNC_CMD=$(cat <<EOF
set -euo pipefail
S3_PREFIX='$S3_PREFIX'
AWS_REGION='$AWS_REGION'
TMP_PASS="\$(mktemp /tmp/nava-mail-pass.XXXXXX)"
cleanup() { rm -f "\$TMP_PASS"; }
trap cleanup EXIT
aws s3 cp "\$S3_PREFIX/password" "\$TMP_PASS" --region "\$AWS_REGION" --only-show-errors
sudo mkdir -p /run/nava-mail
sudo chmod 700 /run/nava-mail
sudo cp "\$TMP_PASS" /run/nava-mail/password
sudo chmod 600 /run/nava-mail/password
sudo chown root:root /run/nava-mail/password
echo "STAGED_OK"
EOF
)

bash "$SCRIPT_DIR/ssm-run-command.sh" "$SYNC_CMD"

echo "STAGED_OK"
