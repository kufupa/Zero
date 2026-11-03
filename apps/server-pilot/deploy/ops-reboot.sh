#!/usr/bin/env bash
# Laptop entrypoint: soft EC2 reboot + wait SSM Online + post-boot smoke.
set -euo pipefail

: "${AWS_REGION:=af-south-1}"
: "${INSTANCE_ID:=i-008f737974a9ba9b3}"
: "${REBOOT_SSM_WAIT_SECONDS:=300}"
: "${REBOOT_SSM_POLL_SECONDS:=10}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

for arg in "$@"; do
  case "$arg" in
    -h|--help)
      echo "usage: $0"
      echo "  aws ec2 reboot-instances → wait SSM Online → post-boot-smoke.sh"
      exit 0
      ;;
    *)
      echo "unknown arg: $arg" >&2
      exit 2
      ;;
  esac
done

echo "== ops-reboot: reboot-instances ${INSTANCE_ID} =="
aws ec2 reboot-instances --region "$AWS_REGION" --instance-ids "$INSTANCE_ID"

echo "== ops-reboot: wait SSM Online (max ${REBOOT_SSM_WAIT_SECONDS}s) =="
START_EPOCH="$(date +%s)"
while true; do
  NOW_EPOCH="$(date +%s)"
  ELAPSED="$((NOW_EPOCH - START_EPOCH))"
  if [ "$ELAPSED" -ge "$REBOOT_SSM_WAIT_SECONDS" ]; then
    echo "ops-reboot: SSM not Online within ${REBOOT_SSM_WAIT_SECONDS}s" >&2
    exit 1
  fi
  PING="$(
    aws ssm describe-instance-information \
      --region "$AWS_REGION" \
      --filters "Key=InstanceIds,Values=${INSTANCE_ID}" \
      --query 'InstanceInformationList[0].PingStatus' \
      --output text 2>/dev/null || echo "Unknown"
  )"
  echo "  PingStatus=${PING} elapsed=${ELAPSED}s"
  if [ "$PING" = "Online" ] && [ "$ELAPSED" -ge 30 ]; then
    # Give pm2-ubuntu + smoke a head start after agent returns Online
    break
  fi
  sleep "$REBOOT_SSM_POLL_SECONDS"
done

# Extra settle for pm2 resurrect
sleep 20

echo "== ops-reboot: pm2-boot =="
# Boot can drain multiple resurrected PM2 processes before starting replacements.
SSM_EXECUTION_TIMEOUT_SECONDS=10800 SSM_MAX_POLL_SECONDS=11100 \
  bash "${SCRIPT_DIR}/ssm-run-command.sh" \
  'export NVM_DIR=/home/ubuntu/.nvm; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"; bash /home/ubuntu/repos/zero/apps/server-pilot/deploy/pm2-boot.sh'

echo "== ops-reboot: post-boot-smoke =="
bash "${SCRIPT_DIR}/ssm-run-command.sh" \
  'export NVM_DIR=/home/ubuntu/.nvm; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"; bash /home/ubuntu/repos/zero/apps/server-pilot/deploy/post-boot-smoke.sh'

echo "== ops-reboot: remote-admin lifecycle readiness =="
REMOTE_ADMIN_MODE=1 REMOTE_TARGET_HEALTH_REQUIRED=0 REMOTE_ADMIN_LIFECYCLE_MODE=auto bash "${SCRIPT_DIR}/launch-readiness.sh"

echo "ops-reboot ok"
