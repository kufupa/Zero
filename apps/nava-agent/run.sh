#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
cd "$root"
node_major=$(node -p "Number(process.versions.node.split('.')[0])")
if (( node_major < 22 )); then echo "Node 22 or later required" >&2; exit 1; fi
case "${1:-}" in
  migrate|start|worker|import-train) task=$1; shift ;;
  *) echo 'usage: bash apps/nava-agent/run.sh migrate|start|worker|import-train [args...]' >&2; exit 2 ;;
esac
if [[ -n ${NAVA_ENV_FILE:-} ]]; then
  [[ -f $NAVA_ENV_FILE && ! -L $NAVA_ENV_FILE && -O $NAVA_ENV_FILE ]] || { echo 'env file must be a regular file owned by this user' >&2; exit 1; }
  mode=$(stat -c '%a' "$NAVA_ENV_FILE")
  (( (8#$mode & 077) == 0 )) || { echo 'env file must not be accessible by group or others' >&2; exit 1; }
  # Avoid inheriting pilot credentials or overriding values in the dedicated env file.
  exec env -i HOME="$HOME" PATH="$PATH" USER="${USER:-}" node --env-file="$NAVA_ENV_FILE" apps/nava-agent/node_modules/tsx/dist/cli.mjs "apps/nava-agent/src/${task/start/main}.ts" "$@"
fi
exec node apps/nava-agent/node_modules/tsx/dist/cli.mjs "apps/nava-agent/src/${task/start/main}.ts" "$@"
