#!/usr/bin/env bash
# Centurion launch safety gate. Read-only except operator-run RDS protection step.
set -euo pipefail
set +x

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${AWS_REGION:=af-south-1}"
: "${INSTANCE_ID:=i-008f737974a9ba9b3}"
: "${RDS_INSTANCE_ID:=nava-zero-mail-pilot}"
: "${S3_BUCKET:=nava-zero-mail-845242190536-af-south-1}"
: "${REMOTE_ADMIN_MODE:=0}"
: "${REMOTE_TARGET_HEALTH_REQUIRED:=0}"
: "${REMOTE_ADMIN_LIFECYCLE_MODE:=}"

case "$REMOTE_ADMIN_MODE" in
  0|1) ;;
  *)
    echo "launch-readiness: REMOTE_ADMIN_MODE must be 0 or 1" >&2
    exit 2
    ;;
esac
case "$REMOTE_TARGET_HEALTH_REQUIRED" in
  0|1) ;;
  *)
    echo "launch-readiness: REMOTE_TARGET_HEALTH_REQUIRED must be 0 or 1" >&2
    exit 2
    ;;
esac
if [ "$REMOTE_ADMIN_MODE" != "1" ] && [ "$REMOTE_TARGET_HEALTH_REQUIRED" != "0" ]; then
  echo "launch-readiness: REMOTE_TARGET_HEALTH_REQUIRED requires REMOTE_ADMIN_MODE=1" >&2
  exit 2
fi
case "$REMOTE_ADMIN_LIFECYCLE_MODE" in
  ""|pre-registration|active|rollback|auto) ;;
  *)
    echo "launch-readiness: REMOTE_ADMIN_LIFECYCLE_MODE must be pre-registration, active, rollback, or auto" >&2
    exit 2
    ;;
esac
if [ "$REMOTE_ADMIN_MODE" != "1" ] && [ -n "$REMOTE_ADMIN_LIFECYCLE_MODE" ]; then
  echo "launch-readiness: REMOTE_ADMIN_LIFECYCLE_MODE requires REMOTE_ADMIN_MODE=1" >&2
  exit 2
fi
if [ "$REMOTE_ADMIN_MODE" = "1" ] && [ -z "$REMOTE_ADMIN_LIFECYCLE_MODE" ]; then
  # Preserve Task 4 callers: 0 means its original pre-registration gate;
  # 1 means its original active target-and-rule gate.
  if [ "$REMOTE_TARGET_HEALTH_REQUIRED" = "1" ]; then
    REMOTE_ADMIN_LIFECYCLE_MODE="compat-active"
  else
    REMOTE_ADMIN_LIFECYCLE_MODE="compat-pre-registration"
  fi
fi

REMOTE_ADMIN_HOST="nava-admin.trynava.io"
REMOTE_ALB_NAME="nava-remote-admin-alb"
REMOTE_TARGET_GROUP_NAME="nava-remote-admin"
REMOTE_TARGET_SECURITY_GROUP_NAME="nava-remote-admin-target"
REMOTE_WAF_NAME="nava-remote-admin-waf"
REMOTE_LOG_BUCKET="nava-zero-remote-alb-logs-845242190536-af-south-1"
REMOTE_VPC_ID="vpc-0f078e17a5f0f8599"
REMOTE_TARGET_PRIVATE_IP="172.31.12.112"
REMOTE_ALB_SUBNET_A="subnet-0e6446aaaeaa8762e"
REMOTE_ALB_SUBNET_B="subnet-094bf8643d98c22f6"

for required_command in aws node bash; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    echo "launch-readiness: missing required command: ${required_command}" >&2
    exit 2
  fi
done

REMOTE_COMMAND="$(cat <<'REMOTE'
set -euo pipefail
set +x

REPO_ROOT="${REPO_ROOT:-/home/ubuntu/repos/zero}"
SERVER_PILOT="${REPO_ROOT}/apps/server-pilot"
ENV_FILE="${ENV_FILE:-${SERVER_PILOT}/.env.production}"
REMOTE_ADMIN_MODE="__REMOTE_ADMIN_MODE__"
export REQUIRE_HOTEL_PROBE=1
export PATH="${HOME}/.local/share/pnpm:${HOME}/.nvm/versions/node/$(ls "${HOME}/.nvm/versions/node" 2>/dev/null | sort -V | tail -1)/bin:${PATH}"

ENV_LOADED=false
if [ -r "$ENV_FILE" ]; then
  set +e
  set -a
  source "$ENV_FILE" >/dev/null 2>&1
  ENV_STATUS=$?
  set +a
  set -e
  if [ "$ENV_STATUS" -eq 0 ]; then
    ENV_LOADED=true
  fi
fi

CANONICAL_ORIGIN="https://nava.legacyhotels.co.za"
: "${BETTER_AUTH_URL:?BETTER_AUTH_URL missing from production environment}"
case "$BETTER_AUTH_URL" in
  "$CANONICAL_ORIGIN"|"$CANONICAL_ORIGIN/")
    ;;
  *)
    echo "refusing: BETTER_AUTH_URL must be canonical HTTPS origin" >&2
    exit 2
    ;;
esac
PUBLIC_ORIGIN="$CANONICAL_ORIGIN"
PUBLIC_HOST="${CANONICAL_ORIGIN#https://}"
export BETTER_AUTH_URL="$PUBLIC_ORIGIN"

HTTP_OK=false
if curl --disable --noproxy '*' -fsS \
  --max-time 10 \
  "http://127.0.0.1:8788/health" >/dev/null 2>&1; then
  HTTP_OK=true
fi

HTTPS_OK=false
TLS_VALID=false
CERT_FILE="$(mktemp)"
cleanup_cert() { rm -f "$CERT_FILE"; }
trap cleanup_cert EXIT

if timeout 10 openssl s_client \
  -connect "127.0.0.1:443" \
  -servername "$PUBLIC_HOST" \
  -verify_hostname "$PUBLIC_HOST" \
  -verify_return_error \
  -CAfile /etc/ssl/certs/ca-certificates.crt \
  -showcerts </dev/null 2>/dev/null |
  openssl x509 -outform PEM >"$CERT_FILE" 2>/dev/null \
  && openssl x509 -in "$CERT_FILE" -checkend 2592000 -noout >/dev/null 2>&1; then
  TLS_VALID=true
fi

if curl --disable --noproxy '*' -fsS \
  --max-time 10 \
  --resolve "${PUBLIC_HOST}:443:127.0.0.1" \
  "${PUBLIC_ORIGIN%/}/health" >/dev/null 2>&1; then
  HTTPS_OK=true
fi

HOTEL_PROBE_OK=false
if REQUIRE_HOTEL_PROBE=1 bash "${SERVER_PILOT}/deploy/vpn-health-assert.sh" >/dev/null 2>&1; then
  HOTEL_PROBE_OK=true
fi

UFW_STATUS_READ=false
UFW_RULES_READ=false
UFW_ACTIVE=false
UFW_DEFAULT_DENY=false
UFW_TUN443=false
UFW_BROAD443_ABSENT=false
UFW_REMOTE_ALB8443_ONLY=false
UFW_VERBOSE=""
UFW_ADDED=""
EXPECTED_UFW_ALLOW='ufw allow in on tun0 to any port 443 proto tcp'
EXPECTED_UFW_REMOTE_ALB_A='ufw allow in on ens5 from 172.31.0.0/20 to any port 8443 proto tcp'
EXPECTED_UFW_REMOTE_ALB_B='ufw allow in on ens5 from 172.31.32.0/20 to any port 8443 proto tcp'

if UFW_VERBOSE="$(sudo ufw status verbose 2>/dev/null)"; then
  UFW_STATUS_READ=true
  if printf '%s\n' "$UFW_VERBOSE" | grep -q '^Status: active$'; then
    UFW_ACTIVE=true
  fi
  if printf '%s\n' "$UFW_VERBOSE" | grep -q 'Default: deny (incoming)'; then
    UFW_DEFAULT_DENY=true
  fi
fi
if UFW_ADDED="$(sudo ufw show added 2>/dev/null)"; then
  UFW_RULES_READ=true
  if [ "${REMOTE_ADMIN_MODE:-0}" = "1" ]; then
    if printf '%s\n' "$UFW_ADDED" |
      awk \
        -v legacy="$EXPECTED_UFW_ALLOW" \
        -v remote_a="$EXPECTED_UFW_REMOTE_ALB_A" \
        -v remote_b="$EXPECTED_UFW_REMOTE_ALB_B" '
        /^[[:space:]]*ufw([[:space:]]|$)/ {
          line = $0
          sub(/^[[:space:]]+/, "", line)
          sub(/[[:space:]]+$/, "", line)
          rule_count += 1
          if (line == legacy) legacy_count += 1
          else if (line == remote_a) remote_a_count += 1
          else if (line == remote_b) remote_b_count += 1
          else unexpected = 1
        }
        END {
          exit rule_count == 3 &&
            legacy_count == 1 &&
            remote_a_count == 1 &&
            remote_b_count == 1 &&
            !unexpected ? 0 : 1
        }
      '; then
      UFW_TUN443=true
      UFW_BROAD443_ABSENT=true
      UFW_REMOTE_ALB8443_ONLY=true
    fi
  elif printf '%s\n' "$UFW_ADDED" |
    awk -v expected="$EXPECTED_UFW_ALLOW" '
      /^[[:space:]]*ufw([[:space:]]|$)/ {
        line = $0
        sub(/^[[:space:]]+/, "", line)
        sub(/[[:space:]]+$/, "", line)
        rule_count += 1
        if (line == expected) exact_count += 1
      }
      END { exit rule_count == 1 && exact_count == 1 ? 0 : 1 }
    '; then
    UFW_TUN443=true
    UFW_BROAD443_ABSENT=true
  fi
fi

LISTENER_SAFE=false
if {
  printf "%s\n" "__READINESS_TCP_LISTENERS__"
  ss -ltnH
  printf "%s\n" "__READINESS_UDP_LISTENERS__"
  ss -lunH
} 2>/dev/null | node -e '
  let output = "";
  process.stdin.on("data", (chunk) => (output += chunk));
  process.stdin.on("end", () => {
    const section = (start, end) => {
      const startIndex = output.indexOf(start);
      const endIndex = output.indexOf(end);
      if (
        startIndex < 0 ||
        endIndex < 0 ||
        startIndex >= endIndex ||
        output.indexOf(start, startIndex + 1) >= 0 ||
        output.indexOf(end, endIndex + 1) >= 0
      ) {
        return null;
      }
      return output
        .slice(startIndex + start.length, endIndex)
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    };
    const tcpLines = section(
      "__READINESS_TCP_LISTENERS__",
      "__READINESS_UDP_LISTENERS__",
    );
    const udpStart = output.indexOf("__READINESS_UDP_LISTENERS__");
    const udpLines =
      udpStart < 0 || output.indexOf("__READINESS_UDP_LISTENERS__", udpStart + 1) >= 0
        ? null
        : output
            .slice(udpStart + "__READINESS_UDP_LISTENERS__".length)
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean);
    if (tcpLines === null || udpLines === null) process.exit(1);
    const listenAddresses = (lines, port, requireListen) =>
      lines.flatMap((line) => {
        if (requireListen && !/\bLISTEN\b/.test(line)) return [];
        const suffix = `:${port}`;
        const local = line.split(/\s+/).find((field) => field.endsWith(suffix));
        return local ? [local.slice(0, -suffix.length)] : [];
      });
    const loopbackOnly = (port) => {
      const addresses = listenAddresses(tcpLines, port, true);
      return (
        addresses.length > 0 &&
        addresses.every(
          (address) =>
            address === "127.0.0.1" ||
            address === "::1" ||
            address === "[::1]",
        )
      );
    };
    const target8443 = listenAddresses(tcpLines, 8443, true);
    const udp8443 = listenAddresses(udpLines, 8443, false);
    const safe =
      loopbackOnly(8788) &&
      loopbackOnly(8789) &&
      target8443.length === 1 &&
      target8443[0] === "172.31.12.112" &&
      udp8443.length === 0;
    process.exit(safe ? 0 : 1);
  });
'; then
  LISTENER_SAFE=true
fi

PM2_SUMMARY="$(
  if command -v pm2 >/dev/null 2>&1; then
    pm2 jlist 2>/dev/null | node -e '
      let raw = "";
      process.stdin.on("data", (chunk) => (raw += chunk));
      process.stdin.on("end", () => {
        try {
          const apps = JSON.parse(raw);
          const requiredNames = ["http", "worker", "ai-worker"];
          const required = {};
          for (const name of requiredNames) {
            const app = apps.find((candidate) => candidate.name === name);
            required[name] = {
              present: Boolean(app),
              online: app?.pm2_env?.status === "online",
              restarts: Number(app?.pm2_env?.restart_time ?? 0),
            };
          }
          // Conditional HMS: hms-ai-worker must be absent at launch-readiness
          // (HMS_OFF). Sole starter is ops-hms-shadow.sh; proofs under
          // /opt/nava/shared/hms-reservation-*-proof.v1.json are ops-only.
          const hms = apps.find((candidate) => candidate.name === "hms-ai-worker");
          const hmsPresent = Boolean(hms);
          process.stdout.write(JSON.stringify({
            required,
            allOnline: requiredNames.every((name) => required[name].online),
            hmsAiWorkerPresent: hmsPresent,
            hmsOff: !hmsPresent,
          }));
        } catch {
          process.stdout.write(JSON.stringify({ required: {}, allOnline: false }));
        }
      });
    '
  else
    printf '%s' '{"required":{},"allOnline":false}'
  fi
)"
if [ -z "$PM2_SUMMARY" ]; then
  PM2_SUMMARY='{"required":{},"allOnline":false}'
fi

DISK_USED_PERCENT=100
DISK_FREE_MB=0
read -r DISK_USED_PERCENT DISK_FREE_KB < <(
  df -Pk / | awk 'NR == 2 { gsub("%", "", $5); print $5, $4 }'
)
DISK_FREE_MB=$((DISK_FREE_KB / 1024))
DISK_SAFE=false
if [ "$DISK_USED_PERCENT" -lt "${MAX_DISK_USED_PERCENT:-85}" ] \
  && [ "$DISK_FREE_MB" -ge "${MIN_DISK_FREE_MB:-2048}" ]; then
  DISK_SAFE=true
fi

export HTTP_OK HTTPS_OK TLS_VALID HOTEL_PROBE_OK ENV_LOADED
export DISK_USED_PERCENT DISK_FREE_MB DISK_SAFE
export PM2_SUMMARY
export UFW_STATUS_READ UFW_RULES_READ
export UFW_ACTIVE UFW_DEFAULT_DENY UFW_TUN443 UFW_BROAD443_ABSENT UFW_REMOTE_ALB8443_ONLY LISTENER_SAFE

cd "$SERVER_PILOT"
DB_SUMMARY="$(
  node --input-type=module <<'NODE'
import postgres from "postgres";

const empty = {
  connected: false,
  centurionActiveTransportCount: 0,
  centurionActiveCategoryCount: 0,
  workflowCategoryMissingCount: 0,
  workflowNonterminalCount: 0,
  workflowDeadLetterCount: 0,
  workflowDeadLetterRecentCount: 0,
  outboundNonterminalCount: 0,
  latestInboundAt: null,
  counts: { threads: 0, messages: 0, inboundMessages: 0 },
};

let sql;
try {
  if (!process.env.DATABASE_URL) throw new Error("database config unavailable");
  sql = postgres(process.env.DATABASE_URL, {
    max: 1,
    connect_timeout: 10,
    idle_timeout: 2,
  });

  const [transport] = await sql`
    SELECT count(*)::int AS count
    FROM mailbox_transport
    WHERE id = 'transport-centurion' AND is_active = true
  `;
  const [categories] = await sql`
    SELECT count(DISTINCT slug)::int AS count
    FROM mail_category
    WHERE transport_id = 'transport-centurion'
      AND is_active = true
      AND slug IN (
        'bookings','groups-events','manage-stay','confirm-reconcile','money-billing',
        'documents-delivery','exceptions-recovery','guest-experience','internal-partner',
        'automated-channel','unknown-review','urgent'
      )
  `;
  const [workflowCats] = await sql`
    WITH expected(slug) AS (
      VALUES
        ('bookings'),('groups-events'),('manage-stay'),('confirm-reconcile'),
        ('money-billing'),('documents-delivery'),('exceptions-recovery'),
        ('guest-experience'),('internal-partner'),('automated-channel'),
        ('unknown-review'),('urgent')
    )
    SELECT count(*)::int AS missing
    FROM mailbox_transport t
    CROSS JOIN expected e
    WHERE t.is_active = true
      AND NOT EXISTS (
        SELECT 1 FROM mail_category c
        WHERE c.transport_id = t.id
          AND c.slug = e.slug
          AND c.is_active = true
      )
  `;
  const [workflow] = await sql`
    SELECT
      count(*) FILTER (
        WHERE state IN ('queued', 'claimed', 'running', 'retry_wait')
      )::int AS nonterminal,
      count(*) FILTER (WHERE state = 'dead_letter')::int AS dead_letter,
      count(*) FILTER (
        WHERE state = 'dead_letter'
          AND coalesce(finished_at, updated_at) > now() - interval '24 hours'
      )::int AS dead_letter_recent
    FROM ai_workflow_run
  `;
  const [outbound] = await sql`
    SELECT count(*)::int AS nonterminal
    FROM outbound_send_queue
    WHERE status IN ('pending', 'sending')
  `;
  const [mail] = await sql`
    SELECT
      count(*)::int AS messages,
      count(*) FILTER (WHERE direction = 'inbound')::int AS inbound_messages,
      max(received_at) FILTER (WHERE direction = 'inbound') AS latest_inbound_at
    FROM message
  `;
  const [threads] = await sql`SELECT count(*)::int AS count FROM mail_thread`;

  process.stdout.write(JSON.stringify({
    connected: true,
    centurionActiveTransportCount: Number(transport?.count ?? 0),
    centurionActiveCategoryCount: Number(categories?.count ?? 0),
    workflowCategoryMissingCount: Number(workflowCats?.missing ?? 0),
    workflowNonterminalCount: Number(workflow?.nonterminal ?? 0),
    workflowDeadLetterCount: Number(workflow?.dead_letter ?? 0),
    workflowDeadLetterRecentCount: Number(workflow?.dead_letter_recent ?? 0),
    outboundNonterminalCount: Number(outbound?.nonterminal ?? 0),
    latestInboundAt: mail?.latest_inbound_at
      ? new Date(mail.latest_inbound_at).toISOString()
      : null,
    counts: {
      threads: Number(threads?.count ?? 0),
      messages: Number(mail?.messages ?? 0),
      inboundMessages: Number(mail?.inbound_messages ?? 0),
    },
  }));
} catch {
  process.stdout.write(JSON.stringify(empty));
} finally {
  if (sql) await sql.end({ timeout: 2 }).catch(() => undefined);
}
NODE
)"
if [ -z "$DB_SUMMARY" ]; then
  DB_SUMMARY='{"connected":false,"centurionActiveTransportCount":0,"centurionActiveCategoryCount":0,"workflowCategoryMissingCount":0,"workflowNonterminalCount":0,"workflowDeadLetterCount":0,"workflowDeadLetterRecentCount":0,"outboundNonterminalCount":0,"latestInboundAt":null,"counts":{"threads":0,"messages":0,"inboundMessages":0}}'
fi

node - "$PM2_SUMMARY" "$DB_SUMMARY" <<'NODE'
const pm2 = JSON.parse(process.argv[2]);
const db = JSON.parse(process.argv[3]);
const bool = (name) => process.env[name] === "true";
const report = {
  health: {
    http: bool("HTTP_OK"),
    https: bool("HTTPS_OK"),
    tls: bool("TLS_VALID"),
  },
  pm2,
  hotelProbe: bool("HOTEL_PROBE_OK"),
  firewall: {
    statusRead: bool("UFW_STATUS_READ"),
    rulesRead: bool("UFW_RULES_READ"),
    active: bool("UFW_ACTIVE"),
    defaultDeny: bool("UFW_DEFAULT_DENY"),
    tunnel443: bool("UFW_TUN443"),
    broad443Absent: bool("UFW_BROAD443_ABSENT"),
    remoteAlb8443Only: bool("UFW_REMOTE_ALB8443_ONLY"),
    listenerSafe: bool("LISTENER_SAFE"),
  },
  config: {
    envLoaded: bool("ENV_LOADED"),
    mailTransportModeReal: process.env.MAIL_TRANSPORT_MODE === "real",
    betterAuthUrlCorrect:
      process.env.BETTER_AUTH_URL === "https://nava.legacyhotels.co.za",
    undoSendSecondsCorrect: process.env.UNDO_SEND_SECONDS === "30",
    aiWriteGateEnabled: process.env.AI_WRITE_GATE_ENABLED === "true",
    aiDraftsDisabled: process.env.AI_DRAFTS_ENABLED === "false",
  },
  db,
  disk: {
    safe: bool("DISK_SAFE"),
    usedPercent: Number(process.env.DISK_USED_PERCENT ?? 100),
    freeMB: Number(process.env.DISK_FREE_MB ?? 0),
  },
};
process.stdout.write(`NAVA_READINESS_REMOTE_JSON=${JSON.stringify(report)}\n`);
NODE
REMOTE
)"
REMOTE_COMMAND="${REMOTE_COMMAND//__REMOTE_ADMIN_MODE__/$REMOTE_ADMIN_MODE}"

SSM_RESULT=""
SSM_EXIT=0
set +e
SSM_RESULT="$(
  AWS_REGION="$AWS_REGION" INSTANCE_ID="$INSTANCE_ID" \
    bash "${SCRIPT_DIR}/ssm-run-command.sh" "$REMOTE_COMMAND" 2>/dev/null
)"
SSM_EXIT=$?
set -e

REMOTE_JSON="$(
  node - "$SSM_RESULT" <<'NODE'
try {
  const invocation = JSON.parse(process.argv[2]);
  const marker = "NAVA_READINESS_REMOTE_JSON=";
  const line = String(invocation.Stdout ?? "")
    .split("\n")
    .find((candidate) => candidate.startsWith(marker));
  if (!line) process.exit(1);
  const parsed = JSON.parse(line.slice(marker.length));
  process.stdout.write(JSON.stringify(parsed));
} catch {
  process.exit(1);
}
NODE
)" || REMOTE_JSON=""

if [ "$SSM_EXIT" -ne 0 ] || [ -z "$REMOTE_JSON" ]; then
  REMOTE_JSON='{"health":{"http":false,"https":false,"tls":false},"pm2":{"required":{},"allOnline":false},"hotelProbe":false,"firewall":{"statusRead":false,"rulesRead":false,"active":false,"defaultDeny":false,"tunnel443":false,"broad443Absent":false,"listenerSafe":false},"config":{"envLoaded":false,"mailTransportModeReal":false,"betterAuthUrlCorrect":false,"undoSendSecondsCorrect":false,"aiWriteGateEnabled":false,"aiDraftsDisabled":false},"db":{"connected":false,"centurionActiveTransportCount":0,"centurionActiveCategoryCount":0,"workflowCategoryMissingCount":0,"workflowNonterminalCount":0,"workflowDeadLetterCount":0,"workflowDeadLetterRecentCount":0,"outboundNonterminalCount":0,"latestInboundAt":null,"counts":{"threads":0,"messages":0,"inboundMessages":0}},"disk":{"safe":false,"usedPercent":100,"freeMB":0}}'
fi

RDS_JSON="$(
  aws rds describe-db-instances \
    --region "$AWS_REGION" \
    --db-instance-identifier "$RDS_INSTANCE_ID" \
    --query 'DBInstances[0].{status:DBInstanceStatus,deletionProtection:DeletionProtection,multiAZ:MultiAZ,backupRetentionDays:BackupRetentionPeriod,backupLatestRestorableAt:LatestRestorableTime}' \
    --output json 2>/dev/null || printf '%s' '{}'
)"

S3_AVAILABLE=false
if aws s3api head-bucket --region "$AWS_REGION" --bucket "$S3_BUCKET" >/dev/null 2>&1; then
  S3_AVAILABLE=true
fi
S3_VERSIONING="$(
  aws s3api get-bucket-versioning \
    --region "$AWS_REGION" \
    --bucket "$S3_BUCKET" \
    --query 'Status' \
    --output text 2>/dev/null || true
)"
case "$S3_VERSIONING" in
  Enabled|Suspended)
    ;;
  *)
    S3_VERSIONING="Disabled"
    ;;
esac
S3_LIFECYCLE="$(
  aws s3api get-bucket-lifecycle-configuration \
    --region "$AWS_REGION" \
    --bucket "$S3_BUCKET" \
    --query 'Rules[].{id:ID,status:Status,expirationDays:Expiration.Days,abortDays:AbortIncompleteMultipartUpload.DaysAfterInitiation}' \
    --output json 2>/dev/null || printf '%s' '[]'
)"
# BEGIN_READINESS_PERIMETER_COLLECTION
collect_readiness_perimeter() {
  S3_CORS='{"CORSRules":[]}'
  S3_CORS_OK=false
  S3_PUBLIC_ACCESS='{}'
  S3_PUBLIC_ACCESS_OK=false
  INSTANCE_NETWORK='{}'
  INSTANCE_NETWORK_OK=false
  SG_STATE='[]'
  SG_QUERY_OK=false
  SG_IDS=()

  local s3_cors_result=""
  if s3_cors_result="$(
    aws s3api get-bucket-cors \
      --region "$AWS_REGION" \
      --bucket "$S3_BUCKET" \
      --output json 2>/dev/null
  )"; then
    if node -e '
      const value = JSON.parse(process.argv[1]);
      const isRecord = (item) =>
        item !== null && typeof item === "object" && !Array.isArray(item);
      const isStringArray = (item, required = false) =>
        Array.isArray(item) &&
        (!required || item.length > 0) &&
        item.every((entry) => typeof entry === "string" && entry.length > 0);
      const fields = new Set([
        "AllowedOrigins",
        "AllowedMethods",
        "AllowedHeaders",
        "ExposeHeaders",
        "MaxAgeSeconds",
      ]);
      const valid =
        isRecord(value) &&
        Object.keys(value).length === 1 &&
        Object.hasOwn(value, "CORSRules") &&
        Array.isArray(value.CORSRules) &&
        value.CORSRules.length > 0 &&
        value.CORSRules.every(
          (rule) =>
            isRecord(rule) &&
            Object.keys(rule).every((field) => fields.has(field)) &&
            isStringArray(rule.AllowedOrigins, true) &&
            isStringArray(rule.AllowedMethods, true) &&
            (rule.AllowedHeaders === undefined ||
              isStringArray(rule.AllowedHeaders)) &&
            (rule.ExposeHeaders === undefined ||
              isStringArray(rule.ExposeHeaders)) &&
            (rule.MaxAgeSeconds === undefined ||
              (Number.isInteger(rule.MaxAgeSeconds) &&
                rule.MaxAgeSeconds >= 0)),
        );
      process.exit(valid ? 0 : 1);
    ' "$s3_cors_result" 2>/dev/null; then
      S3_CORS="$s3_cors_result"
      S3_CORS_OK=true
    else
      echo "launch-readiness: S3 CORS response invalid" >&2
    fi
  else
    echo "launch-readiness: S3 CORS query failed" >&2
  fi

  local s3_public_access_result=""
  if s3_public_access_result="$(
    aws s3api get-public-access-block \
      --region "$AWS_REGION" \
      --bucket "$S3_BUCKET" \
      --query 'PublicAccessBlockConfiguration' \
      --output json 2>/dev/null
  )"; then
    if node -e '
      const value = JSON.parse(process.argv[1]);
      const fields = [
        "BlockPublicAcls",
        "IgnorePublicAcls",
        "BlockPublicPolicy",
        "RestrictPublicBuckets",
      ];
      const valid =
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        Object.keys(value).length === fields.length &&
        Object.keys(value).every((field) => fields.includes(field)) &&
        fields.every((field) => typeof value[field] === "boolean");
      process.exit(valid ? 0 : 1);
    ' "$s3_public_access_result" 2>/dev/null; then
      S3_PUBLIC_ACCESS="$s3_public_access_result"
      S3_PUBLIC_ACCESS_OK=true
    else
      echo "launch-readiness: S3 public-access response invalid" >&2
    fi
  else
    echo "launch-readiness: S3 public-access query failed" >&2
  fi

  local instance_network_result=""
  if instance_network_result="$(
    aws ec2 describe-instances \
      --region "$AWS_REGION" \
      --instance-ids "$INSTANCE_ID" \
      --query 'Reservations[0].Instances[0].{securityGroups:SecurityGroups,networkInterfaces:NetworkInterfaces[].{id:NetworkInterfaceId,deviceIndex:Attachment.DeviceIndex,securityGroups:Groups,publicIpv4:Association.PublicIp,ipv6:Ipv6Addresses[].Ipv6Address},publicIpv4:NetworkInterfaces[].Association.PublicIp,ipv6:NetworkInterfaces[].Ipv6Addresses[].Ipv6Address}' \
      --output json 2>/dev/null
  )"; then
    local sg_ids_text=""
    if sg_ids_text="$(
      node -e '
        const state = JSON.parse(process.argv[1]);
        const groupIdPattern = /^sg-[0-9a-f]{8,17}$/;
        const groupIds = (groups) =>
          Array.isArray(groups) &&
          groups.length > 0 &&
          groups.every(
            (group) =>
              group &&
              typeof group === "object" &&
              !Array.isArray(group) &&
              typeof group.GroupId === "string" &&
              groupIdPattern.test(group.GroupId),
          )
            ? groups.map((group) => group.GroupId)
            : null;
        const exactStrings = (actual, expected) =>
          Array.isArray(actual) &&
          actual.length === expected.length &&
          [...actual].sort().every((value, index) => value === [...expected].sort()[index]);
        const topLevelGroups = groupIds(state?.securityGroups);
        const interfaces = Array.isArray(state?.networkInterfaces)
          ? state.networkInterfaces
          : [];
        const validInterfaces =
          state &&
          typeof state === "object" &&
          !Array.isArray(state) &&
          topLevelGroups !== null &&
          Array.isArray(state.publicIpv4) &&
          state.publicIpv4.every((address) => typeof address === "string") &&
          Array.isArray(state.ipv6) &&
          state.ipv6.every((address) => typeof address === "string") &&
          interfaces.length > 0 &&
          interfaces.every(
            (networkInterface) =>
              networkInterface &&
              typeof networkInterface === "object" &&
              !Array.isArray(networkInterface) &&
              typeof networkInterface.id === "string" &&
              networkInterface.id.startsWith("eni-") &&
              Number.isInteger(networkInterface.deviceIndex) &&
              networkInterface.deviceIndex >= 0 &&
              groupIds(networkInterface.securityGroups) !== null &&
              (networkInterface.publicIpv4 === null ||
                typeof networkInterface.publicIpv4 === "string") &&
              Array.isArray(networkInterface.ipv6) &&
              networkInterface.ipv6.every((address) => typeof address === "string"),
          );
        if (!validInterfaces || new Set(topLevelGroups).size !== topLevelGroups.length) {
          process.exit(1);
        }
        const primary = interfaces.filter((networkInterface) => networkInterface.deviceIndex === 0);
        const interfaceIds = interfaces.map((networkInterface) => networkInterface.id);
        const deviceIndexes = interfaces.map((networkInterface) => networkInterface.deviceIndex);
        if (
          primary.length !== 1 ||
          new Set(interfaceIds).size !== interfaceIds.length ||
          new Set(deviceIndexes).size !== deviceIndexes.length
        ) {
          process.exit(1);
        }
        const primaryGroups = groupIds(primary[0].securityGroups);
        if (primaryGroups === null || !exactStrings(topLevelGroups, primaryGroups)) {
          process.exit(1);
        }
        const ids = [
          ...new Set(
            interfaces.flatMap((networkInterface) => groupIds(networkInterface.securityGroups)),
          ),
        ];
        if (ids.length === 0) process.exit(1);
        process.stdout.write(ids.join("\n"));
      ' "$instance_network_result" 2>/dev/null
    )"; then
      INSTANCE_NETWORK="$instance_network_result"
      mapfile -t SG_IDS <<<"$sg_ids_text"
      INSTANCE_NETWORK_OK=true
      local sg_state_result=""
      if sg_state_result="$(
        aws ec2 describe-security-groups \
          --region "$AWS_REGION" \
          --group-ids "${SG_IDS[@]}" \
          --query 'SecurityGroups[].{id:GroupId,ingress:IpPermissions}' \
          --output json 2>/dev/null
      )"; then
        if node -e 'JSON.parse(process.argv[1])' "$sg_state_result" 2>/dev/null; then
          SG_STATE="$sg_state_result"
          SG_QUERY_OK=true
        else
          echo "launch-readiness: security-group response invalid" >&2
        fi
      else
        echo "launch-readiness: security-group query failed" >&2
      fi
    else
      echo "launch-readiness: EC2 network response invalid" >&2
    fi
  else
    echo "launch-readiness: EC2 network query failed" >&2
  fi
}
collect_readiness_perimeter
# END_READINESS_PERIMETER_COLLECTION

REMOTE_ADMIN_FACTS='{}'
remote_admin_query() {
  local label="$1"
  local variable_name="$2"
  shift 2
  local value=""
  if value="$("$@" 2>/dev/null)"; then
    printf -v "$variable_name" '%s' "$value"
    return 0
  fi
  echo "launch-readiness: remote admin ${label} query failed" >&2
  return 1
}

collect_remote_admin_perimeter() {
  local remote_alb_json=""
  local remote_target_group_json=""
  local remote_target_attributes_json=""
  local remote_target_health_json=""
  local remote_listeners_json=""
  local remote_rules_json=""
  local remote_alb_attributes_json=""
  local remote_target_sg_json=""
  local remote_alb_sg_json=""
  local remote_waf_list_json=""
  local remote_waf_json=""
  local remote_waf_association_json=""
  local remote_log_encryption_json=""
  local remote_log_public_access_json=""
  local remote_log_ownership_json=""
  local remote_log_policy_json=""
  local remote_log_lifecycle_json=""
  local remote_alb_context=""
  local remote_alb_security_group_id=""
  local remote_target_group_arn=""
  local remote_listener_arn=""
  local remote_waf_id=""

  if ! remote_admin_query "ALB" remote_alb_json \
    aws elbv2 describe-load-balancers \
      --region "$AWS_REGION" \
      --names "$REMOTE_ALB_NAME" \
      --output json; then
    return 0
  fi
  if ! remote_alb_context="$(
    node - "$remote_alb_json" 2>/dev/null <<'NODE'
try {
  const value = JSON.parse(process.argv[2]);
  const loadBalancers = Array.isArray(value.LoadBalancers) ? value.LoadBalancers : [];
  if (loadBalancers.length !== 1) process.exit(1);
  const [loadBalancer] = loadBalancers;
  const arn = loadBalancer?.LoadBalancerArn;
  if (typeof arn !== "string" || arn.length === 0) process.exit(1);
  process.stdout.write(arn);
} catch {
  process.exit(1);
}
NODE
  )"; then
    echo "launch-readiness: remote admin ALB response invalid" >&2
    return 0
  fi
  if ! remote_alb_security_group_id="$(
    node - "$remote_alb_json" 2>/dev/null <<'NODE'
try {
  const value = JSON.parse(process.argv[2]);
  const loadBalancers = Array.isArray(value.LoadBalancers) ? value.LoadBalancers : [];
  const securityGroups = Array.isArray(loadBalancers[0]?.SecurityGroups)
    ? loadBalancers[0].SecurityGroups
    : [];
  if (securityGroups.length !== 1 || typeof securityGroups[0] !== "string" || securityGroups[0].length === 0) {
    process.exit(1);
  }
  process.stdout.write(securityGroups[0]);
} catch {
  process.exit(1);
}
NODE
  )"; then
    echo "launch-readiness: remote admin ALB security group response invalid" >&2
    return 0
  fi

  if ! remote_admin_query "target group" remote_target_group_json \
    aws elbv2 describe-target-groups \
      --region "$AWS_REGION" \
      --names "$REMOTE_TARGET_GROUP_NAME" \
      --output json; then
    return 0
  fi
  if ! remote_target_group_arn="$(
    node - "$remote_target_group_json" 2>/dev/null <<'NODE'
try {
  const value = JSON.parse(process.argv[2]);
  const targetGroups = Array.isArray(value.TargetGroups) ? value.TargetGroups : [];
  if (targetGroups.length !== 1) process.exit(1);
  const arn = targetGroups[0]?.TargetGroupArn;
  if (typeof arn !== "string" || arn.length === 0) process.exit(1);
  process.stdout.write(arn);
} catch {
  process.exit(1);
}
NODE
  )"; then
    echo "launch-readiness: remote admin target group response invalid" >&2
    return 0
  fi

  if ! remote_admin_query "target group attributes" remote_target_attributes_json \
    aws elbv2 describe-target-group-attributes \
      --region "$AWS_REGION" \
      --target-group-arn "$remote_target_group_arn" \
      --output json ||
    ! remote_admin_query "target health" remote_target_health_json \
      aws elbv2 describe-target-health \
        --region "$AWS_REGION" \
        --target-group-arn "$remote_target_group_arn" \
        --output json ||
    ! remote_admin_query "listeners" remote_listeners_json \
      aws elbv2 describe-listeners \
        --region "$AWS_REGION" \
        --load-balancer-arn "$remote_alb_context" \
        --output json ||
    ! remote_admin_query "ALB attributes" remote_alb_attributes_json \
      aws elbv2 describe-load-balancer-attributes \
        --region "$AWS_REGION" \
        --load-balancer-arn "$remote_alb_context" \
        --output json ||
    ! remote_admin_query "target security group" remote_target_sg_json \
      aws ec2 describe-security-groups \
        --region "$AWS_REGION" \
        --filters \
          "Name=vpc-id,Values=$REMOTE_VPC_ID" \
          "Name=group-name,Values=$REMOTE_TARGET_SECURITY_GROUP_NAME" \
        --output json ||
    ! remote_admin_query "ALB security group" remote_alb_sg_json \
      aws ec2 describe-security-groups \
        --region "$AWS_REGION" \
        --group-ids "$remote_alb_security_group_id" \
        --output json ||
    ! remote_admin_query "WAF list" remote_waf_list_json \
      aws wafv2 list-web-acls \
        --region "$AWS_REGION" \
        --scope REGIONAL \
        --output json ||
    ! remote_admin_query "log bucket encryption" remote_log_encryption_json \
      aws s3api get-bucket-encryption \
        --region "$AWS_REGION" \
        --bucket "$REMOTE_LOG_BUCKET" \
        --output json ||
    ! remote_admin_query "log bucket public access" remote_log_public_access_json \
      aws s3api get-public-access-block \
        --region "$AWS_REGION" \
        --bucket "$REMOTE_LOG_BUCKET" \
        --output json ||
    ! remote_admin_query "log bucket ownership" remote_log_ownership_json \
      aws s3api get-bucket-ownership-controls \
        --region "$AWS_REGION" \
        --bucket "$REMOTE_LOG_BUCKET" \
        --output json ||
    ! remote_admin_query "log bucket policy" remote_log_policy_json \
      aws s3api get-bucket-policy \
        --region "$AWS_REGION" \
        --bucket "$REMOTE_LOG_BUCKET" \
        --output json ||
    ! remote_admin_query "log bucket lifecycle" remote_log_lifecycle_json \
      aws s3api get-bucket-lifecycle-configuration \
        --region "$AWS_REGION" \
        --bucket "$REMOTE_LOG_BUCKET" \
        --output json; then
    return 0
  fi

  if ! remote_listener_arn="$(
    node - "$remote_listeners_json" 2>/dev/null <<'NODE'
try {
  const value = JSON.parse(process.argv[2]);
  const listeners = Array.isArray(value.Listeners) ? value.Listeners : [];
  const listener = listeners.find(
    (candidate) => candidate?.Protocol === "HTTPS" && candidate?.Port === 443,
  );
  const arn = listener?.ListenerArn;
  if (typeof arn !== "string" || arn.length === 0) process.exit(1);
  process.stdout.write(arn);
} catch {
  process.exit(1);
}
NODE
  )"; then
    echo "launch-readiness: remote admin listener response invalid" >&2
    return 0
  fi
  if ! remote_admin_query "listener rules" remote_rules_json \
    aws elbv2 describe-rules \
      --region "$AWS_REGION" \
      --listener-arn "$remote_listener_arn" \
      --output json; then
    return 0
  fi

  if ! remote_waf_id="$(
    node - "$remote_waf_list_json" "$REMOTE_WAF_NAME" 2>/dev/null <<'NODE'
try {
  const value = JSON.parse(process.argv[2]);
  const name = process.argv[3];
  const webAcls = Array.isArray(value.WebACLs) ? value.WebACLs : [];
  const matches = webAcls.filter((candidate) => candidate?.Name === name);
  if (matches.length !== 1 || typeof matches[0]?.Id !== "string") process.exit(1);
  process.stdout.write(matches[0].Id);
} catch {
  process.exit(1);
}
NODE
  )"; then
    echo "launch-readiness: remote admin WAF response invalid" >&2
    return 0
  fi
  if ! remote_admin_query "WAF" remote_waf_json \
    aws wafv2 get-web-acl \
      --region "$AWS_REGION" \
      --scope REGIONAL \
      --name "$REMOTE_WAF_NAME" \
      --id "$remote_waf_id" \
      --output json ||
    ! remote_admin_query "WAF association" remote_waf_association_json \
      aws wafv2 get-web-acl-for-resource \
        --region "$AWS_REGION" \
        --resource-arn "$remote_alb_context" \
        --output json; then
    return 0
  fi

  REMOTE_ADMIN_FACTS="$(
    node - \
      "$remote_alb_json" \
      "$remote_target_group_json" \
      "$remote_target_attributes_json" \
      "$remote_target_health_json" \
      "$remote_listeners_json" \
      "$remote_rules_json" \
      "$remote_alb_attributes_json" \
      "$remote_target_sg_json" \
      "$remote_alb_sg_json" \
      "$remote_waf_json" \
      "$remote_waf_association_json" \
      "$remote_waf_id" \
      "$remote_log_encryption_json" \
      "$remote_log_public_access_json" \
      "$remote_log_ownership_json" \
      "$remote_log_policy_json" \
      "$remote_log_lifecycle_json" \
      "$INSTANCE_NETWORK" \
      "$SG_STATE" <<'NODE'
const [
  albRaw,
  targetGroupRaw,
  targetAttributesRaw,
  targetHealthRaw,
  listenersRaw,
  rulesRaw,
  albAttributesRaw,
  targetSecurityGroupRaw,
  albSecurityGroupRaw,
  wafRaw,
  wafAssociationRaw,
  expectedWafId,
  logEncryptionRaw,
  logPublicAccessRaw,
  logOwnershipRaw,
  logPolicyRaw,
  logLifecycleRaw,
  instanceNetworkRaw,
  securityGroupsRaw,
] = process.argv.slice(2);

const ACCOUNT_ID = "845242190536";
const VPC_ID = "vpc-0f078e17a5f0f8599";
const INSTANCE_ID = "i-008f737974a9ba9b3";
const HOST = "nava-admin.trynava.io";
const ALB_NAME = "nava-remote-admin-alb";
const TARGET_GROUP_NAME = "nava-remote-admin";
const TARGET_SECURITY_GROUP_NAME = "nava-remote-admin-target";
const WAF_NAME = "nava-remote-admin-waf";
const LOG_BUCKET = "nava-zero-remote-alb-logs-845242190536-af-south-1";
const EXPECTED_SUBNETS = ["subnet-0e6446aaaeaa8762e", "subnet-094bf8643d98c22f6"];

const empty = {
  resourcesResolved: false,
  targetGroupConfigured: false,
  listenerDefault404: false,
  preRegistrationClean: false,
  noNonDefaultListenerRules: false,
  hostForwardExact: false,
  targetHealthy: false,
  targetSecurityGroupOnlyAlb: false,
  noDirectPublicTargetPath: false,
  publicAddressPresence: { ipv4: false, ipv6: false },
  logBucketCompliant: false,
  wafCompliant: false,
};
const parse = (raw) => JSON.parse(raw);
const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const hasExactStrings = (actual, expected) =>
  Array.isArray(actual) &&
  actual.length === expected.length &&
  actual.every((value) => typeof value === "string") &&
  [...actual].sort().every((value, index) => value === [...expected].sort()[index]);
const hasExactObjectKeys = (value, expected) =>
  isRecord(value) &&
  Object.keys(value).length === expected.length &&
  expected.every((key) => Object.hasOwn(value, key));
const isExactEmptyObject = (value) =>
  isRecord(value) && Object.keys(value).length === 0;
const isExactAction = (value, name) =>
  hasExactObjectKeys(value, [name]) && isExactEmptyObject(value[name]);
const isExactByteMatch = (statement, field, expected) => {
  const byteMatch = statement?.ByteMatchStatement;
  if (
    !hasExactObjectKeys(statement, ["ByteMatchStatement"]) ||
    !isRecord(byteMatch) ||
    !hasExactObjectKeys(byteMatch, [
      "SearchString",
      "FieldToMatch",
      "TextTransformations",
      "PositionalConstraint",
    ]) ||
    !hasExactObjectKeys(byteMatch.FieldToMatch, [field]) ||
    !isExactEmptyObject(byteMatch.FieldToMatch[field]) ||
    byteMatch.PositionalConstraint !== "EXACTLY" ||
    !Array.isArray(byteMatch.TextTransformations) ||
    byteMatch.TextTransformations.length !== 1 ||
    !hasExactObjectKeys(byteMatch.TextTransformations[0], ["Priority", "Type"]) ||
    byteMatch.TextTransformations[0].Priority !== 0 ||
    byteMatch.TextTransformations[0].Type !== "NONE"
  ) {
    return false;
  }
  return byteMatch.SearchString === Buffer.from(expected, "utf8").toString("base64");
};
const securityGroupIdPattern = /^sg-[0-9a-f]{8,17}$/;
const groupIds = (groups) => {
  if (
    !Array.isArray(groups) ||
    groups.length === 0 ||
    !groups.every(
      (group) =>
        isRecord(group) &&
        typeof group.GroupId === "string" &&
        securityGroupIdPattern.test(group.GroupId),
    )
  ) {
    return null;
  }
  const ids = groups.map((group) => group.GroupId);
  return new Set(ids).size === ids.length ? ids : null;
};
const describeInstanceNetwork = (value) => {
  if (
    !isRecord(value) ||
    !Array.isArray(value.publicIpv4) ||
    !value.publicIpv4.every((address) => typeof address === "string") ||
    !Array.isArray(value.ipv6) ||
    !value.ipv6.every((address) => typeof address === "string")
  ) {
    return null;
  }
  const topLevelGroupIds = groupIds(value.securityGroups);
  const networkInterfaces = Array.isArray(value.networkInterfaces)
    ? value.networkInterfaces
    : [];
  if (topLevelGroupIds === null || networkInterfaces.length === 0) return null;
  const interfaces = networkInterfaces.map((networkInterface) => {
    if (
      !isRecord(networkInterface) ||
      typeof networkInterface.id !== "string" ||
      !networkInterface.id.startsWith("eni-") ||
      !Number.isInteger(networkInterface.deviceIndex) ||
      networkInterface.deviceIndex < 0 ||
      (networkInterface.publicIpv4 !== null &&
        typeof networkInterface.publicIpv4 !== "string") ||
      !Array.isArray(networkInterface.ipv6) ||
      !networkInterface.ipv6.every((address) => typeof address === "string")
    ) {
      return null;
    }
    const securityGroups = groupIds(networkInterface.securityGroups);
    return securityGroups === null
      ? null
      : {
          id: networkInterface.id,
          deviceIndex: networkInterface.deviceIndex,
          securityGroups,
        };
  });
  if (interfaces.some((networkInterface) => networkInterface === null)) return null;
  const validInterfaces = interfaces;
  const primary = validInterfaces.filter(
    (networkInterface) => networkInterface.deviceIndex === 0,
  );
  if (
    primary.length !== 1 ||
    new Set(validInterfaces.map((networkInterface) => networkInterface.id)).size !==
      validInterfaces.length ||
    new Set(validInterfaces.map((networkInterface) => networkInterface.deviceIndex)).size !==
      validInterfaces.length ||
    !hasExactStrings(topLevelGroupIds, primary[0].securityGroups)
  ) {
    return null;
  }
  return {
    groupIds: [
      ...new Set(
        validInterfaces.flatMap((networkInterface) => networkInterface.securityGroups),
      ),
    ],
    publicIpv4: value.publicIpv4,
    ipv6: value.ipv6,
  };
};

try {
  const albValue = parse(albRaw);
  const targetGroupValue = parse(targetGroupRaw);
  const targetAttributesValue = parse(targetAttributesRaw);
  const targetHealthValue = parse(targetHealthRaw);
  const listenersValue = parse(listenersRaw);
  const rulesValue = parse(rulesRaw);
  const albAttributesValue = parse(albAttributesRaw);
  const targetSecurityGroupValue = parse(targetSecurityGroupRaw);
  const albSecurityGroupValue = parse(albSecurityGroupRaw);
  const wafValue = parse(wafRaw);
  const wafAssociationValue = parse(wafAssociationRaw);
  const logEncryptionValue = parse(logEncryptionRaw);
  const logPublicAccessValue = parse(logPublicAccessRaw);
  const logOwnershipValue = parse(logOwnershipRaw);
  const logPolicyResponse = parse(logPolicyRaw);
  const logPolicyValue = parse(logPolicyResponse?.Policy ?? "");
  const logLifecycleValue = parse(logLifecycleRaw);
  const instanceNetwork = parse(instanceNetworkRaw);
  const securityGroups = parse(securityGroupsRaw);

  const albs = Array.isArray(albValue.LoadBalancers) ? albValue.LoadBalancers : [];
  const targetGroups = Array.isArray(targetGroupValue.TargetGroups)
    ? targetGroupValue.TargetGroups
    : [];
  const listeners = Array.isArray(listenersValue.Listeners) ? listenersValue.Listeners : [];
  const rules = Array.isArray(rulesValue.Rules) ? rulesValue.Rules : [];
  const targetSecurityGroups = Array.isArray(targetSecurityGroupValue.SecurityGroups)
    ? targetSecurityGroupValue.SecurityGroups
    : [];
  const albSecurityGroupRecords = Array.isArray(albSecurityGroupValue.SecurityGroups)
    ? albSecurityGroupValue.SecurityGroups
    : [];
  const [alb] = albs;
  const [targetGroup] = targetGroups;
  const [targetSecurityGroup] = targetSecurityGroups;
  const [albSecurityGroupRecord] = albSecurityGroupRecords;
  const albArn = alb?.LoadBalancerArn;
  const targetGroupArn = targetGroup?.TargetGroupArn;
  const albSecurityGroups = Array.isArray(alb?.SecurityGroups) ? alb.SecurityGroups : [];
  const albSecurityGroup = albSecurityGroups.length === 1 ? albSecurityGroups[0] : "";
  const albSubnets = Array.isArray(alb?.AvailabilityZones)
    ? alb.AvailabilityZones.map((zone) => zone?.SubnetId)
    : [];
  const targetAttributes = Array.isArray(targetAttributesValue.Attributes)
    ? targetAttributesValue.Attributes
    : [];
  const targetHealth = Array.isArray(targetHealthValue.TargetHealthDescriptions)
    ? targetHealthValue.TargetHealthDescriptions
    : [];
  const listener443 = listeners.find(
    (listener) => listener?.Protocol === "HTTPS" && listener?.Port === 443,
  );
  const listenerDefaultActions = Array.isArray(listener443?.DefaultActions)
    ? listener443.DefaultActions
    : [];
  const nonDefaultRules = rules.filter((rule) => rule?.IsDefault !== true);
  const forwardRules = nonDefaultRules.filter((rule) =>
    Array.isArray(rule?.Actions) && rule.Actions.some((action) => action?.Type === "forward"),
  );
  const attributeValue = (attributes, key) =>
    Array.isArray(attributes)
      ? attributes.find((attribute) => attribute?.Key === key)?.Value
      : undefined;
  const hasNoNetworkSources = (permission) =>
    (!Array.isArray(permission?.IpRanges) || permission.IpRanges.length === 0) &&
    (!Array.isArray(permission?.Ipv6Ranges) || permission.Ipv6Ranges.length === 0) &&
    (!Array.isArray(permission?.PrefixListIds) || permission.PrefixListIds.length === 0);
  const isExactPublic443Ingress = (permission) =>
    permission?.IpProtocol === "tcp" &&
    Number(permission?.FromPort) === 443 &&
    Number(permission?.ToPort) === 443 &&
    Array.isArray(permission?.IpRanges) &&
    permission.IpRanges.length === 1 &&
    permission.IpRanges[0]?.CidrIp === "0.0.0.0/0" &&
    hasNoNetworkSources({ ...permission, IpRanges: [] }) &&
    (!Array.isArray(permission?.UserIdGroupPairs) || permission.UserIdGroupPairs.length === 0);
  const isExactTarget8443Egress = (permission) =>
    permission?.IpProtocol === "tcp" &&
    Number(permission?.FromPort) === 8443 &&
    Number(permission?.ToPort) === 8443 &&
    hasNoNetworkSources(permission) &&
    Array.isArray(permission?.UserIdGroupPairs) &&
    permission.UserIdGroupPairs.length === 1 &&
    permission.UserIdGroupPairs[0]?.GroupId === targetSecurityGroup?.GroupId;
  const albSecurityGroupCompliant =
    albSecurityGroupRecords.length === 1 &&
    albSecurityGroupRecord?.GroupId === albSecurityGroup &&
    albSecurityGroupRecord?.GroupName === ALB_NAME &&
    albSecurityGroupRecord?.VpcId === VPC_ID &&
    Array.isArray(albSecurityGroupRecord?.IpPermissions) &&
    albSecurityGroupRecord.IpPermissions.length === 1 &&
    albSecurityGroupRecord.IpPermissions.every(isExactPublic443Ingress) &&
    Array.isArray(albSecurityGroupRecord?.IpPermissionsEgress) &&
    albSecurityGroupRecord.IpPermissionsEgress.length === 1 &&
    albSecurityGroupRecord.IpPermissionsEgress.every(isExactTarget8443Egress);

  empty.resourcesResolved =
    albs.length === 1 &&
    targetGroups.length === 1 &&
    targetSecurityGroups.length === 1 &&
    alb?.LoadBalancerName === ALB_NAME &&
    alb?.Scheme === "internet-facing" &&
    alb?.Type === "application" &&
    alb?.IpAddressType === "ipv4" &&
    alb?.VpcId === VPC_ID &&
    typeof albArn === "string" &&
    hasExactStrings(albSubnets, EXPECTED_SUBNETS) &&
    typeof albSecurityGroup === "string" &&
    albSecurityGroup.length > 0 &&
    albSecurityGroupCompliant &&
    targetGroup?.TargetGroupName === TARGET_GROUP_NAME &&
    typeof targetGroupArn === "string" &&
    targetSecurityGroup?.GroupName === TARGET_SECURITY_GROUP_NAME &&
    targetSecurityGroup?.VpcId === VPC_ID &&
    typeof targetSecurityGroup?.GroupId === "string";

  empty.targetGroupConfigured =
    targetGroups.length === 1 &&
    targetGroup?.Protocol === "HTTP" &&
    targetGroup?.Port === 8443 &&
    targetGroup?.VpcId === VPC_ID &&
    targetGroup?.HealthCheckProtocol === "HTTP" &&
    targetGroup?.HealthCheckPath === "/health" &&
    targetGroup?.Matcher?.HttpCode === "200" &&
    attributeValue(targetAttributes, "deregistration_delay.timeout_seconds") === "30";

  empty.listenerDefault404 =
    listeners.length === 1 &&
    listener443 !== undefined &&
    listenerDefaultActions.length === 1 &&
    listenerDefaultActions[0]?.Type === "fixed-response" &&
    listenerDefaultActions[0]?.FixedResponseConfig?.StatusCode === "404";

  empty.preRegistrationClean =
    targetHealth.length === 0 && nonDefaultRules.length === 0;
  empty.noNonDefaultListenerRules = nonDefaultRules.length === 0;

  empty.hostForwardExact =
    nonDefaultRules.length === 1 &&
    forwardRules.length === 1 &&
    forwardRules[0]?.Priority === "10" &&
    Array.isArray(forwardRules[0]?.Conditions) &&
    forwardRules[0].Conditions.length === 1 &&
    forwardRules[0].Conditions[0]?.Field === "host-header" &&
    hasExactStrings(forwardRules[0].Conditions[0]?.Values, [HOST]) &&
    Array.isArray(forwardRules[0]?.Actions) &&
    forwardRules[0].Actions.length === 1 &&
    forwardRules[0].Actions[0]?.Type === "forward" &&
    (
      forwardRules[0].Actions[0]?.TargetGroupArn === targetGroupArn ||
      (
        Array.isArray(forwardRules[0].Actions[0]?.ForwardConfig?.TargetGroups) &&
        forwardRules[0].Actions[0].ForwardConfig.TargetGroups.length === 1 &&
        forwardRules[0].Actions[0].ForwardConfig.TargetGroups[0]?.TargetGroupArn === targetGroupArn
      )
    );

  empty.targetHealthy =
    targetHealth.length === 1 &&
    targetHealth[0]?.Target?.Id === INSTANCE_ID &&
    targetHealth[0]?.Target?.Port === 8443 &&
    targetHealth[0]?.TargetHealth?.State === "healthy";

  const attachedNetwork = describeInstanceNetwork(instanceNetwork);
  const inspectedSecurityGroups = Array.isArray(securityGroups)
    ? securityGroups
    : [];
  const securityGroupRecordsValid =
    inspectedSecurityGroups.length > 0 &&
    inspectedSecurityGroups.every(
      (group) =>
        isRecord(group) &&
        typeof group.id === "string" &&
        securityGroupIdPattern.test(group.id) &&
        Array.isArray(group.ingress),
    );
  const securityGroupById = new Map(
    securityGroupRecordsValid
      ? inspectedSecurityGroups.map((group) => [group.id, group])
      : [],
  );
  const securityGroupCoverageComplete =
    attachedNetwork !== null &&
    securityGroupRecordsValid &&
    securityGroupById.size === inspectedSecurityGroups.length &&
    securityGroupById.size === attachedNetwork.groupIds.length &&
    attachedNetwork.groupIds.every((id) => securityGroupById.has(id));
  const attachedGroupRecords =
    attachedNetwork === null
      ? []
      : attachedNetwork.groupIds.map((id) => securityGroupById.get(id));
  const targetSecurityGroupAttached =
    attachedNetwork !== null &&
    attachedNetwork.groupIds.includes(targetSecurityGroup?.GroupId);
  const isExactAlb8443 = (permission) =>
    permission?.IpProtocol === "tcp" &&
    Number(permission?.FromPort) === 8443 &&
    Number(permission?.ToPort) === 8443 &&
    Array.isArray(permission?.UserIdGroupPairs) &&
    permission.UserIdGroupPairs.length === 1 &&
    permission.UserIdGroupPairs[0]?.GroupId === albSecurityGroup &&
    (
      permission.UserIdGroupPairs[0]?.UserId === undefined ||
      permission.UserIdGroupPairs[0]?.UserId === ACCOUNT_ID
    ) &&
    (!Array.isArray(permission?.IpRanges) || permission.IpRanges.length === 0) &&
    (!Array.isArray(permission?.Ipv6Ranges) || permission.Ipv6Ranges.length === 0) &&
    (!Array.isArray(permission?.PrefixListIds) || permission.PrefixListIds.length === 0);
  const targetSecurityGroupRecord = attachedGroupRecords.find(
    (group) => group?.id === targetSecurityGroup?.GroupId,
  );
  const legacyIngressEmpty = attachedGroupRecords
    .filter((group) => group?.id !== targetSecurityGroup?.GroupId)
    .every((group) => Array.isArray(group?.ingress) && group.ingress.length === 0);
  const targetIngressOnlyAlb8443 =
    Array.isArray(targetSecurityGroupRecord?.ingress) &&
    targetSecurityGroupRecord.ingress.length === 1 &&
    targetSecurityGroupRecord.ingress.every(isExactAlb8443);
  empty.targetSecurityGroupOnlyAlb =
    securityGroupCoverageComplete &&
    targetSecurityGroupAttached &&
    legacyIngressEmpty &&
    targetIngressOnlyAlb8443;
  empty.publicAddressPresence = {
    ipv4:
      attachedNetwork !== null &&
      attachedNetwork.publicIpv4.some((address) => typeof address === "string"),
    ipv6:
      attachedNetwork !== null &&
      attachedNetwork.ipv6.some((address) => typeof address === "string"),
  };
  empty.noDirectPublicTargetPath = empty.targetSecurityGroupOnlyAlb;

  const albAttributes = Array.isArray(albAttributesValue.Attributes)
    ? albAttributesValue.Attributes
    : [];
  const allPublicAccessBlocked = [
    "BlockPublicAcls",
    "IgnorePublicAcls",
    "BlockPublicPolicy",
    "RestrictPublicBuckets",
  ].every((key) => logPublicAccessValue?.PublicAccessBlockConfiguration?.[key] === true);
  const encryptedSseS3 =
    Array.isArray(logEncryptionValue?.ServerSideEncryptionConfiguration?.Rules) &&
    logEncryptionValue.ServerSideEncryptionConfiguration.Rules.length > 0 &&
    logEncryptionValue.ServerSideEncryptionConfiguration.Rules.every(
      (rule) => rule?.ApplyServerSideEncryptionByDefault?.SSEAlgorithm === "AES256",
    );
  const bucketOwnerEnforced =
    Array.isArray(logOwnershipValue?.OwnershipControls?.Rules) &&
    logOwnershipValue.OwnershipControls.Rules.some(
      (rule) => rule?.ObjectOwnership === "BucketOwnerEnforced",
    );
  const lifecycle365 =
    Array.isArray(logLifecycleValue?.Rules) &&
    logLifecycleValue.Rules.some(
      (rule) =>
        rule?.Status === "Enabled" &&
        rule?.Expiration?.Days === 365,
    );
  const policyStatements = Array.isArray(logPolicyValue?.Statement)
    ? logPolicyValue.Statement
    : [];
  const exactModernLogDeliveryAllow = (statement) => {
    if (
      !hasExactObjectKeys(statement, [
        "Sid",
        "Effect",
        "Principal",
        "Action",
        "Resource",
        "Condition",
      ]) ||
      !hasExactObjectKeys(statement.Principal, ["Service"]) ||
      !hasExactObjectKeys(statement.Condition, ["ArnLike"]) ||
      !hasExactObjectKeys(statement.Condition.ArnLike, ["aws:SourceArn"])
    ) {
      return false;
    }
    return (
      statement.Sid === "AllowAlbLogDeliveryWrite" &&
      statement.Effect === "Allow" &&
      statement.Principal.Service ===
        "logdelivery.elasticloadbalancing.amazonaws.com" &&
      statement.Action === "s3:PutObject" &&
      statement.Resource ===
        `arn:aws:s3:::${LOG_BUCKET}/AWSLogs/${ACCOUNT_ID}/*` &&
      statement.Condition.ArnLike["aws:SourceArn"] === albArn
    );
  };
  const exactLegacyLogDeliveryAllow = (statement) => {
    if (
      !hasExactObjectKeys(statement, [
        "Sid",
        "Effect",
        "Principal",
        "Action",
        "Resource",
      ]) ||
      !hasExactObjectKeys(statement.Principal, ["AWS"])
    ) {
      return false;
    }
    return (
      statement.Sid === "AllowAlbLogDeliveryLegacyWrite" &&
      statement.Effect === "Allow" &&
      statement.Principal.AWS === "arn:aws:iam::098369216593:root" &&
      statement.Action === "s3:PutObject" &&
      statement.Resource ===
        `arn:aws:s3:::${LOG_BUCKET}/AWSLogs/${ACCOUNT_ID}/*`
    );
  };
  const exactTlsOnlyDeny = (statement) => {
    if (
      !hasExactObjectKeys(statement, [
        "Sid",
        "Effect",
        "Principal",
        "Action",
        "Resource",
        "Condition",
      ]) ||
      !hasExactObjectKeys(statement.Condition, ["Bool"]) ||
      !hasExactObjectKeys(statement.Condition.Bool, ["aws:SecureTransport"])
    ) {
      return false;
    }
    return (
      statement.Sid === "DenyInsecureTransport" &&
      statement.Effect === "Deny" &&
      statement.Principal === "*" &&
      statement.Action === "s3:*" &&
      hasExactStrings(statement.Resource, [
        `arn:aws:s3:::${LOG_BUCKET}`,
        `arn:aws:s3:::${LOG_BUCKET}/*`,
      ]) &&
      statement.Condition.Bool["aws:SecureTransport"] === "false"
    );
  };
  const exactLogBucketPolicy =
    hasExactObjectKeys(logPolicyValue, ["Version", "Statement"]) &&
    logPolicyValue.Version === "2012-10-17" &&
    policyStatements.length === 3 &&
    policyStatements.filter(
      (statement) => statement?.Sid === "AllowAlbLogDeliveryWrite",
    ).length === 1 &&
    policyStatements.filter(
      (statement) => statement?.Sid === "AllowAlbLogDeliveryLegacyWrite",
    ).length === 1 &&
    policyStatements.filter(
      (statement) => statement?.Sid === "DenyInsecureTransport",
    ).length === 1 &&
    exactModernLogDeliveryAllow(
      policyStatements.find(
        (statement) => statement?.Sid === "AllowAlbLogDeliveryWrite",
      ),
    ) &&
    exactLegacyLogDeliveryAllow(
      policyStatements.find(
        (statement) => statement?.Sid === "AllowAlbLogDeliveryLegacyWrite",
      ),
    ) &&
    exactTlsOnlyDeny(
      policyStatements.find(
        (statement) => statement?.Sid === "DenyInsecureTransport",
      ),
    );
  empty.logBucketCompliant =
    attributeValue(albAttributes, "access_logs.s3.enabled") === "true" &&
    attributeValue(albAttributes, "access_logs.s3.bucket") === LOG_BUCKET &&
    attributeValue(albAttributes, "access_logs.s3.prefix") === "" &&
    encryptedSseS3 &&
    allPublicAccessBlocked &&
    bucketOwnerEnforced &&
    lifecycle365 &&
    exactLogBucketPolicy;

  const webAcl = wafValue?.WebACL;
  const wafRules = Array.isArray(webAcl?.Rules) ? webAcl.Rules : [];
  const exactManagedRule = (rule, name, priority, groupName) => {
    const managed = rule?.Statement?.ManagedRuleGroupStatement;
    return (
      isRecord(rule) &&
      rule.Name === name &&
      rule.Priority === priority &&
      !Object.hasOwn(rule, "Action") &&
      isExactAction(rule.OverrideAction, "None") &&
      hasExactObjectKeys(rule.Statement, ["ManagedRuleGroupStatement"]) &&
      hasExactObjectKeys(managed, ["VendorName", "Name"]) &&
      managed.VendorName === "AWS" &&
      managed.Name === groupName
    );
  };
  const hasExactBlockAction = (rule) =>
    isExactAction(rule?.Action, "Block") && !Object.hasOwn(rule, "OverrideAction");
  const isExactSigninRateRule = (rule) => {
    const rate = rule?.Statement?.RateBasedStatement;
    const scopeDown = rate?.ScopeDownStatement;
    const andStatement = scopeDown?.AndStatement;
    const statements = andStatement?.Statements;
    return (
      isRecord(rule) &&
      rule.Name === "signin-25-per-5m" &&
      rule.Priority === 40 &&
      hasExactObjectKeys(rule.Statement, ["RateBasedStatement"]) &&
      hasExactObjectKeys(rate, [
        "Limit",
        "AggregateKeyType",
        "EvaluationWindowSec",
        "ScopeDownStatement",
      ]) &&
      hasExactObjectKeys(scopeDown, ["AndStatement"]) &&
      hasExactObjectKeys(andStatement, ["Statements"]) &&
      rate?.Limit === 25 &&
      rate?.AggregateKeyType === "IP" &&
      rate?.EvaluationWindowSec === 300 &&
      Array.isArray(statements) &&
      statements.length === 2 &&
      hasExactBlockAction(rule) &&
      statements.some((statement) =>
        isExactByteMatch(statement, "UriPath", "/api/auth/sign-in/email"),
      ) &&
      statements.some((statement) => isExactByteMatch(statement, "Method", "POST"))
    );
  };
  const isExactPlaneRateRule = (rule) => {
    const rate = rule?.Statement?.RateBasedStatement;
    return (
      isRecord(rule) &&
      rule.Name === "remote-plane-1000-per-5m" &&
      rule.Priority === 50 &&
      hasExactObjectKeys(rule.Statement, ["RateBasedStatement"]) &&
      hasExactObjectKeys(rate, [
        "Limit",
        "AggregateKeyType",
        "EvaluationWindowSec",
      ]) &&
      rate?.Limit === 1000 &&
      rate?.AggregateKeyType === "IP" &&
      rate?.EvaluationWindowSec === 300 &&
      hasExactBlockAction(rule)
    );
  };
  empty.wafCompliant =
    webAcl?.Name === WAF_NAME &&
    webAcl?.Id === expectedWafId &&
    wafAssociationValue?.WebACL?.ARN === webAcl?.ARN &&
    isExactAction(webAcl?.DefaultAction, "Allow") &&
    wafRules.length === 5 &&
    exactManagedRule(
      wafRules[0],
      "AWS-AmazonIpReputation",
      10,
      "AWSManagedRulesAmazonIpReputationList",
    ) &&
    exactManagedRule(
      wafRules[1],
      "AWS-Common",
      20,
      "AWSManagedRulesCommonRuleSet",
    ) &&
    exactManagedRule(
      wafRules[2],
      "AWS-KnownBadInputs",
      30,
      "AWSManagedRulesKnownBadInputsRuleSet",
    ) &&
    isExactSigninRateRule(wafRules[3]) &&
    isExactPlaneRateRule(wafRules[4]);
} catch {
  // Keep all remote facts false when any AWS response is missing or malformed.
}

process.stdout.write(JSON.stringify(empty));
NODE
  )" || {
    REMOTE_ADMIN_FACTS='{}'
    echo "launch-readiness: remote admin response invalid" >&2
  }
}

if [ "$REMOTE_ADMIN_MODE" = "1" ]; then
  collect_remote_admin_perimeter
fi

CLOUDWATCH_ALARM_COUNT="$(
  aws cloudwatch describe-alarms \
    --region "$AWS_REGION" \
    --query 'length(MetricAlarms)' \
    --output text 2>/dev/null || printf '%s' '0'
)"
SNS_TOPIC_COUNT="$(
  aws sns list-topics \
    --region "$AWS_REGION" \
    --query 'length(Topics)' \
    --output text 2>/dev/null || printf '%s' '0'
)"

# BEGIN_READINESS_REPORT_BUILDER
build_readiness_report() {
  REMOTE_ADMIN_FACTS="$REMOTE_ADMIN_FACTS" node - \
    "$REMOTE_JSON" \
    "$RDS_JSON" \
    "$S3_AVAILABLE" \
    "$S3_VERSIONING" \
    "$S3_LIFECYCLE" \
    "$CLOUDWATCH_ALARM_COUNT" \
    "$SNS_TOPIC_COUNT" \
    "$S3_CORS" \
    "$S3_PUBLIC_ACCESS" \
    "$INSTANCE_NETWORK" \
    "$SG_STATE" \
    "$INSTANCE_NETWORK_OK" \
    "$SG_QUERY_OK" \
    "$S3_CORS_OK" \
    "$S3_PUBLIC_ACCESS_OK" \
    "${REMOTE_ADMIN_MODE:-0}" \
    "${REMOTE_TARGET_HEALTH_REQUIRED:-0}" \
    "${REMOTE_ADMIN_LIFECYCLE_MODE:-}" <<'NODE'
const remote = JSON.parse(process.argv[2]);
const rds = JSON.parse(process.argv[3] || "{}");
const s3Available = process.argv[4] === "true";
const s3Versioning = process.argv[5] || "Disabled";
const s3Lifecycle = JSON.parse(process.argv[6] || "[]");
const cloudWatchAlarmCount = Number(process.argv[7] || 0);
const snsTopicCount = Number(process.argv[8] || 0);
const cors = JSON.parse(process.argv[9] || '{"CORSRules":[]}') ?? { CORSRules: [] };
const publicAccess = JSON.parse(process.argv[10] || "{}") ?? {};
const instanceNetwork = JSON.parse(process.argv[11] || "{}") ?? {};
const securityGroupValue = JSON.parse(process.argv[12] || "[]");
const securityGroups = Array.isArray(securityGroupValue) ? securityGroupValue : [];
const instanceNetworkOk = process.argv[13] === "true";
const securityGroupQueryOk = process.argv[14] === "true";
const s3CorsOk = process.argv[15] === "true";
const s3PublicAccessOk = process.argv[16] === "true";
const remoteAdminMode = process.argv[17] === "1";
const remoteTargetHealthRequired = process.argv[18] === "1";
const requestedRemoteAdminLifecycleMode = process.argv[19] || "";
const remoteAdminLifecycleMode =
  remoteAdminMode && requestedRemoteAdminLifecycleMode === ""
    ? remoteTargetHealthRequired
      ? "compat-active"
      : "compat-pre-registration"
    : requestedRemoteAdminLifecycleMode;
let remoteAdminFacts = {};
try {
  const parsed = JSON.parse(process.env.REMOTE_ADMIN_FACTS || "{}");
  if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
    remoteAdminFacts = parsed;
  }
} catch {
  remoteAdminFacts = {};
}
const canonicalOrigin = "https://nava.legacyhotels.co.za";
const remoteAdminOrigin = "https://nava-admin.trynava.io";
const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isStringArray = (value, requireValue = false) =>
  Array.isArray(value) &&
  (!requireValue || value.length > 0) &&
  value.every((item) => typeof item === "string" && item.length > 0);
const corsRules =
  isRecord(cors) && Array.isArray(cors.CORSRules) ? cors.CORSRules : [];
const corsRuleFields = new Set([
  "AllowedOrigins",
  "AllowedMethods",
  "AllowedHeaders",
  "ExposeHeaders",
  "MaxAgeSeconds",
]);
const corsStructureValid =
  isRecord(cors) &&
  Object.keys(cors).length === 1 &&
  Object.hasOwn(cors, "CORSRules") &&
  corsRules.length > 0 &&
  corsRules.every(
    (rule) =>
      isRecord(rule) &&
      Object.keys(rule).every((field) => corsRuleFields.has(field)) &&
      isStringArray(rule.AllowedOrigins, true) &&
      isStringArray(rule.AllowedMethods, true) &&
      (rule.AllowedHeaders === undefined ||
        isStringArray(rule.AllowedHeaders)) &&
      (rule.ExposeHeaders === undefined ||
        isStringArray(rule.ExposeHeaders)) &&
      (rule.MaxAgeSeconds === undefined ||
        (Number.isInteger(rule.MaxAgeSeconds) && rule.MaxAgeSeconds >= 0)),
  );
const hasWildcardCorsOrigin =
  corsStructureValid &&
  corsRules.some((rule) =>
    rule.AllowedOrigins.some((origin) => origin.includes("*")),
  );
const hasCanonicalCorsRule =
  corsStructureValid &&
  corsRules.some(
    (rule) =>
      rule.AllowedOrigins.includes(canonicalOrigin) &&
      rule.AllowedMethods.includes("GET") &&
      rule.AllowedMethods.includes("HEAD"),
  );
const hasExactGetHeadMethods = (rule) =>
  Array.isArray(rule?.AllowedMethods) &&
  rule.AllowedMethods.length === 2 &&
  rule.AllowedMethods.includes("GET") &&
  rule.AllowedMethods.includes("HEAD");
const hasRemoteAdminCorsRule =
  corsStructureValid &&
  corsRules.some(
    (rule) =>
      rule.AllowedOrigins.includes(remoteAdminOrigin) &&
      hasExactGetHeadMethods(rule),
  );
const publicAccessFields = [
  "BlockPublicAcls",
  "IgnorePublicAcls",
  "BlockPublicPolicy",
  "RestrictPublicBuckets",
];
const publicAccessStructureValid =
  isRecord(publicAccess) &&
  Object.keys(publicAccess).length === publicAccessFields.length &&
  Object.keys(publicAccess).every((field) =>
    publicAccessFields.includes(field),
  ) &&
  publicAccessFields.every(
    (field) => typeof publicAccess[field] === "boolean",
  );
const sgIdPattern = /^sg-[0-9a-f]{8,17}$/;
const groupIds = (groups) => {
  if (
    !Array.isArray(groups) ||
    groups.length === 0 ||
    !groups.every(
      (group) =>
        isRecord(group) &&
        typeof group.GroupId === "string" &&
        sgIdPattern.test(group.GroupId),
    )
  ) {
    return null;
  }
  const ids = groups.map((group) => group.GroupId);
  return new Set(ids).size === ids.length ? ids : null;
};
const sameStringSet = (actual, expected) =>
  Array.isArray(actual) &&
  actual.length === expected.length &&
  [...actual].sort().every((value, index) => value === [...expected].sort()[index]);
const topLevelGroupIds = isRecord(instanceNetwork)
  ? groupIds(instanceNetwork.securityGroups)
  : null;
const rawNetworkInterfaces =
  isRecord(instanceNetwork) && Array.isArray(instanceNetwork.networkInterfaces)
    ? instanceNetwork.networkInterfaces
    : [];
const parsedNetworkInterfaces = rawNetworkInterfaces.map((networkInterface) => {
  if (
    !isRecord(networkInterface) ||
    typeof networkInterface.id !== "string" ||
    !networkInterface.id.startsWith("eni-") ||
    !Number.isInteger(networkInterface.deviceIndex) ||
    networkInterface.deviceIndex < 0 ||
    (networkInterface.publicIpv4 !== null &&
      typeof networkInterface.publicIpv4 !== "string") ||
    !Array.isArray(networkInterface.ipv6) ||
    !networkInterface.ipv6.every((address) => typeof address === "string")
  ) {
    return null;
  }
  const securityGroups = groupIds(networkInterface.securityGroups);
  return securityGroups === null
    ? null
    : {
        id: networkInterface.id,
        deviceIndex: networkInterface.deviceIndex,
        securityGroups,
      };
});
const networkInterfacesValid =
  rawNetworkInterfaces.length > 0 &&
  !parsedNetworkInterfaces.some((networkInterface) => networkInterface === null);
const networkInterfaces = networkInterfacesValid
  ? parsedNetworkInterfaces
  : [];
const primaryNetworkInterfaces = networkInterfaces.filter(
  (networkInterface) => networkInterface.deviceIndex === 0,
);
const instanceNetworkShapeValid =
  isRecord(instanceNetwork) &&
  topLevelGroupIds !== null &&
  Array.isArray(instanceNetwork.publicIpv4) &&
  instanceNetwork.publicIpv4.every((address) => typeof address === "string") &&
  Array.isArray(instanceNetwork.ipv6) &&
  instanceNetwork.ipv6.every((address) => typeof address === "string") &&
  networkInterfacesValid &&
  primaryNetworkInterfaces.length === 1 &&
  new Set(networkInterfaces.map((networkInterface) => networkInterface.id)).size ===
    networkInterfaces.length &&
  new Set(
    networkInterfaces.map((networkInterface) => networkInterface.deviceIndex),
  ).size === networkInterfaces.length &&
  sameStringSet(topLevelGroupIds, primaryNetworkInterfaces[0].securityGroups);
const attachedIds = instanceNetworkShapeValid
  ? [
      ...new Set(
        networkInterfaces.flatMap((networkInterface) => networkInterface.securityGroups),
      ),
    ]
  : [];
const inspectedRecordsValid =
  securityGroups.length > 0 &&
  securityGroups.every(
    (group) =>
      isRecord(group) &&
      typeof group.id === "string" &&
      sgIdPattern.test(group.id) &&
      Array.isArray(group.ingress),
  );
const inspectedIds = inspectedRecordsValid
  ? securityGroups.map((group) => group.id)
  : [];
const inspectedIdsUnique =
  inspectedRecordsValid && new Set(inspectedIds).size === inspectedIds.length;
const exactSecurityGroupSet =
  instanceNetworkShapeValid &&
  inspectedIdsUnique &&
  attachedIds.length === inspectedIds.length &&
  attachedIds.every((id) => inspectedIds.includes(id));
const ingressEmpty =
  inspectedRecordsValid &&
  securityGroups.every((group) => group.ingress.length === 0);
const instanceNetworkValid =
  instanceNetworkOk && instanceNetworkShapeValid;
const publicAddressPresence = {
  ipv4:
    instanceNetworkValid &&
    instanceNetwork.publicIpv4.length > 0,
  ipv6:
    instanceNetworkValid &&
    instanceNetwork.ipv6.length > 0,
};
const securityGroupsValid =
  securityGroupQueryOk &&
  inspectedRecordsValid &&
  inspectedIdsUnique &&
  exactSecurityGroupSet &&
  ingressEmpty;
const securityGroupCoverageValid =
  securityGroupQueryOk &&
  inspectedRecordsValid &&
  inspectedIdsUnique &&
  exactSecurityGroupSet;
const pm2Required = remote.pm2?.required ?? {};
const db = remote.db ?? {};
let detectedRemoteAdminState = "unknown";

const checks = {
  httpHealthy: remote.health?.http === true,
  httpsHealthy: remote.health?.https === true,
  tlsValid: remote.health?.tls === true,
  pm2HttpOnline: pm2Required.http?.present === true && pm2Required.http?.online === true,
  pm2WorkerOnline:
    pm2Required.worker?.present === true && pm2Required.worker?.online === true,
  pm2AiWorkerOnline:
    pm2Required["ai-worker"]?.present === true &&
    pm2Required["ai-worker"]?.online === true,
  strictHotelProbe: remote.hotelProbe === true,
  productionEnvLoaded: remote.config?.envLoaded === true,
  mailTransportReal: remote.config?.mailTransportModeReal === true,
  betterAuthUrlCorrect: remote.config?.betterAuthUrlCorrect === true,
  undoSendSeconds30: remote.config?.undoSendSecondsCorrect === true,
  aiWriteGateEnabled: remote.config?.aiWriteGateEnabled === true,
  aiDraftsDisabled: remote.config?.aiDraftsDisabled === true,
  databaseConnected: db.connected === true,
  centurionTransportActive: db.centurionActiveTransportCount === 1,
  centurionCategoriesActive: db.centurionActiveCategoryCount === 12,
  workflowCategoriesComplete: Number(db.workflowCategoryMissingCount ?? 0) === 0,
  workflowNonterminalBacklogEmpty: db.workflowNonterminalCount === 0,
  // Fail only on recent dead letters (24h). Historical terminal rows stay in observations.
  workflowDeadLetterBacklogEmpty: Number(db.workflowDeadLetterRecentCount ?? 0) === 0,
  // Warn-only (see WARN_ONLY_CHECKS below): printed as a warning, never fails the gate.
  outboundBacklogEmpty: db.outboundNonterminalCount === 0,
  diskSafe: remote.disk?.safe === true,
  rdsAvailable: rds.status === "available",
  pitrAvailable:
    Number(rds.backupRetentionDays ?? 0) > 0 &&
    Boolean(rds.backupLatestRestorableAt),
  deletionProtection: rds.deletionProtection === true,
  ufwTunnel443Only:
    remote.firewall?.statusRead === true &&
    remote.firewall?.rulesRead === true &&
    remote.firewall?.active === true &&
    remote.firewall?.defaultDeny === true &&
    remote.firewall?.tunnel443 === true &&
    remote.firewall?.broad443Absent === true,
  s3CorsCanonical:
    s3CorsOk &&
    corsStructureValid &&
    !hasWildcardCorsOrigin &&
    hasCanonicalCorsRule,
  s3PublicAccessBlocked:
    s3PublicAccessOk &&
    publicAccessStructureValid &&
    publicAccess.BlockPublicAcls === true &&
    publicAccess.IgnorePublicAcls === true &&
    publicAccess.BlockPublicPolicy === true &&
    publicAccess.RestrictPublicBuckets === true,
};
if (!remoteAdminMode) {
  checks.securityGroupIngressEmpty = instanceNetworkValid && securityGroupsValid;
  checks.instanceHasNoPublicIpv6 =
    instanceNetworkValid && !publicAddressPresence.ipv6;
}
if (remoteAdminMode) {
  const preRegistration =
    remoteAdminFacts.preRegistrationClean === true &&
    remoteAdminFacts.noNonDefaultListenerRules === true &&
    remoteAdminFacts.hostForwardExact !== true &&
    remoteAdminFacts.targetHealthy !== true;
  const active =
    remoteAdminFacts.preRegistrationClean !== true &&
    remoteAdminFacts.noNonDefaultListenerRules !== true &&
    remoteAdminFacts.hostForwardExact === true &&
    remoteAdminFacts.targetHealthy === true;
  const rollback =
    remoteAdminFacts.preRegistrationClean !== true &&
    remoteAdminFacts.noNonDefaultListenerRules === true &&
    remoteAdminFacts.hostForwardExact !== true &&
    remoteAdminFacts.targetHealthy === true;
  detectedRemoteAdminState =
    preRegistration && !active && !rollback
      ? "pre-registration"
      : active && !rollback
        ? "active"
        : rollback
          ? "rollback"
          : "unknown";
  const remoteChecks = {
    remoteResourcesResolved: remoteAdminFacts.resourcesResolved === true,
    remoteTargetGroupConfigured: remoteAdminFacts.targetGroupConfigured === true,
    remoteListenerDefault404: remoteAdminFacts.listenerDefault404 === true,
    remoteTargetSecurityGroupOnlyAlb:
      remoteAdminFacts.targetSecurityGroupOnlyAlb === true,
    remoteNoDirectPublicTargetPath:
      remoteAdminFacts.noDirectPublicTargetPath === true,
    remoteEc2EniSecurityGroupsCovered:
      instanceNetworkValid && securityGroupCoverageValid,
    remoteUfwAlb8443Only: remote.firewall?.remoteAlb8443Only === true,
    remoteListenerSafe: remote.firewall?.listenerSafe === true,
    s3CorsRemoteAdmin:
      s3CorsOk &&
      corsStructureValid &&
      !hasWildcardCorsOrigin &&
      hasRemoteAdminCorsRule,
    remoteAlbLoggingCompliant: remoteAdminFacts.logBucketCompliant === true,
    remoteWafCompliant: remoteAdminFacts.wafCompliant === true,
  };
  if (remoteAdminLifecycleMode === "compat-active") {
    Object.assign(remoteChecks, {
      remoteHostForwardExact: remoteAdminFacts.hostForwardExact === true,
      remoteTargetHealthy: remoteAdminFacts.targetHealthy === true,
    });
  } else if (remoteAdminLifecycleMode === "compat-pre-registration") {
    remoteChecks.remotePreRegistrationClean =
      remoteAdminFacts.preRegistrationClean === true;
  } else {
    remoteChecks.remoteLifecycleStateKnown = detectedRemoteAdminState !== "unknown";
    remoteChecks.remoteLifecycleStateExpected =
      remoteAdminLifecycleMode === "auto" ||
      detectedRemoteAdminState === remoteAdminLifecycleMode;
  }
  Object.assign(checks, remoteChecks);
}
// Warn-only checks are reported in `warnings` and printed, but only `failures` decides READY.
const WARN_ONLY_CHECKS = new Set(["outboundBacklogEmpty"]);
const failedChecks = Object.entries(checks)
  .filter(([, passed]) => !passed)
  .map(([name]) => name);
const failures = failedChecks.filter((name) => !WARN_ONLY_CHECKS.has(name));
const warnings = failedChecks.filter((name) => WARN_ONLY_CHECKS.has(name));

const report = {
  status: failures.length === 0 ? "READY" : "NOT_READY",
  generatedAt: new Date().toISOString(),
  monitoringMode: "manual",
  checks,
  failures,
  warnings,
  observations: {
    multiAZ: rds.multiAZ === true,
    backupLatestRestorableAt: rds.backupLatestRestorableAt ?? null,
    s3: {
      available: s3Available,
      versioning: s3Versioning,
      lifecycle: s3Lifecycle,
      corsCanonical: checks.s3CorsCanonical,
      publicAccessBlocked: checks.s3PublicAccessBlocked,
    },
    network: {
      securityGroupIngressEmpty: checks.securityGroupIngressEmpty,
      ...(remoteAdminMode
        ? { publicAddressPresence }
        : { instanceHasNoPublicIpv6: checks.instanceHasNoPublicIpv6 }),
    },
    cloudWatchAlarmCount,
    snsTopicCount,
    latestInboundAt: db.latestInboundAt ?? null,
    workflowDeadLetterCount: Number(db.workflowDeadLetterCount ?? 0),
    workflowDeadLetterRecentCount: Number(db.workflowDeadLetterRecentCount ?? 0),
    outboundNonterminalCount: db.outboundNonterminalCount ?? null,
    counts: db.counts ?? {},
    pm2Restarts: {
      http: Number(pm2Required.http?.restarts ?? 0),
      worker: Number(pm2Required.worker?.restarts ?? 0),
      aiWorker: Number(pm2Required["ai-worker"]?.restarts ?? 0),
    },
    disk: remote.disk ?? { safe: false, usedPercent: 100, freeMB: 0 },
    accessMode: remoteAdminMode ? "remote-admin" : "legacy-only-recovery",
    remoteAdmin: remoteAdminMode
      ? {
          requestedLifecycleMode: remoteAdminLifecycleMode,
          detectedState: detectedRemoteAdminState,
          targetHealthRequired: remoteTargetHealthRequired,
          preRegistrationClean: remoteAdminFacts.preRegistrationClean === true,
          noNonDefaultListenerRules:
            remoteAdminFacts.noNonDefaultListenerRules === true,
          targetHealthy: remoteAdminFacts.targetHealthy === true,
        }
      : undefined,
  },
};
process.stdout.write(JSON.stringify(report));
NODE
}
# END_READINESS_REPORT_BUILDER

REPORT_JSON="$(build_readiness_report)"

printf '%s\n' "$REPORT_JSON"
node - "$REPORT_JSON" <<'NODE' >&2
const report = JSON.parse(process.argv[2]);
const failures = report.failures.length ? report.failures.join(",") : "none";
console.error(
  `launch-readiness ${report.status}; criticalFailures=${failures}; ` +
    `monitoringMode=${report.monitoringMode}; multiAZ=${report.observations.multiAZ}; ` +
    `s3Versioning=${report.observations.s3.versioning}`,
);
if (report.warnings.length) {
  console.error(
    `WARNING launch-readiness: ${report.warnings.join(",")} not met ` +
      `(outboundNonterminalCount=${report.observations.outboundNonterminalCount}). ` +
      "Warn-only: this does not fail the deploy. Check the outbound queue.",
  );
}
NODE

if node -e 'process.exit(JSON.parse(process.argv[1]).status === "READY" ? 0 : 1)' "$REPORT_JSON"; then
  exit 0
fi
exit 1
