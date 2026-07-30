#!/usr/bin/env bash
# Write /home/ubuntu/repos/zero/apps/server-pilot/.env.production on EC2.
# Run as root (sudo) so install -o ubuntu works. Pulls DATABASE_URL from
# Secrets Manager via the EC2 instance profile; S3_BUCKET and BETTER_AUTH_SECRET
# must be passed in via env. File is owned by ubuntu, mode 600, untracked.
set -euo pipefail

: "${AWS_REGION:=af-south-1}"
: "${DB_SECRET_NAME:=nava-zero/server-pilot/database-url}"
: "${S3_BUCKET:?S3_BUCKET required}"
: "${BETTER_AUTH_URL:=https://nava.legacy.local}"
: "${BETTER_AUTH_SECRET:?BETTER_AUTH_SECRET required}"
: "${POP3_POLL_INTERVAL_MS:=30000}"
: "${POP3_MAX_MESSAGES_PER_CYCLE:=500}"
: "${UNDO_SEND_SECONDS:=20}"

DATABASE_URL="$(
  aws secretsmanager get-secret-value \
    --region "$AWS_REGION" \
    --secret-id "$DB_SECRET_NAME" \
    --query SecretString \
    --output text \
    | node -e 'let data=""; process.stdin.on("data", c => data += c); process.stdin.on("end", () => process.stdout.write(JSON.parse(data).DATABASE_URL));'
)"

ENV_PATH="/home/ubuntu/repos/zero/apps/server-pilot/.env.production"
install -o ubuntu -g ubuntu -m 600 /dev/null "$ENV_PATH"

# Quote values so special chars in secrets/URLs cannot break shell parsing.
quote_val() {
  printf "'%s'" "${1//\'/\'\\\'\'}"
}

cat > "$ENV_PATH" <<EOF
NODE_ENV='production'
PORT='8788'
DATABASE_URL=$(quote_val "$DATABASE_URL")
BETTER_AUTH_URL=$(quote_val "$BETTER_AUTH_URL")
BETTER_AUTH_SECRET=$(quote_val "$BETTER_AUTH_SECRET")
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
    printf '%s=%s\n' "$key" "$(quote_val "$val")" >> "$ENV_PATH"
  fi
}

append_env INGEST_FIXTURE_DIR "${INGEST_FIXTURE_DIR:-}"
append_env POP3_HOST "${POP3_HOST:-}"
append_env POP3_PORT "${POP3_PORT:-}"
append_env POP3_TLS "${POP3_TLS:-}"
append_env POP3_TLS_REJECT_UNAUTHORIZED "${POP3_TLS_REJECT_UNAUTHORIZED:-}"
append_env POP3_USER "${POP3_USER:-}"
append_env POP3_PASSWORD "${POP3_PASSWORD:-}"
append_env POP3_SECRET_ARN "${POP3_SECRET_ARN:-}"
append_env SMTP_HOST "${SMTP_HOST:-}"
append_env SMTP_PORT "${SMTP_PORT:-}"
append_env SMTP_SECURE "${SMTP_SECURE:-}"
append_env SMTP_REQUIRE_TLS "${SMTP_REQUIRE_TLS:-}"
append_env SMTP_TLS_SERVERNAME "${SMTP_TLS_SERVERNAME:-}"
append_env SMTP_USER "${SMTP_USER:-}"
append_env SMTP_PASSWORD "${SMTP_PASSWORD:-}"
append_env AI_DRAFTS_ENABLED "${AI_DRAFTS_ENABLED:-}"
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

# HMS read runtime (optional; required when HMS_DRAFT_ENRICHMENT_MODE != off).
# Gate defaults: enrichment off; never emit mutation-enable keys.
append_env HMS_DRAFT_ENRICHMENT_MODE "${HMS_DRAFT_ENRICHMENT_MODE:-off}"
append_env HMS_READ_SECRET_ARN "${HMS_READ_SECRET_ARN:-}"
append_env HMS_CHROMIUM_EXECUTABLE_PATH "${HMS_CHROMIUM_EXECUTABLE_PATH:-}"
append_env HMS_HEALTH_STATUS_PATH "${HMS_HEALTH_STATUS_PATH:-}"
append_env HMS_RUN_DEADLINE_MS "${HMS_RUN_DEADLINE_MS:-}"
append_env HMS_CIRCUIT_COOLDOWN_MS "${HMS_CIRCUIT_COOLDOWN_MS:-}"
append_env HMS_READ_GATE_VERSION "${HMS_READ_GATE_VERSION:-1}"
# Intentionally omitted (must never appear): HMS_MUTATION_ENABLED, HMS_WRITE_ENABLED,
# HMS_WRITE_ADAPTERS, HMS_ALLOW_LIVE_WRITE, HMS_LIVE_MUTATION, INFOR_HMS_WRITE.

chown ubuntu:ubuntu "$ENV_PATH"
chmod 600 "$ENV_PATH"
echo "Wrote $ENV_PATH owned by ubuntu with mode 600"
