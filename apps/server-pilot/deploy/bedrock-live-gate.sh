#!/usr/bin/env bash
# EC2 Bedrock live gate: one Converse call via instance role. NOT in daily ai-gate.
# May source production Bedrock/AWS settings; never runs Vitest; never keeps DATABASE_URL.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_PILOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${SERVER_PILOT}/../.." && pwd)"
ENV_FILE="${ENV_FILE:-${SERVER_PILOT}/.env.production}"

echo "== bedrock-live-gate: repo ${REPO_ROOT} =="
cd "$REPO_ROOT"

if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

# Immediately drop DB credentials / pilot-RDS Vitest escape hatch after sourcing AWS/Bedrock settings.
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS

export PATH="${HOME}/.local/share/pnpm:${HOME}/.nvm/versions/node/$(ls "${HOME}/.nvm/versions/node" 2>/dev/null | sort -V | tail -1)/bin:${PATH}"

export NODE_ENV=production
export AI_ENABLED=true
export BEDROCK_REGION="${BEDROCK_REGION:-us-east-1}"

cd "$SERVER_PILOT"
pnpm exec tsx scripts/bedrock-live-smoke.ts

echo "bedrock-live-gate: PASS"
