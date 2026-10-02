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
SERVER_PILOT=/home/ubuntu/repos/zero/apps/server-pilot
REMOTE_COMMON_ENV="${SERVER_PILOT}/.env.remote-common"
REMOTE_ADMIN_ENV="${SERVER_PILOT}/.env.remote-admin"
export NAVA_BUILD_COMMIT="${NAVA_BUILD_COMMIT:-$(git rev-parse HEAD 2>/dev/null || true)}"

validate_remote_env_files() {
  bash "$SERVER_PILOT/deploy/write-ec2-remote-env.sh" --validate
}

start_remote_http() {
  env -i \
    HOME="$HOME" \
    PATH="$PATH" \
    NAVA_BUILD_COMMIT="$NAVA_BUILD_COMMIT" \
    SERVER_PILOT="$SERVER_PILOT" \
    REMOTE_COMMON_ENV="$REMOTE_COMMON_ENV" \
    REMOTE_ADMIN_ENV="$REMOTE_ADMIN_ENV" \
    bash -ceu '
      set -a
      source "$REMOTE_COMMON_ENV"
      source "$REMOTE_ADMIN_ENV"
      set +a
      pm2 delete remote-http 2>/dev/null || true
      pm2 start "$SERVER_PILOT/deploy/pm2.config.cjs" --only remote-http --update-env
    '
}

start_legacy_processes() {
  local mode
  set -a
  source "$ENV_FILE"
  set +a
  : "${BETTER_AUTH_URL:?BETTER_AUTH_URL required for legacy HTTP}"
  mode="${MAIL_TRANSPORT_MODE:-fixture}"
  if [ "$mode" = "fixture" ]; then
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
}

assert_http_loopback_only() {
  local listeners
  listeners="$(ss -ltnH '( sport = :8788 or sport = :8789 )')" || return 1
  HTTP_LISTENERS="$listeners" node -e '
const lines=(process.env.HTTP_LISTENERS||"").trim().split(/\n/).filter(Boolean);
for (const port of [8788,8789]) {
  const matches=lines.filter((line)=>line.split(/\s+/)[3]===`127.0.0.1:${port}`);
  if (matches.length !== 1) process.exit(1);
}
if (lines.some((line)=>!/127\.0\.0\.1:(8788|8789)\b/.test(line))) process.exit(1);
'
}

bash "$SERVER_PILOT/deploy/check-migration-compatibility.sh"

validate_remote_env_files || {
  echo "remote HTTP environment validation failed before PM2 mutation" >&2
  exit 20
}

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

start_legacy_processes
start_remote_http
pm2 save
for health_url in http://127.0.0.1:8788/health http://127.0.0.1:8789/health; do
  curl -fsS "$health_url"
done
spa_origin="https://nava.legacyhotels.co.za"
spa_host="${spa_origin#https://}"
curl --disable --noproxy '*' -fsS \
  --resolve "${spa_host}:443:127.0.0.1" \
  "${spa_origin}/health" >/dev/null
remote_host="nava-admin.trynava.io"
curl --disable --noproxy '*' -fsS \
  --connect-to "${remote_host}:8443:172.31.12.112:8443" \
  -H "Host: ${remote_host}" \
  "http://${remote_host}:8443/" >/dev/null
assert_http_loopback_only
REMOTE
)"
bash "${SCRIPT_DIR}/ssm-run-command.sh" "$REMOTE_COMMAND"

echo "== ops-restart: remote-admin lifecycle readiness =="
REMOTE_ADMIN_MODE=1 REMOTE_TARGET_HEALTH_REQUIRED=0 REMOTE_ADMIN_LIFECYCLE_MODE=auto bash "${SCRIPT_DIR}/launch-readiness.sh"

echo
echo "ops-restart ok"
