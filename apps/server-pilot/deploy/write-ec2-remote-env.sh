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

# HTTP-only controls. Intentionally excludes Better Auth, POP3, HMS credentials, and Google keys.
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
  PLAYWRIGHT_BROWSERS_PATH
  HMS_CHROMIUM_EXECUTABLE_PATH
  HMS_DAVINCI_CREATE
  HMS_DAVINCI_MAKE_QUOTE
  HMS_DAVINCI_READS
  HMS_EXPECTED_TENANT
  HMS_EXPECTED_PROPERTY_CODE
  HMS_EXPECTED_TRANSPORT_ID
  HMS_JOB_QUEUE
  HMS_LANE_PAUSED
  HMS_PREFETCH_ENABLED
  HMS_PREFETCH_PER_HOUR
  HMS_GUEST_PREFETCH_PER_HOUR
  HMS_AVAILABILITY_PREFETCH
  HMS_AVAILABILITY_PER_HOUR
  HMS_QUOTE_PREPARE
  HMS_QUOTE_PREPARE_PER_HOUR
  PARTY_MATCH_V2
  HMS_STAGEHAND_CDP_URL_DAVINCI
  RESERVATIONIST_STAFF_QUOTE_CONFIGURATION
  RESERVATIONIST_STAFF_QUOTE_CONFIGURATION_HRDAV
  INBOUND_EXTRACTION
  INBOUND_TRIAGE_CLASSIFIER
  LEGACY_INBOUND_TRIAGE_PIPELINE
  RESERVATION_V2_ARRIVAL_PREFILL
  PANE_STAY_LOOKUP
  QUOTE_RATE_CONTEXT
  NEEDS_YOU_SINCE
  PANE_WRITE_CREATE
  PANE_HMS_LAB_CREATE_WORKER
  PANE_CLOUD_CREATE_DISPATCH
  PANE_WRITE_AMEND
  PANE_HMS_LAB_AMEND_WORKER
  PANE_WRITE_AMEND_UNPAID
  PANE_WRITE_AMEND_PAID
  PANE_WRITE_CANCEL_UNPAID
  PANE_WRITE_CANCEL_PAID
  PANE_WRITE_ADDONS
  PANE_WRITE_ATTACH
  PANE_HMS_LAB_ATTACH_WORKER
)

# The bounded M1 render updates workflow controls and native runtime dependencies.
# Later workflow controls are optional until their durable source is configured.
M1_ONLY_WRITE_CONTROLS=(
  PANE_WRITE_CREATE
  PANE_CLOUD_CREATE_DISPATCH
  PANE_WRITE_ATTACH
  PANE_HMS_LAB_ATTACH_WORKER
)
M1_ONLY_OPTIONAL_WRITE_CONTROLS=(
  HMS_DAVINCI_CREATE
  HMS_DAVINCI_MAKE_QUOTE
  HMS_DAVINCI_READS
  PANE_HMS_LAB_CREATE_WORKER
  PANE_WRITE_AMEND
  PANE_HMS_LAB_AMEND_WORKER
  PANE_WRITE_AMEND_UNPAID
  PANE_WRITE_AMEND_PAID
  PANE_WRITE_CANCEL_UNPAID
  PANE_WRITE_CANCEL_PAID
  PANE_WRITE_ADDONS
  LEGACY_INBOUND_TRIAGE_PIPELINE
  RESERVATION_V2_ARRIVAL_PREFILL
  PANE_STAY_LOOKUP
  QUOTE_RATE_CONTEXT
)
M1_ONLY_RUNTIME_DEPENDENCIES=(
  RESERVATIONIST_STAFF_QUOTE_CONFIGURATION
  HMS_EXPECTED_PROPERTY_CODE
  HMS_EXPECTED_TENANT
  HMS_EXPECTED_TRANSPORT_ID
  HMS_CHROMIUM_EXECUTABLE_PATH
  PLAYWRIGHT_BROWSERS_PATH
)
M1_ONLY_ALLOWLIST=("${M1_ONLY_WRITE_CONTROLS[@]}" "${M1_ONLY_OPTIONAL_WRITE_CONTROLS[@]}"
  "${M1_ONLY_RUNTIME_DEPENDENCIES[@]}")

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
  "BEDROCK_GUARDRAIL_VERSION", "MASTRA_STORAGE_PATH", "GOTENBERG_URL", "NAVA_BUILD_COMMIT", "PLAYWRIGHT_BROWSERS_PATH",
  "HMS_CHROMIUM_EXECUTABLE_PATH", "HMS_DAVINCI_CREATE", "HMS_DAVINCI_MAKE_QUOTE", "HMS_DAVINCI_READS",
  "HMS_EXPECTED_TENANT", "HMS_EXPECTED_PROPERTY_CODE", "HMS_EXPECTED_TRANSPORT_ID", "HMS_JOB_QUEUE", "HMS_LANE_PAUSED",
  "HMS_PREFETCH_ENABLED", "HMS_PREFETCH_PER_HOUR", "HMS_GUEST_PREFETCH_PER_HOUR", "HMS_AVAILABILITY_PREFETCH",
  "HMS_AVAILABILITY_PER_HOUR", "HMS_QUOTE_PREPARE", "HMS_QUOTE_PREPARE_PER_HOUR", "PARTY_MATCH_V2", "HMS_STAGEHAND_CDP_URL_DAVINCI",
  "RESERVATIONIST_STAFF_QUOTE_CONFIGURATION", "RESERVATIONIST_STAFF_QUOTE_CONFIGURATION_HRDAV",
  "INBOUND_EXTRACTION", "INBOUND_TRIAGE_CLASSIFIER", "LEGACY_INBOUND_TRIAGE_PIPELINE", "RESERVATION_V2_ARRIVAL_PREFILL", "PANE_STAY_LOOKUP", "QUOTE_RATE_CONTEXT", "NEEDS_YOU_SINCE",
  "PANE_WRITE_CREATE", "PANE_HMS_LAB_CREATE_WORKER", "PANE_CLOUD_CREATE_DISPATCH", "PANE_WRITE_AMEND", "PANE_HMS_LAB_AMEND_WORKER", "PANE_WRITE_AMEND_UNPAID", "PANE_WRITE_AMEND_PAID",
  "PANE_WRITE_CANCEL_UNPAID", "PANE_WRITE_CANCEL_PAID", "PANE_WRITE_ADDONS", "PANE_WRITE_ATTACH",
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
    const validate = (keys, allowed) => {
      for (const key of keys) if (values.has(key) && !allowed.includes(values.get(key))) throw new Error("invalid");
    };
    validate(["PANE_WRITE_CREATE", "PANE_WRITE_AMEND", "PANE_WRITE_AMEND_UNPAID", "PANE_WRITE_AMEND_PAID",
      "PANE_WRITE_CANCEL_UNPAID", "PANE_WRITE_CANCEL_PAID", "PANE_WRITE_ADDONS", "PANE_WRITE_ATTACH"], ["off", "lab", "on"]);
    validate(["PANE_HMS_LAB_CREATE_WORKER", "PANE_HMS_LAB_ATTACH_WORKER", "PANE_HMS_LAB_AMEND_WORKER",
      "PANE_CLOUD_CREATE_DISPATCH", "HMS_JOB_QUEUE", "HMS_AVAILABILITY_PREFETCH",
      "LEGACY_INBOUND_TRIAGE_PIPELINE", "RESERVATION_V2_ARRIVAL_PREFILL", "PANE_STAY_LOOKUP"], ["off", "on"]);
    const quoteRateContext = values.get("QUOTE_RATE_CONTEXT")?.trim().toLowerCase();
    if (quoteRateContext && !["off", "on"].includes(quoteRateContext)) throw new Error("invalid");
    validate(["HMS_PREFETCH_ENABLED", "HMS_LANE_PAUSED", "PARTY_MATCH_V2"], ["true", "false", "1", "0"]);
    validate(["HMS_QUOTE_PREPARE"], ["true", "false", "1", "0", "on", "off"]);
    for (const key of ["HMS_PREFETCH_PER_HOUR", "HMS_GUEST_PREFETCH_PER_HOUR", "HMS_AVAILABILITY_PER_HOUR", "HMS_QUOTE_PREPARE_PER_HOUR"]) {
      if (values.has(key) && !/^\d{1,15}$/.test(values.get(key))) throw new Error("invalid");
    }
    for (const [key, pattern] of [["HMS_EXPECTED_TENANT", /^[A-Z][A-Z0-9_]+$/],
      ["HMS_EXPECTED_PROPERTY_CODE", /^[A-Z][A-Z0-9]+$/],
      ["HMS_EXPECTED_TRANSPORT_ID", /^transport-[a-z0-9]+(?:-[a-z0-9]+)*$/]]) {
      if (values.has(key) && !pattern.test(values.get(key))) throw new Error("invalid");
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

M1_ONLY=0
if [ "$(id -un)" != "ubuntu" ]; then
  echo "write-ec2-remote-env.sh must run as ubuntu" >&2
  exit 2
fi

case "${1:-}" in
  --validate)
    validate_remote_env_files
    exit 0
    ;;
  --m1-only)
    [ "$#" -eq 1 ] || exit 2
    M1_ONLY=1
    ;;
  --ensure-model | --validate-model | --prepare-model)
    [ "$#" -eq 1 ] || exit 2
    ;;
  --check-model)
    [ "$#" -eq 2 ] || exit 2
    ;;
  '') ;;
  *)
    echo "usage: $0 [--m1-only|--validate|--ensure-model|--validate-model|--prepare-model|--check-model dir]" >&2
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
if [ -n "${1:-}" ] && [ "$M1_ONLY" -eq 0 ]; then
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

if [ "$M1_ONLY" -eq 1 ]; then
  # Validate both existing overlays, but preserve them unless M1 common changes.
  validate_remote_env_files
fi

M1_SOURCE_BEFORE_SHA=""
M1_COMMON_BEFORE_SHA=""
M1_ADMIN_BEFORE_SHA=""
if [ "$M1_ONLY" -eq 1 ]; then
  M1_SOURCE_BEFORE_SHA="$(sha256sum -- "$LEGACY_ENV_FILE" | awk '{print $1}')"
  M1_COMMON_BEFORE_SHA="$(sha256sum -- "$REMOTE_COMMON_ENV" | awk '{print $1}')"
  M1_ADMIN_BEFORE_SHA="$(sha256sum -- "$REMOTE_ADMIN_ENV" | awk '{print $1}')"
fi

REMOTE_COMMON_TMP="$(mktemp "${SERVER_PILOT}/.env.remote-common.tmp.XXXXXX")"
REMOTE_ADMIN_TMP=""
REMOTE_M1_SOURCE_TMP=""
if [ "$M1_ONLY" -eq 0 ]; then
  REMOTE_ADMIN_TMP="$(mktemp "${SERVER_PILOT}/.env.remote-admin.tmp.XXXXXX")"
fi
cleanup() {
  rm -f -- "$REMOTE_COMMON_TMP"
  if [ -n "$REMOTE_ADMIN_TMP" ]; then rm -f -- "$REMOTE_ADMIN_TMP"; fi
  if [ -n "$REMOTE_M1_SOURCE_TMP" ]; then rm -f -- "$REMOTE_M1_SOURCE_TMP"; fi
}
trap cleanup EXIT

quote_val() {
  printf "'%s'" "${1//\'/\'\\\'\'}"
}

if [ "$M1_ONLY" -eq 1 ]; then
  REMOTE_M1_SOURCE_TMP="$(mktemp "${SERVER_PILOT}/.env.remote-common-m1-source.tmp.XXXXXX")"
  node "$SCRIPT_DIR/parse-ec2-legacy-env.mjs" \
    "$LEGACY_ENV_FILE" \
    "$REMOTE_M1_SOURCE_TMP" \
    "${M1_ONLY_ALLOWLIST[@]}"
  node - "$REMOTE_COMMON_ENV" "$REMOTE_M1_SOURCE_TMP" "$REMOTE_COMMON_TMP" \
    "${M1_ONLY_ALLOWLIST[@]}" \
    "$((${#M1_ONLY_WRITE_CONTROLS[@]} + ${#M1_ONLY_OPTIONAL_WRITE_CONTROLS[@]}))" \
    "${#M1_ONLY_WRITE_CONTROLS[@]}" <<'NODE'
const fs = require("fs");
const args = process.argv.slice(2);
const [installedPath, sourcePath, candidatePath] = args;
const requiredControlCount = Number(args.pop());
const controlCount = Number(args.pop());
const keys = args.slice(3);
const controlKeys = new Set(keys.slice(0, controlCount));
const dependencyKeys = new Set(keys.slice(controlCount));
const target = new Set(keys);
const sourceAuthoritativeReadControls = new Set([
  "LEGACY_INBOUND_TRIAGE_PIPELINE", "RESERVATION_V2_ARRIVAL_PREFILL", "PANE_STAY_LOOKUP", "QUOTE_RATE_CONTEXT",
]);
const chunks = (text) => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
const body = (line) => line.endsWith("\n") ? line.slice(0, -1) : line;
const keyOf = (line) => /^([A-Z][A-Z0-9_]*)=/.exec(body(line))?.[1];
const parse = (path) => {
  const result = new Map();
  for (const line of chunks(fs.readFileSync(path, "utf8"))) {
    const key = keyOf(line);
    if (!key) continue;
    if (result.has(key)) throw new Error("duplicate");
    result.set(key, line);
  }
  return result;
};
const fail = (message) => {
  process.stderr.write(`${message}\n`);
  process.exit(2);
};
try {
  const source = parse(sourcePath);
  for (const key of keys) {
    // The Centurion descriptor is optional on installations using only the HRDAV descriptor.
    const required = (dependencyKeys.has(key) && key !== "RESERVATIONIST_STAFF_QUOTE_CONFIGURATION") || keys.indexOf(key) < requiredControlCount;
    if (!target.has(key) || (required && !source.has(key))) fail(`M1 durable key missing: ${key}`);
  }
  const installed = chunks(fs.readFileSync(installedPath, "utf8"));
  const merged = [];
  const replaced = new Set();
  for (const line of installed) {
    const key = keyOf(line);
    if (!target.has(key)) {
      merged.push(line);
      continue;
    }
    if (replaced.has(key)) fail(`duplicate installed M1 key: ${key}`);
    replaced.add(key);
    if (!source.has(key)) {
      // Missing read flags use the application default in every process.
      if (!sourceAuthoritativeReadControls.has(key)) merged.push(line);
      continue;
    }
    if (dependencyKeys.has(key)) {
      if (body(line) !== body(source.get(key))) {
        fail(`existing M1 dependency conflicts with durable source: ${key}`);
      }
      merged.push(line);
      continue;
    }
    if (!controlKeys.has(key)) fail(`unrecognized M1 key: ${key}`);
    const ending = line.endsWith("\n") ? "\n" : "";
    merged.push(body(source.get(key)) + ending);
  }
  const appended = keys.filter((key) => source.has(key) && !replaced.has(key));
  let candidate = merged.join("");
  if (appended.length) {
    if (candidate && !candidate.endsWith("\n")) {
      fail("existing remote-common lacks final newline; refusing M1 append");
    }
    candidate += appended.map((key) => body(source.get(key))).join("\n") + "\n";
  }
  const unrelated = (text) => chunks(text).filter((line) => !target.has(keyOf(line))).join("");
  if (unrelated(candidate) !== unrelated(fs.readFileSync(installedPath, "utf8"))) {
    fail("unrelated remote-common bytes changed");
  }
  fs.writeFileSync(candidatePath, candidate, "utf8");
} catch (error) {
  if (error.message !== "duplicate") throw error;
  fail("remote-common has duplicate keys");
}
NODE
  rm -f -- "$REMOTE_M1_SOURCE_TMP"
  REMOTE_M1_SOURCE_TMP=""
  validate_remote_env_file "$REMOTE_COMMON_TMP" common
else
  node "$SCRIPT_DIR/parse-ec2-legacy-env.mjs" \
    "$LEGACY_ENV_FILE" \
    "$REMOTE_COMMON_TMP" \
    "${REMOTE_COMMON_ALLOWLIST[@]}"
fi

# Flip to `on` needs CANARY PASS <workflow> <property> <sha> on the live SHA, except the narrow Labtest bootstraps below.
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
  HMS_PREFETCH_ENABLED: "prefetch",
  HMS_AVAILABILITY_PREFETCH: "availability",
  PARTY_MATCH_V2: "party",
  INBOUND_TRIAGE_CLASSIFIER: "triage",
  LEGACY_INBOUND_TRIAGE_PIPELINE: "triage",
  INBOUND_EXTRACTION: "extraction",
  PANE_WRITE_CREATE: "create",
  PANE_HMS_LAB_CREATE_WORKER: "create",
  PANE_CLOUD_CREATE_DISPATCH: "create",
  PANE_WRITE_AMEND_UNPAID: "amend",
  PANE_WRITE_AMEND_PAID: "amend",
  PANE_WRITE_AMEND: "amend",
  PANE_HMS_LAB_AMEND_WORKER: "amend",
  PANE_WRITE_CANCEL_UNPAID: "cancel",
  PANE_WRITE_CANCEL_PAID: "cancel",
  PANE_WRITE_ADDONS: "addons",
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
  if (!isWorkflow(key)) continue;
  // Amend's lab mode is an enabled workflow too; lab -> on widens it to real guests.
  const widensAmend = key === "PANE_WRITE_AMEND" &&
    ((value === "lab" && !["lab", "on"].includes(prev.get(key))) || (value === "on" && prev.get(key) !== "on"));
  if (!widensAmend && (!isOn(value) || isOn(prev.get(key)))) continue;
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
function shaMatch(canarySha, live, exact) {
  const a = canarySha.toLowerCase();
  const b = live.toLowerCase();
  if (exact) return /^[0-9a-f]{40}$/.test(a) && a === b;
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
  PANE_WRITE_CREATE: "HRCEN",
  PANE_HMS_LAB_CREATE_WORKER: "HRCEN",
  PANE_CLOUD_CREATE_DISPATCH: "HRCEN",
  PANE_WRITE_AMEND: "HRCEN",
  PANE_WRITE_AMEND_UNPAID: "HRCEN",
  PANE_WRITE_AMEND_PAID: "HRCEN",
  PANE_HMS_LAB_AMEND_WORKER: "HRCEN",
  PANE_WRITE_CANCEL_UNPAID: "HRCEN",
  PANE_WRITE_CANCEL_PAID: "HRCEN",
  PANE_WRITE_ADDONS: "HRCEN",
  PANE_WRITE_ATTACH: "HRCEN",
  HMS_DAVINCI_CREATE: "HRDAV",
  HMS_DAVINCI_MAKE_QUOTE: "HRDAV",
  HMS_DAVINCI_READS: "HRDAV",
  PANE_HMS_LAB_ATTACH_WORKER: "HRCEN",
};
const CONFIGURED_PROPERTY_FLAGS = new Set(["HMS_JOB_QUEUE", "HMS_QUOTE_PREPARE", "HMS_PREFETCH_ENABLED",
  "HMS_AVAILABILITY_PREFETCH", "PARTY_MATCH_V2"]);
for (const flag of flips) {
  // These authority switches may bootstrap only in their dedicated Labtest modes.
  // The PANE_WRITE_* lab -> on widenings below still require an exact HRCEN canary.
  const labOnlyBootstrap =
    (flag === "PANE_CLOUD_CREATE_DISPATCH" && next.get("PANE_WRITE_CREATE") === "lab") ||
    (flag === "PANE_HMS_LAB_ATTACH_WORKER" && next.get("PANE_WRITE_ATTACH") === "lab");
  if (labOnlyBootstrap) continue;
  const neededProperty = FLAG_PROPERTY[flag] || (CONFIGURED_PROPERTY_FLAGS.has(flag) ?
    (next.get("HMS_EXPECTED_PROPERTY_CODE") || "HRCEN") : undefined);
  const exactSha = neededProperty === "HRCEN";
  const hit = rows.find(
    (row) =>
      workflowMatch(flag, row.workflow) &&
      /^(HRCEN|HRDAV)$/.test(row.property) &&
      (!neededProperty || row.property === neededProperty) &&
      shaMatch(row.sha, liveSha, exactSha),
  );
  if (hit) continue;
  const stale = rows.some((row) => workflowMatch(flag, row.workflow) &&
    (!neededProperty || row.property === neededProperty));
  process.stderr.write(
    stale
      ? `write-ec2-remote-env: refuse: stale canary SHA for ${flag} (live ${liveSha})\n`
      : `write-ec2-remote-env: refuse: no CANARY PASS <workflow> <property> <sha> for ${flag}\n`,
  );
  process.exit(2);
}
NODE

if [ "$M1_ONLY" -eq 0 ]; then
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
fi

if [ "$M1_ONLY" -eq 1 ]; then
  node -e 'const fs=require("fs");const fd=fs.openSync(process.argv[1],"r");try{fs.fsyncSync(fd)}finally{fs.closeSync(fd)}' \
    "$REMOTE_COMMON_TMP"
else
  node -e 'const fs=require("fs"); for (const path of process.argv.slice(1)) { const fd=fs.openSync(path,"r"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }' \
    "$REMOTE_COMMON_TMP" "$REMOTE_ADMIN_TMP"
fi
chmod 600 "$REMOTE_COMMON_TMP"
if [ "$M1_ONLY" -eq 0 ]; then chmod 600 "$REMOTE_ADMIN_TMP"; fi
if [ "$(stat -c '%a:%U:%G' "$REMOTE_COMMON_TMP")" != "600:ubuntu:ubuntu" ] ||
  { [ "$M1_ONLY" -eq 0 ] && [ "$(stat -c '%a:%U:%G' "$REMOTE_ADMIN_TMP")" != "600:ubuntu:ubuntu" ]; }; then
  echo "remote env temporary files must be ubuntu-owned mode 0600" >&2
  exit 2
fi
if [ "$M1_ONLY" -eq 1 ] && {
  [ "$(sha256sum -- "$LEGACY_ENV_FILE" | awk '{print $1}')" != "$M1_SOURCE_BEFORE_SHA" ] ||
    [ "$(sha256sum -- "$REMOTE_COMMON_ENV" | awk '{print $1}')" != "$M1_COMMON_BEFORE_SHA" ] ||
    [ "$(sha256sum -- "$REMOTE_ADMIN_ENV" | awk '{print $1}')" != "$M1_ADMIN_BEFORE_SHA" ];
}; then
  echo "M1 env source or existing overlays changed during render" >&2
  exit 2
fi

# All validation completes before promotion. M1-only replaces only common; admin stays byte-identical.
mv -f -- "$REMOTE_COMMON_TMP" "$REMOTE_COMMON_ENV"
if [ "$M1_ONLY" -eq 0 ]; then mv -f -- "$REMOTE_ADMIN_TMP" "$REMOTE_ADMIN_ENV"; fi
node -e 'const fs=require("fs");const fd=fs.openSync(process.argv[1],"r");try{fs.fsyncSync(fd)}finally{fs.closeSync(fd)}' "$SERVER_PILOT"
REMOTE_COMMON_TMP=""
if [ "$M1_ONLY" -eq 0 ]; then REMOTE_ADMIN_TMP=""; fi
trap - EXIT
if [ "$M1_ONLY" -eq 1 ]; then
  echo "Wrote remote HTTP M1 common environment with mode 0600; admin unchanged"
else
  echo "Wrote remote HTTP environment files with mode 0600"
fi
