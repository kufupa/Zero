#!/usr/bin/env bash
# Laptop entrypoint: install/refresh the loopback Gotenberg sidecar on pilot EC2.
# Does not rewrite .env.production (install-gotenberg.sh appends GOTENBERG_URL if missing).
# Does not bounce PM2 — run ops-restart.sh after so http sees the URL.
set -euo pipefail

: "${AWS_REGION:=af-south-1}"
: "${INSTANCE_ID:=i-008f737974a9ba9b3}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

for arg in "$@"; do
  case "$arg" in
    -h|--help)
      echo "usage: $0"
      echo "  SSM: fail if install-gotenberg.sh missing (deploy this commit first),"
      echo "       else sudo install-gotenberg.sh (docker.io + 127.0.0.1:3000 sidecar)"
      echo "  Then: bash apps/server-pilot/deploy/ops-restart.sh"
      exit 0
      ;;
    *)
      echo "unknown arg: $arg" >&2
      exit 2
      ;;
  esac
done

echo "== ops-gotenberg: install sidecar ${INSTANCE_ID} =="
REMOTE_COMMAND="$(cat <<'REMOTE'
set -euo pipefail
INSTALL=/home/ubuntu/repos/zero/apps/server-pilot/deploy/install-gotenberg.sh
if [ ! -f "$INSTALL" ]; then
  echo "missing $INSTALL — deploy this commit first" >&2
  exit 1
fi
sudo bash "$INSTALL"
REMOTE
)"
bash "${SCRIPT_DIR}/ssm-run-command.sh" "$REMOTE_COMMAND"

echo "ops-gotenberg ok"
