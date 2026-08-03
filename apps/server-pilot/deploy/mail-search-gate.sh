#!/usr/bin/env bash
# EC2 mail search gate: disposable-DB vitest for parser + FTS + contract.
# Never sources .env.production / .env into Vitest.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_PILOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "$SERVER_PILOT"

unset DATABASE_URL VITEST_ALLOW_PILOT_RDS

if [ -z "${TEST_DATABASE_URL:-}" ]; then
  echo "mail-search-gate: TEST_DATABASE_URL must point to a disposable non-production DB" >&2
  exit 1
fi
if [ "${CONFIRM_DISPOSABLE_TEST_DB:-}" != "1" ]; then
  echo "mail-search-gate: CONFIRM_DISPOSABLE_TEST_DB=1 required before DB Vitest" >&2
  exit 1
fi
case "${TEST_DATABASE_URL}" in
  *nava-zero-mail-pilot*)
    echo "mail-search-gate: REFUSE TEST_DATABASE_URL pointing at pilot RDS" >&2
    exit 2
    ;;
esac

export NODE_ENV=test
export MAIL_TRANSPORT_MODE=fixture
export PATH="${HOME}/.local/share/pnpm:${HOME}/.nvm/versions/node/$(ls "${HOME}/.nvm/versions/node" 2>/dev/null | sort -V | tail -1)/bin:${PATH}"

echo "== mail-search-gate: vitest =="
DATABASE_URL="$TEST_DATABASE_URL" pnpm exec vitest run \
  tests/mail-search-parse.test.ts \
  tests/mail-search-parity.test.ts \
  tests/mail-search-query.test.ts \
  tests/mail-search-contract.test.ts \
  tests/mail-search-fts.test.ts \
  --reporter=dot

echo "mail-search-gate: PASS"
