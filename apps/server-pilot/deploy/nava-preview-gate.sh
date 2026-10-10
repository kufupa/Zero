#!/usr/bin/env bash
# Real-browser gate for /nava-preview on the production EC2 host. No manual login.
#
# The pilot operator account signs in through the same better-auth endpoint the other
# EC2 Playwright gates use. Its session cookies become a Playwright storage state in a
# private temp dir, removed on exit. curl and Chromium pin the canonical host to the
# local nginx (curl --resolve semantics), so the gate never depends on public DNS.
# The runner reads the latest threads of the transport and writes the run to
# /opt/nava/shared/nava-preview/<run>/ (mode 700). The gallery is then copied to the
# mail bucket under nava-preview-gate/<run>/, which the instance role can write.
#
# Usage:
#   nava-preview-gate.sh                                    run on the EC2 host
#   nava-preview-gate.sh --dry-run                          plan and config check only
#   nava-preview-gate.sh --summarize <results.json | run>   summary of an existing run
#   nava-preview-gate.sh --ae4 <thread-id> [--dry-run]      AE4 discount-override proof on one thread
#   nava-preview-gate.sh --ae1-rates <thread-id> [--dry-run] AE1 multi-stay rates proof on one thread
#   nava-preview-gate.sh --ae2-find <thread-id> [--dry-run]  AE2 amendment find proof on one thread
#
# --ae4 drives scripts/nava-ae4-override-proof.ts with the same sign-in: it sets the type to Quote, types one 2027 stay,
# saves an NCOR1B override, prepares the PDF and the Excel and screenshots the row's review. Unlike the viewer gate it
# writes: the work item and its field and rate events, one rates run (the one HMS call, a read) and the documents. No
# HMS or mailbox write can pass its guard. Its last stdout line is the AE4 summary as one JSON line. Use an internal,
# non-guest thread whose stored read is a quote request; NAVA_AE4_ALLOW_NO_EVENT=1 runs on any thread without the event.
#
# --ae1-rates drives scripts/nava-ae1-rates-proof.ts: on a multi-stay quote it fills missing room counts with the split
# NAVA_AE1_ROOMS (default 15/15 per stay) and picks a listed room type for "Email asked for X", runs each stay's rates
# search once, prepares the combined quote PDF and downloads the Excel. HMS: one rates read per stay, at most one party
# search, no write. Writes: field.edit work events, per stay one ai_draft_generation and ai_workflow_run, the documents.
#
# --ae2-find drives scripts/nava-ae2-find-proof.ts: on an amendment thread it clicks "Find this booking in HMS" once and
# reports which of the email's dates the find sent and what HMS holds. HMS: one read-only find, no write. Writes: the
# queued find job (one ai_workflow_run). Both print their summary as the last stdout line, one JSON line.
#
# Secrets: the pilot password comes from Secrets Manager (or PLAYWRIGHT_REAL_MAIL_PASSWORD)
# and goes to node on stdin only. No secret is printed, echoed, or put on a command line.
set -euo pipefail
umask 077

unset DATABASE_URL VITEST_ALLOW_PILOT_RDS TEST_DATABASE_URL NODE_OPTIONS DOTENV_CONFIG_PATH

CANONICAL_HOST="nava.legacyhotels.co.za"
CANONICAL_ORIGIN="https://${CANONICAL_HOST}"
RESOLVE_TO="127.0.0.1"
TRANSPORT_ID="transport-centurion"
LATEST_COUNT=20
# NAVA_PREVIEW_THREADS=id1,id2 runs those threads instead of the latest ones (a targeted live proof).
SELECTION=(--latest "$LATEST_COUNT")
if [ -n "${NAVA_PREVIEW_THREADS:-}" ]; then SELECTION=(--threads "$NAVA_PREVIEW_THREADS"); fi
RUNNER_TIMEOUT_MS=90000
# The AE4 rates run reads HMS (about 2 minutes); the runner waits up to its maximum for it.
AE4_TIMEOUT_MS=600000
# AE1 waits up to this for each stay's rates run; AE2 for the queued find job.
AE1_TIMEOUT_MS=600000
AE2_TIMEOUT_MS=600000
PILOT_EMAIL="navaai@legacyhotels.co.za"
PILOT_SECRET_ID="nava-zero/server-pilot/pilot-users"
# NAVA_PREVIEW_OUT_ROOT is for tests and dry runs only; the EC2 run keeps the default.
OUT_ROOT="${NAVA_PREVIEW_OUT_ROOT:-/opt/nava/shared/nava-preview}"
GATE_PREFIX="nava-preview-gate"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${REPO_ROOT:-$(cd "${SCRIPT_DIR}/../../.." && pwd)}"
ENV_FILE="${ENV_FILE:-${REPO_ROOT}/apps/server-pilot/.env.production}"

MODE="run"
SUMMARIZE_TARGET=""
AE4_THREAD=""
AE4_DRY=0
PROOF_USAGE="--ae4 | --ae1-rates | --ae2-find <thread-id> [--dry-run]"
case "${1:-}" in
  "") ;;
  --dry-run) MODE="dry-run" ;;
  --summarize)
    MODE="summarize"
    SUMMARIZE_TARGET="${2:-}"
    if [ -z "$SUMMARIZE_TARGET" ]; then
      echo "usage: $0 --summarize <results.json | run-dir>" >&2
      exit 2
    fi
    ;;
  --ae4 | --ae1-rates | --ae2-find)
    # One proof thread for every proof mode. AE4_THREAD and AE4_DRY name it for all three.
    case "$1" in
      --ae4) MODE="ae4" ;;
      --ae1-rates) MODE="ae1" ;;
      --ae2-find) MODE="ae2" ;;
    esac
    AE4_THREAD="${2:-}"
    # The same id shape nava-preview-run.ts accepts for --threads.
    if ! [[ "$AE4_THREAD" =~ ^[A-Za-z0-9_.:~@-]{1,128}$ ]]; then
      echo "usage: $0 $1 <thread-id> [--dry-run]" >&2
      exit 2
    fi
    case "${3:-}" in
      "") ;;
      --dry-run) AE4_DRY=1 ;;
      *)
        echo "usage: $0 $1 <thread-id> [--dry-run]" >&2
        exit 2
        ;;
    esac
    ;;
  *)
    echo "usage: $0 [--dry-run | --summarize <results.json | run-dir> | ${PROOF_USAGE}]" >&2
    exit 2
    ;;
esac

fail() {
  echo "nava-preview-gate: $*" >&2
  exit 2
}

# Prints the value of a plain KEY=value line. Used only for non-secret settings.
read_env_value() {
  local key="$1" file="$2" line
  [ -f "$file" ] || return 0
  line="$(grep -m1 "^${key}=" "$file" || true)"
  line="${line#"${key}"=}"
  line="${line%\"}"
  line="${line#\"}"
  line="${line%\'}"
  line="${line#\'}"
  printf '%s' "$line"
}

# Counts and ids only. Subjects, banners and field values are never printed here.
summarize_run() {
  node -e '
const fs = require("node:fs");
const path = require("node:path");
const target = process.argv[1];
let data;
try {
  const file = fs.statSync(target).isDirectory() ? path.join(target, "results.json") : target;
  data = JSON.parse(fs.readFileSync(file, "utf8"));
} catch {
  console.error("results.json is missing or unreadable");
  process.exit(2);
}
const results = Array.isArray(data.results) ? data.results : [];
const tally = (key) =>
  results.reduce((acc, r) => {
    const k = key(r);
    if (k) acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});
const fmt = (obj) => Object.entries(obj).map(([k, v]) => `${k}=${v}`).join(" ") || "none";
const prefilled = results.filter((r) => (r.prefilled || []).length > 0);
const fieldCount = prefilled.reduce((n, r) => n + r.prefilled.length, 0);
const banners = results.filter((r) => (r.banners || []).length > 0);
const problems = results.filter((r) => r.outcome === "error" || r.outcome === "timeout");
const blocked =
  results.reduce((n, r) => n + (r.blockedWrites || []).length, 0) +
  (data.blockedOutsideThreads || []).length;
const transport = (data.meta && data.meta.transportId) || "unknown";
console.log(`threads: ${results.length} (transport ${transport})`);
console.log(`outcomes: ${fmt(tally((r) => r.outcome))}`);
console.log(`intents: ${fmt(tally((r) => r.intent))}`);
console.log(`threads with prefill: ${prefilled.length} (${fieldCount} fields)`);
console.log(`threads with banners: ${banners.length}`);
const ids = problems.map((r) => r.threadId).join(", ");
console.log(`errors or timeouts: ${problems.length}${ids ? ` -> ${ids}` : ""}`);
console.log(`blocked writes: ${blocked}`);
process.exit(problems.length > 0 || blocked > 0 ? 1 : 0);
' "$1"
}

if [ "$MODE" = "summarize" ]; then
  summarize_run "$SUMMARIZE_TARGET"
  exit 0
fi

RUN_PREFIX="gate"
case "$MODE" in
  ae4) RUN_PREFIX="ae4" ;;
  ae1) RUN_PREFIX="ae1-rates" ;;
  ae2) RUN_PREFIX="ae2-find" ;;
esac

S3_BUCKET_NAME="${S3_BUCKET:-$(read_env_value S3_BUCKET "$ENV_FILE")}"
AWS_REGION_NAME="${AWS_REGION:-$(read_env_value AWS_REGION "$ENV_FILE")}"
AWS_REGION_NAME="${AWS_REGION_NAME:-af-south-1}"
BETTER_AUTH_VALUE="${BETTER_AUTH_URL:-$(read_env_value BETTER_AUTH_URL "$ENV_FILE")}"
if [ -n "$BETTER_AUTH_VALUE" ] && [ "$BETTER_AUTH_VALUE" != "$CANONICAL_ORIGIN" ] &&
  [ "$BETTER_AUTH_VALUE" != "${CANONICAL_ORIGIN}/" ]; then
  fail "refusing: BETTER_AUTH_URL must be ${CANONICAL_ORIGIN}"
fi

if [ "$MODE" = "dry-run" ] || [ "$AE4_DRY" = "1" ]; then
  echo "nava-preview gate: dry run. No network, AWS or browser calls are made."
  for tool in node pnpm curl aws; do
    if command -v "$tool" >/dev/null 2>&1; then
      echo "tool ok:     ${tool}"
    else
      echo "tool MISSING: ${tool}"
    fi
  done
  echo "origin:      ${CANONICAL_ORIGIN} (curl and Chromium pin ${CANONICAL_HOST} to ${RESOLVE_TO})"
  echo "transport:   ${TRANSPORT_ID} (sent as x-zero-active-transport)"
  if [ "$MODE" = "ae4" ]; then
    echo "proof:       AE4 discount override on thread ${AE4_THREAD}, ${AE4_TIMEOUT_MS} ms for the rates run"
    echo "hms:         one rates read (workstation.executeStaffQuote); every HMS write is blocked"
  elif [ "$MODE" = "ae1" ]; then
    echo "proof:       AE1 multi-stay rates on thread ${AE4_THREAD}, ${AE1_TIMEOUT_MS} ms per stay's rates run"
    echo "rooms:       ${NAVA_AE1_ROOMS:-15/15} per stay where the pane has no count (NAVA_AE1_ROOMS)"
    echo "hms:         one rates read per stay (workstation.executeStaffQuote), at most one party search; every HMS write is blocked"
  elif [ "$MODE" = "ae2" ]; then
    echo "proof:       AE2 amendment find on thread ${AE4_THREAD}, ${AE2_TIMEOUT_MS} ms for the find job"
    echo "hms:         one read-only find (paneStayLookup.queueFind); every HMS and mailbox write is blocked"
  else
    echo "selection:   ${SELECTION[*]}, ${RUNNER_TIMEOUT_MS} ms per thread"
  fi
  echo "sign-in:     POST ${CANONICAL_ORIGIN}/api/auth/sign-in/email as the pilot operator account"
  echo "password:    Secrets Manager ${PILOT_SECRET_ID} (region ${AWS_REGION_NAME}), never printed"
  echo "output:      ${OUT_ROOT}/${RUN_PREFIX}-<UTC run id>/ (mode 700)"
  if [ -n "$S3_BUCKET_NAME" ]; then
    echo "gallery:     s3://${S3_BUCKET_NAME}/${GATE_PREFIX}/<run id>/"
  else
    echo "gallery:     local only (S3_BUCKET not set)"
  fi
  if [ -f "$ENV_FILE" ]; then
    echo "env file:    present"
  else
    echo "env file:    missing (BETTER_AUTH_URL and S3_BUCKET must come from the environment)"
  fi
  exit 0
fi

require_tool() {
  command -v "$1" >/dev/null 2>&1 || fail "missing tool: $1"
}
require_tool node
require_tool pnpm
require_tool curl
require_tool aws
[ -n "$BETTER_AUTH_VALUE" ] || fail "BETTER_AUTH_URL missing from ${ENV_FILE}"

RUN_ID="${RUN_PREFIX}-$(date -u +%Y%m%dT%H%M%SZ)"
OUT_DIR="${OUT_ROOT}/${RUN_ID}"
AUTH_DIR=""
cleanup() {
  local status=$?
  if [ -n "$AUTH_DIR" ] && [ -d "$AUTH_DIR" ]; then
    rm -rf "$AUTH_DIR"
  fi
  unset PLAYWRIGHT_REAL_MAIL_PASSWORD
  exit "$status"
}
trap cleanup EXIT
# A signal from SSM or the operator must still remove the auth dir: exit runs the EXIT trap.
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

CURL_PIN=(--disable --noproxy '*' --resolve "${CANONICAL_HOST}:443:${RESOLVE_TO}")

curl "${CURL_PIN[@]}" -fsS "${CANONICAL_ORIGIN}/health" >/dev/null ||
  fail "backend health check failed via nginx at ${RESOLVE_TO}"
echo "health ok via nginx"

# /opt/nava/shared is root-owned. Create this private root once with sudo, as the
# existing deploy scripts do for their private subdirectories, then work as the operator.
if [ ! -d "$OUT_ROOT" ]; then
  sudo install -d -o "$(id -un)" -g "$(id -gn)" -m 0700 "$OUT_ROOT" ||
    fail "cannot create ${OUT_ROOT} (sudo is needed once)"
fi
[ -w "$OUT_ROOT" ] || fail "${OUT_ROOT} is not writable by $(id -un)"
chmod 700 "$OUT_ROOT"
install -d -m 700 "$OUT_DIR"
AUTH_DIR="$(mktemp -d "${OUT_ROOT}/.auth.XXXXXX")"

if [ -z "${PLAYWRIGHT_REAL_MAIL_PASSWORD:-}" ]; then
  SECRET_JSON="$(
    aws secretsmanager get-secret-value \
      --region "$AWS_REGION_NAME" \
      --secret-id "$PILOT_SECRET_ID" \
      --query SecretString \
      --output text
  )"
  PLAYWRIGHT_REAL_MAIL_PASSWORD="$(
    printf '%s' "$SECRET_JSON" |
      node "${SCRIPT_DIR}/nava-preview-auth.mjs" password "$PILOT_EMAIL"
  )" || fail "could not read the pilot account from ${PILOT_SECRET_ID}"
  unset SECRET_JSON
fi

printf '%s' "$PLAYWRIGHT_REAL_MAIL_PASSWORD" |
  node "${SCRIPT_DIR}/nava-preview-auth.mjs" signin-body "$PILOT_EMAIL" "$AUTH_DIR/signin.json"

SIGNIN_STATUS="$(
  curl "${CURL_PIN[@]}" -sS \
    -o "$AUTH_DIR/signin.body" \
    -D "$AUTH_DIR/signin.headers" \
    -w '%{http_code}' \
    -X POST "${CANONICAL_ORIGIN}/api/auth/sign-in/email" \
    -H 'Content-Type: application/json' \
    --data-binary "@${AUTH_DIR}/signin.json"
)" || fail "sign-in request failed"
[ "$SIGNIN_STATUS" = "200" ] || fail "sign-in refused with HTTP ${SIGNIN_STATUS}"
unset PLAYWRIGHT_REAL_MAIL_PASSWORD
rm -f "$AUTH_DIR/signin.json" "$AUTH_DIR/signin.body"

node "${SCRIPT_DIR}/nava-preview-storage-state.mjs" \
  "$AUTH_DIR/signin.headers" "$AUTH_DIR/storage-state.json" "$CANONICAL_HOST" ||
  fail "could not build the storage state from the sign-in response"
rm -f "$AUTH_DIR/signin.headers"

export PATH="${HOME}/.local/share/pnpm:${HOME}/.nvm/versions/node/$(ls "${HOME}/.nvm/versions/node" 2>/dev/null | sort -V | tail -1)/bin:${PATH}"
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/nava/playwright-browsers}"
if [ -f /opt/nava/ec2-playwright-chromium/env.sh ]; then
  # shellcheck disable=SC1091
  source /opt/nava/ec2-playwright-chromium/env.sh
fi

cd "$REPO_ROOT"
echo "pnpm install (playwright pin)"
# Quiet install: SSM keeps only the first ~24 KB of stdout, and the summary must fit.
HUSKY=0 pnpm install --frozen-lockfile --reporter=silent || { echo "gate: pnpm install failed" >&2; exit 2; }

echo "run: ${RUN_ID}"
echo "out: ${OUT_DIR}"
if [ "$MODE" = "ae4" ]; then
  RUNNER=(scripts/nava-ae4-override-proof.ts --threads "$AE4_THREAD" --out "$OUT_DIR" --timeout-ms "$AE4_TIMEOUT_MS")
  RESULT_FILE="summary.json"
  # The AE4 run dir holds only the proof's own files: the summary, two screenshots, the PDF and the Excel.
  UPLOAD=(--exclude '*' --include 'summary.json' --include '*.png' --include 'quote.pdf' --include 'quote.xlsx')
elif [ "$MODE" = "ae1" ]; then
  RUNNER=(scripts/nava-ae1-rates-proof.ts --threads "$AE4_THREAD" --out "$OUT_DIR" --timeout-ms "$AE1_TIMEOUT_MS")
  RESULT_FILE="summary.json"
  # The summary, the rates, documents and pane screenshots, the PDF and the Excel.
  UPLOAD=(--exclude '*' --include 'summary.json' --include '*.png' --include 'quote.pdf' --include 'quote.xlsx')
elif [ "$MODE" = "ae2" ]; then
  RUNNER=(scripts/nava-ae2-find-proof.ts --threads "$AE4_THREAD" --out "$OUT_DIR" --timeout-ms "$AE2_TIMEOUT_MS")
  RESULT_FILE="summary.json"
  # The summary and the amendment card and pane screenshots.
  UPLOAD=(--exclude '*' --include 'summary.json' --include '*.png')
else
  RUNNER=(scripts/nava-preview-run.ts "${SELECTION[@]}" --out "$OUT_DIR" --timeout-ms "$RUNNER_TIMEOUT_MS")
  RESULT_FILE="results.json"
  UPLOAD=(--exclude '*' --include 'results.json' --include 'index.html' --include 'threads/*')
fi

set +e
NAVA_PREVIEW_BASE_URL="$CANONICAL_ORIGIN" \
NAVA_PREVIEW_STORAGE_STATE="$AUTH_DIR/storage-state.json" \
NAVA_PREVIEW_RESOLVE_TO="$RESOLVE_TO" \
NAVA_PREVIEW_TRANSPORT_ID="$TRANSPORT_ID" \
pnpm --dir apps/server-pilot exec tsx "${RUNNER[@]}"
RUN_EXIT=$?
set -e

# A proof runner prints its own one-line summary.
if [ "$MODE" = "run" ]; then
  set +e
  summarize_run "$OUT_DIR"
  set -e
fi

if [ -n "$S3_BUCKET_NAME" ] && [ -f "$OUT_DIR/$RESULT_FILE" ]; then
  DEST="s3://${S3_BUCKET_NAME}/${GATE_PREFIX}/${RUN_ID}/"
  if aws s3 sync "$OUT_DIR" "$DEST" \
    --region "$AWS_REGION_NAME" \
    "${UPLOAD[@]}" \
    --only-show-errors; then
    echo "gallery: ${DEST}"
    echo "fetch on the VPS: aws s3 sync ${DEST} ${OUT_DIR}-gallery/"
  else
    echo "gallery upload failed; the local copy stays in ${OUT_DIR}" >&2
  fi
else
  echo "gallery: local only in ${OUT_DIR}"
fi

if [ "$MODE" = "ae4" ] || [ "$MODE" = "ae1" ] || [ "$MODE" = "ae2" ]; then
  PROOF_NAME="$(printf '%s' "$MODE" | tr '[:lower:]' '[:upper:]')"
  echo "runner exit: ${RUN_EXIT} (0 ${PROOF_NAME} pass, 1 ${PROOF_NAME} failed, 2 blocked, config or launch)"
else
  echo "runner exit: ${RUN_EXIT} (0 pass, 1 gate failure, 2 config or launch)"
fi
exit "$RUN_EXIT"
