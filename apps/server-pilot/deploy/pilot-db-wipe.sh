#!/usr/bin/env bash
# Truncate pilot mail tables (leave auth users). Destructive — requires CONFIRM.
# Usage (on EC2): CONFIRM_PILOT_WIPE=1 bash apps/server-pilot/deploy/pilot-db-wipe.sh
# Never run against non-pilot DBs. Live wipe is a separate cutover task.
set -euo pipefail

if [ "${CONFIRM_PILOT_WIPE:-}" != "1" ]; then
  echo "refusing wipe: set CONFIRM_PILOT_WIPE=1" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_PILOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_PATH="${ENV_PATH:-${SERVER_PILOT}/.env.production}"
MARKER_PATH="${MARKER_PATH:-/var/lib/nava-pilot/wipe-navaai.ok}"

if [ -z "${DATABASE_URL:-}" ] && [ -r "$ENV_PATH" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_PATH"
  set +a
fi

: "${DATABASE_URL:?DATABASE_URL required (set in env or .env.production)}"

WIPE_SQL="$(cat <<'SQL'
TRUNCATE TABLE
  mail_draft_revision,
  mail_draft,
  ai_workflow_run,
  ai_draft_generation,
  attachment,
  message,
  mail_thread_category,
  mail_thread,
  mail_label,
  mail_category,
  mailbox_access,
  mail_ingest_quarantine,
  mailbox_transport,
  mail_ingest_mailbox
RESTART IDENTITY CASCADE;
SQL
)"

echo "Wiping pilot mail tables via DATABASE_URL (auth users untouched)..."
if command -v psql >/dev/null 2>&1; then
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "$WIPE_SQL"
else
  echo "psql not found; falling back to postgres npm package" >&2
  NODE_BIN="${NODE_BIN:-node}"
  export WIPE_SQL
  (
    cd "$SERVER_PILOT"
    "$NODE_BIN" --input-type=module -e '
      import postgres from "postgres";
      const sql = postgres(process.env.DATABASE_URL);
      await sql.unsafe(process.env.WIPE_SQL);
      await sql.end({ timeout: 5 });
    '
  )
fi

MARKER_DIR="$(dirname "$MARKER_PATH")"
if mkdir -p "$MARKER_DIR" 2>/dev/null; then
  date -u +%Y-%m-%dT%H:%M:%SZ >"$MARKER_PATH"
else
  sudo mkdir -p "$MARKER_DIR"
  date -u +%Y-%m-%dT%H:%M:%SZ | sudo tee "$MARKER_PATH" >/dev/null
fi
echo "wipe marker written: $MARKER_PATH"
echo "pilot-db-wipe OK"
