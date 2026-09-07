#!/usr/bin/env bash
# Safe, scoped entry point for the reservation-tools pilot slices.
#
# The gate is deliberately fail-closed: an unknown mode/slice, missing named
# test/configuration, absent disposable DB, or skipped required test is an
# error. It never sources an environment file and never accepts pilot RDS.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_PILOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${SERVER_PILOT}/../.." && pwd)"

readonly FIXTURE_MANIFEST="${SERVER_PILOT}/tests/fixtures/reservation-tools-pilot.json"

die() {
  local message=$1
  local status=${2:-1}
  echo "reservation-pilot-gate: ${message}" >&2
  exit "$status"
}

usage() {
  cat >&2 <<'EOF'
usage: bash apps/server-pilot/scripts/reservation-pilot-gate.sh \
  {unit|db|browser|build} <named-slice>

The gate runs one exact named slice. It does not select tests by a broad glob.
DB mode requires CONFIRM_DISPOSABLE_TEST_DB=1 and a loopback
NAVA_TEST_DATABASE_URL for an owned disposable database.
EOF
  exit 64
}

[[ $# -eq 2 ]] || usage
MODE=$1
SLICE=$2

case "$MODE" in
  unit|db|browser|build) ;;
  *) die "unknown mode '${MODE}' (expected unit, db, browser, or build)" 65 ;;
esac

require_file() {
  local relative_path=$1
  local absolute_path="${REPO_ROOT}/${relative_path}"
  [[ -f "$absolute_path" ]] || die "required file/config missing for ${MODE} ${SLICE}: ${relative_path}" 69
}

require_files() {
  local relative_path
  for relative_path in "$@"; do
    require_file "$relative_path"
  done
}

case "${MODE}:${SLICE}" in
  unit:dashboard|unit:measurement)
    require_files \
      "apps/server-pilot/scripts/reservation-pilot-gate.sh" \
      "apps/server-pilot/tests/reservation-pilot-gate.test.ts" \
      "apps/server-pilot/tests/fixtures/reservation-tools-pilot.json"
    ;;
  unit:reads)
    require_files \
      "apps/server-pilot/tests/hms-read-service.test.ts" \
      "apps/server-pilot/tests/hms-normal-runtime-read-service.test.ts" \
      "apps/server-pilot/tests/hms-reservation-context.test.ts" \
      "apps/server-pilot/tests/hms-property-read-lock.test.ts"
    ;;
  unit:documents)
    require_files \
      "apps/server-pilot/tests/existing-document-service.test.ts" \
      "apps/server-pilot/tests/existing-document-validation.test.ts" \
      "apps/server-pilot/tests/hms-live-communications-reads.test.ts" \
      "apps/server-pilot/tests/hms-artifact.test.ts"
    ;;
  unit:finance)
    require_files \
      "apps/server-pilot/tests/hms-folio-read.test.ts" \
      "apps/server-pilot/tests/hms-live-folio-read.test.ts" \
      "apps/server-pilot/tests/hms-finance-completeness.test.ts"
    ;;
  unit:quotes)
    require_files \
      "apps/server-pilot/tests/hms-quote-stay-v2.test.ts" \
      "apps/server-pilot/tests/hms-live-quote-stay.test.ts" \
      "apps/server-pilot/tests/hms-quote-request-normalization.test.ts" \
      "apps/server-pilot/tests/hms-quote-completeness.test.ts"
    ;;
  unit:contexts)
    require_files \
      "apps/server-pilot/tests/hms-context-reads.test.ts" \
      "apps/server-pilot/tests/hms-notes-traces-read.test.ts"
    ;;
  unit:knowledge)
    require_files \
      "apps/server-pilot/tests/property-knowledge-read.test.ts" \
      "apps/server-pilot/tests/fixtures/property-knowledge.json"
    ;;
  unit:drafting)
    require_files \
      "apps/server-pilot/tests/reply-playbooks.test.ts" \
      "apps/server-pilot/tests/reply-assessment.test.ts" \
      "apps/server-pilot/tests/prepared-draft-input.test.ts" \
      "apps/server-pilot/tests/local-model-adapter-contract.test.ts" \
      "apps/server-pilot/tests/shadow-model-routing.test.ts"
    ;;
  unit:baseline)
    require_files \
      "apps/server-pilot/tests/mail-baseline.test.ts" \
      "apps/server-pilot/tests/mail-baseline-projection.test.ts" \
      "apps/server-pilot/tests/mail-baseline-extraction.test.ts"
    ;;
  unit:shadow)
    require_files \
      "apps/server-pilot/tests/shadow-evaluation.test.ts" \
      "apps/server-pilot/tests/shadow-reference-matcher.test.ts" \
      "apps/server-pilot/tests/shadow-scorecard.test.ts"
    ;;
  unit:approval)
    require_files \
      "apps/server-pilot/tests/draft-approval.test.ts" \
      "apps/server-pilot/tests/draft-refresh-generation.test.ts"
    ;;
  db:dashboard)
    require_files "apps/server-pilot/tests/admin-dashboard-query.test.ts"
    ;;
  db:reads)
    require_files \
      "apps/server-pilot/tests/hms-read-service.test.ts" \
      "apps/server-pilot/tests/hms-normal-runtime-read-service.test.ts"
    ;;
  db:documents)
    require_files "apps/server-pilot/tests/existing-document-validation.test.ts"
    ;;
  db:baseline)
    require_files "apps/server-pilot/tests/mail-baseline-projection.test.ts"
    ;;
  db:shadow)
    require_files "apps/server-pilot/tests/shadow-evaluation.test.ts"
    ;;
  db:outbox)
    require_files "apps/server-pilot/tests/outbound-queue.test.ts"
    ;;
  browser:dashboard|browser:documents|browser:pilot)
    require_files \
      "apps/mail/tests/e2e/reservation-tools-pilot.spec.ts" \
      "apps/mail/vite.pilot-fixture.config.ts"
    ;;
  build:server)
    require_files "apps/server-pilot/package.json"
    ;;
  build:mail)
    require_files "apps/mail/package.json"
    ;;
  *)
    die "unknown slice '${SLICE}' for mode '${MODE}'" 65
    ;;
esac

readonly CLEAN_UNSET_VARS=(
  DATABASE_URL
  TEST_DATABASE_URL
  NAVA_TEST_DATABASE_URL
  NAVA_TEST_DATABASE_CONNECTION_FILE
  NAVA_TEST_DATABASE_RECEIPT
  NAVA_EXPECTED_DATABASE
  NAVA_EXPECTED_ROLE
  NAVA_EXPECTED_RUN
  CONFIRM_DISPOSABLE_TEST_DB
  VITEST_ALLOW_PILOT_RDS
  OPENAI_API_KEY
  ANTHROPIC_API_KEY
  GOOGLE_API_KEY
  GOOGLE_APPLICATION_CREDENTIALS
  AZURE_OPENAI_API_KEY
  AZURE_CLIENT_ID
  AZURE_CLIENT_SECRET
  AZURE_TENANT_ID
  COHERE_API_KEY
  MISTRAL_API_KEY
  OPENROUTER_API_KEY
  GROQ_API_KEY
  AWS_ACCESS_KEY_ID
  AWS_SECRET_ACCESS_KEY
  AWS_SESSION_TOKEN
  AWS_PROFILE
  AWS_DEFAULT_PROFILE
  AWS_WEB_IDENTITY_TOKEN_FILE
  AWS_BEARER_TOKEN_BEDROCK
  BEDROCK_API_KEY
  BEDROCK_MODEL_ID
  MODEL_API_KEY
  MODEL_BASE_URL
  LLM_API_KEY
  AI_ENABLED
  AI_MODEL
  HMS_USERNAME
  HMS_PASSWORD
  HMS_SECRET_ARN
  HMS_SESSION_TOKEN
  HMS_API_KEY
  PMS_USERNAME
  PMS_PASSWORD
  PMS_TOKEN
  PMS_SECRET_ARN
  PMS_API_KEY
  PLAYWRIGHT_BASE_URL
  PLAYWRIGHT_WS_ENDPOINT
  PLAYWRIGHT_BROWSERS_PATH
  BROWSERSTACK_USERNAME
  BROWSERSTACK_ACCESS_KEY
  MAIL_USERNAME
  MAIL_PASSWORD
  MAIL_API_KEY
  MAIL_SMTP_PASSWORD
  MAIL_IMAP_PASSWORD
  MAILGUN_API_KEY
  SENDGRID_API_KEY
  RESEND_API_KEY
  SMTP_USERNAME
  SMTP_PASSWORD
  SMTP_URL
  IMAP_URL
  POP3_URL
  POP3_USERNAME
  POP3_PASSWORD
  DOTENV_CONFIG_PATH
)

run_clean_command() {
  local -a unset_args=()
  local key
  for key in "${CLEAN_UNSET_VARS[@]}"; do
    unset_args+=(-u "$key")
  done
  env \
    "${unset_args[@]}" \
    NODE_ENV=test \
    CI=1 \
    MAIL_TRANSPORT_MODE=fixture \
    HMS_TRANSPORT_MODE=fixture \
    PMS_TRANSPORT_MODE=fixture \
    AWS_EC2_METADATA_DISABLED=true \
    NO_PROXY='*' \
    HTTP_PROXY= \
    HTTPS_PROXY= \
    ALL_PROXY= \
    DOTENV_CONFIG_PATH=/dev/null \
    NAVA_FIXTURE_NETWORK=loopback-only \
    NAVA_EXTERNAL_SOCKETS=deny \
    "$@"
}

run_clean_db_command() {
  local -a unset_args=()
  local key
  for key in "${CLEAN_UNSET_VARS[@]}"; do
    unset_args+=(-u "$key")
  done
  env \
    "${unset_args[@]}" \
    NODE_ENV=test \
    CI=1 \
    MAIL_TRANSPORT_MODE=fixture \
    HMS_TRANSPORT_MODE=fixture \
    PMS_TRANSPORT_MODE=fixture \
    AWS_EC2_METADATA_DISABLED=true \
    NO_PROXY='*' \
    HTTP_PROXY= \
    HTTPS_PROXY= \
    ALL_PROXY= \
    DOTENV_CONFIG_PATH=/dev/null \
    NAVA_FIXTURE_NETWORK=loopback-only \
    NAVA_EXTERNAL_SOCKETS=deny \
    NAVA_TEST_DATABASE_URL="$NAVA_TEST_DATABASE_URL" \
    TEST_DATABASE_URL="$NAVA_TEST_DATABASE_URL" \
    CONFIRM_DISPOSABLE_TEST_DB=1 \
    HMS_DB_TEST_REQUIRED=1 \
    NAVA_TEST_DATABASE_SCOPE=reservation-pilot-owned \
    "$@"
}

verify_vitest_report() {
  local report_path=$1
  node --input-type=module - "$report_path" <<'NODE'
import { readFileSync } from 'node:fs';

const reportPath = process.argv[2];
const report = JSON.parse(readFileSync(reportPath, 'utf8'));
const total = Number(report.numTotalTests ?? 0);
const passed = Number(report.numPassedTests ?? 0);
const failed = Number(report.numFailedTests ?? 0);
const skipped =
  Number(report.numPendingTests ?? 0) +
  Number(report.numTodoTests ?? 0) +
  Number(report.numSkippedTests ?? 0);

function countSkipped(assertions) {
  return (assertions ?? []).filter((assertion) =>
    ['pending', 'skipped', 'todo'].includes(assertion.status),
  ).length;
}

const assertionSkipped = (report.testResults ?? []).reduce(
  (sum, suite) => sum + countSkipped(suite.assertionResults),
  0,
);

if (total < 1) throw new Error('required test slice selected zero tests');
if (failed > 0 || skipped > 0 || assertionSkipped > 0 || passed !== total) {
  throw new Error(
    `required test slice is not fully green (total=${total}, passed=${passed}, failed=${failed}, skipped=${skipped + assertionSkipped})`,
  );
}
NODE
}

run_vitest() {
  local report_path
  report_path=$(mktemp "${TMPDIR:-/tmp}/reservation-pilot-vitest.XXXXXX.json")
  trap 'rm -f "$report_path"' RETURN

  local -a test_files=("$@")
  local test_name_pattern=''
  if [[ "${test_files[0]}" == --pattern=* ]]; then
    test_name_pattern=${test_files[0]#--pattern=}
    test_files=("${test_files[@]:1}")
  fi

  local -a command=(
    pnpm
    exec
    vitest
    run
    "${test_files[@]}"
    --reporter=json
    "--outputFile=${report_path}"
  )
  if [[ -n "$test_name_pattern" ]]; then
    command+=(--testNamePattern "$test_name_pattern")
  fi

  (cd "$SERVER_PILOT" && run_clean_command "${command[@]}")
  [[ -s "$report_path" ]] || die 'Vitest produced no result report; required slice cannot skip green' 1
  verify_vitest_report "$report_path" || die 'required Vitest slice failed or skipped' 1
  rm -f "$report_path"
  trap - RETURN
}

validate_disposable_url() {
  [[ -n "${NAVA_TEST_DATABASE_URL:-}" ]] || die 'db mode requires NAVA_TEST_DATABASE_URL for an owned disposable database' 66
  [[ "${CONFIRM_DISPOSABLE_TEST_DB:-}" == '1' ]] || \
    die 'db mode requires CONFIRM_DISPOSABLE_TEST_DB=1; ambient DB values are never accepted' 66

  if ! env NAVA_TEST_DATABASE_URL="$NAVA_TEST_DATABASE_URL" node --input-type=module >/dev/null 2>/dev/null <<'NODE'
const raw = process.env.NAVA_TEST_DATABASE_URL?.trim() ?? '';
let parsed;
try {
  parsed = new URL(raw);
} catch {
  console.error('invalid disposable database URL');
  process.exit(1);
}

if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
  console.error('database URL must use postgres protocol');
  process.exit(1);
}

const host = parsed.hostname.toLowerCase();
const database = decodeURIComponent(parsed.pathname.replace(/^\//, '')).toLowerCase();
const productionLooking = /(pilot|prod|production|live|rds|amazonaws|aurora|neon|supabase)/i;
const loopback = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';

if (!loopback) {
  console.error('unknown database host; only loopback disposable targets are accepted');
  process.exit(1);
}
if (host !== '127.0.0.1' || parsed.port !== '15432') {
  console.error('database endpoint does not match the owned loopback mapping');
  process.exit(1);
}
if (productionLooking.test(host) || productionLooking.test(database)) {
  console.error('production-looking database target refused');
  process.exit(1);
}
if (!database || database === 'postgres' || database === 'template0' || database === 'template1') {
  console.error('generic database name is not an owned disposable target');
  process.exit(1);
}
NODE
  then
    die 'refused unknown or production-looking database before connection' 66
  fi
}

verify_connection_artifact() {
  local connection_file="${NAVA_TEST_DATABASE_CONNECTION_FILE:-${REPO_ROOT}/.private/centurion-dashboard-tools-execution/disposable-postgres-connection.env}"
  [[ -f "$connection_file" ]] || die 'disposable connection artifact is missing; ownership is not proven' 66
  local mode
  mode=$(stat -c '%a' "$connection_file" 2>/dev/null || true)
  [[ "$mode" == '600' ]] || die 'disposable connection artifact must be mode 600' 66

  local assignment_count
  assignment_count=$(awk 'NF && $0 !~ /^#/ { count += 1 } END { print count + 0 }' "$connection_file")
  [[ "$assignment_count" == '1' ]] || die 'disposable connection artifact must contain only one assignment' 66
  local file_url
  file_url=$(sed -n 's/^NAVA_TEST_DATABASE_URL=//p' "$connection_file" | head -n 1)
  [[ -n "$file_url" && "$file_url" == "$NAVA_TEST_DATABASE_URL" ]] || \
    die 'NAVA_TEST_DATABASE_URL does not match the mode-600 disposable connection artifact' 66
}

verify_owned_disposable_target() {
  local receipt="${NAVA_TEST_DATABASE_RECEIPT:-${REPO_ROOT}/.private/centurion-dashboard-tools-execution/disposable-postgres-receipt.txt}"
  [[ -f "$receipt" ]] || die 'disposable ownership receipt is missing; DB mode refuses before connection' 66

  local container_name container_id image_ref host_binding database_name role_name run_label
  container_name=$(sed -n 's/^Container name: //p' "$receipt" | head -n 1)
  container_id=$(sed -n 's/^Container ID: //p' "$receipt" | head -n 1)
  image_ref=$(sed -n 's/^Image: //p' "$receipt" | head -n 1)
  host_binding=$(sed -n 's/^Host binding: //p' "$receipt" | head -n 1)
  database_name=$(sed -n 's/^Database: //p' "$receipt" | head -n 1)
  role_name=$(sed -n 's/^Role: //p' "$receipt" | head -n 1)
  run_label=$(sed -n 's/^Run label: //p' "$receipt" | head -n 1)

  [[ "$container_name" =~ ^[A-Za-z0-9_.-]+$ ]] || die 'disposable receipt has an invalid container name' 66
  [[ "$container_id" =~ ^[a-f0-9]{64}$ ]] || die 'disposable receipt has an invalid container ID' 66
  [[ "$image_ref" =~ ^postgres@sha256:[a-f0-9]{64}$ ]] || die 'disposable receipt has no pinned Postgres image digest' 66
  [[ "$host_binding" == '127.0.0.1:15432 -> container 5432/tcp' ]] || \
    die 'disposable DB host mapping is not the owned loopback mapping' 66
  [[ "$database_name" =~ ^[A-Za-z0-9_.-]+$ && "$role_name" =~ ^[A-Za-z0-9_.-]+$ ]] || \
    die 'disposable receipt has invalid database identity' 66
  [[ "$run_label" == '20260907-u1setup' ]] || die 'disposable receipt run label mismatch' 66

  command -v docker >/dev/null 2>&1 || die 'Docker is required to verify the owned disposable target' 66
  local actual_id state actual_image expected_image_id actual_host_ip actual_host_port
  actual_id=$(docker inspect --format '{{.Id}}' "$container_name" 2>/dev/null || true)
  state=$(docker inspect --format '{{.State.Status}}' "$container_name" 2>/dev/null || true)
  [[ "$actual_id" == "$container_id" && "$state" == 'running' ]] || \
    die 'disposable container identity or running state does not match the ownership receipt' 66

  expected_image_id=$(docker image inspect "$image_ref" --format '{{.Id}}' 2>/dev/null || true)
  actual_image=$(docker inspect --format '{{.Image}}' "$container_name" 2>/dev/null || true)
  [[ -n "$expected_image_id" && "$actual_image" == "$expected_image_id" ]] || \
    die 'disposable container image digest does not match the ownership receipt' 66

  actual_host_ip=$(docker inspect --format '{{(index (index .HostConfig.PortBindings "5432/tcp") 0).HostIp}}' "$container_name" 2>/dev/null || true)
  actual_host_port=$(docker inspect --format '{{(index (index .HostConfig.PortBindings "5432/tcp") 0).HostPort}}' "$container_name" 2>/dev/null || true)
  [[ "$actual_host_ip" == '127.0.0.1' && "$actual_host_port" == '15432' ]] || \
    die 'disposable container has a wildcard or unexpected host mapping' 66

  local owner_label run_label_actual lifecycle_label
  owner_label=$(docker inspect --format '{{index .Config.Labels "zero.owner"}}' "$container_name" 2>/dev/null || true)
  run_label_actual=$(docker inspect --format '{{index .Config.Labels "zero.run"}}' "$container_name" 2>/dev/null || true)
  lifecycle_label=$(docker inspect --format '{{index .Config.Labels "zero.lifecycle"}}' "$container_name" 2>/dev/null || true)
  [[ "$owner_label" == 'centurion-dashboard-tools' && "$run_label_actual" == "$run_label" && "$lifecycle_label" == 'disposable' ]] || \
    die 'disposable container ownership/lifecycle labels do not match the receipt' 66

  local url=$NAVA_TEST_DATABASE_URL
  if ! (
    cd "$SERVER_PILOT"
    env \
      NAVA_TEST_DATABASE_URL="$url" \
      NAVA_EXPECTED_DATABASE="$database_name" \
      NAVA_EXPECTED_ROLE="$role_name" \
      NAVA_EXPECTED_RUN="$run_label" \
      node --input-type=module >/dev/null 2>/dev/null <<'NODE'
import postgres from 'postgres';

const url = process.env.NAVA_TEST_DATABASE_URL;
const expectedDatabase = process.env.NAVA_EXPECTED_DATABASE;
const expectedRole = process.env.NAVA_EXPECTED_ROLE;
const expectedRun = process.env.NAVA_EXPECTED_RUN;
if (!url || !expectedDatabase || !expectedRole || !expectedRun) process.exit(1);

const connection = postgres(url, { max: 1, connect_timeout: 5, idle_timeout: 5 });
try {
  const [identity] = await connection`
    select
      current_database() as database_name,
      current_user as role_name,
      pg_get_userbyid(datdba) as owner_name
    from pg_database
    where datname = current_database()
  `;
  if (
    !identity ||
    identity.database_name !== expectedDatabase ||
    identity.role_name !== expectedRole ||
    identity.owner_name !== expectedRole
  ) process.exit(1);

  const sentinelRows = await connection.unsafe('select * from "centurion_u1_setup_sentinel"');
  if (sentinelRows.length !== 1) process.exit(1);
  const markerEntry = Object.entries(sentinelRows[0]).find(([key]) => /marker|run/i.test(key));
  if (!markerEntry || String(markerEntry[1]) !== expectedRun) process.exit(1);
} catch {
  process.exitCode = 1;
} finally {
  await connection.end({ timeout: 2 }).catch(() => undefined);
}
NODE
  ); then
    die 'disposable database owner or synthetic sentinel check failed' 67
  fi
}

probe_disposable_database() {
  local url=$NAVA_TEST_DATABASE_URL
  if ! (
    cd "$SERVER_PILOT"
    env NAVA_TEST_DATABASE_URL="$url" node --input-type=module >/dev/null 2>/dev/null <<'NODE'
import postgres from 'postgres';

const url = process.env.NAVA_TEST_DATABASE_URL;
if (!url) process.exit(1);
const connection = postgres(url, {
  max: 1,
  connect_timeout: 5,
  idle_timeout: 5,
});
try {
  await connection`select 1`;
} catch {
  process.exitCode = 1;
} finally {
  await connection.end({ timeout: 2 }).catch(() => undefined);
}
NODE
  ); then
    die 'disposable database probe failed; no required DB slice may skip' 67
  fi
}

run_db_slice() {
  validate_disposable_url
  verify_connection_artifact
  verify_owned_disposable_target
  probe_disposable_database

  local report_path
  report_path=$(mktemp "${TMPDIR:-/tmp}/reservation-pilot-db-vitest.XXXXXX.json")
  trap 'rm -f "$report_path"' RETURN
  local -a test_files=("$@")
  local -a command=(
    pnpm
    exec
    vitest
    run
    "${test_files[@]}"
    --reporter=json
    "--outputFile=${report_path}"
  )

  (
    cd "$SERVER_PILOT"
    run_clean_db_command "${command[@]}"
  )
  [[ -s "$report_path" ]] || die 'DB Vitest produced no result report; required slice cannot skip green' 1
  verify_vitest_report "$report_path" || die 'required DB Vitest slice failed or skipped' 1
  rm -f "$report_path"
  trap - RETURN
}

run_browser_slice() {
  local config="${REPO_ROOT}/apps/mail/vite.pilot-fixture.config.ts"
  local -a test_files=("$@")
  if ! rg -q '127\.0\.0\.1|localhost|loopback' "$config"; then
    die 'browser fixture config must explicitly use a loopback origin' 69
  fi
  local origin=${NAVA_FIXTURE_ORIGIN:-http://127.0.0.1:4179}
  if ! NAVA_GATE_ORIGIN="$origin" node --input-type=module >/dev/null 2>/dev/null <<'NODE'
const origin = process.env.NAVA_GATE_ORIGIN;
const parsed = new URL(origin);
if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) process.exit(1);
NODE
  then
    die 'browser fixture origin must be loopback-only' 66
  fi

  local report_path
  report_path=$(mktemp "${TMPDIR:-/tmp}/reservation-pilot-browser.XXXXXX.json")
  local error_path
  error_path=$(mktemp "${TMPDIR:-/tmp}/reservation-pilot-browser-error.XXXXXX.log")
  trap 'rm -f "$report_path" "$error_path"' RETURN
  local -a command=(
    pnpm
    exec
    playwright
    test
    "${test_files[@]}"
    "--config=${config}"
    --reporter=json
    --forbid-only
    --workers=1
  )

  (
    cd "$REPO_ROOT"
    run_clean_command "${command[@]}" >"$report_path" 2>"$error_path"
  ) || die 'browser fixture runner failed; no external or live service is permitted' 1
  [[ -s "$report_path" ]] || die 'browser runner produced no result report; required slice cannot skip green' 1
  node --input-type=module - "$report_path" <<'NODE'
import { readFileSync } from 'node:fs';

const report = JSON.parse(readFileSync(process.argv[2], 'utf8'));
let specs = 0;
let skipped = 0;
function visitSuite(suite) {
  for (const spec of suite.specs ?? []) {
    specs += 1;
    if (spec.ok === false || spec.skip === true || spec.status === 'skipped') skipped += 1;
  }
  for (const child of suite.suites ?? []) visitSuite(child);
}
for (const suite of report.suites ?? []) visitSuite(suite);
if (specs < 1) throw new Error('required browser slice selected zero tests');
if (skipped > 0) throw new Error(`required browser slice skipped ${skipped} test(s)`);
NODE
  rm -f "$report_path" "$error_path"
  trap - RETURN
}

run_build_slice() {
  local package_filter=$1
  (
    cd "$REPO_ROOT"
    run_clean_command pnpm --filter "$package_filter" build
  )
}

case "${MODE}:${SLICE}" in
  unit:dashboard)
    run_vitest "tests/reservation-pilot-gate.test.ts"
    ;;
  unit:measurement)
    run_vitest "tests/reservation-pilot-gate.test.ts"
    ;;
  unit:reads)
    run_vitest \
      "tests/hms-read-service.test.ts" \
      "tests/hms-normal-runtime-read-service.test.ts" \
      "tests/hms-reservation-context.test.ts" \
      "tests/hms-property-read-lock.test.ts"
    ;;
  unit:documents)
    run_vitest \
      "tests/existing-document-service.test.ts" \
      "tests/existing-document-validation.test.ts" \
      "tests/hms-live-communications-reads.test.ts" \
      "tests/hms-artifact.test.ts"
    ;;
  unit:finance)
    run_vitest \
      "tests/hms-folio-read.test.ts" \
      "tests/hms-live-folio-read.test.ts" \
      "tests/hms-finance-completeness.test.ts"
    ;;
  unit:quotes)
    run_vitest \
      "tests/hms-quote-stay-v2.test.ts" \
      "tests/hms-live-quote-stay.test.ts" \
      "tests/hms-quote-request-normalization.test.ts" \
      "tests/hms-quote-completeness.test.ts"
    ;;
  unit:contexts)
    run_vitest \
      "tests/hms-context-reads.test.ts" \
      "tests/hms-notes-traces-read.test.ts"
    ;;
  unit:knowledge)
    run_vitest "tests/property-knowledge-read.test.ts"
    ;;
  unit:drafting)
    run_vitest \
      "tests/reply-playbooks.test.ts" \
      "tests/reply-assessment.test.ts" \
      "tests/prepared-draft-input.test.ts" \
      "tests/local-model-adapter-contract.test.ts" \
      "tests/shadow-model-routing.test.ts"
    ;;
  unit:baseline)
    run_vitest \
      "tests/mail-baseline.test.ts" \
      "tests/mail-baseline-projection.test.ts" \
      "tests/mail-baseline-extraction.test.ts"
    ;;
  unit:shadow)
    run_vitest \
      "tests/shadow-evaluation.test.ts" \
      "tests/shadow-reference-matcher.test.ts" \
      "tests/shadow-scorecard.test.ts"
    ;;
  unit:approval)
    run_vitest \
      "tests/draft-approval.test.ts" \
      "tests/draft-refresh-generation.test.ts"
    ;;
  db:dashboard)
    run_db_slice "tests/admin-dashboard-query.test.ts"
    ;;
  db:reads)
    run_db_slice \
      "tests/hms-read-service.test.ts" \
      "tests/hms-normal-runtime-read-service.test.ts"
    ;;
  db:documents)
    run_db_slice "tests/existing-document-validation.test.ts"
    ;;
  db:baseline)
    run_db_slice "tests/mail-baseline-projection.test.ts"
    ;;
  db:shadow)
    run_db_slice "tests/shadow-evaluation.test.ts"
    ;;
  db:outbox)
    run_db_slice "tests/outbound-queue.test.ts"
    ;;
  browser:dashboard|browser:documents|browser:pilot)
    run_browser_slice "apps/mail/tests/e2e/reservation-tools-pilot.spec.ts"
    ;;
  build:server)
    run_build_slice '@zero/server'
    ;;
  build:mail)
    run_build_slice '@zero/mail'
    ;;
esac

echo "reservation-pilot-gate: PASS mode=${MODE} slice=${SLICE}"
