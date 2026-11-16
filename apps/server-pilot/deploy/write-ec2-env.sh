#!/usr/bin/env bash
# Write /home/ubuntu/repos/zero/apps/server-pilot/.env.production on EC2.
# Run as root (sudo) so install -o ubuntu works. Pulls DATABASE_URL from
# Secrets Manager via the EC2 instance profile; S3_BUCKET and BETTER_AUTH_SECRET
# must be passed in via env. File is owned by ubuntu, mode 600, untracked.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
POLICY_MODULE="$SCRIPT_DIR/../tooling/hms-cloud/hms-workflow-policy.mjs"
[ ! -e "${NAVA_RUN_HOLD_FILE:-/tmp/mh1024/HOLD.txt}" ] || { echo 'durable env refused: HOLD file present' >&2; exit 2; }

: "${AWS_REGION:=af-south-1}"
: "${DB_SECRET_NAME:=nava-zero/server-pilot/database-url}"
: "${OUTLOOK_DEVICE_WRAPPING_KEY_SECRET_NAME:=nava-zero/server-pilot/outlook-device-wrapping-key}"
: "${S3_BUCKET:?S3_BUCKET required}"
: "${BETTER_AUTH_URL:=https://nava.legacyhotels.co.za}"
: "${BETTER_AUTH_SECRET:?BETTER_AUTH_SECRET required}"
: "${POP3_POLL_INTERVAL_MS:=30000}"
: "${POP3_MAX_MESSAGES_PER_CYCLE:=500}"
: "${UNDO_SEND_SECONDS:=20}"

# Validate the shared controls before fetching secrets or preparing a candidate.
node --input-type=module - "$POLICY_MODULE" <<'NODE'
import { pathToFileURL } from 'node:url';
const { SCOPED_RUNTIME_CONTROL_KEYS, validateRuntimeControl } = await import(pathToFileURL(process.argv[2]).href);
try {
  for (const key of SCOPED_RUNTIME_CONTROL_KEYS) validateRuntimeControl(key, process.env[key]);
} catch {
  process.stderr.write('invalid shared runtime control\n');
  process.exit(2);
}
NODE
shared_controls="$(node --input-type=module -e 'const m=await import(process.argv[1]); process.stdout.write(m.SCOPED_RUNTIME_CONTROL_KEYS.join("\n"));' "$POLICY_MODULE")"
mapfile -t HMS_SHARED_CONTROLS <<<"$shared_controls"
# Reject misspelled release controls before touching the existing env file.
for key in PANE_WRITE_CREATE PANE_WRITE_AMEND PANE_WRITE_AMEND_UNPAID PANE_WRITE_AMEND_PAID \
  PANE_WRITE_CANCEL_UNPAID PANE_WRITE_CANCEL_PAID PANE_WRITE_ATTACH; do
  case "${!key:-}" in ''|off|lab|on) ;; *) echo "invalid $key" >&2; exit 2 ;; esac
done
for key in PANE_HMS_LAB_CREATE_WORKER PANE_HMS_LAB_ATTACH_WORKER PANE_HMS_LAB_AMEND_WORKER \
  PANE_CLOUD_CREATE_DISPATCH HMS_JOB_QUEUE HMS_AVAILABILITY_PREFETCH LEGACY_INBOUND_TRIAGE_PIPELINE RESERVATION_V2_ARRIVAL_PREFILL PANE_STAY_LOOKUP; do
  case "${!key:-}" in ''|off|on) ;; *) echo "invalid $key" >&2; exit 2 ;; esac
done
case "${PANE_BRAIN:-}" in ''|agent|classifier) ;; *) echo 'invalid PANE_BRAIN' >&2; exit 2 ;; esac
quote_rate_context="${QUOTE_RATE_CONTEXT:-}"
quote_rate_context="${quote_rate_context#"${quote_rate_context%%[![:space:]]*}"}"
quote_rate_context="${quote_rate_context%"${quote_rate_context##*[![:space:]]}"}"
case "${quote_rate_context,,}" in ''|off|on) ;; *) echo 'invalid QUOTE_RATE_CONTEXT' >&2; exit 2 ;; esac
unset quote_rate_context
for key in HMS_PREFETCH_ENABLED HMS_LANE_PAUSED PARTY_MATCH_V2; do
  case "${!key:-}" in ''|true|false|1|0) ;; *) echo "invalid $key" >&2; exit 2 ;; esac
done
case "${HMS_QUOTE_PREPARE:-}" in ''|true|false|1|0|on|off) ;; *) echo 'invalid HMS_QUOTE_PREPARE' >&2; exit 2 ;; esac
for key in HMS_PREFETCH_PER_HOUR HMS_GUEST_PREFETCH_PER_HOUR HMS_AVAILABILITY_PER_HOUR HMS_QUOTE_PREPARE_PER_HOUR; do
  value="${!key:-}"
  if [[ -n "$value" && ! "$value" =~ ^[0-9]{1,15}$ ]]; then echo "invalid $key" >&2; exit 2; fi
done
unset key value

DATABASE_URL="$(
  aws secretsmanager get-secret-value \
    --region "$AWS_REGION" \
    --secret-id "$DB_SECRET_NAME" \
    --query SecretString \
    --output text \
    | node -e 'let data=""; process.stdin.on("data", c => data += c); process.stdin.on("end", () => process.stdout.write(JSON.parse(data).DATABASE_URL));'
)"
if [[ -z "$DATABASE_URL" ]]; then
  echo "database secret did not contain DATABASE_URL" >&2
  exit 1
fi

# Operator provisions this dedicated, stable Secrets Manager SecretString once.
# Fetch on every env refresh; never rotate/recreate it during deployment or use
# the DB/Auth credentials as substitutes. A missing/invalid value leaves the
# existing production env untouched and never prints the candidate key.
NAVA_OUTLOOK_DEVICE_WRAPPING_KEY="$(
  aws secretsmanager get-secret-value \
    --region "$AWS_REGION" \
    --secret-id "$OUTLOOK_DEVICE_WRAPPING_KEY_SECRET_NAME" \
    --query SecretString \
    --output text 2>/dev/null \
    | node -e 'let raw=""; process.stdin.on("data", chunk => raw += chunk); process.stdin.on("end", () => { raw=raw.trim(); const bytes=Buffer.from(raw, "base64"); if (!/^[A-Za-z0-9+/]{43}=$/.test(raw) || bytes.length !== 32 || bytes.toString("base64") !== raw) { process.stderr.write("Outlook device wrapping key missing or invalid\n"); process.exitCode=1; return; } process.stdout.write(raw); });'
)"

# Real SMTP is Rocketseed-only (IP-trust). Validate before touching live env.
if [[ "${MAIL_TRANSPORT_MODE:-fixture}" == "real" ]]; then
  : "${SMTP_HOST:=172.24.0.8}"
  : "${SMTP_PORT:=587}"
  : "${SMTP_SECURE:=false}"
  if [[ "${SMTP_HOST}" != "172.24.0.8" ]]; then
    echo "SMTP_HOST must be 172.24.0.8 when MAIL_TRANSPORT_MODE=real (got ${SMTP_HOST})" >&2
    exit 1
  fi
fi

ENV_PATH="/home/ubuntu/repos/zero/apps/server-pilot/.env.production"
ENV_TMP="$(mktemp "${ENV_PATH}.tmp.XXXXXX")"
cleanup_env_tmp() { rm -f -- "$ENV_TMP"; }
trap cleanup_env_tmp EXIT
install -o root -g root -m 600 /dev/null "$ENV_TMP"

# Quote values so special chars in secrets/URLs cannot break shell parsing.
quote_val() {
  printf "'%s'" "${1//\'/\'\\\'\'}"
}

cat > "$ENV_TMP" <<EOF
NODE_ENV='production'
PORT='8788'
DATABASE_URL=$(quote_val "$DATABASE_URL")
BETTER_AUTH_URL=$(quote_val "$BETTER_AUTH_URL")
BETTER_AUTH_SECRET=$(quote_val "$BETTER_AUTH_SECRET")
NAVA_OUTLOOK_DEVICE_WRAPPING_KEY=$(quote_val "$NAVA_OUTLOOK_DEVICE_WRAPPING_KEY")
AWS_REGION=$(quote_val "$AWS_REGION")
S3_BUCKET=$(quote_val "$S3_BUCKET")
POP3_POLL_INTERVAL_MS=$(quote_val "$POP3_POLL_INTERVAL_MS")
POP3_MAX_MESSAGES_PER_CYCLE=$(quote_val "$POP3_MAX_MESSAGES_PER_CYCLE")
MAIL_TRANSPORT_MODE=$(quote_val "${MAIL_TRANSPORT_MODE:-fixture}")
UNDO_SEND_SECONDS=$(quote_val "$UNDO_SEND_SECONDS")
PILOT_OPEN_SIGNUP='0'
EOF

# Optional real-mail POP3/SMTP keys (quoted when present).
append_env() {
  local key="$1"
  local val="${2:-}"
  if [[ -n "$val" ]]; then
    printf '%s=%s\n' "$key" "$(quote_val "$val")" >> "$ENV_TMP"
  fi
}

append_env INGEST_FIXTURE_DIR "${INGEST_FIXTURE_DIR:-}"
append_env POP3_HOST "${POP3_HOST:-}"
append_env POP3_PORT "${POP3_PORT:-}"
append_env POP3_TLS "${POP3_TLS:-}"
append_env POP3_USER "${POP3_USER:-}"
append_env POP3_PASSWORD "${POP3_PASSWORD:-}"
append_env POP3_SECRET_ARN "${POP3_SECRET_ARN:-}"
append_env SMTP_HOST "${SMTP_HOST:-}"
append_env SMTP_PORT "${SMTP_PORT:-}"
append_env SMTP_SECURE "${SMTP_SECURE:-}"
append_env SMTP_USER "${SMTP_USER:-}"
# Optional: leftover SMTP_PASSWORD is ignored by RealSmtpTransport on Rocketseed.
append_env SMTP_PASSWORD "${SMTP_PASSWORD:-}"
append_env AI_DRAFTS_ENABLED "${AI_DRAFTS_ENABLED:-}"
append_env CATCHUP_UPLOAD_ENABLED "${CATCHUP_UPLOAD_ENABLED:-}"
# Real-mail: durable triage writes on by default (ops can still override).
if [[ "${MAIL_TRANSPORT_MODE:-fixture}" == "real" ]]; then
  append_env AI_WRITE_GATE_ENABLED "${AI_WRITE_GATE_ENABLED:-true}"
  # Pilot: allow unstamped Centurion BCC copies until IT stamps X-Zero-Mailbox.
  append_env INGEST_REQUIRE_OWNER_HEADER "${INGEST_REQUIRE_OWNER_HEADER:-false}"
else
  append_env AI_WRITE_GATE_ENABLED "${AI_WRITE_GATE_ENABLED:-}"
  append_env INGEST_REQUIRE_OWNER_HEADER "${INGEST_REQUIRE_OWNER_HEADER:-}"
fi
append_env SMTP_SECRET_ARN "${SMTP_SECRET_ARN:-}"
append_env MAIL_TLS_REJECT_UNAUTHORIZED "${MAIL_TLS_REJECT_UNAUTHORIZED:-}"

# HMS read runtime (optional; required when HMS_DRAFT_ENRICHMENT_MODE != off).
# Gate defaults: enrichment off; never emit mutation-enable keys.
append_env HMS_DRAFT_ENRICHMENT_MODE "${HMS_DRAFT_ENRICHMENT_MODE:-off}"
append_env HMS_READ_SECRET_ARN "${HMS_READ_SECRET_ARN:-}"
# Evidence HMAC: ARN + key version metadata only (never raw key).
EVIDENCE_META="${HMS_EVIDENCE_HMAC_ENV_FILE:-/etc/nava/hms-evidence-hmac.env}"
if [[ -f "$EVIDENCE_META" ]]; then
  # shellcheck disable=SC1090
  set -a
  # shellcheck disable=SC1090
  source "$EVIDENCE_META"
  set +a
fi
append_env HMS_EVIDENCE_HMAC_SECRET_ARN "${HMS_EVIDENCE_HMAC_SECRET_ARN:-}"
append_env HMS_EVIDENCE_HMAC_KEY_VERSION "${HMS_EVIDENCE_HMAC_KEY_VERSION:-}"
# Intentionally omitted: HMS_EVIDENCE_HMAC_KEY (child-only via asm-exec).
append_env HMS_CHROMIUM_EXECUTABLE_PATH "/opt/nava/chromium/chrome"
append_env PLAYWRIGHT_BROWSERS_PATH "${PLAYWRIGHT_BROWSERS_PATH:-/opt/nava/ms-playwright}"
append_env HMS_READ_ROLE_PROOF_PATH "${HMS_READ_ROLE_PROOF_PATH:-/etc/nava/hms-read-role-proof.v1.json}"
append_env HMS_HEALTH_STATUS_PATH "${HMS_HEALTH_STATUS_PATH:-/tmp/nava-zero-hms-health.json}"
append_env HMS_EXPECTED_TENANT "${HMS_EXPECTED_TENANT:-THECENTURION_PRD}"
append_env HMS_EXPECTED_PROPERTY_CODE "${HMS_EXPECTED_PROPERTY_CODE:-HRCEN}"
append_env HMS_EXPECTED_TRANSPORT_ID "${HMS_EXPECTED_TRANSPORT_ID:-transport-centurion}"
append_env HMS_RUN_DEADLINE_MS "${HMS_RUN_DEADLINE_MS:-}"
append_env HMS_CIRCUIT_COOLDOWN_MS "${HMS_CIRCUIT_COOLDOWN_MS:-}"
append_env HMS_READ_GATE_VERSION "${HMS_READ_GATE_VERSION:-1}"
append_env NAVA_BUILD_COMMIT "${NAVA_BUILD_COMMIT:-}"
append_env HMS_SHADOW_SERVICE_USER_ID "${HMS_SHADOW_SERVICE_USER_ID:-}"
append_env HMS_BROWSER_ARTIFACT_ROOT "${HMS_BROWSER_ARTIFACT_ROOT:-/opt/nava/shared/hms-browser-artifacts}"
append_env GOTENBERG_URL "${GOTENBERG_URL:-http://127.0.0.1:3000}"
# Optional Azure Luna (quote analyse). Fetch fails closed: omit keys, never echo values.
: "${AZURE_LUNA_SECRET_NAME:=nava-zero/server-pilot/azure-luna}"
AZURE_LUNA_PARSED="$(
  aws secretsmanager get-secret-value \
    --region "$AWS_REGION" \
    --secret-id "$AZURE_LUNA_SECRET_NAME" \
    --query SecretString \
    --output text 2>/dev/null \
    | node -e '
      let raw = "";
      process.stdin.on("data", (chunk) => { raw += chunk; });
      process.stdin.on("end", () => {
        try {
          const parsed = JSON.parse(raw);
          const base = typeof parsed.AZURE_OPENAI_BASE_URL === "string" ? parsed.AZURE_OPENAI_BASE_URL.trim() : "";
          const key = typeof parsed.AZURE_FOUNDRY_API_KEY === "string" ? parsed.AZURE_FOUNDRY_API_KEY.trim() : "";
          if (!base || !key || /[\r\n\0]/.test(base) || /[\r\n\0]/.test(key)) process.exit(0);
          process.stdout.write(JSON.stringify({ AZURE_OPENAI_BASE_URL: base, AZURE_FOUNDRY_API_KEY: key }));
        } catch {
          process.exit(0);
        }
      });
    ' || true
)"
if [[ -n "${AZURE_LUNA_PARSED}" ]]; then
  AZURE_OPENAI_BASE_URL="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).AZURE_OPENAI_BASE_URL)' "$AZURE_LUNA_PARSED")"
  AZURE_FOUNDRY_API_KEY="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).AZURE_FOUNDRY_API_KEY)' "$AZURE_LUNA_PARSED")"
  append_env AZURE_OPENAI_BASE_URL "$AZURE_OPENAI_BASE_URL"
  append_env AZURE_FOUNDRY_API_KEY "$AZURE_FOUNDRY_API_KEY"
fi
append_env QUOTE_WORKFLOW_LLM "${QUOTE_WORKFLOW_LLM:-}"
append_env PANE_BRAIN "${PANE_BRAIN:-}"
# Scanned voucher PDF vision read: off unless ops set SCANNED_PDF_VISION=on.
append_env SCANNED_PDF_VISION "${SCANNED_PDF_VISION:-}"
# Quote follow-up drafts (R10): off unless ops set QUOTE_FOLLOWUPS=on.
append_env QUOTE_FOLLOWUPS "${QUOTE_FOLLOWUPS:-}"
# ISO instant: only quotes sent at or after it get follow-ups. Set it when turning QUOTE_FOLLOWUPS on (else: process start).
append_env QUOTE_FOLLOWUPS_SINCE "${QUOTE_FOLLOWUPS_SINCE:-}"
# Queued pane HMS lookups (ai-worker claims pane jobs): off unless ops set HMS_JOB_QUEUE=on.
# Prefetch also needs HMS_PREFETCH_ENABLED=1; HMS_LANE_PAUSED=1 stops every hms lane claim.
append_env HMS_JOB_QUEUE "${HMS_JOB_QUEUE:-}"
append_env HMS_LANE_PAUSED "${HMS_LANE_PAUSED:-}"
append_env LEGACY_INBOUND_TRIAGE_PIPELINE "${LEGACY_INBOUND_TRIAGE_PIPELINE:-}"
append_env RESERVATION_V2_ARRIVAL_PREFILL "${RESERVATION_V2_ARRIVAL_PREFILL:-}"
append_env PANE_STAY_LOOKUP "${PANE_STAY_LOOKUP:-}"
append_env QUOTE_RATE_CONTEXT "${QUOTE_RATE_CONTEXT:-}"
append_env HMS_QUOTE_PREPARE "${HMS_QUOTE_PREPARE:-}"
append_env HMS_QUOTE_PREPARE_PER_HOUR "${HMS_QUOTE_PREPARE_PER_HOUR:-}"
append_env HMS_PREFETCH_ENABLED "${HMS_PREFETCH_ENABLED:-}"
append_env HMS_PREFETCH_PER_HOUR "${HMS_PREFETCH_PER_HOUR:-}"
append_env HMS_GUEST_PREFETCH_PER_HOUR "${HMS_GUEST_PREFETCH_PER_HOUR:-}"
append_env PARTY_MATCH_V2 "${PARTY_MATCH_V2:-}"
# Availability probe per quote stay (U10): off unless ops set HMS_AVAILABILITY_PREFETCH=on. Needs HMS_JOB_QUEUE=on.
# HMS_AVAILABILITY_PER_HOUR caps probes apart from confirmation prefetch (default 6).
append_env HMS_AVAILABILITY_PREFETCH "${HMS_AVAILABILITY_PREFETCH:-}"
append_env HMS_AVAILABILITY_PER_HOUR "${HMS_AVAILABILITY_PER_HOUR:-}"
# Per-workflow pane writes (KTD1). Unset unless ops pass them; never default on.
append_env PANE_WRITE_CREATE "${PANE_WRITE_CREATE:-}"
append_env PANE_HMS_LAB_CREATE_WORKER "${PANE_HMS_LAB_CREATE_WORKER:-}"
# Cloud Create cutover stays off until the shared write claim is ready.
append_env PANE_CLOUD_CREATE_DISPATCH "${PANE_CLOUD_CREATE_DISPATCH:-}"
append_env PANE_WRITE_AMEND_UNPAID "${PANE_WRITE_AMEND_UNPAID:-}"
append_env PANE_WRITE_AMEND_PAID "${PANE_WRITE_AMEND_PAID:-}"
append_env PANE_WRITE_AMEND "${PANE_WRITE_AMEND:-}"
append_env PANE_HMS_LAB_AMEND_WORKER "${PANE_HMS_LAB_AMEND_WORKER:-}"
append_env PANE_WRITE_CANCEL_UNPAID "${PANE_WRITE_CANCEL_UNPAID:-}"
append_env PANE_WRITE_CANCEL_PAID "${PANE_WRITE_CANCEL_PAID:-}"
append_env PANE_WRITE_ATTACH "${PANE_WRITE_ATTACH:-}"
# The dedicated Labtest attachment claimant stays off unless explicitly enabled.
append_env PANE_HMS_LAB_ATTACH_WORKER "${PANE_HMS_LAB_ATTACH_WORKER:-}"
# Carry every supplied shared control without duplicating keys already written above.
for key in "${HMS_SHARED_CONTROLS[@]}"; do
  if ! grep -q "^${key}=" "$ENV_TMP"; then append_env "$key" "${!key:-}"; fi
done
unset AZURE_LUNA_PARSED AZURE_OPENAI_BASE_URL AZURE_FOUNDRY_API_KEY
# Intentionally omitted (must never appear): HMS_MUTATION_ENABLED, HMS_WRITE_ENABLED,
# HMS_WRITE_ADAPTERS, HMS_ALLOW_LIVE_WRITE, HMS_LIVE_MUTATION, INFOR_HMS_WRITE.

node -e 'const fs=require("fs");const fd=fs.openSync(process.argv[1],"r");try{fs.fsyncSync(fd)}finally{fs.closeSync(fd)}' "$ENV_TMP"
chown ubuntu:ubuntu "$ENV_TMP"
chmod 600 "$ENV_TMP"
[ ! -e "${NAVA_RUN_HOLD_FILE:-/tmp/mh1024/HOLD.txt}" ] || { echo 'durable env refused: HOLD file present' >&2; exit 2; }
mv -f -- "$ENV_TMP" "$ENV_PATH"
node -e 'const fs=require("fs");const fd=fs.openSync(process.argv[1],"r");try{fs.fsyncSync(fd)}finally{fs.closeSync(fd)}' "$(dirname "$ENV_PATH")"
ENV_TMP=""
trap - EXIT
echo "Wrote $ENV_PATH owned by ubuntu with mode 600"
