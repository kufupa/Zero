#!/usr/bin/env bash
# Atomic source + registry CAS (Task 13). Calls runSourceRegistryTransaction.
# Incomplete restore exits 20 and must halt the HMS live lane.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_PILOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

: "${HMS_ACTIVE_REGISTRY_PATH:=/opt/nava/shared/hms-active-registry/active.json}"
: "${HMS_RELEASE_ROOT:=/opt/nava/shared/hms-releases}"
: "${HMS_REGISTRY_BACKUP_ROOT:=/opt/nava/shared/hms-active-registry/backups}"

if [ -z "${HMS_REGISTRY_CANDIDATE:-}" ]; then
  echo "source-registry-cas: HMS_REGISTRY_CANDIDATE unset — skip CAS" >&2
  exit 0
fi

if [ -z "${HMS_SOURCE_REGISTRY_CURRENT:-}" ] || [ -z "${HMS_SOURCE_REGISTRY_CANDIDATE:-}" ]; then
  echo "source-registry-cas: require HMS_SOURCE_REGISTRY_CURRENT + HMS_SOURCE_REGISTRY_CANDIDATE" >&2
  exit 2
fi

export HMS_ACTIVE_REGISTRY_PATH HMS_RELEASE_ROOT HMS_REGISTRY_BACKUP_ROOT
export HMS_REGISTRY_CANDIDATE HMS_SOURCE_REGISTRY_CURRENT HMS_SOURCE_REGISTRY_CANDIDATE
# Optional crash injection: before_source_switch | after_source_switch |
# before_registry_rename | after_registry_rename | before_pm2_restart |
# after_pm2_restart | before_health_verdict | after_health_verdict
export HMS_CAS_CRASH_AT="${HMS_CAS_CRASH_AT:-}"

cd "$SERVER_PILOT"
set +e
node --import tsx src/ops/run-source-registry-cas.ts
status=$?
set -e
if [ "$status" -eq 20 ]; then
  echo "source-registry-cas: incomplete restore (exit 20) — halt live lane" >&2
  exit 20
fi
exit "$status"
