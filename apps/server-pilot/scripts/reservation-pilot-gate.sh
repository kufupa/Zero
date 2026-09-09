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
readonly GATE_LIB="${SERVER_PILOT}/scripts/reservation-pilot-gate-lib.mjs"
readonly BROWSER_NAMESPACE_SCRIPT='
set -eu
/usr/sbin/ip link set lo up
interfaces=$(/usr/sbin/ip -o link show)
printf "%s\n" "$interfaces" | /usr/bin/grep -q ": lo:"
if printf "%s\n" "$interfaces" | /usr/bin/grep -v -q ": lo:"; then
  exit 1
fi
exec "$@"
'

run_gate_helper() {
  env -i PATH="${PATH:-/usr/local/bin:/usr/bin:/bin}" HOME=/tmp node "$GATE_LIB" "$@"
}

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

if [[ "$MODE" == db ]]; then
  DB_PROFILE=${NAVA_TEST_DATABASE_PROFILE:-pg17}
  DB_PROFILE_VALUES=$(run_gate_helper db-profile "$DB_PROFILE" all) || \
    die "unknown disposable database profile '${DB_PROFILE}'" 66
  IFS=$'\t' read -r DB_PORT DB_RUN_LABEL DB_MAJOR DB_RECEIPT_REL DB_CONNECTION_REL \
    DB_SENTINEL_TABLE DB_SENTINEL_MARKER <<<"$DB_PROFILE_VALUES"
  DB_RECEIPT="${REPO_ROOT}/${DB_RECEIPT_REL}"
  DB_CONNECTION="${REPO_ROOT}/${DB_CONNECTION_REL}"
fi

require_files() {
  run_gate_helper assert-files "$REPO_ROOT" "$@" || \
    die "required file/config missing for ${MODE} ${SLICE}" 69
}

case "$MODE" in
  unit|db)
    run_gate_helper assert-plan-files "$REPO_ROOT" "$MODE" "$SLICE" || \
      die "unknown slice '${SLICE}' for mode '${MODE}' or required file/config is missing" 69
    ;;
  browser)
    run_gate_helper assert-plan-files "$REPO_ROOT" "$MODE" "$SLICE" || \
      die "unknown slice '${SLICE}' for mode '${MODE}' or required file/config is missing" 69
    require_files \
      "apps/mail/tests/e2e/reservation-tools-pilot.spec.ts" \
      "apps/mail/vite.pilot-fixture.config.ts" \
      "apps/server-pilot/scripts/reservation-pilot-fixture-guard.mjs"
    ;;
  build)
    case "$SLICE" in
      server) require_files "apps/server-pilot/package.json" ;;
      mail) require_files "apps/mail/package.json" ;;
      *) die "unknown slice '${SLICE}' for mode '${MODE}'" 65 ;;
    esac
    ;;
esac

run_clean_command() {
  node "$GATE_LIB" run-child --kind=fixture --cwd="$PWD" -- "$@"
}

run_clean_db_command() {
  node "$GATE_LIB" run-child --kind=db --cwd="$PWD" -- "$@"
}

verify_vitest_report() {
  local report_path=$1
  run_gate_helper validate-vitest-report "$report_path"
}

run_vitest_in_dir() {
  local cwd=$1
  shift
  local report_path
  report_path=$(mktemp "${TMPDIR:-/tmp}/reservation-pilot-vitest.XXXXXX.json")
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
  (cd "$cwd" && run_clean_command "${command[@]}")
  [[ -s "$report_path" ]] || die 'Vitest produced no result report; required slice cannot skip green' 1
  verify_vitest_report "$report_path" || die 'required Vitest slice failed or skipped' 1
  rm -f "$report_path"
  trap - RETURN
}

run_vitest() {
  run_vitest_in_dir "$SERVER_PILOT" "$@"
}

validate_disposable_url() {
  [[ -n "${NAVA_TEST_DATABASE_URL:-}" ]] || die 'db mode requires NAVA_TEST_DATABASE_URL for an owned disposable database' 66
  [[ "${CONFIRM_DISPOSABLE_TEST_DB:-}" == '1' ]] || \
    die 'db mode requires CONFIRM_DISPOSABLE_TEST_DB=1; ambient DB values are never accepted' 66

  if ! env -i PATH="$PATH" NAVA_TEST_DATABASE_URL="$NAVA_TEST_DATABASE_URL" NAVA_EXPECTED_DB_PORT="$DB_PORT" node --input-type=module >/dev/null 2>/dev/null <<'NODE'
const raw = process.env.NAVA_TEST_DATABASE_URL?.trim() ?? '';
const expectedPort = process.env.NAVA_EXPECTED_DB_PORT;
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
if (host !== '127.0.0.1' || parsed.port !== expectedPort) {
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
  local connection_file="$DB_CONNECTION"
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
  local receipt="$DB_RECEIPT"
  [[ -f "$receipt" ]] || die 'disposable ownership receipt is missing; DB mode refuses before connection' 66

  local container_name container_id image_ref host_binding database_name role_name run_label receipt_major
  container_name=$(sed -n 's/^Container name: //p' "$receipt" | head -n 1)
  container_id=$(sed -n 's/^Container ID: //p' "$receipt" | head -n 1)
  image_ref=$(sed -n -e 's/^Image: //p' -e 's/^Resolved image: //p' "$receipt" | head -n 1)
  host_binding=$(sed -n 's/^Host binding: //p' "$receipt" | head -n 1)
  database_name=$(sed -n 's/^Database: //p' "$receipt" | head -n 1)
  role_name=$(sed -n 's/^Role: //p' "$receipt" | head -n 1)
  run_label=$(sed -n 's/^Run label: //p' "$receipt" | head -n 1)
  receipt_major=$(sed -n 's/^PostgreSQL major observed: //p' "$receipt" | head -n 1)

  [[ "$container_name" =~ ^[A-Za-z0-9_.-]+$ ]] || die 'disposable receipt has an invalid container name' 66
  [[ "$container_id" =~ ^[a-f0-9]{64}$ ]] || die 'disposable receipt has an invalid container ID' 66
  [[ "$image_ref" =~ ^postgres@sha256:[a-f0-9]{64}$ ]] || die 'disposable receipt has no pinned Postgres image digest' 66
  [[ "$host_binding" == "127.0.0.1:${DB_PORT} -> container 5432/tcp" ]] || \
    die 'disposable DB host mapping is not the owned loopback mapping' 66
  [[ "$database_name" =~ ^[A-Za-z0-9_.-]+$ && "$role_name" =~ ^[A-Za-z0-9_.-]+$ ]] || \
    die 'disposable receipt has invalid database identity' 66
  [[ "$run_label" == "$DB_RUN_LABEL" ]] || die 'disposable receipt run label mismatch' 66
  [[ -z "$receipt_major" || "$receipt_major" == "$DB_MAJOR" ]] || \
    die 'disposable receipt PostgreSQL major does not match the selected profile' 66

  command -v docker >/dev/null 2>&1 || die 'Docker is required to verify the owned disposable target' 66
  local actual_id state actual_image expected_image_id bindings_json
  actual_id=$(docker inspect --format '{{.Id}}' "$container_name" 2>/dev/null || true)
  state=$(docker inspect --format '{{.State.Status}}' "$container_name" 2>/dev/null || true)
  [[ "$actual_id" == "$container_id" && "$state" == 'running' ]] || \
    die 'disposable container identity or running state does not match the ownership receipt' 66

  expected_image_id=$(docker image inspect "$image_ref" --format '{{.Id}}' 2>/dev/null || true)
  actual_image=$(docker inspect --format '{{.Image}}' "$container_name" 2>/dev/null || true)
  [[ -n "$expected_image_id" && "$actual_image" == "$expected_image_id" ]] || \
    die 'disposable container image digest does not match the ownership receipt' 66

  bindings_json=$(docker inspect --format '{{json .HostConfig.PortBindings}}' "$container_name" 2>/dev/null || true)
  if ! printf '%s' "$bindings_json" | run_gate_helper validate-port-bindings /dev/stdin "$DB_PORT" >/dev/null 2>&1; then
    die 'disposable container has a wildcard, extra, or unexpected host mapping' 66
  fi

  local owner_label run_label_actual lifecycle_label
  owner_label=$(docker inspect --format '{{index .Config.Labels "zero.owner"}}' "$container_name" 2>/dev/null || true)
  run_label_actual=$(docker inspect --format '{{index .Config.Labels "zero.run"}}' "$container_name" 2>/dev/null || true)
  lifecycle_label=$(docker inspect --format '{{index .Config.Labels "zero.lifecycle"}}' "$container_name" 2>/dev/null || true)
  [[ "$owner_label" == 'centurion-dashboard-tools' && "$run_label_actual" == "$run_label" && "$lifecycle_label" == 'disposable' ]] || \
    die 'disposable container ownership/lifecycle labels do not match the receipt' 66
  if [[ "$DB_PROFILE" == 'pg16' ]]; then
    local purpose_label major_label
    purpose_label=$(docker inspect --format '{{index .Config.Labels "zero.purpose"}}' "$container_name" 2>/dev/null || true)
    major_label=$(docker inspect --format '{{index .Config.Labels "zero.postgres-major"}}' "$container_name" 2>/dev/null || true)
    [[ "$purpose_label" == 'migration-parity' && "$major_label" == "$DB_MAJOR" ]] || \
      die 'disposable PG16 purpose/major labels do not match the ownership receipt' 66
  fi

  local url=$NAVA_TEST_DATABASE_URL
  if ! (
    cd "$SERVER_PILOT"
    env -i PATH="$PATH" HOME="${HOME:-/tmp}" \
      NAVA_TEST_DATABASE_URL="$url" \
      NAVA_EXPECTED_DATABASE="$database_name" \
      NAVA_EXPECTED_ROLE="$role_name" \
      NAVA_EXPECTED_RUN="$run_label" \
      NAVA_EXPECTED_MAJOR="$DB_MAJOR" \
      NAVA_EXPECTED_PORT='5432' \
      NAVA_EXPECTED_SENTINEL_TABLE="$DB_SENTINEL_TABLE" \
      NAVA_EXPECTED_SENTINEL_MARKER="$DB_SENTINEL_MARKER" \
      node --input-type=module >/dev/null 2>/dev/null <<'NODE'
import postgres from 'postgres';

const url = process.env.NAVA_TEST_DATABASE_URL;
const expectedDatabase = process.env.NAVA_EXPECTED_DATABASE;
const expectedRole = process.env.NAVA_EXPECTED_ROLE;
const expectedRun = process.env.NAVA_EXPECTED_RUN;
const expectedMajor = process.env.NAVA_EXPECTED_MAJOR;
const expectedPort = process.env.NAVA_EXPECTED_PORT;
const expectedSentinelTable = process.env.NAVA_EXPECTED_SENTINEL_TABLE;
const expectedSentinelMarker = process.env.NAVA_EXPECTED_SENTINEL_MARKER;
if (!url || !expectedDatabase || !expectedRole || !expectedRun || !expectedMajor || !expectedPort || !expectedSentinelMarker || !/^[A-Za-z0-9_]+$/.test(expectedSentinelTable ?? '')) process.exit(1);

const connection = postgres(url, { max: 1, connect_timeout: 5, idle_timeout: 5 });
try {
  const [identity] = await connection`
    select
      current_database() as database_name,
      current_user as role_name,
      pg_get_userbyid(datdba) as owner_name,
      current_setting('server_version') as server_version,
      current_setting('port') as server_port
    from pg_database
    where datname = current_database()
  `;
  if (
    !identity ||
    identity.database_name !== expectedDatabase ||
    identity.role_name !== expectedRole ||
    identity.owner_name !== expectedRole ||
    String(identity.server_version).match(/^\d+/)?.[0] !== expectedMajor ||
    String(identity.server_port) !== expectedPort
  ) process.exit(1);

  const sentinelRows = await connection.unsafe(`select * from "${expectedSentinelTable}"`);
  if (sentinelRows.length !== 1) process.exit(1);
  const markerEntry = Object.entries(sentinelRows[0]).find(([key]) => /marker|run/i.test(key));
  if (!markerEntry || String(markerEntry[1]) !== expectedSentinelMarker || expectedSentinelMarker !== expectedRun) process.exit(1);
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
    env -i PATH="$PATH" HOME="${HOME:-/tmp}" NAVA_TEST_DATABASE_URL="$url" node --input-type=module >/dev/null 2>/dev/null <<'NODE'
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
    --no-file-parallelism
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

run_db_planned_slice() {
  local slice=$1
  local planned_files
  planned_files=$(run_gate_helper server-test-files db "$slice") || \
    die "named DB slice '${slice}' has no executable server test plan" 69
  [[ -n "$planned_files" ]] || die "named DB slice '${slice}' selected no tests" 69

  local -a test_files=()
  while IFS= read -r test_file; do
    [[ -n "$test_file" ]] && test_files+=("$test_file")
  done <<<"$planned_files"
  ((${#test_files[@]} > 0)) || die "named DB slice '${slice}' selected no tests" 69
  run_db_slice "${test_files[@]}"
}

run_browser_slice() {
  local config="${REPO_ROOT}/apps/mail/vite.pilot-fixture.config.ts"
  local slice=${1:-}
  local grep_pattern
  case "$slice" in
    dashboard) grep_pattern='reservation-tools-pilot/dashboard' ;;
    documents) grep_pattern='reservation-tools-pilot/documents' ;;
    pilot) grep_pattern='reservation-tools-pilot/pilot' ;;
    *) die "unknown browser slice '${slice}'" 65 ;;
  esac
  run_gate_helper validate-browser-config "$config" "$FIXTURE_MANIFEST" || \
    die 'browser fixture config does not enforce literal fake loopback mode' 69
  run_gate_helper check-browser-boundary || \
    die 'actual browser egress isolation is unavailable; browser slice refuses' 69
  local origin
  origin=$(run_gate_helper manifest-origin "$FIXTURE_MANIFEST") || \
    die 'browser fixture manifest origin is invalid' 69

  local report_path
  report_path=$(mktemp "${TMPDIR:-/tmp}/reservation-pilot-browser.XXXXXX.json")
  local error_path
  error_path=$(mktemp "${TMPDIR:-/tmp}/reservation-pilot-browser-error.XXXXXX.log")
  trap 'rm -f "$report_path" "$error_path"' RETURN
  local -a command=(
    pnpm
    --dir
    "${REPO_ROOT}/apps/mail"
    exec
    playwright
    test
    "tests/e2e/reservation-tools-pilot.spec.ts"
    # Playwright applies --grep to the file-qualified full title.  Anchor the
    # reviewed slice at the suffix so the mapping remains exact without
    # selecting zero tests because of the generated file prefix.
    --grep=".*${grep_pattern}$"
    --config=vite.pilot-fixture.config.ts
    --reporter=json
    --forbid-only
    --workers=1
  )

  local -a isolated_command=(
    /usr/bin/unshare
    --user
    --map-root-user
    --net
    --fork
    /bin/sh
    -ceu
    "$BROWSER_NAMESPACE_SCRIPT"
    reservation-browser-network
    "${command[@]}"
  )

  (
    cd "$REPO_ROOT"
    NAVA_FIXTURE_ORIGIN="$origin" run_clean_command "${isolated_command[@]}" >"$report_path" 2>"$error_path"
  ) || die 'browser fixture runner failed; no external or live service is permitted' 1
  [[ -s "$report_path" ]] || die 'browser runner produced no result report; required slice cannot skip green' 1
  run_gate_helper validate-browser-report "$report_path" "$grep_pattern" || \
    die 'required browser slice selected zero tests, skipped, or failed' 1
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
  unit:gate)
    run_gate_helper validate-manifest "$FIXTURE_MANIFEST" || die 'synthetic fixture manifest validation failed' 69
    run_vitest \
      "tests/reservation-pilot-gate.test.ts" \
      "tests/reservation-pilot-gate-dispatch.test.ts"
    ;;
  unit:dashboard)
    run_vitest \
      "tests/admin-dashboard-access.test.ts" \
      "tests/admin-dashboard-metrics.test.ts" \
      "tests/admin-dashboard-query.test.ts" \
      "tests/admin-dashboard-export.test.ts"
    run_vitest_in_dir "${REPO_ROOT}/apps/mail" \
      "tests/admin-dashboard/response-metrics-availability.test.ts" \
      "tests/admin-dashboard/business-overview.test.tsx" \
      "tests/admin-dashboard/export.test.ts"
    ;;
  unit:measurement)
    run_vitest \
      "tests/mail-measurement-config.test.ts" \
      "tests/mail-data-health.test.ts"
    ;;
  unit:reads)
    run_vitest \
      "tests/hms-read-service.test.ts" \
      "tests/hms-normal-runtime-read-service.test.ts" \
      "tests/hms-reservation-context.test.ts" \
      "tests/hms-property-read-lock.test.ts" \
      "tests/hms-independent-read-review.test.ts"
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
      "tests/hms-candidate-agent.test.ts" \
      "tests/hms-claim-envelope.test.ts" \
      "tests/hms-live-guest-stay.test.ts" \
      "tests/local-model-adapter-contract.test.ts" \
      "tests/shadow-model-routing.test.ts"
    ;;
  unit:baseline)
    run_vitest \
      "tests/mail-baseline.test.ts" \
      "tests/mail-baseline-projection.test.ts" \
      "tests/mail-baseline-extraction.test.ts" \
      "tests/mail-baseline-ingest.test.ts" \
      "tests/mail-baseline-coverage.test.ts"
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
      "tests/hms-normal-runtime-read-service.test.ts" \
      "tests/hms-independent-read-db-review.test.ts"
    ;;
  db:quotes)
    run_db_slice "tests/hms-quote-db.test.ts"
    ;;
  db:documents)
    run_db_slice \
      "tests/existing-document-validation.test.ts" \
      "tests/existing-document-db.test.ts"
    ;;
  db:finance)
    run_db_slice "tests/hms-finance-db.test.ts"
    ;;
  db:baseline)
    run_db_slice \
      "tests/mail-baseline-projection.test.ts" \
      "tests/mail-baseline-worker.test.ts" \
      "tests/outbound-queue.test.ts"
    ;;
  db:shadow)
    run_db_slice "tests/shadow-evaluation.test.ts"
    ;;
  db:outbox)
    run_db_slice \
      "tests/outbound-queue.test.ts" \
      "tests/draft-stale-conflict.test.ts" \
      "tests/hms-candidate-state.test.ts"
    ;;
  db:candidate-drafting)
    run_db_planned_slice candidate-drafting
    ;;
  browser:dashboard|browser:documents|browser:pilot)
    run_browser_slice "$SLICE"
    ;;
  build:server)
    run_build_slice '@zero/server'
    ;;
  build:mail)
    run_build_slice '@zero/mail'
    ;;
esac

echo "reservation-pilot-gate: PASS mode=${MODE} slice=${SLICE}"
