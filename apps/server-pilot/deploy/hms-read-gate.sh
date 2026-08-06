#!/usr/bin/env bash
# HMS read foundation gate — fail closed. Fixture-only by default.
# Orchestrator runs live/shadow/canary steps after review (see ORCHESTRATOR section).
#
# Usage:
#   bash apps/server-pilot/deploy/hms-read-gate.sh --fixture-only
#   bash apps/server-pilot/deploy/hms-read-gate.sh --full   # still no live HMS from this script
#   bash apps/server-pilot/deploy/hms-read-gate.sh --fixture-only --tool hms_find_reservation
#   bash apps/server-pilot/deploy/hms-read-gate.sh --fixture-only --wave B1
#
# Never sources .env.production / .env into Vitest.
# Outputs under .superpowers/sdd/hms-read-foundation/gates/ (gitignored via local .gitignore).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_PILOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${SERVER_PILOT}/../.." && pwd)"
GATE_DIR="${REPO_ROOT}/.superpowers/sdd/hms-read-foundation/gates"

MODE="--fixture-only"
SCOPE_TOOL=""
SCOPE_WAVE=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --fixture-only|--full)
      MODE="$1"
      shift
      ;;
    --tool)
      [ "$#" -ge 2 ] || {
        echo "usage: $0 [--fixture-only|--full] [--tool <tool-id>|--wave <subwave-id>]" >&2
        exit 2
      }
      [ -z "$SCOPE_TOOL" ] && [ -z "$SCOPE_WAVE" ] || {
        echo "usage: $0 [--fixture-only|--full] [--tool <tool-id>|--wave <subwave-id>]" >&2
        exit 2
      }
      SCOPE_TOOL="$2"
      shift 2
      ;;
    --wave)
      [ "$#" -ge 2 ] || {
        echo "usage: $0 [--fixture-only|--full] [--tool <tool-id>|--wave <subwave-id>]" >&2
        exit 2
      }
      [ -z "$SCOPE_TOOL" ] && [ -z "$SCOPE_WAVE" ] || {
        echo "usage: $0 [--fixture-only|--full] [--tool <tool-id>|--wave <subwave-id>]" >&2
        exit 2
      }
      SCOPE_WAVE="$2"
      shift 2
      ;;
    *)
      echo "usage: $0 [--fixture-only|--full] [--tool <tool-id>|--wave <subwave-id>]" >&2
      exit 2
      ;;
  esac
done
case "$MODE" in
  --fixture-only|--full) ;;
  *)
    echo "usage: $0 [--fixture-only|--full] [--tool <tool-id>|--wave <subwave-id>]" >&2
    exit 2
    ;;
esac
# Scope is recorded for orchestrator filtering; fixture suites remain portfolio-safe.
if [ -n "$SCOPE_TOOL" ] || [ -n "$SCOPE_WAVE" ]; then
  echo "== hms-read-gate: scope tool=${SCOPE_TOOL:--} wave=${SCOPE_WAVE:--} =="
fi

mkdir -p "$GATE_DIR"
cat > "${GATE_DIR}/.gitignore" <<'EOF'
*
!.gitignore
EOF

echo "== hms-read-gate: mode=${MODE} repo=${REPO_ROOT} =="
cd "$REPO_ROOT"

# Refuse pilot-RDS Vitest escape hatch and any inherited production DATABASE_URL.
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS

export NODE_ENV=test
export PATH="${HOME}/.local/share/pnpm:${HOME}/.nvm/versions/node/$(ls "${HOME}/.nvm/versions/node" 2>/dev/null | sort -V | tail -1)/bin:${PATH}"

fail() {
  echo "hms-read-gate: FAIL — $*" >&2
  echo "{\"passed\":false,\"error\":$(printf '%s' "$*" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))' 2>/dev/null || echo "\"$*\"")}" > "${GATE_DIR}/hms-read-gate-last.json"
  exit 1
}

phase_a_source_digest() {
  node - "$REPO_ROOT" "${SCRIPT_DIR}/mail-artifact-reservation-chain-files.txt" <<'NODE'
const crypto=require("crypto");
const fs=require("fs");
const path=require("path");
const root=path.resolve(process.argv[2]);
const allowlist=process.argv[3];
const phaseB=new Set([
  "apps/server-pilot/src/mail/artifacts/read-artifact.ts",
  "apps/server-pilot/src/ops/mail-artifact-backtest.ts",
  "apps/server-pilot/src/storage/s3.ts",
  "apps/server-pilot/tests/hms-artifact.test.ts",
  "apps/server-pilot/tests/mail-artifact-backtest.test.ts",
  "apps/server-pilot/tests/s3-stream.test.ts",
]);
const files=fs.readFileSync(allowlist,"utf8").split(/\r?\n/).filter(Boolean)
  .filter((file)=>!phaseB.has(file)).sort();
const digest=crypto.createHash("sha256");
for(const relative of files){
  let file=root;
  for(const part of relative.split("/")){
    if(!part||part==="."||part==="..")process.exit(1);
    file=path.join(file,part);
    if(fs.lstatSync(file).isSymbolicLink())process.exit(1);
  }
  file=fs.realpathSync(file);
  if(!file.startsWith(root+path.sep)||!fs.statSync(file).isFile())process.exit(1);
  digest.update(relative);digest.update("\0");
  digest.update(crypto.createHash("sha256").update(fs.readFileSync(file)).digest());
}
process.stdout.write(digest.digest("hex"));
NODE
}

TESTED_BASE_COMMIT="$(git -C "$REPO_ROOT" rev-parse HEAD)" ||
  fail "unable to resolve tested base commit"
require_clean_base_build_inputs() {
  local build_input
  for build_input in \
    apps/server-pilot/package.json \
    apps/server-pilot/tsconfig.json \
    apps/server-pilot/src/mail/artifacts/read-artifact.ts \
    apps/server-pilot/src/storage/s3.ts \
    apps/server-pilot/tests/hms-artifact.test.ts \
    apps/server-pilot/evals/hms \
    package.json \
    packages/tsconfig/base.json \
    packages/tsconfig/package.json \
    pnpm-lock.yaml \
    pnpm-workspace.yaml; do
    git -C "$REPO_ROOT" diff --quiet "$TESTED_BASE_COMMIT" -- "$build_input" ||
      fail "base build input differs from tested commit: $build_input"
  done
}
require_bound_release_inputs() {
  node - "$REPO_ROOT" "${SCRIPT_DIR}/mail-artifact-reservation-chain-files.txt" <<'NODE'
const fs=require("fs");
const {execFileSync}=require("child_process");
const root=process.argv[2];
const allowlist=new Set(fs.readFileSync(process.argv[3],"utf8")
  .split(/\r?\n/).map(line=>line.trim()).filter(Boolean));
const phaseB=new Set([
  "apps/server-pilot/src/mail/artifacts/read-artifact.ts",
  "apps/server-pilot/src/ops/mail-artifact-backtest.ts",
  "apps/server-pilot/src/storage/s3.ts",
  "apps/server-pilot/tests/hms-artifact.test.ts",
  "apps/server-pilot/tests/mail-artifact-backtest.test.ts",
  "apps/server-pilot/tests/s3-stream.test.ts",
]);
const scope=[
  "apps/server-pilot/src",
  "apps/server-pilot/deploy",
  "apps/server-pilot/tests",
  "apps/server-pilot/vitest.config.ts",
  "apps/server-pilot/evals/hms",
  "packages/testing",
];
const readNames=(args)=>execFileSync("git",["-C",root,...args,"--",...scope])
  .toString("utf8").split("\0").filter(Boolean);
const changed=new Set([
  ...readNames(["diff","--name-only","-z","HEAD"]),
  ...readNames(["ls-files","--others","--exclude-standard","-z"]),
]);
for(const file of changed){
  if(allowlist.has(file)||phaseB.has(file)||file.endsWith(".bak"))continue;
  process.stderr.write(`unbound release input drift: ${file}\n`);
  process.exit(1);
}
NODE
}
require_clean_base_build_inputs
require_bound_release_inputs ||
  fail "modified HMS release/test input is outside the Phase A allowlist"
TESTED_SOURCE_SHA256="$(phase_a_source_digest)" ||
  fail "unable to fingerprint Phase A source"

require_disposable_test_db() {
  if [ -z "${TEST_DATABASE_URL:-}" ]; then
    fail "TEST_DATABASE_URL must point to a disposable non-production DB for --full"
  fi
  if [ "${CONFIRM_DISPOSABLE_TEST_DB:-}" != "1" ]; then
    fail "CONFIRM_DISPOSABLE_TEST_DB=1 required before DB Vitest"
  fi
  TEST_DATABASE_URL_VALUE="$TEST_DATABASE_URL" node -e '
const raw=process.env.TEST_DATABASE_URL_VALUE||"";
let url;
try{url=new URL(raw)}catch{process.exit(1)}
const host=url.hostname.toLowerCase();
const database=decodeURIComponent(url.pathname.replace(/^\/+/,"")).toLowerCase();
const combined=`${host}/${database}`;
if(!/^postgres(ql)?:$/.test(url.protocol))process.exit(1);
if(/nava-zero-mail-pilot|(^|[._-])prod(uction)?([._-]|$)/.test(combined))process.exit(1);
const local=host==="localhost"||host==="127.0.0.1"||host==="::1";
const namedDisposable=/(^|[-_])(test|testing|disposable)([-_]|$)/.test(database);
if(!local&&!namedDisposable)process.exit(1);
' || fail "TEST_DATABASE_URL must positively identify a disposable non-production database"
}

cd "$SERVER_PILOT"

# Fixture boundary/eval suites are unit-only — run with DATABASE_URL unset.
echo "== hms-read-gate: production-boundary + eval =="
(
  unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
  export HMS_DB_TEST_REQUIRED=0
  pnpm exec vitest run \
    tests/hms-production-boundary.test.ts \
    tests/ai-eval-runner.test.ts \
    --reporter=dot
) || fail "vitest boundary/eval failed"

echo "== hms-read-gate: shadow eval =="
(
  unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
  pnpm run eval:hms-shadow
) | tee "${GATE_DIR}/hms-shadow-eval.json" || fail "eval:hms-shadow failed"

if [ "$MODE" = "--full" ]; then
  require_disposable_test_db
  echo "== hms-read-gate: HMS vitest bundle (DB required, --full only) =="
  (
    unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
    export HMS_DB_TEST_REQUIRED=1
    DATABASE_URL="$TEST_DATABASE_URL" pnpm exec vitest run \
      tests/hms-contracts.test.ts \
      tests/hms-request-policy.test.ts \
      tests/hms-runtime.test.ts \
      tests/hms-browser-artifacts.test.ts \
      tests/hms-live-guest-stay.test.ts \
      tests/hms-live-proof.test.ts \
      tests/hms-artifact.test.ts \
      tests/hms-discovery.test.ts \
      tests/hms-adapter.test.ts \
      tests/hms-live-read-manifest.test.ts \
      tests/hms-thread-context.test.ts \
      tests/hms-candidate-agent.test.ts \
      tests/hms-candidate-state.test.ts \
      tests/hms-production-boundary.test.ts \
      tests/hms-shadow.test.ts \
      tests/ai-workflow-run-contract.test.ts \
      tests/ai-worker-contract.test.ts \
      tests/deploy-config.test.ts \
      tests/ai-eval-runner.test.ts \
      --maxWorkers=1 \
      --reporter=dot
  ) || fail "HMS vitest bundle failed"
elif [ "$MODE" = "--fixture-only" ]; then
  echo "== hms-read-gate: non-DB HMS unit suite (fixture-only) =="
  (
    unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
    export HMS_DB_TEST_REQUIRED=0
    pnpm exec vitest run \
      tests/hms-contracts.test.ts \
      tests/hms-request-policy.test.ts \
      tests/hms-runtime.test.ts \
      tests/hms-browser-artifacts.test.ts \
      tests/hms-live-guest-stay.test.ts \
      tests/hms-live-proof.test.ts \
      tests/hms-artifact.test.ts \
      tests/hms-discovery.test.ts \
      tests/hms-adapter.test.ts \
      tests/hms-live-read-manifest.test.ts \
      tests/hms-thread-context.test.ts \
      tests/hms-candidate-agent.test.ts \
      tests/hms-candidate-state.test.ts \
      tests/hms-production-boundary.test.ts \
      tests/hms-shadow.test.ts \
      tests/ai-workflow-run-contract.test.ts \
      tests/ai-worker-contract.test.ts \
      tests/deploy-config.test.ts \
      tests/ai-eval-runner.test.ts \
      --maxWorkers=1 \
      --reporter=dot
  ) || fail "HMS non-DB unit suite failed"
fi

echo "== hms-read-gate: playwright fixture config (API journeys) =="
cd "$REPO_ROOT"
if command -v pnpm >/dev/null 2>&1; then
  unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
  pnpm --dir packages/testing exec playwright test \
    --config=playwright.hms-fixture.config.ts \
    || fail "playwright hms-fixture failed"
else
  fail "pnpm missing"
fi

# Signed-ish report: sha256 of concatenated gate artifacts
REPORT_PATH="${GATE_DIR}/hms-read-gate-report.json"
POST_TEST_SOURCE_SHA256="$(phase_a_source_digest)" ||
  fail "unable to re-fingerprint Phase A source"
POST_TEST_BASE_COMMIT="$(git -C "$REPO_ROOT" rev-parse HEAD)" ||
  fail "unable to re-resolve tested base commit"
require_clean_base_build_inputs
require_bound_release_inputs ||
  fail "modified HMS release/test input changed while fixture gate ran"
if [ "$POST_TEST_SOURCE_SHA256" != "$TESTED_SOURCE_SHA256" ]; then
  fail "Phase A source changed while fixture gate ran"
fi
if [ "$POST_TEST_BASE_COMMIT" != "$TESTED_BASE_COMMIT" ]; then
  fail "base commit changed while fixture gate ran"
fi
SHADOW_HASH="none"
if [ -f "${GATE_DIR}/hms-shadow-eval.json" ]; then
  if command -v sha256sum >/dev/null 2>&1; then
    SHADOW_HASH="$(sha256sum "${GATE_DIR}/hms-shadow-eval.json" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    SHADOW_HASH="$(shasum -a 256 "${GATE_DIR}/hms-shadow-eval.json" | awk '{print $1}')"
  fi
fi

cat > "$REPORT_PATH" <<EOF
{
  "passed": true,
  "mode": "${MODE}",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "testedBaseCommit": "${TESTED_BASE_COMMIT}",
  "testedSourceSha256": "${TESTED_SOURCE_SHA256}",
  "shadowEvalSha256": "${SHADOW_HASH}",
  "liveMutation": false,
  "orchestratorRemaining": [
    "migrate 0015 via ops-deploy.sh --migrate",
    "deploy EC2 with HMS_DRAFT_ENRICHMENT_MODE=off",
    "confirm PM2 http/ai-worker/hms-ai-worker health",
    "set shadow; run labelled corpus on EC2",
    "live read canary via SSM only after fixture/security gates",
    "review metrics + request-policy violations",
    "set shadow only after hard/statistical gates (enabled forbidden)",
    "rollback path: set off"
  ]
}
EOF

echo "hms-read-gate: PASS — report ${REPORT_PATH}"
echo ""
echo "=== ORCHESTRATOR-ONLY (not run by this script) ==="
echo "1. pnpm --dir apps/server-pilot run build"
echo "2. bash apps/server-pilot/deploy/ops-deploy.sh --migrate"
echo "3. Keep HMS_DRAFT_ENRICHMENT_MODE=off until shadow green"
echo "4. Shadow labelled corpus >=30 for statistical gates"
echo "5. Live read canary via ssm-run-command.sh (approved reads only)"
echo "6. Shadow only after hard+stat gates; enabled forever forbidden; else off"
exit 0
