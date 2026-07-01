#!/usr/bin/env bash
# RDS smoke test: connect via DATABASE_URL and print Postgres version.
# Run on EC2 as ubuntu after .env.production is written.
# Usage: bash apps/server-pilot/deploy/rds-smoke.sh
#   (or source .env.production first and pass DATABASE_URL via env)
set -euo pipefail

ENV_PATH="${ENV_PATH:-/home/ubuntu/repos/zero/apps/server-pilot/.env.production}"

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
  echo "psql not found; falling back to node pg script" >&2
  NODE_BIN="${NODE_BIN:-node}"
  "$NODE_BIN" -e '
    const { Client } = require("pg");
    const c = new Client({ connectionString: process.env.DATABASE_URL });
    c.connect().then(() => c.query("select version();")).then(r => {
      console.log(r.rows[0].version);
      return c.end();
    }).catch(e => { console.error(e); process.exit(1); });
  '
fi
