#!/usr/bin/env bash
# NVM-safe PM2 boot with exact mode-specific default apps.
# Never starts hms-ai-worker — ops-hms-shadow.sh start is the sole HMS starter.
set -euo pipefail

REPO_ROOT="${REPO_ROOT:-/home/ubuntu/repos/zero}"
SERVER_PILOT="${REPO_ROOT}/apps/server-pilot"
ENV_FILE="${ENV_FILE:-${SERVER_PILOT}/.env.production}"
if [ ! -f "$ENV_FILE" ] && [ -f /home/ubuntu/.env.production ]; then
  ENV_FILE=/home/ubuntu/.env.production
fi
REMOTE_COMMON_ENV="${SERVER_PILOT}/.env.remote-common"
REMOTE_ADMIN_ENV="${SERVER_PILOT}/.env.remote-admin"

if [ "$(id -u)" -eq 0 ]; then
  echo "pm2-boot.sh must run as ubuntu" >&2
  exit 2
fi

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

export PATH="${HOME}/.local/share/pnpm:${HOME}/.nvm/versions/node/$(ls "${HOME}/.nvm/versions/node" 2>/dev/null | sort -V | tail -1)/bin:${PATH}"

export NAVA_BUILD_COMMIT="${NAVA_BUILD_COMMIT:-$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || true)}"

cd "$REPO_ROOT"

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

assert_http_loopback_with_retry() {
  local attempt
  for attempt in 1 2 3 4 5; do
    assert_http_loopback_only && return 0
    [ "$attempt" -lt 5 ] && sleep 1
  done
  return 1
}

start_legacy_processes() {
  local mode
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
  : "${BETTER_AUTH_URL:?BETTER_AUTH_URL required for legacy HTTP}"
  mode="${MAIL_TRANSPORT_MODE:-fixture}"
  if [ "$mode" = "fixture" ]; then
    pm2 start "${SERVER_PILOT}/deploy/pm2.config.cjs" --only http --update-env
    pm2 start "${SERVER_PILOT}/deploy/pm2.config.cjs" --only ai-worker --update-env
  else
    pm2 start "${SERVER_PILOT}/deploy/pm2.config.cjs" --only http --update-env
    pm2 start "${SERVER_PILOT}/deploy/pm2.config.cjs" --only worker --update-env
    pm2 start "${SERVER_PILOT}/deploy/pm2.config.cjs" --only ai-worker --update-env
  fi
}

ensure_hms_absent() {
  local state present
  state="$(pm2 jlist)" || return 1
  present="$(
    HMS_PM2_STATE="$state" node -e '
try {
  const apps=JSON.parse(process.env.HMS_PM2_STATE||"");
  process.stdout.write(apps.some((app)=>app?.name==="hms-ai-worker")?"1":"0");
} catch { process.exit(2); }
'
  )" || return 1
  if [ "$present" = "1" ]; then
    pm2 delete hms-ai-worker >/dev/null || return 1
  fi
  pm2 save >/dev/null || return 1
  state="$(pm2 jlist)" || return 1
  present="$(
    HMS_PM2_STATE="$state" node -e '
try {
  const apps=JSON.parse(process.env.HMS_PM2_STATE||"");
  process.stdout.write(apps.some((app)=>app?.name==="hms-ai-worker")?"1":"0");
} catch { process.exit(2); }
'
  )" || return 1
  [ "$present" = "0" ]
}

invalidate_hms_proofs() {
  local path
  for path in \
    /opt/nava/shared/hms-runtime/hms-reservation-canary-proof.v1.json \
    /opt/nava/shared/hms-runtime/hms-reservation-shadow-proof.v1.json; do
    rm -f -- "$path" || return 1
    [ ! -e "$path" ] && [ ! -L "$path" ] || return 1
  done
}

delete_all_pm2_processes() {
  local state count
  state="$(pm2 jlist)" || return 1
  count="$(
    HMS_PM2_STATE="$state" node -e '
try {
  const apps=JSON.parse(process.env.HMS_PM2_STATE||"");
  if(!Array.isArray(apps))process.exit(2);
  process.stdout.write(String(apps.length));
} catch { process.exit(2); }
'
  )" || return 1
  if [ "$count" -gt 0 ]; then
    pm2 delete all >/dev/null || return 1
  fi
  state="$(pm2 jlist)" || return 1
  HMS_PM2_STATE="$state" node -e '
const apps=JSON.parse(process.env.HMS_PM2_STATE||"");
if(!Array.isArray(apps)||apps.length!==0)process.exit(1);
'
}

verify_default_process_set() {
  local mode="$1" state
  state="$(pm2 jlist)" || return 1
  HMS_PM2_STATE="$state" node - "$mode" <<'NODE'
const apps=JSON.parse(process.env.HMS_PM2_STATE||"");
const mode=process.argv[2];
const expected=(mode==="fixture"
  ?["ai-worker","http","remote-http"]
  :["ai-worker","http","remote-http","worker"]).sort();
const actual=apps.map((app)=>app?.name).sort();
if(JSON.stringify(actual)!==JSON.stringify(expected)||
  apps.some((app)=>app?.pm2_env?.status!=="online"))process.exit(1);
NODE
}

bash "$SERVER_PILOT/deploy/check-migration-compatibility.sh"

validate_remote_env_files || {
  echo "pm2-boot: remote HTTP environment validation failed before PM2 mutation" >&2
  exit 20
}

invalidate_hms_proofs || {
  echo "pm2-boot: HMS proof invalidation failed" >&2
  exit 20
}
delete_all_pm2_processes || {
  echo "pm2-boot: existing process cleanup failed" >&2
  exit 20
}

start_legacy_processes
start_remote_http
assert_http_loopback_with_retry || {
  echo "pm2-boot: raw HTTP processes must listen only on 127.0.0.1" >&2
  exit 20
}
MODE="${MAIL_TRANSPORT_MODE:-fixture}"

ensure_hms_absent || {
  echo "pm2-boot: HMS process cleanup failed" >&2
  exit 20
}
verify_default_process_set "$MODE" || {
  echo "pm2-boot: default process set unhealthy" >&2
  exit 20
}
pm2 save
pm2 status
