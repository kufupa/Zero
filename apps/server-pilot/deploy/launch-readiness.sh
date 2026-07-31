#!/usr/bin/env bash
# Centurion launch safety gate. Read-only except operator-run RDS protection step.
set -euo pipefail
set +x

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${AWS_REGION:=af-south-1}"
: "${INSTANCE_ID:=i-008f737974a9ba9b3}"
: "${RDS_INSTANCE_ID:=nava-zero-mail-pilot}"
: "${S3_BUCKET:=nava-zero-mail-845242190536-af-south-1}"

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
UFW_VERBOSE=""
UFW_ADDED=""
EXPECTED_UFW_ALLOW='ufw allow in on tun0 to any port 443 proto tcp'

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
  if printf '%s\n' "$UFW_ADDED" |
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
          process.stdout.write(JSON.stringify({
            required,
            allOnline: requiredNames.every((name) => required[name].online),
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
export UFW_ACTIVE UFW_DEFAULT_DENY UFW_TUN443 UFW_BROAD443_ABSENT

cd "$SERVER_PILOT"
DB_SUMMARY="$(
  node --input-type=module <<'NODE'
import postgres from "postgres";

const empty = {
  connected: false,
  centurionActiveTransportCount: 0,
  centurionActiveCategoryCount: 0,
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
      AND slug IN ('at-risk', 'new-bookings', 'groups-events', 'ops', 'urgent')
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
  DB_SUMMARY='{"connected":false,"centurionActiveTransportCount":0,"centurionActiveCategoryCount":0,"workflowNonterminalCount":0,"workflowDeadLetterCount":0,"workflowDeadLetterRecentCount":0,"outboundNonterminalCount":0,"latestInboundAt":null,"counts":{"threads":0,"messages":0,"inboundMessages":0}}'
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
  REMOTE_JSON='{"health":{"http":false,"https":false,"tls":false},"pm2":{"required":{},"allOnline":false},"hotelProbe":false,"firewall":{"statusRead":false,"rulesRead":false,"active":false,"defaultDeny":false,"tunnel443":false,"broad443Absent":false},"config":{"envLoaded":false,"mailTransportModeReal":false,"betterAuthUrlCorrect":false,"undoSendSecondsCorrect":false,"aiWriteGateEnabled":false,"aiDraftsDisabled":false},"db":{"connected":false,"centurionActiveTransportCount":0,"centurionActiveCategoryCount":0,"workflowNonterminalCount":0,"workflowDeadLetterCount":0,"workflowDeadLetterRecentCount":0,"outboundNonterminalCount":0,"latestInboundAt":null,"counts":{"threads":0,"messages":0,"inboundMessages":0}},"disk":{"safe":false,"usedPercent":100,"freeMB":0}}'
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
      --query 'Reservations[0].Instances[0].{securityGroups:SecurityGroups,ipv6:NetworkInterfaces[].Ipv6Addresses[].Ipv6Address}' \
      --output json 2>/dev/null
  )"; then
    INSTANCE_NETWORK="$instance_network_result"
    local sg_ids_text=""
    if sg_ids_text="$(
      node -e '
        const state = JSON.parse(process.argv[1]);
        const validRecord =
          state &&
          typeof state === "object" &&
          !Array.isArray(state) &&
          Array.isArray(state.securityGroups) &&
          state.securityGroups.length > 0 &&
          Array.isArray(state.ipv6) &&
          state.ipv6.every((address) => typeof address === "string") &&
          state.securityGroups.every(
            (group) =>
              group &&
              typeof group === "object" &&
              !Array.isArray(group) &&
              typeof group.GroupId === "string" &&
              /^sg-[0-9a-f]{8,17}$/.test(group.GroupId),
          );
        if (!validRecord) process.exit(1);
        const ids = state.securityGroups.map((group) => group.GroupId);
        if (new Set(ids).size !== ids.length) process.exit(1);
        process.stdout.write(ids.join("\n"));
      ' "$INSTANCE_NETWORK" 2>/dev/null
    )"; then
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
  node - \
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
    "$S3_PUBLIC_ACCESS_OK" <<'NODE'
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
const canonicalOrigin = "https://nava.legacyhotels.co.za";
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
const attachedGroups = Array.isArray(instanceNetwork.securityGroups)
  ? instanceNetwork.securityGroups
  : [];
const attachedRecordsValid =
  isRecord(instanceNetwork) &&
  attachedGroups.length > 0 &&
  attachedGroups.every(
    (group) =>
      isRecord(group) &&
      typeof group.GroupId === "string" &&
      sgIdPattern.test(group.GroupId),
  ) &&
  Array.isArray(instanceNetwork.ipv6) &&
  instanceNetwork.ipv6.every((address) => typeof address === "string");
const attachedIds = attachedRecordsValid
  ? attachedGroups.map((group) => group.GroupId)
  : [];
const attachedIdsUnique =
  attachedRecordsValid && new Set(attachedIds).size === attachedIds.length;
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
  attachedIdsUnique &&
  inspectedIdsUnique &&
  attachedIds.length === inspectedIds.length &&
  attachedIds.every((id) => inspectedIds.includes(id));
const ingressEmpty =
  inspectedRecordsValid &&
  securityGroups.every((group) => group.ingress.length === 0);
const instanceNetworkValid =
  instanceNetworkOk && attachedRecordsValid && attachedIdsUnique;
const securityGroupsValid =
  securityGroupQueryOk &&
  inspectedRecordsValid &&
  inspectedIdsUnique &&
  exactSecurityGroupSet &&
  ingressEmpty;
const pm2Required = remote.pm2?.required ?? {};
const db = remote.db ?? {};

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
  centurionCategoriesActive: db.centurionActiveCategoryCount === 5,
  workflowNonterminalBacklogEmpty: db.workflowNonterminalCount === 0,
  // Fail only on recent dead letters (24h). Historical terminal rows stay in observations.
  workflowDeadLetterBacklogEmpty: Number(db.workflowDeadLetterRecentCount ?? 0) === 0,
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
  securityGroupIngressEmpty: instanceNetworkValid && securityGroupsValid,
  instanceHasNoPublicIpv6:
    instanceNetworkValid && instanceNetwork.ipv6.length === 0,
};
const failures = Object.entries(checks)
  .filter(([, passed]) => !passed)
  .map(([name]) => name);

const report = {
  status: failures.length === 0 ? "READY" : "NOT_READY",
  generatedAt: new Date().toISOString(),
  monitoringMode: "manual",
  checks,
  failures,
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
      instanceHasNoPublicIpv6: checks.instanceHasNoPublicIpv6,
    },
    cloudWatchAlarmCount,
    snsTopicCount,
    latestInboundAt: db.latestInboundAt ?? null,
    workflowDeadLetterCount: Number(db.workflowDeadLetterCount ?? 0),
    workflowDeadLetterRecentCount: Number(db.workflowDeadLetterRecentCount ?? 0),
    counts: db.counts ?? {},
    pm2Restarts: {
      http: Number(pm2Required.http?.restarts ?? 0),
      worker: Number(pm2Required.worker?.restarts ?? 0),
      aiWorker: Number(pm2Required["ai-worker"]?.restarts ?? 0),
    },
    disk: remote.disk ?? { safe: false, usedPercent: 100, freeMB: 0 },
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
NODE

if node -e 'process.exit(JSON.parse(process.argv[1]).status === "READY" ? 0 : 1)' "$REPORT_JSON"; then
  exit 0
fi
exit 1
