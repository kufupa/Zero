#!/usr/bin/env bash
# Recheck the artifact on every PM2 start, restart and resurrection.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SERVER_PILOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd -- "$SERVER_PILOT/../.." && pwd)"
source "$SCRIPT_DIR/build-identity.sh"
nava_load_build_commit "$REPO_ROOT"

# Never pass rewrite credentials or cohort configuration to legacy workers.
unset NAVA_AGENT_BASE_URL NAVA_STAFF_JWT_SECRET NAVA_REWRITE_COHORT_USER_ID NAVA_REWRITE_COHORT_MAILBOX_ID

node_bin=node
case "${1:-}" in
  http)
    entry=dist/main.js
    gateway_env="${HOME:?HOME required}/.config/nava-agent/gateway.env"
    if [ -e "$gateway_env" ] || [ -L "$gateway_env" ]; then
      source "$SCRIPT_DIR/nava-gateway-env.sh"
      if ! nava_gateway_load "$gateway_env"; then
        unset NAVA_AGENT_BASE_URL NAVA_STAFF_JWT_SECRET NAVA_REWRITE_COHORT_USER_ID NAVA_REWRITE_COHORT_MAILBOX_ID
        echo 'rewrite gateway config invalid; starting legacy HTTP only' >&2
      fi
    fi
    unset gateway_env
    ;;
  worker) entry=dist/mail/ingest/worker.js ;;
  ai-worker)
    entry=dist/ai/worker.js
    # The HMS secret wrapper previously pinned the system Node executable.
    if [ "${AI_WORKER_LANE:-}" = hms ]; then node_bin=/usr/bin/node; fi
    ;;
  *) echo "invalid server entry" >&2; exit 2 ;;
esac
cd "$SERVER_PILOT"
exec "$node_bin" "$entry"
