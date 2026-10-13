#!/usr/bin/env bash
# Render isolated remote HTTP env files from the legacy runtime and remote auth secret.
# Run as ubuntu on EC2; generated mode-0600 files stay ubuntu-owned.
set -euo pipefail

: "${AWS_REGION:=af-south-1}"
: "${REMOTE_AUTH_SECRET_NAME:=nava-zero/server-pilot/remote-auth}"
: "${REMOTE_AUTH_URL:=https://nava-admin.trynava.io}"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${REPO_ROOT:-/home/ubuntu/repos/zero}"
SERVER_PILOT="${REPO_ROOT}/apps/server-pilot"
LEGACY_ENV_FILE="${ENV_FILE:-${SERVER_PILOT}/.env.production}"
if [ ! -f "$LEGACY_ENV_FILE" ] && [ -f /home/ubuntu/.env.production ]; then
  LEGACY_ENV_FILE=/home/ubuntu/.env.production
fi
REMOTE_COMMON_ENV="${SERVER_PILOT}/.env.remote-common"
REMOTE_ADMIN_ENV="${SERVER_PILOT}/.env.remote-admin"

# HTTP-only controls. Intentionally excludes Better Auth, POP3, HMS, and Google keys.
REMOTE_COMMON_ALLOWLIST=(
  DATABASE_URL
  AWS_REGION
  S3_BUCKET
  MAIL_TRANSPORT_MODE
  SMTP_HOST
  SMTP_PORT
  SMTP_SECURE
  SMTP_USER
  SMTP_PASSWORD
  SMTP_SECRET_ARN
  MAIL_TLS_REJECT_UNAUTHORIZED
  UNDO_SEND_SECONDS
  INGEST_MAX_MESSAGE_BYTES
  INGEST_MAX_ATTACHMENT_BYTES
  INGEST_REQUIRE_OWNER_HEADER
  AI_ENABLED
  AI_WRITE_GATE_ENABLED
  AI_DRAFTS_ENABLED
  CATCHUP_UPLOAD_ENABLED
  AI_STALE_RUN_TIMEOUT_MS
  AI_MODEL_ID
  AI_WORKER_IDEMPOTENCY_PREFIX
  BEDROCK_REGION
  BEDROCK_GUARDRAIL_ID
  BEDROCK_GUARDRAIL_VERSION
  MASTRA_STORAGE_PATH
  NAVA_BUILD_COMMIT
  HMS_JOB_QUEUE
  NEEDS_YOU_SINCE
)

validate_remote_env_file() {
  local path="$1"
  local kind="$2"
  if [ ! -f "$path" ] || [ -L "$path" ]; then
    echo "remote env missing or unsafe: $path" >&2
    return 1
  fi
  if [ "$(stat -c '%a:%U:%G' "$path")" != "600:ubuntu:ubuntu" ]; then
    echo "remote env must be ubuntu-owned mode 0600: $path" >&2
    return 1
  fi
  node - "$path" "$kind" <<'NODE'
const fs = require("fs");
const [path, kind] = process.argv.slice(2);
const common = new Set([
  "NODE_ENV", "DATABASE_URL", "AWS_REGION", "S3_BUCKET", "MAIL_TRANSPORT_MODE",
  "SMTP_HOST", "SMTP_PORT", "SMTP_SECURE", "SMTP_USER", "SMTP_PASSWORD",
  "SMTP_SECRET_ARN", "MAIL_TLS_REJECT_UNAUTHORIZED", "UNDO_SEND_SECONDS",
  "INGEST_MAX_MESSAGE_BYTES", "INGEST_MAX_ATTACHMENT_BYTES",
  "INGEST_REQUIRE_OWNER_HEADER", "AI_ENABLED", "AI_WRITE_GATE_ENABLED",
  "AI_DRAFTS_ENABLED", "CATCHUP_UPLOAD_ENABLED", "AI_STALE_RUN_TIMEOUT_MS", "AI_MODEL_ID",
  "AI_WORKER_IDEMPOTENCY_PREFIX", "BEDROCK_REGION", "BEDROCK_GUARDRAIL_ID",
  "BEDROCK_GUARDRAIL_VERSION", "MASTRA_STORAGE_PATH", "NAVA_BUILD_COMMIT",
]);
try {
  const values = new Map();
  for (const line of fs.readFileSync(path, "utf8").split("\n").filter(Boolean)) {
    const match = /^([A-Z][A-Z0-9_]*)='((?:[^']|'\\'')*)'$/.exec(line);
    if (!match || values.has(match[1])) throw new Error("invalid");
    values.set(match[1], match[2].replace(/'\\''/g, "'"));
  }
  if (kind === "common") {
    if (![...values.keys()].every((key) => common.has(key))) throw new Error("invalid");
    if (values.get("NODE_ENV") !== "production") throw new Error("invalid");
    for (const key of ["DATABASE_URL", "AWS_REGION", "S3_BUCKET"]) {
      if (!values.has(key) || values.get(key).trim().length === 0) {
        throw new Error("invalid");
      }
    }
  } else if (
    values.size !== 2 ||
    !values.has("BETTER_AUTH_URL") ||
    !values.has("BETTER_AUTH_SECRET") ||
    values.get("BETTER_AUTH_URL") !== "https://nava-admin.trynava.io" ||
    values.get("BETTER_AUTH_SECRET")?.trim().length === 0 ||
    /[\r\n\0]/.test(values.get("BETTER_AUTH_SECRET") ?? "")
  ) {
    throw new Error("invalid");
  }
} catch {
  process.stderr.write("remote env malformed\n");
  process.exit(2);
}
NODE
}

validate_remote_env_files() {
  validate_remote_env_file "$REMOTE_COMMON_ENV" common
  validate_remote_env_file "$REMOTE_ADMIN_ENV" admin
}

if [ "$(id -un)" != "ubuntu" ]; then
  echo "write-ec2-remote-env.sh must run as ubuntu" >&2
  exit 2
fi

case "${1:-}" in
  --validate)
    validate_remote_env_files
    exit 0
    ;;
  '')
    ;;
  *)
    echo "usage: $0 [--validate]" >&2
    exit 2
    ;;
esac

if [ ! -d "$SERVER_PILOT" ] || [ -L "$SERVER_PILOT" ]; then
  echo "server-pilot directory missing or unsafe: $SERVER_PILOT" >&2
  exit 2
fi
if [ ! -f "$LEGACY_ENV_FILE" ] || [ -L "$LEGACY_ENV_FILE" ]; then
  echo "legacy runtime env missing or unsafe: $LEGACY_ENV_FILE" >&2
  exit 2
fi
if [ "$(stat -c '%a:%U:%G' "$LEGACY_ENV_FILE")" != "600:ubuntu:ubuntu" ]; then
  echo "legacy runtime env must be ubuntu-owned mode 0600: $LEGACY_ENV_FILE" >&2
  exit 2
fi

REMOTE_COMMON_TMP="$(mktemp "${SERVER_PILOT}/.env.remote-common.tmp.XXXXXX")"
REMOTE_ADMIN_TMP="$(mktemp "${SERVER_PILOT}/.env.remote-admin.tmp.XXXXXX")"
cleanup() {
  rm -f -- "$REMOTE_COMMON_TMP" "$REMOTE_ADMIN_TMP"
}
trap cleanup EXIT

quote_val() {
  printf "'%s'" "${1//\'/\'\\\'\'}"
}

node "$SCRIPT_DIR/parse-ec2-legacy-env.mjs" \
  "$LEGACY_ENV_FILE" \
  "$REMOTE_COMMON_TMP" \
  "${REMOTE_COMMON_ALLOWLIST[@]}"

REMOTE_AUTH_SECRET="$(
  aws secretsmanager get-secret-value \
    --region "$AWS_REGION" \
    --secret-id "$REMOTE_AUTH_SECRET_NAME" \
    --query SecretString \
    --output text \
    | node -e '
let data = "";
process.stdin.on("data", (chunk) => { data += chunk; });
process.stdin.on("end", () => {
  try {
    const parsed = JSON.parse(data);
    if (
      !parsed ||
      Array.isArray(parsed) ||
      Object.keys(parsed).length !== 1 ||
      Object.keys(parsed)[0] !== "BETTER_AUTH_SECRET" ||
      typeof parsed.BETTER_AUTH_SECRET !== "string" ||
      parsed.BETTER_AUTH_SECRET.trim().length === 0 ||
      /[\r\n\0]/.test(parsed.BETTER_AUTH_SECRET)
    ) {
      process.exit(2);
    }
    process.stdout.write(parsed.BETTER_AUTH_SECRET);
  } catch {
    process.exit(2);
  }
});
'
)" || {
  echo "remote auth secret is missing or malformed" >&2
  exit 2
}
if [ -z "$REMOTE_AUTH_SECRET" ]; then
  echo "remote auth secret is missing or malformed" >&2
  exit 2
fi

printf 'BETTER_AUTH_URL=%s\nBETTER_AUTH_SECRET=%s\n' \
  "$(quote_val "$REMOTE_AUTH_URL")" \
  "$(quote_val "$REMOTE_AUTH_SECRET")" >"$REMOTE_ADMIN_TMP"

node -e 'const fs=require("fs"); for (const path of process.argv.slice(1)) { const fd=fs.openSync(path,"r"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }' \
  "$REMOTE_COMMON_TMP" "$REMOTE_ADMIN_TMP"
chmod 600 "$REMOTE_COMMON_TMP"
chmod 600 "$REMOTE_ADMIN_TMP"
if [ "$(stat -c '%a:%U:%G' "$REMOTE_COMMON_TMP")" != "600:ubuntu:ubuntu" ] ||
  [ "$(stat -c '%a:%U:%G' "$REMOTE_ADMIN_TMP")" != "600:ubuntu:ubuntu" ]; then
  echo "remote env temporary files must be ubuntu-owned mode 0600" >&2
  exit 2
fi

# All secret parsing and both temporary files complete before either live file changes.
mv -f -- "$REMOTE_COMMON_TMP" "$REMOTE_COMMON_ENV"
mv -f -- "$REMOTE_ADMIN_TMP" "$REMOTE_ADMIN_ENV"
node -e 'const fs=require("fs");const fd=fs.openSync(process.argv[1],"r");try{fs.fsyncSync(fd)}finally{fs.closeSync(fd)}' "$SERVER_PILOT"
REMOTE_COMMON_TMP=""
REMOTE_ADMIN_TMP=""
trap - EXIT
echo "Wrote remote HTTP environment files with mode 0600"
