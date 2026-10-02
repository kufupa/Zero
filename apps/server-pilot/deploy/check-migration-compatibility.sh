#!/usr/bin/env bash
# Read-only schema gate; source runtime DB credentials only in this child process.
set -euo pipefail
SERVER_PILOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-${SERVER_PILOT}/.env.production}"
if [ ! -f "$ENV_FILE" ] && [ -f /home/ubuntu/.env.production ]; then
  ENV_FILE=/home/ubuntu/.env.production
fi
set -a
source "$ENV_FILE"
set +a
cd "$SERVER_PILOT"
exec node --import tsx scripts/check-migration-compatibility.ts
