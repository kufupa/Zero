#!/usr/bin/env bash
# Laptop entrypoint: bounce PM2 apps without OS reboot (no rebuild).
# Keeps HMS off — ops-hms-shadow.sh start is the sole HMS starter.
set -euo pipefail

: "${AWS_REGION:=af-south-1}"
: "${INSTANCE_ID:=i-008f737974a9ba9b3}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

for arg in "$@"; do
  case "$arg" in
    -h|--help)
      echo "usage: $0"
      echo "  SSM: pm2 delete+start (env refresh) + health (no code sync/build)"
      echo "  Never starts hms-ai-worker (use ops-hms-shadow.sh start)."
      exit 0
      ;;
    *)
      echo "unknown arg: $arg" >&2
      exit 2
      ;;
  esac
done

echo "== ops-restart: pm2 delete+start (env refresh; HMS off) =="
REMOTE_COMMAND="$(cat <<'REMOTE'
set -euo pipefail
export NVM_DIR=/home/ubuntu/.nvm
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
export PATH="$HOME/.local/share/pnpm:$PATH"
cd /home/ubuntu/repos/zero
ENV_FILE=apps/server-pilot/.env.production
[ -f "$ENV_FILE" ] || ENV_FILE=/home/ubuntu/.env.production
set -a
source "$ENV_FILE"
set +a
export NAVA_BUILD_COMMIT="${NAVA_BUILD_COMMIT:-$(git rev-parse HEAD 2>/dev/null || true)}"

pm2_state="$(pm2 jlist)"
hms_present="$(
  HMS_PM2_STATE="$pm2_state" node -e '
try {
  const apps=JSON.parse(process.env.HMS_PM2_STATE||"");
  process.stdout.write(apps.some((app)=>app?.name==="hms-ai-worker")?"1":"0");
} catch { process.exit(2); }
'
)"
if [ "$hms_present" = "1" ]; then
  pm2 delete hms-ai-worker >/dev/null
fi
pm2 save >/dev/null
pm2_state="$(pm2 jlist)"
HMS_PM2_STATE="$pm2_state" node -e '
const apps=JSON.parse(process.env.HMS_PM2_STATE||"");
if(apps.some((app)=>app?.name==="hms-ai-worker"))process.exit(1);
'

for path in \
  /opt/nava/shared/hms-runtime/hms-reservation-canary-proof.v1.json \
  /opt/nava/shared/hms-runtime/hms-reservation-shadow-proof.v1.json; do
  rm -f -- "$path"
  [ ! -e "$path" ] && [ ! -L "$path" ]
done

MODE="${MAIL_TRANSPORT_MODE:-fixture}"
if [ "$MODE" = "fixture" ]; then
  pm2 delete worker 2>/dev/null || true
  pm2 delete http ai-worker 2>/dev/null || true
  pm2 start apps/server-pilot/deploy/pm2.config.cjs --only http --update-env
  pm2 start apps/server-pilot/deploy/pm2.config.cjs --only ai-worker --update-env
else
  pm2 delete http worker ai-worker 2>/dev/null || true
  pm2 start apps/server-pilot/deploy/pm2.config.cjs --only http --update-env
  pm2 start apps/server-pilot/deploy/pm2.config.cjs --only worker --update-env
  pm2 start apps/server-pilot/deploy/pm2.config.cjs --only ai-worker --update-env
fi
pm2 save
curl -fsS http://127.0.0.1:8788/health
REMOTE
)"
bash "${SCRIPT_DIR}/ssm-run-command.sh" "$REMOTE_COMMAND"

echo
echo "ops-restart ok"
