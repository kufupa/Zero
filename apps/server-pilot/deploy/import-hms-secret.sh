#!/usr/bin/env bash
# Import HMS read secret into Secrets Manager without printing credentials.
# Reads apps/server-pilot/.env.hms.local (gitignored). Prints ARN only.
# Accepts only credentialMode=view_only (audited_write refused).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SOURCE="${HMS_LOCAL_ENV_FILE:-$ROOT/apps/server-pilot/.env.hms.local}"
SECRET_NAME="${HMS_READ_SECRET_NAME:-nava-zero/server-pilot/infor-hms-read}"
AWS_REGION="${AWS_REGION:-af-south-1}"

if [[ ! -f "$SOURCE" ]]; then
  echo "missing $SOURCE — create from skeleton:" >&2
  cat >&2 <<'EOF'
HMS_LOGIN_URL=
HMS_USERNAME=NAVAAI
HMS_PASSWORD=
HMS_EXPECTED_TENANT=THECENTURION_PRD
HMS_EXPECTED_PROPERTY_CODE=HRCEN
HMS_EXPECTED_PROPERTY_NAME=
HMS_MAILBOX_TRANSPORT_ID=
HMS_CREDENTIAL_MODE=view_only
EOF
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$SOURCE"
set +a

: "${HMS_LOGIN_URL:?HMS_LOGIN_URL missing}"
: "${HMS_USERNAME:?HMS_USERNAME missing}"
: "${HMS_PASSWORD:?HMS_PASSWORD missing}"
: "${HMS_EXPECTED_TENANT:?HMS_EXPECTED_TENANT missing}"
: "${HMS_EXPECTED_PROPERTY_CODE:?HMS_EXPECTED_PROPERTY_CODE missing}"
: "${HMS_EXPECTED_PROPERTY_NAME:?HMS_EXPECTED_PROPERTY_NAME missing}"
: "${HMS_MAILBOX_TRANSPORT_ID:?HMS_MAILBOX_TRANSPORT_ID missing}"
: "${HMS_CREDENTIAL_MODE:?HMS_CREDENTIAL_MODE missing}"

if [[ "${HMS_CREDENTIAL_MODE}" != "view_only" ]]; then
  echo "import-hms-secret: REFUSE credentialMode=${HMS_CREDENTIAL_MODE} (only view_only allowed)" >&2
  unset HMS_PASSWORD HMS_USERNAME HMS_LOGIN_URL
  exit 2
fi

tmp="$(mktemp)"
trap 'rm -f "$tmp"; unset HMS_PASSWORD HMS_USERNAME HMS_LOGIN_URL' EXIT
chmod 600 "$tmp"

jq -n \
  --arg loginUrl "$HMS_LOGIN_URL" \
  --arg username "$HMS_USERNAME" \
  --arg password "$HMS_PASSWORD" \
  --arg expectedTenant "$HMS_EXPECTED_TENANT" \
  --arg expectedPropertyCode "$HMS_EXPECTED_PROPERTY_CODE" \
  --arg expectedPropertyName "$HMS_EXPECTED_PROPERTY_NAME" \
  --arg mailboxTransportId "$HMS_MAILBOX_TRANSPORT_ID" \
  --arg credentialMode "$HMS_CREDENTIAL_MODE" \
  '{
    loginUrl:$loginUrl,
    username:$username,
    password:$password,
    expectedTenant:$expectedTenant,
    expectedPropertyCode:$expectedPropertyCode,
    expectedPropertyName:$expectedPropertyName,
    mailboxTransportId:$mailboxTransportId,
    credentialMode:$credentialMode
  }' >"$tmp"

# Unset locals before any further output
unset HMS_PASSWORD HMS_USERNAME

if arn="$(aws secretsmanager describe-secret \
  --region "$AWS_REGION" \
  --secret-id "$SECRET_NAME" \
  --query ARN \
  --output text 2>/dev/null)"; then
  aws secretsmanager put-secret-value \
    --region "$AWS_REGION" \
    --secret-id "$SECRET_NAME" \
    --secret-string "file://$tmp" >/dev/null
else
  arn="$(aws secretsmanager create-secret \
    --region "$AWS_REGION" \
    --name "$SECRET_NAME" \
    --secret-string "file://$tmp" \
    --query ARN \
    --output text)"
fi

printf '%s\n' "$arn"
