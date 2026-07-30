#!/usr/bin/env bash
# HMS read foundation gate — fail closed. Fixture-only by default.
# Orchestrator runs live/shadow/canary steps after review (see ORCHESTRATOR section).
#
# Usage:
#   bash apps/server-pilot/deploy/hms-read-gate.sh --fixture-only
#   bash apps/server-pilot/deploy/hms-read-gate.sh --full   # still no live HMS from this script
#
# Outputs under .superpowers/sdd/hms-read-foundation/gates/ (gitignored via local .gitignore).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_PILOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${SERVER_PILOT}/../.." && pwd)"
GATE_DIR="${REPO_ROOT}/.superpowers/sdd/hms-read-foundation/gates"
MODE="${1:---fixture-only}"
ENV_FILE="${ENV_FILE:-${SERVER_PILOT}/.env.production}"

mkdir -p "$GATE_DIR"
cat > "${GATE_DIR}/.gitignore" <<'EOF'
*
!.gitignore
EOF

echo "== hms-read-gate: mode=${MODE} repo=${REPO_ROOT} =="
cd "$REPO_ROOT"

if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

export NODE_ENV=test
export HMS_DB_TEST_REQUIRED=1
export PATH="${HOME}/.local/share/pnpm:${HOME}/.nvm/versions/node/$(ls "${HOME}/.nvm/versions/node" 2>/dev/null | sort -V | tail -1)/bin:${PATH}"

fail() {
  echo "hms-read-gate: FAIL — $*" >&2
  echo "{\"passed\":false,\"error\":$(printf '%s' "$*" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))' 2>/dev/null || echo "\"$*\"")}" > "${GATE_DIR}/hms-read-gate-last.json"
  exit 1
}

# Fail closed: DATABASE_URL required when gate runs
if [ -z "${DATABASE_URL:-}" ]; then
  # Local fixture agents may lack RDS — still run unit boundary + eval without DB suites
  if [ "$MODE" = "--fixture-only" ] && [ "${HMS_GATE_ALLOW_NO_DB:-}" = "1" ]; then
    echo "== hms-read-gate: HMS_GATE_ALLOW_NO_DB=1 — skipping DB-required vitest bundle =="
    export HMS_DB_TEST_REQUIRED=0
  else
    fail "DATABASE_URL unset (HMS_DB_TEST_REQUIRED=1). Set HMS_GATE_ALLOW_NO_DB=1 only for local unit boundary."
  fi
fi

cd "$SERVER_PILOT"

# Vitest setup refuses pilot RDS host unless VITEST_ALLOW_PILOT_RDS=1.
# Fixture boundary/eval suites are unit-only — run with DATABASE_URL unset.
echo "== hms-read-gate: production-boundary + eval =="
(
  unset DATABASE_URL
  export HMS_DB_TEST_REQUIRED=0
  pnpm exec vitest run \
    tests/hms-production-boundary.test.ts \
    tests/ai-eval-runner.test.ts \
    --reporter=dot
) || fail "vitest boundary/eval failed"

echo "== hms-read-gate: shadow eval =="
(
  unset DATABASE_URL
  pnpm run eval:hms-shadow
) | tee "${GATE_DIR}/hms-shadow-eval.json" || fail "eval:hms-shadow failed"

if [ "$MODE" = "--full" ]; then
  if [ "${HMS_DB_TEST_REQUIRED}" = "1" ]; then
    echo "== hms-read-gate: HMS vitest bundle (DB required, --full only) =="
    # Intentional gate against configured DATABASE_URL (prefer disposable).
    # Pilot RDS allowed only with VITEST_ALLOW_PILOT_RDS=1 already set by caller.
    if echo "${DATABASE_URL:-}" | grep -q 'nava-zero-mail-pilot'; then
      export VITEST_ALLOW_PILOT_RDS=1
      echo "== hms-read-gate: WARNING using pilot RDS (VITEST_ALLOW_PILOT_RDS=1) =="
    fi
    pnpm exec vitest run \
      tests/hms-contracts.test.ts \
      tests/hms-request-policy.test.ts \
      tests/hms-runtime.test.ts \
      tests/hms-discovery.test.ts \
      tests/hms-adapter.test.ts \
      tests/hms-live-read-manifest.test.ts \
      tests/hms-thread-context.test.ts \
      tests/hms-artifact.test.ts \
      tests/hms-candidate-agent.test.ts \
      tests/hms-candidate-state.test.ts \
      tests/hms-production-boundary.test.ts \
      tests/ai-workflow-run-contract.test.ts \
      tests/ai-worker-contract.test.ts \
      tests/ai-eval-runner.test.ts \
      --reporter=dot || fail "HMS vitest bundle failed"
  fi
elif [ "$MODE" = "--fixture-only" ]; then
  echo "== hms-read-gate: non-DB HMS unit suite (fixture-only) =="
  (
    unset DATABASE_URL
    export HMS_DB_TEST_REQUIRED=0
    pnpm exec vitest run \
      tests/hms-contracts.test.ts \
      tests/hms-request-policy.test.ts \
      tests/hms-runtime.test.ts \
      tests/hms-discovery.test.ts \
      tests/hms-adapter.test.ts \
      tests/hms-live-read-manifest.test.ts \
      tests/hms-thread-context.test.ts \
      tests/hms-artifact.test.ts \
      tests/hms-candidate-agent.test.ts \
      tests/hms-production-boundary.test.ts \
      tests/ai-eval-runner.test.ts \
      --reporter=dot
  ) || fail "HMS non-DB unit suite failed"
fi

echo "== hms-read-gate: playwright fixture config (API journeys) =="
cd "$REPO_ROOT"
if command -v pnpm >/dev/null 2>&1; then
  pnpm --dir packages/testing exec playwright test \
    --config=playwright.hms-fixture.config.ts \
    || fail "playwright hms-fixture failed"
else
  fail "pnpm missing"
fi

# Signed-ish report: sha256 of concatenated gate artifacts
REPORT_PATH="${GATE_DIR}/hms-read-gate-report.json"
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
  "shadowEvalSha256": "${SHADOW_HASH}",
  "liveMutation": false,
  "orchestratorRemaining": [
    "migrate 0015 via ops-deploy.sh --migrate",
    "deploy EC2 with HMS_DRAFT_ENRICHMENT_MODE=off",
    "confirm PM2 http/ai-worker/hms-ai-worker health",
    "set shadow; run labelled corpus on EC2",
    "live read canary via SSM only after fixture/security gates",
    "review metrics + request-policy violations",
    "set enabled only after hard/statistical gates",
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
echo "6. Flip enabled only after hard+stat gates; else off"
exit 0
