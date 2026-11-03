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
  PANE_BRAIN
  QUOTE_WORKFLOW_LLM
  AI_WORKER_IDEMPOTENCY_PREFIX
  BEDROCK_REGION
  BEDROCK_GUARDRAIL_ID
  BEDROCK_GUARDRAIL_VERSION
  MASTRA_STORAGE_PATH
  GOTENBERG_URL
  NAVA_BUILD_COMMIT
  HMS_DAVINCI_CREATE
  HMS_DAVINCI_MAKE_QUOTE
  HMS_DAVINCI_READS
  HMS_JOB_QUEUE
  HMS_QUOTE_PREPARE
  HMS_QUOTE_PREPARE_PER_HOUR
  HMS_STAGEHAND_CDP_URL_DAVINCI
  RESERVATIONIST_STAFF_QUOTE_CONFIGURATION_HRDAV
  INBOUND_EXTRACTION
  INBOUND_TRIAGE_CLASSIFIER
  NEEDS_YOU_SINCE
  PANE_WRITE_CREATE
  PANE_WRITE_AMEND_UNPAID
  PANE_WRITE_AMEND_PAID
  PANE_WRITE_CANCEL_UNPAID
  PANE_WRITE_CANCEL_PAID
  PANE_WRITE_ATTACH
  PANE_HMS_LAB_ATTACH_WORKER
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
  "AI_DRAFTS_ENABLED", "CATCHUP_UPLOAD_ENABLED", "AI_STALE_RUN_TIMEOUT_MS", "AI_MODEL_ID", "PANE_BRAIN", "QUOTE_WORKFLOW_LLM",
  "AI_WORKER_IDEMPOTENCY_PREFIX", "BEDROCK_REGION", "BEDROCK_GUARDRAIL_ID",
  "BEDROCK_GUARDRAIL_VERSION", "MASTRA_STORAGE_PATH", "GOTENBERG_URL", "NAVA_BUILD_COMMIT",
  "HMS_DAVINCI_CREATE", "HMS_DAVINCI_MAKE_QUOTE", "HMS_DAVINCI_READS", "HMS_JOB_QUEUE", "HMS_QUOTE_PREPARE", "HMS_QUOTE_PREPARE_PER_HOUR", "HMS_STAGEHAND_CDP_URL_DAVINCI",
  "RESERVATIONIST_STAFF_QUOTE_CONFIGURATION_HRDAV",
  "INBOUND_EXTRACTION", "INBOUND_TRIAGE_CLASSIFIER", "NEEDS_YOU_SINCE",
  "PANE_WRITE_CREATE", "PANE_WRITE_AMEND_UNPAID", "PANE_WRITE_AMEND_PAID",
  "PANE_WRITE_CANCEL_UNPAID", "PANE_WRITE_CANCEL_PAID", "PANE_WRITE_ATTACH",
  "PANE_HMS_LAB_ATTACH_WORKER",
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
    if (values.has("PANE_BRAIN") && !["agent", "classifier"].includes(values.get("PANE_BRAIN"))) {
      throw new Error("invalid");
    }
    if (values.has("QUOTE_WORKFLOW_LLM") && !["on", "off"].includes(values.get("QUOTE_WORKFLOW_LLM"))) {
      throw new Error("invalid");
    }
    if (values.has("GOTENBERG_URL")) {
      const url = new URL(values.get("GOTENBERG_URL"));
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("invalid");
    }
  } else if (kind === "brain") {
    if (![...values.keys()].every((key) => ["PANE_BRAIN", "QUOTE_WORKFLOW_LLM"].includes(key)) ||
      (values.has("PANE_BRAIN") && !["agent", "classifier"].includes(values.get("PANE_BRAIN"))) ||
      (values.has("QUOTE_WORKFLOW_LLM") && !["on", "off"].includes(values.get("QUOTE_WORKFLOW_LLM")))) {
      throw new Error("invalid");
    }
  } else if (kind === "model") {
    const keys = ["AZURE_OPENAI_BASE_URL", "AZURE_FOUNDRY_API_KEY"];
    if (values.size !== 0 && (values.size !== keys.length || keys.some((key) =>
      !values.has(key) || values.get(key).trim().length === 0 ||
      /[\x00-\x1f\x7f]/.test(values.get(key))
    ))) throw new Error("invalid");
    if (values.size !== 0) {
      const url = new URL(values.get("AZURE_OPENAI_BASE_URL"));
      if (url.protocol !== "https:" || url.username || url.password) throw new Error("invalid");
    }
  } else if (kind !== "admin" ||
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
  --ensure-model | --validate-model | --prepare-model)
    [ "$#" -eq 1 ] || exit 2
    ;;
  --check-model)
    [ "$#" -eq 2 ] || exit 2
    ;;
  '') ;;
  *)
    echo "usage: $0 [--validate|--ensure-model|--validate-model|--prepare-model|--check-model dir]" >&2
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

# Per-launch snapshots are private and disposable. Never modify older overlays.
if [ -n "${1:-}" ]; then
  validate_remote_env_files
  umask 077
  snapshot_dir=""
  cleanup_snapshot() {
    if [ -n "$snapshot_dir" ]; then
      rm -f -- "$snapshot_dir/raw" "$snapshot_dir/model" "$snapshot_dir/model-check" \
        "$snapshot_dir/brain" "$snapshot_dir/brain-check" "$snapshot_dir/common" "$snapshot_dir/admin"
      rmdir -- "$snapshot_dir" || true
    fi
  }
  trap cleanup_snapshot EXIT
  trap 'exit 2' HUP INT TERM
  snapshot_dir="$(mktemp -d "${SERVER_PILOT}/.env.remote-launch.XXXXXX")"
  model_raw="$snapshot_dir/raw"
  model_candidate="$snapshot_dir/model"
  model_check="$snapshot_dir/model-check"
  brain_candidate="$snapshot_dir/brain"
  brain_check="$snapshot_dir/brain-check"
  cp -- "$REMOTE_COMMON_ENV" "$snapshot_dir/common"
  cp -- "$REMOTE_ADMIN_ENV" "$snapshot_dir/admin"
  validate_remote_env_file "$snapshot_dir/common" common
  validate_remote_env_file "$snapshot_dir/admin" admin

  render_model() {
    node "$SCRIPT_DIR/parse-ec2-legacy-env.mjs" "$LEGACY_ENV_FILE" "$model_raw" \
      AZURE_OPENAI_BASE_URL AZURE_FOUNDRY_API_KEY PANE_BRAIN QUOTE_WORKFLOW_LLM
    sed -n '/^AZURE_OPENAI_BASE_URL=/p; /^AZURE_FOUNDRY_API_KEY=/p' "$model_raw" >"$1"
    sed -n '/^PANE_BRAIN=/p; /^QUOTE_WORKFLOW_LLM=/p' "$model_raw" >"$2"
    validate_remote_env_file "$1" model
    validate_remote_env_file "$2" brain
  }

  render_model "$model_candidate" "$brain_candidate"
  render_model "$model_check" "$brain_check"
  validate_remote_env_files
  if [ ! -f "$LEGACY_ENV_FILE" ] || [ -L "$LEGACY_ENV_FILE" ] ||
    [ "$(stat -c '%a:%U:%G' "$LEGACY_ENV_FILE")" != "600:ubuntu:ubuntu" ]; then
    echo "legacy runtime env changed or unsafe" >&2
    exit 2
  fi
  if ! cmp -s -- "$model_candidate" "$model_check" ||
    ! cmp -s -- "$brain_candidate" "$brain_check" ||
    ! cmp -s -- "$snapshot_dir/common" "$REMOTE_COMMON_ENV" ||
    ! cmp -s -- "$snapshot_dir/admin" "$REMOTE_ADMIN_ENV"; then
    echo "remote model source changed during preparation" >&2
    exit 2
  fi
  # Preserve a pre-existing remote override; an unset source defaults to classifier.
  if grep -q '^PANE_BRAIN=' "$snapshot_dir/common"; then
    brain_source="$(grep '^PANE_BRAIN=' "$brain_candidate" || true)"
    if [ -z "$brain_source" ]; then brain_source="PANE_BRAIN='classifier'"; fi
    if ! grep -Fqx -- "$brain_source" "$snapshot_dir/common"; then
      echo "remote pane routing conflicts with source" >&2
      exit 2
    fi
  fi
  if grep -q '^QUOTE_WORKFLOW_LLM=' "$snapshot_dir/common" &&
    ! grep -Fqx -- "$(grep '^QUOTE_WORKFLOW_LLM=' "$snapshot_dir/common")" "$brain_candidate"; then
    echo "remote quote model flag conflicts with source" >&2
    exit 2
  fi
  if [ "${1:-}" = "--check-model" ]; then
    input_dir="$2"
    if [ "$(dirname -- "$input_dir")" != "$SERVER_PILOT" ] ||
      [[ "$(basename -- "$input_dir")" != .env.remote-launch.* ]] ||
      [ ! -d "$input_dir" ] || [ -L "$input_dir" ] ||
      [ "$(stat -c '%a:%U:%G' "$input_dir")" != "700:ubuntu:ubuntu" ]; then
      echo "remote launch snapshot missing or unsafe" >&2
      exit 2
    fi
    for kind in model brain common admin; do
      validate_remote_env_file "$input_dir/$kind" "$kind"
      if ! cmp -s -- "$input_dir/$kind" "$snapshot_dir/$kind"; then
        echo "remote launch source changed before execution" >&2
        exit 2
      fi
    done
  fi
  if [ "${1:-}" = "--prepare-model" ]; then
    rm -f -- "$model_raw" "$model_check" "$brain_check"
    printf '%s\n' "$snapshot_dir"
    snapshot_dir=""
  fi
  exit 0
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

# Flip to `on` needs CANARY PASS <workflow> <property> <sha> on the live SHA (M3/G6).
nava_live_sha="${NAVA_LIVE_SHA:-}"
if [ -z "$nava_live_sha" ] && [ -d "${REPO_ROOT}/.git" ]; then
  nava_live_sha="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || true)"
fi
node - "$REMOTE_COMMON_TMP" "$REMOTE_COMMON_ENV" \
  "${NAVA_CANARY_PASS_FILE:-/tmp/mh1024/CANARY.txt}" "$nava_live_sha" <<'NODE'
const fs = require("fs");
const [newPath, oldPath, canaryPath, liveSha] = process.argv.slice(2);
const WORKFLOW = {
  HMS_DAVINCI_CREATE: "create",
  HMS_DAVINCI_MAKE_QUOTE: "quote",
  HMS_DAVINCI_READS: "reads",
  HMS_QUOTE_PREPARE: "quote",
  INBOUND_TRIAGE_CLASSIFIER: "triage",
  INBOUND_EXTRACTION: "extraction",
  PANE_WRITE_CREATE: "create",
  PANE_WRITE_AMEND_UNPAID: "amend",
  PANE_WRITE_AMEND_PAID: "amend",
  PANE_WRITE_CANCEL_UNPAID: "cancel",
  PANE_WRITE_CANCEL_PAID: "cancel",
  PANE_WRITE_ATTACH: "attach",
  PANE_HMS_LAB_ATTACH_WORKER: "attach",
  RESERVATIONIST_PANE_SAVE: "save",
  HMS_JOB_QUEUE: "queue",
};
function parse(path) {
  const map = new Map();
  if (!path || !fs.existsSync(path)) return map;
  for (const line of fs.readFileSync(path, "utf8").split("\n")) {
    const match = /^([A-Z][A-Z0-9_]*)='((?:[^']|'\\'')*)'$/.exec(line);
    if (match) map.set(match[1], match[2].replace(/'\\''/g, "'"));
  }
  return map;
}
function isOn(value) {
  return /^(on|true|1)$/i.test(String(value ?? ""));
}
function isWorkflow(key) {
  return Object.prototype.hasOwnProperty.call(WORKFLOW, key) || key.endsWith("_ON");
}
const next = parse(newPath);
const prev = parse(oldPath);
const flips = [];
for (const [key, value] of next) {
  if (!isWorkflow(key) || !isOn(value) || isOn(prev.get(key))) continue;
  flips.push(key);
}
if (flips.length === 0) process.exit(0);
if (!liveSha) {
  process.stderr.write("write-ec2-remote-env: refuse: live SHA missing for flag on\n");
  process.exit(2);
}
let canary = "";
try {
  canary = fs.readFileSync(canaryPath, "utf8");
} catch {
  canary = "";
}
const rows = [];
const lineRe = /^CANARY PASS (\S+) (\S+) ([0-9a-fA-F]{7,40})\s*$/;
for (const line of canary.split(/\r?\n/)) {
  const match = lineRe.exec(line);
  if (match) rows.push({ workflow: match[1], property: match[2], sha: match[3] });
}
function shaMatch(canarySha, live) {
  const a = canarySha.toLowerCase();
  const b = live.toLowerCase();
  if (a === b) return true;
  if (a.length >= 7 && b.startsWith(a)) return true;
  if (b.length >= 7 && a.startsWith(b)) return true;
  return false;
}
function workflowMatch(flag, token) {
  const alias = WORKFLOW[flag] || flag;
  return token === flag || token.toLowerCase() === String(alias).toLowerCase();
}
const FLAG_PROPERTY = {
  HMS_DAVINCI_CREATE: "HRDAV",
  HMS_DAVINCI_MAKE_QUOTE: "HRDAV",
  HMS_DAVINCI_READS: "HRDAV",
};
for (const flag of flips) {
  const neededProperty = FLAG_PROPERTY[flag];
  const hit = rows.find(
    (row) =>
      workflowMatch(flag, row.workflow) &&
      /^(HRCEN|HRDAV)$/.test(row.property) &&
      (!neededProperty || row.property === neededProperty) &&
      shaMatch(row.sha, liveSha),
  );
  if (hit) continue;
  const stale = rows.some((row) => workflowMatch(flag, row.workflow));
  process.stderr.write(
    stale
      ? `write-ec2-remote-env: refuse: stale canary SHA for ${flag} (live ${liveSha})\n`
      : `write-ec2-remote-env: refuse: no CANARY PASS <workflow> <property> <sha> for ${flag}\n`,
  );
  process.exit(2);
}
NODE

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
