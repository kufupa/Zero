#!/usr/bin/env bash
# EC2 AI gate: targeted AI/mail contract tests + build with NODE_ENV=test.
# ASCII-safe output for SSM.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_PILOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${SERVER_PILOT}/../.." && pwd)"
ENV_FILE="${ENV_FILE:-${SERVER_PILOT}/.env.production}"

echo "== ai-gate: repo ${REPO_ROOT} =="
cd "$REPO_ROOT"

if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

export NODE_ENV=test
export PATH="${HOME}/.local/share/pnpm:${HOME}/.nvm/versions/node/$(ls "${HOME}/.nvm/versions/node" 2>/dev/null | sort -V | tail -1)/bin:${PATH}"

cd "$SERVER_PILOT"

echo "== ai-gate: targeted tests =="
pnpm test \
  tests/env.test.ts \
  tests/package-contract.test.ts \
  tests/schema-contract.test.ts \
  tests/ai-workflow-run-contract.test.ts \
  tests/ai-enqueue-contract.test.ts \
  tests/ai-triage-contract.test.ts \
  tests/ai-feedback-contract.test.ts \
  tests/ai-security-contract.test.ts \
  tests/bedrock-adapter-contract.test.ts \
  tests/ai-worker-contract.test.ts \
  tests/deploy-config.test.ts \
  tests/ai-eval-runner.test.ts \
  --reporter=dot

echo "== ai-gate: spike eval =="
# Spike eval stays on fake adapter — see bedrock-live-gate.sh for live Bedrock.
pnpm ai:test -- --mode=spike

echo "== ai-gate: build =="
pnpm build

echo "ai-gate: PASS"
