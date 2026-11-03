#!/usr/bin/env bash
# Recheck the artifact on every PM2 start, restart and resurrection.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SERVER_PILOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd -- "$SERVER_PILOT/../.." && pwd)"
source "$SCRIPT_DIR/build-identity.sh"
nava_load_build_commit "$REPO_ROOT"

case "${1:-}" in
  http) entry=dist/main.js ;;
  worker) entry=dist/mail/ingest/worker.js ;;
  ai-worker) entry=dist/ai/worker.js ;;
  *) echo "invalid server entry" >&2; exit 2 ;;
esac
cd "$SERVER_PILOT"
exec node "$entry"
