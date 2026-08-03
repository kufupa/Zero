#!/usr/bin/env bash
# EC2 AI gate: DB-free AI/mail contract tests + build with NODE_ENV=test.
# Never sources .env.production — keeps pilot RDS out of Vitest.
# ASCII-safe output for SSM.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_PILOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${SERVER_PILOT}/../.." && pwd)"

echo "== ai-gate: repo ${REPO_ROOT} =="
cd "$REPO_ROOT"

export NODE_ENV=test
export PATH="${HOME}/.local/share/pnpm:${HOME}/.nvm/versions/node/$(ls "${HOME}/.nvm/versions/node" 2>/dev/null | sort -V | tail -1)/bin:${PATH}"

# Refuse pilot-RDS Vitest escape hatch and any inherited production DATABASE_URL.
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS

cd "$SERVER_PILOT"

echo "== ai-gate: DB-free targeted tests =="
pnpm exec vitest run \
  tests/env.test.ts \
  tests/package-contract.test.ts \
  tests/schema-contract.test.ts \
  tests/ai-feedback-contract.test.ts \
  tests/ai-security-contract.test.ts \
  tests/bedrock-adapter-contract.test.ts \
  tests/deploy-config.test.ts \
  tests/ai-eval-runner.test.ts \
  tests/centurion-live-corpus-contract.test.ts \
  --reporter=dot

# Optional disposable non-pilot DB for durable AI contracts. Never pilot RDS.
# Canonical: TEST_DATABASE_URL + CONFIRM_DISPOSABLE_TEST_DB=1.
# Legacy alias: AI_GATE_TEST_DATABASE_URL → TEST_DATABASE_URL.
if [ -n "${AI_GATE_TEST_DATABASE_URL:-}" ] && [ -z "${TEST_DATABASE_URL:-}" ]; then
  TEST_DATABASE_URL="${AI_GATE_TEST_DATABASE_URL}"
fi
if [ -n "${TEST_DATABASE_URL:-}" ]; then
  if [ "${CONFIRM_DISPOSABLE_TEST_DB:-}" != "1" ]; then
    echo "ai-gate: CONFIRM_DISPOSABLE_TEST_DB=1 required before DB Vitest" >&2
    exit 2
  fi
  case "${TEST_DATABASE_URL}" in
    *nava-zero-mail-pilot*)
      echo "ai-gate: REFUSE TEST_DATABASE_URL pointing at pilot RDS" >&2
      exit 2
      ;;
  esac
  echo "== ai-gate: disposable-DB contracts =="
  DATABASE_URL="$TEST_DATABASE_URL" pnpm exec vitest run \
    tests/ai-workflow-run-contract.test.ts \
    tests/ai-enqueue-contract.test.ts \
    tests/ai-triage-contract.test.ts \
    tests/ai-worker-contract.test.ts \
    --reporter=dot
else
  echo "== ai-gate: skip DB-backed contracts (set TEST_DATABASE_URL + CONFIRM_DISPOSABLE_TEST_DB=1) =="
fi

echo "== ai-gate: spike eval =="
# Spike eval stays on fake adapter — see bedrock-live-gate.sh for live Bedrock.
pnpm ai:test -- --mode=spike

echo "== ai-gate: build =="
pnpm build

echo "ai-gate: PASS"
