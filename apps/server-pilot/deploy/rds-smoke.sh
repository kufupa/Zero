#!/usr/bin/env bash
# RDS smoke test: connect via DATABASE_URL and print Postgres version.
# Run on EC2 as ubuntu after .env.production is written.
# Usage: bash apps/server-pilot/deploy/rds-smoke.sh
#   (or source .env.production first and pass DATABASE_URL via env)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_PILOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_PATH="${ENV_PATH:-${SERVER_PILOT}/.env.production}"

if [ -z "${DATABASE_URL:-}" ] && [ -r "$ENV_PATH" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_PATH"
  set +a
fi

: "${DATABASE_URL:?DATABASE_URL required (set in env or .env.production)}"

if command -v psql >/dev/null 2>&1; then
  psql "$DATABASE_URL" -c "select version();"
else
  echo "psql not found; falling back to postgres npm package" >&2
  NODE_BIN="${NODE_BIN:-node}"
  (
    cd "$SERVER_PILOT"
    "$NODE_BIN" --input-type=module -e '
      import postgres from "postgres";
      const sql = postgres(process.env.DATABASE_URL);
      const [row] = await sql`select version()`;
      console.log(row.version);
      await sql.end({ timeout: 5 });
    '
  )
fi
