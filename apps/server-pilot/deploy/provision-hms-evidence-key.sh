#!/usr/bin/env bash
# Operator-host bootstrap for Phase B evidence HMAC secret + EC2 metadata.
# Creates secret (or describes existing), scopes IAM, installs ARN/version only
# on EC2 via SSM, pins asm-exec. Never prints key bytes. Never fetch secret payload.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
ASM_EXEC_SRC="${REPO_ROOT}/apps/server-pilot/deploy/vendor/asm-exec"
# Vendor CRLF bytes (source integrity). Installed path is LF after tr -d '\r'.
DEFAULT_PIN='5f0c7f82827fe4eb89db0ba177aec694cd4cbf3acff003b09d1b545ea8595b7f'
ASM_EXEC_INSTALLED_SHA256='81fd29e1f039209282bc8cbe482cda033d331f07284533a46f990368228a7e65'
ROLE_NAME='nava-prod-public-ipv4-WorkerRole-bPmrMEkmdwLU'
ACCOUNT_ID='845242190536'

AWS_REGION='af-south-1'
INSTANCE_ID='i-008f737974a9ba9b3'
SECRET_NAME='nava-zero/server-pilot/hms-evidence-hmac'
ASM_EXEC_SHA256="$DEFAULT_PIN"
JSON_OUT=0

usage() {
  printf '%s\n' \
    "usage: $0 --region <region> --instance <id> --secret-name <name> --asm-exec-sha256 <sha> [--json]" >&2
  exit 2
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --region) [ "$#" -ge 2 ] || usage; AWS_REGION="$2"; shift 2 ;;
    --instance) [ "$#" -ge 2 ] || usage; INSTANCE_ID="$2"; shift 2 ;;
    --secret-name) [ "$#" -ge 2 ] || usage; SECRET_NAME="$2"; shift 2 ;;
    --asm-exec-sha256) [ "$#" -ge 2 ] || usage; ASM_EXEC_SHA256="$2"; shift 2 ;;
    --json) JSON_OUT=1; shift ;;
    -h|--help) usage ;;
    *) usage ;;
  esac
done

[ -n "$AWS_REGION" ] && [ -n "$INSTANCE_ID" ] && [ -n "$SECRET_NAME" ] && [ -n "$ASM_EXEC_SHA256" ] || usage
[ "$ASM_EXEC_SHA256" = "$DEFAULT_PIN" ] || {
  echo "asm-exec sha256 must equal pinned ${DEFAULT_PIN}" >&2
  exit 2
}
[ -f "$ASM_EXEC_SRC" ] || {
  echo "missing vendored asm-exec at ${ASM_EXEC_SRC}" >&2
  exit 2
}
printf '%s  %s\n' "$ASM_EXEC_SHA256" "$ASM_EXEC_SRC" | sha256sum -c - >/dev/null

umask 077
KEY_TMP=""
cleanup() {
  if [ -n "$KEY_TMP" ] && [ -e "$KEY_TMP" ]; then
    rm -f -- "$KEY_TMP"
  fi
}
trap cleanup EXIT

SECRET_ARN=""
VERSION_ID=""
SECRET_CREATED=0

if SECRET_ARN="$(
  aws secretsmanager describe-secret \
    --region "$AWS_REGION" \
    --secret-id "$SECRET_NAME" \
    --query ARN \
    --output text 2>/dev/null
)"; then
  VERSION_ID="$(
    aws secretsmanager list-secret-version-ids \
      --region "$AWS_REGION" \
      --secret-id "$SECRET_NAME" \
      --query "Versions[?contains(VersionStages,\`AWSCURRENT\`)].VersionId | [0]" \
      --output text
  )"
else
  KEY_TMP="$(mktemp "${TMPDIR:-/tmp}/nava-hms-evidence-key.XXXXXX")"
  chmod 600 "$KEY_TMP"
  openssl rand -base64 32 | tr -d '\n' >"$KEY_TMP"
  chmod 600 "$KEY_TMP"
  # Windows AWS CLI needs a native path for file:// (Git Bash /tmp is invisible).
  SECRET_FILE_URI="file://${KEY_TMP}"
  if command -v cygpath >/dev/null 2>&1; then
    SECRET_FILE_URI="file://$(cygpath -m "$KEY_TMP")"
  fi
  CREATE_JSON="$(
    aws secretsmanager create-secret \
      --region "$AWS_REGION" \
      --name "$SECRET_NAME" \
      --description "Nava Zero server-pilot HMS evidence HMAC key (base64)" \
      --secret-string "$SECRET_FILE_URI" \
      --output json
  )"
  rm -f -- "$KEY_TMP"
  KEY_TMP=""
  unset SECRET_FILE_URI
  SECRET_ARN="$(
    node -e 'const j=JSON.parse(process.argv[1]); process.stdout.write(String(j.ARN||""))' "$CREATE_JSON"
  )"
  VERSION_ID="$(
    node -e 'const j=JSON.parse(process.argv[1]); process.stdout.write(String(j.VersionId||""))' "$CREATE_JSON"
  )"
  SECRET_CREATED=1
fi

case "$SECRET_ARN" in
  ""|None) echo "secret ARN unavailable" >&2; exit 1 ;;
esac
case "$VERSION_ID" in
  ""|None) echo "secret VersionId unavailable" >&2; exit 1 ;;
esac

POLICY_DOC="$(node -e '
const account=process.argv[1];
const region=process.argv[2];
const doc={
  Version:"2012-10-17",
  Statement:[{
    Effect:"Allow",
    Action:["secretsmanager:GetSecretValue","secretsmanager:DescribeSecret"],
    Resource:[
      `arn:aws:secretsmanager:${region}:${account}:secret:nava-zero/server-pilot/database-url-*`,
      `arn:aws:secretsmanager:${region}:${account}:secret:nava-zero/server-pilot/infor-hms-read-*`,
      `arn:aws:secretsmanager:${region}:${account}:secret:nava-zero/server-pilot/hms-evidence-hmac-*`,
    ],
  }],
};
process.stdout.write(JSON.stringify(doc));
' "$ACCOUNT_ID" "$AWS_REGION")"

aws iam put-role-policy \
  --region "$AWS_REGION" \
  --role-name "$ROLE_NAME" \
  --policy-name NavaZeroSecretsRead \
  --policy-document "$POLICY_DOC" >/dev/null

# EC2: pin vendor SRC + installed LF asm-exec + write metadata-only env (never key).
# shellcheck disable=SC2016
REMOTE_CMD=$(cat <<EOF
set -euo pipefail
PIN='${ASM_EXEC_SHA256}'
INSTALLED_PIN='${ASM_EXEC_INSTALLED_SHA256}'
SRC='/home/ubuntu/repos/zero/apps/server-pilot/deploy/vendor/asm-exec'
META='/etc/nava/hms-evidence-hmac.env'
ARN='${SECRET_ARN}'
VER='${VERSION_ID}'
printf '%s  %s\n' "\$PIN" "\$SRC" | sha256sum -c -
sudo install -d -o root -g root -m 0755 /etc/nava
ASM_TMP="\$(sudo mktemp /tmp/asm-exec.XXXXXX)"
tr -d '\\r' <"\$SRC" | sudo tee "\$ASM_TMP" >/dev/null
sudo install -o root -g root -m 0755 "\$ASM_TMP" /usr/local/bin/asm-exec
sudo rm -f "\$ASM_TMP"
printf '%s  %s\n' "\$INSTALLED_PIN" /usr/local/bin/asm-exec | sha256sum -c -
grep -q 'os.execvpe' /usr/local/bin/asm-exec
META_TMP="\$(sudo mktemp /etc/nava/.hms-evidence-hmac.env.XXXXXX)"
printf 'HMS_EVIDENCE_HMAC_SECRET_ARN=%s\nHMS_EVIDENCE_HMAC_KEY_VERSION=%s\n' "\$ARN" "\$VER" | sudo tee "\$META_TMP" >/dev/null
sudo chown root:root "\$META_TMP"
sudo chmod 0644 "\$META_TMP"
sudo mv -T "\$META_TMP" "\$META"
grep -q '^HMS_EVIDENCE_HMAC_SECRET_ARN=' "\$META"
grep -q '^HMS_EVIDENCE_HMAC_KEY_VERSION=' "\$META"
! awk -F= '\$1=="HMS_EVIDENCE_HMAC_KEY"{found=1} END{exit found+0}' "\$META"
OUT="\$(/usr/local/bin/asm-exec -- /bin/echo ASM_EXEC_SENTINEL_OK)"
test "\$OUT" = 'ASM_EXEC_SENTINEL_OK'
echo INSTANCE_EVIDENCE_BOOTSTRAP_OK
EOF
)

export AWS_REGION INSTANCE_ID
SSM_OUT="$(bash "${SCRIPT_DIR}/ssm-run-command.sh" "$REMOTE_CMD")"
echo "$SSM_OUT" | grep -q 'INSTANCE_EVIDENCE_BOOTSTRAP_OK' || {
  echo "EC2 evidence bootstrap SSM failed" >&2
  exit 1
}

if [ "$JSON_OUT" -eq 1 ]; then
  node -e '
const created=process.argv[1]==="1";
process.stdout.write(JSON.stringify({
  schemaVersion:1,
  secretName:process.argv[2],
  secretArn:process.argv[3],
  versionId:process.argv[4],
  secretCreated:created,
  secretMetadataReady:true,
  instanceMetadataInstalled:true,
  asmExecPinned:true,
})+"\n");
' "$SECRET_CREATED" "$SECRET_NAME" "$SECRET_ARN" "$VERSION_ID"
else
  echo "secretMetadataReady=true instanceMetadataInstalled=true asmExecPinned=true"
  echo "secretArn=${SECRET_ARN}"
  echo "versionId=${VERSION_ID}"
fi
