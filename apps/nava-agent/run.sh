#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
node_major=$(node -p "Number(process.versions.node.split('.')[0])")
if (( node_major < 22 )); then echo "Node 22 or later required" >&2; exit 1; fi
case "${1:-}" in
  migrate|start|worker|import-train) task=$1; shift; exec npm --prefix apps/nava-agent run "$task" -- "$@" ;;
  *) echo 'usage: apps/nava-agent/run.sh migrate|start|worker|import-train' >&2; exit 2 ;;
esac
