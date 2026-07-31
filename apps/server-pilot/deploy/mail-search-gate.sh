#!/usr/bin/env bash
# EC2 mail search gate: disposable-DB vitest for parser + FTS + contract.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_PILOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${ENV_FILE:-${SERVER_PILOT}/.env.production}"

cd "$SERVER_PILOT"

if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

if [ -z "${TEST_DATABASE_URL:-}" ]; then
  echo "mail-search-gate: TEST_DATABASE_URL must point to a disposable non-production DB" >&2
  exit 1
fi
export DATABASE_URL="$TEST_DATABASE_URL"
unset VITEST_ALLOW_PILOT_RDS

export NODE_ENV=test
export MAIL_TRANSPORT_MODE=fixture
export PATH="${HOME}/.local/share/pnpm:${HOME}/.nvm/versions/node/$(ls "${HOME}/.nvm/versions/node" 2>/dev/null | sort -V | tail -1)/bin:${PATH}"

echo "== mail-search-gate: vitest =="
pnpm exec vitest run \
  tests/mail-search-parse.test.ts \
  tests/mail-search-parity.test.ts \
  tests/mail-search-query.test.ts \
  tests/mail-search-contract.test.ts \
  tests/mail-search-fts.test.ts \
  --reporter=dot

echo "mail-search-gate: PASS"
