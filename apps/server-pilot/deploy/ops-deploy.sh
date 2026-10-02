#!/usr/bin/env bash
# Laptop entrypoint: ship new code to pilot EC2 (sync → optional migrate → deploy → health).
set -euo pipefail

: "${AWS_REGION:=af-south-1}"
: "${INSTANCE_ID:=i-008f737974a9ba9b3}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DO_MIGRATE=0
QUIESCED=0
for arg in "$@"; do
  case "$arg" in
    --migrate) DO_MIGRATE=1 ;;
    --quiesced) QUIESCED=1 ;;
    -h|--help)
      echo "usage: $0 [--migrate] [--quiesced]"
      echo "  sync git bundle → optional db:migrate → deploy-ec2.sh → health"
      echo "  --quiesced: assets only (no PM2/health); online pm2 http OK; VPN assert retained"
      exit 0
      ;;
    *)
      echo "unknown arg: $arg (try --migrate / --quiesced)" >&2
      exit 2
      ;;
  esac
done

echo "== ops-deploy: sync bundle =="
bash "${SCRIPT_DIR}/sync-ec2-git-bundle.sh"

REMOTE_NVM='export NVM_DIR=/home/ubuntu/.nvm; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"; export PATH="$HOME/.local/share/pnpm:$PATH"'

echo "== ops-deploy: install dependencies before migration check =="
bash "${SCRIPT_DIR}/ssm-run-command.sh" \
  "${REMOTE_NVM}; cd /home/ubuntu/repos/zero && pnpm install --frozen-lockfile"

if [ "$DO_MIGRATE" -eq 1 ]; then
  echo "== ops-deploy: migrate =="
  bash "${SCRIPT_DIR}/ssm-run-command.sh" \
    "${REMOTE_NVM}; cd /home/ubuntu/repos/zero/apps/server-pilot && set -a && source .env.production && set +a && pnpm db:migrate"
fi

if [ "$QUIESCED" != "1" ]; then
  echo "== ops-deploy: verify database before remote env bootstrap =="
  bash "${SCRIPT_DIR}/ssm-run-command.sh" \
    "${REMOTE_NVM}; cd /home/ubuntu/repos/zero && bash apps/server-pilot/deploy/check-migration-compatibility.sh"
fi

if [ "$QUIESCED" != "1" ]; then
  echo "== ops-deploy: bootstrap isolated remote env when absent =="
  bash "${SCRIPT_DIR}/ssm-run-command.sh" \
    "${REMOTE_NVM}; cd /home/ubuntu/repos/zero && \
      if [ ! -e apps/server-pilot/.env.remote-common ] && [ ! -e apps/server-pilot/.env.remote-admin ]; then \
        bash apps/server-pilot/deploy/write-ec2-remote-env.sh; \
      elif [ ! -f apps/server-pilot/.env.remote-common ] || [ ! -f apps/server-pilot/.env.remote-admin ]; then \
        echo 'remote HTTP env files must both exist or both be bootstrapped' >&2; exit 20; \
      fi"
fi

if [ "$QUIESCED" = "1" ]; then
  echo "== ops-deploy: on-box quiesced deploy (no PM2 / no HTTP health) =="
  bash "${SCRIPT_DIR}/ssm-run-command.sh" \
    "${REMOTE_NVM}; cd /home/ubuntu/repos/zero && bash apps/server-pilot/deploy/deploy-ec2.sh --quiesced"
fi

if [ "$QUIESCED" != "1" ]; then
  echo "== ops-deploy: on-box deploy =="
  bash "${SCRIPT_DIR}/ssm-run-command.sh" \
    "${REMOTE_NVM}; cd /home/ubuntu/repos/zero && bash apps/server-pilot/deploy/deploy-ec2.sh"

  echo "== ops-deploy: health =="
  bash "${SCRIPT_DIR}/ssm-run-command.sh" \
    'curl -fsS http://127.0.0.1:8788/health && curl -fsS http://127.0.0.1:8789/health && curl --disable --noproxy "*" -fsS --connect-to "nava-admin.trynava.io:8443:172.31.12.112:8443" -H "Host: nava-admin.trynava.io" "http://nava-admin.trynava.io:8443/" >/dev/null'

  echo "== ops-deploy: remote-admin lifecycle readiness =="
  REMOTE_ADMIN_MODE=1 REMOTE_TARGET_HEALTH_REQUIRED=0 REMOTE_ADMIN_LIFECYCLE_MODE=auto bash "${SCRIPT_DIR}/launch-readiness.sh"
fi

echo "== ops-deploy: VPN HARD assert =="
bash "${SCRIPT_DIR}/ssm-run-command.sh" \
  'bash /home/ubuntu/repos/zero/apps/server-pilot/deploy/vpn-health-assert.sh'

echo "ops-deploy ok"

# Phase B source+registry CAS (Task 13): when HMS_REGISTRY_CANDIDATE is set,
# invoke runSourceRegistryTransaction via source-registry-cas.sh.
# Crash injection: before/after_source_switch, before/after_registry_rename,
# before/after_pm2_restart, before/after_health_verdict (HMS_CAS_CRASH_AT).
# Incomplete restore → exit 20 and halt the live lane.
if [ -n "${HMS_REGISTRY_CANDIDATE:-}" ]; then
  echo "== ops-deploy: source+registry CAS (source-registry-transaction) =="
  bash "${SCRIPT_DIR}/ssm-run-command.sh" \
    "${REMOTE_NVM}; cd /home/ubuntu/repos/zero && \
      export HMS_REGISTRY_CANDIDATE='${HMS_REGISTRY_CANDIDATE}' \
        HMS_SOURCE_REGISTRY_CURRENT='${HMS_SOURCE_REGISTRY_CURRENT:?}' \
        HMS_SOURCE_REGISTRY_CANDIDATE='${HMS_SOURCE_REGISTRY_CANDIDATE:?}' \
        HMS_CAS_CRASH_AT='${HMS_CAS_CRASH_AT:-}' && \
      bash apps/server-pilot/deploy/source-registry-cas.sh" || {
        status=$?
        if [ "$status" -eq 20 ]; then
          echo "ops-deploy: incomplete restore (exit 20) — halt live lane" >&2
          exit 20
        fi
        exit "$status"
      }
fi
