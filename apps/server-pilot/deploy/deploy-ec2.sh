#!/usr/bin/env bash
# Deploy server-pilot + mail SPA to EC2 (SSM-friendly, run as ubuntu).
# Phase B Task 13: when HMS_REGISTRY_CANDIDATE is set, invoke
# source-registry-cas.sh → runSourceRegistryTransaction (CAS source + active.json).
# Incomplete restore exits 20 and halts the HMS live lane (before/after_source_switch,
# before/after_registry_rename, before/after_pm2_restart, health_verdict).
set -euo pipefail

REPO_ROOT="${REPO_ROOT:-/home/ubuntu/repos/zero}"
SERVER_PILOT="${REPO_ROOT}/apps/server-pilot"
MAIL_APP="${REPO_ROOT}/apps/mail"
WEB_ROOT="${WEB_ROOT:-/var/www/nava-mail}"
ENV_FILE="${ENV_FILE:-${REPO_ROOT}/apps/server-pilot/.env.production}"
if [ ! -f "$ENV_FILE" ] && [ -f /home/ubuntu/.env.production ]; then
  ENV_FILE=/home/ubuntu/.env.production
fi
REMOTE_COMMON_ENV="${SERVER_PILOT}/.env.remote-common"
REMOTE_ADMIN_ENV="${SERVER_PILOT}/.env.remote-admin"

QUIESCED=0
for arg in "$@"; do
  case "$arg" in
    --quiesced) QUIESCED=1 ;;
    -h|--help)
      echo "usage: $0 [--quiesced]"
      echo "  default: install/build/sync + PM2 start + HTTP health"
      echo "  --quiesced: install/build/sync only; no PM2 mutation; no HTTP health"
      echo "             (safe while pm2 http/ai-worker stay online — assets only)"
      exit 0
      ;;
    *)
      echo "unknown arg: $arg (try --quiesced)" >&2
      exit 2
      ;;
  esac
done

echo "== deploy: repo ${REPO_ROOT} =="
cd "$REPO_ROOT"

# Root owns trust-boundary parents; app owns only mutable runtime/artifact leaves.
echo "== ensure protected HMS runtime hierarchy =="
for path in /opt/nava /opt/nava/shared \
  /opt/nava/shared/hms-browser-artifacts /opt/nava/shared/hms-runtime; do
  [ ! -L "$path" ] || {
    echo "unsafe HMS runtime symlink: $path" >&2
    exit 20
  }
done
sudo install -d -o root -g root -m 0755 /opt/nava /opt/nava/shared
sudo install -d -o ubuntu -g ubuntu -m 0700 \
  /opt/nava/shared/hms-browser-artifacts \
  /opt/nava/shared/hms-runtime

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

validate_remote_env_files() {
  bash "${SERVER_PILOT}/deploy/write-ec2-remote-env.sh" --validate
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
  local transport_mode
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
  : "${BETTER_AUTH_URL:?BETTER_AUTH_URL required for legacy HTTP}"
  transport_mode="${MAIL_TRANSPORT_MODE:-fixture}"
  if [ "$transport_mode" = "fixture" ]; then
    pm2 delete worker 2>/dev/null || true
    pm2 delete http ai-worker 2>/dev/null || true
    pm2 start "${SERVER_PILOT}/deploy/pm2.config.cjs" --only http --update-env
    pm2 start "${SERVER_PILOT}/deploy/pm2.config.cjs" --only ai-worker --update-env
  else
    pm2 delete http worker ai-worker 2>/dev/null || true
    pm2 start "${SERVER_PILOT}/deploy/pm2.config.cjs" --only http --update-env
    pm2 start "${SERVER_PILOT}/deploy/pm2.config.cjs" --only worker --update-env
    pm2 start "${SERVER_PILOT}/deploy/pm2.config.cjs" --only ai-worker --update-env
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

validate_remote_env_files || {
  echo "remote HTTP environment validation failed before PM2 mutation" >&2
  exit 20
}

export PATH="${HOME}/.local/share/pnpm:${HOME}/.nvm/versions/node/$(ls "${HOME}/.nvm/versions/node" 2>/dev/null | sort -V | tail -1)/bin:${PATH}"

# husky prepare copyFileSync needs owner-write on generated shim; prior deploys
# can leave .husky/_/h mode 0444 and abort pnpm install with EACCES.
if [ -e "${REPO_ROOT}/.husky/_/h" ]; then
  chmod u+w "${REPO_ROOT}/.husky/_/h" || true
fi

echo "== pnpm install =="
pnpm install --frozen-lockfile

echo "== build server-pilot =="
pnpm --filter @zero/server build

echo "== build mail SPA =="
# Empty string = same-origin /api via nginx. No host is baked into this shared artifact.
export VITE_PUBLIC_BACKEND_URL=""
unset VITE_PUBLIC_APP_URL
# Near-realtime thread list poll (policy min 15s; default baked for pilot).
export VITE_MAIL_POLL_MS="${VITE_MAIL_POLL_MS:-15000}"
pnpm --filter @zero/mail build

echo "== sync SPA to ${WEB_ROOT} =="
sudo mkdir -p "$WEB_ROOT"
sudo rsync -a --delete "${MAIL_APP}/build/client/" "${WEB_ROOT}/"

echo "== hosts: nava.legacyhotels.co.za =="
# EC2 uses split-tunnel routing and does not consume hotel DNS; on-box browser gates need this.
sudo sed -i \
  '/^[[:space:]]*127\.0\.0\.1[[:space:]]\+nava\.legacy\.local[[:space:]]*$/d' \
  /etc/hosts
HOSTS_TMP="$(mktemp)"
awk -v canonical='nava.legacyhotels.co.za' '
  {
    original = $0
    comment_at = index(original, "#")
    content = comment_at ? substr(original, 1, comment_at - 1) : original
    comment = comment_at ? substr(original, comment_at) : ""
    count = split(content, fields, /[[:space:]]+/)
    found = 0
    kept = 0
    output = ""
    for (i = 1; i <= count; i += 1) {
      if (fields[i] == canonical) {
        found = 1
      } else if (fields[i] != "") {
        kept += 1
        output = output (output ? " " : "") fields[i]
      }
    }
    if (!found) {
      print original
    } else if (kept >= 2) {
      print output (comment ? " " comment : "")
    } else if (comment) {
      print comment
    }
  }
  END { print "127.0.0.1 nava.legacyhotels.co.za" }
' /etc/hosts > "$HOSTS_TMP"
sudo tee /etc/hosts < "$HOSTS_TMP" >/dev/null
rm -f "$HOSTS_TMP"

echo "== hosts: appsrv-1.legacyhotels.co.za (Infor HMS via VPN) =="
# Hotel internal hostname has no public A record; EC2 split-tunnel ignores VPN DNS.
# Map to Infor app-server so Chromium hostname matches *.legacyhotels.co.za cert.
if ! grep -qE '(^|[[:space:]])appsrv-1\.legacyhotels\.co\.za([[:space:]]|$)' /etc/hosts; then
  echo '172.24.240.41 appsrv-1.legacyhotels.co.za' | sudo tee -a /etc/hosts >/dev/null
fi

echo "== hosts: appsrv-1.legacyhotels.co.za (Infor HMS via VPN) =="
# Hotel internal hostname has no public A record; EC2 split-tunnel ignores VPN DNS.
# Map to Infor app-server so Chromium hostname matches *.legacyhotels.co.za cert.
if ! grep -qE '(^|[[:space:]])appsrv-1\.legacyhotels\.co\.za([[:space:]]|$)' /etc/hosts; then
  echo '172.24.240.41 appsrv-1.legacyhotels.co.za' | sudo tee -a /etc/hosts >/dev/null
fi

echo "== nginx =="
REMOTE_ALB_TARGET_PRIVATE_IP="172.31.12.112"

assert_remote_alb_target_private_ip() {
  local primary_ens5_ip
  primary_ens5_ip="$(
    ip -4 -o addr show dev ens5 scope global primary 2>/dev/null \
      | awk 'NR == 1 { split($4, cidr, "/"); print cidr[1]; exit }'
  )" || primary_ens5_ip=""

  if [ "$primary_ens5_ip" != "$REMOTE_ALB_TARGET_PRIVATE_IP" ]; then
    echo "remote ALB target private IP mismatch on primary ens5" >&2
    return 1
  fi
}

# Refuse one-sided Nginx candidates before install/reload so neither plane
# can be wiped by a bad deploy. Independent of live ALB rule state.
assert_dual_plane_nginx_candidate() {
  local candidate="${1:-$NGINX_SRC}"
  local missing=0

  if [ ! -f "$candidate" ]; then
    echo "nginx dual-plane candidate missing file: ${candidate}" >&2
    return 1
  fi

  for required in \
    'server_name nava.legacyhotels.co.za' \
    'listen 443 ssl' \
    'proxy_pass http://127.0.0.1:8788/api/' \
    "listen ${REMOTE_ALB_TARGET_PRIVATE_IP}:8443" \
    'server_name nava-admin.trynava.io' \
    'proxy_pass http://127.0.0.1:8789/api/' \
    'proxy_pass http://127.0.0.1:8789/health'
  do
    if ! grep -Fq "$required" "$candidate"; then
      echo "nginx dual-plane candidate missing: ${required}" >&2
      missing=1
    fi
  done

  [ "$missing" -eq 0 ]
}

NGINX_SITE="${NGINX_SITE:-/etc/nginx/sites-available/nava-zero}"
NGINX_ENABLED="${NGINX_ENABLED:-/etc/nginx/sites-enabled/nava-zero}"
NGINX_SRC="${SERVER_PILOT}/deploy/nginx.conf"
if command -v nginx >/dev/null 2>&1; then
  NGINX_BACKUP=""
  NGINX_EXISTED=0
  NGINX_ENABLED_EXISTED=0
  NGINX_ENABLED_TARGET=""
  NGINX_TRANSACTION_ACTIVE=0
  NGINX_FAILURE_CONTEXT="nginx transaction aborted"

  cleanup_nginx_backup() {
    if [ -z "$NGINX_BACKUP" ]; then
      return 0
    fi
    if ! sudo rm -f "$NGINX_BACKUP"; then
      echo "nginx backup cleanup failed: ${NGINX_BACKUP}" >&2
      return 1
    fi
    NGINX_BACKUP=""
  }

  restore_nginx() {
    local rollback_failed=0
    local enabled_removed=1

    if ! sudo rm -f "$NGINX_ENABLED"; then
      rollback_failed=1
      enabled_removed=0
    fi

    if [ "$NGINX_EXISTED" -eq 1 ]; then
      if ! sudo cp --preserve=mode,ownership,timestamps "$NGINX_BACKUP" "$NGINX_SITE"; then
        rollback_failed=1
      fi
    elif [ "$enabled_removed" -eq 1 ]; then
      if ! sudo rm -f "$NGINX_SITE"; then
        rollback_failed=1
      fi
    else
      # Keep the candidate site so an unremovable enabled link cannot become broken.
      rollback_failed=1
    fi

    if [ "$NGINX_ENABLED_EXISTED" -eq 1 ] && [ "$enabled_removed" -eq 1 ]; then
      if ! sudo ln -s "$NGINX_ENABLED_TARGET" "$NGINX_ENABLED"; then
        rollback_failed=1
      fi
    fi

    if [ "$rollback_failed" -eq 0 ]; then
      if ! sudo nginx -t; then
        rollback_failed=1
      elif ! sudo systemctl reload nginx; then
        rollback_failed=1
      fi
    fi

    [ "$rollback_failed" -eq 0 ]
  }

  nginx_on_exit() {
    local original_status="$1"
    local was_active="$NGINX_TRANSACTION_ACTIVE"
    local rollback_ok=1
    local cleanup_ok=1

    # Prevent nested exits and repeated signals from interrupting rollback.
    trap - EXIT
    trap '' INT TERM
    NGINX_TRANSACTION_ACTIVE=0

    if [ "$was_active" -eq 1 ] && ! restore_nginx; then
      rollback_ok=0
    fi
    if ! cleanup_nginx_backup; then
      cleanup_ok=0
    fi

    if [ "$was_active" -eq 1 ]; then
      if [ "$rollback_ok" -eq 1 ]; then
        if [ "$NGINX_FAILURE_CONTEXT" = "nginx candidate failed" ]; then
          echo "nginx candidate failed; restored previous config" >&2
        else
          echo "${NGINX_FAILURE_CONTEXT}; restored previous config" >&2
        fi
      elif [ "$NGINX_FAILURE_CONTEXT" = "nginx candidate failed" ]; then
        echo "nginx candidate failed; rollback failed" >&2
      else
        echo "${NGINX_FAILURE_CONTEXT}; rollback failed" >&2
      fi
    fi

    if [ "$rollback_ok" -ne 1 ] || [ "$cleanup_ok" -ne 1 ]; then
      exit 1
    fi
    exit "$original_status"
  }

  nginx_on_signal() {
    local signal_status="$1"
    NGINX_FAILURE_CONTEXT="nginx transaction interrupted"
    trap '' INT TERM
    exit "$signal_status"
  }

  activate_nginx() {
    if ! sudo install -o root -g root -m 644 "$NGINX_SRC" "$NGINX_SITE"; then
      return 1
    fi
    if ! sudo ln -sfn "$NGINX_SITE" "$NGINX_ENABLED"; then
      return 1
    fi
    if ! sudo nginx -t; then
      return 1
    fi
    if ! assert_remote_alb_target_private_ip; then
      return 1
    fi
    if ! sudo systemctl reload nginx; then
      return 1
    fi
  }

  # All handlers exist before backup creation or candidate mutation.
  trap 'nginx_on_exit $?' EXIT
  trap 'nginx_on_signal 130' INT
  trap 'nginx_on_signal 143' TERM

  NGINX_BACKUP="$(mktemp "${TMPDIR:-/tmp}/nava-nginx.XXXXXX")"

  if sudo test -L "$NGINX_SITE"; then
    echo "nginx site path is a symlink; candidate not installed" >&2
    exit 1
  elif sudo test -f "$NGINX_SITE"; then
    if ! sudo cp --preserve=mode,ownership,timestamps "$NGINX_SITE" "$NGINX_BACKUP"; then
      echo "nginx site backup failed; candidate not installed" >&2
      exit 1
    fi
    NGINX_EXISTED=1
  elif sudo test -e "$NGINX_SITE"; then
    echo "nginx site path is not a regular file; candidate not installed" >&2
    exit 1
  fi

  if sudo test -L "$NGINX_ENABLED"; then
    if ! NGINX_ENABLED_TARGET="$(sudo readlink "$NGINX_ENABLED")"; then
      echo "nginx enabled symlink target could not be read; candidate not installed" >&2
      exit 1
    fi
    if ! sudo test -e "$NGINX_ENABLED"; then
      echo "nginx enabled symlink is already broken; candidate not installed" >&2
      exit 1
    fi
    NGINX_ENABLED_EXISTED=1
  elif sudo test -e "$NGINX_ENABLED"; then
    echo "nginx enabled path is not a symlink; candidate not installed" >&2
    exit 1
  fi

  if ! assert_dual_plane_nginx_candidate "$NGINX_SRC"; then
    echo "nginx candidate missing dual-plane contracts; prior site left untouched" >&2
    exit 1
  fi

  NGINX_TRANSACTION_ACTIVE=1
  if ! activate_nginx; then
    NGINX_FAILURE_CONTEXT="nginx candidate failed"
    exit 1
  fi

  # Candidate is live. Disarm rollback before deleting its backup.
  NGINX_TRANSACTION_ACTIVE=0
  if cleanup_nginx_backup; then
    trap - EXIT INT TERM
  else
    echo "nginx activated but temporary backup cleanup failed" >&2
    exit 1
  fi
else
  echo "nginx not installed; install nginx and the validated TLS files before deploy" >&2
  exit 1
fi

if [ "$QUIESCED" = "1" ]; then
  # Assets only — leave running pm2 http/worker/ai-worker alone (online OK).
  # HMS worker still sole-started by ops-hms-shadow.sh; we do not touch it here either.
  echo "== quiesced: skip PM2 mutation and HTTP health (online http OK) =="
  echo "quiesced deploy ok (assets synced; no PM2 mutation; no HTTP health)"
  exit 0
fi

# Optional registry-candidate CAS before generic PM2 start (Task 13).
# Requires HMS_REGISTRY_CANDIDATE + pointer env; incomplete restore → exit 20.
if [ -n "${HMS_REGISTRY_CANDIDATE:-}" ]; then
  echo "== source-registry-transaction CAS =="
  bash "${SERVER_PILOT}/deploy/source-registry-cas.sh"
fi

echo "== pm2 =="
export NAVA_BUILD_COMMIT="${NAVA_BUILD_COMMIT:-$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || true)}"

# Always keep HMS off on generic deploy — ops-hms-shadow.sh start is sole HMS starter.
# Invalidate canary/shadow proofs on build identity change.
invalidate_hms_proofs || {
  echo "HMS proof invalidation failed" >&2
  exit 20
}

if ! command -v pm2 >/dev/null 2>&1; then
  echo "pm2 not installed; installing globally"
  npm install -g pm2
fi

ensure_hms_absent || {
  echo "HMS process cleanup failed" >&2
  exit 20
}
start_legacy_processes
start_remote_http
pm2 save
bash "${SERVER_PILOT}/deploy/pm2-startup.sh"
pm2 status

echo "== health =="
for HEALTH_URL in \
  "http://127.0.0.1:8788/health" \
  "http://127.0.0.1:8789/health"; do
  for attempt in $(seq 1 10); do
    if curl -fsS "$HEALTH_URL"; then
      break
    fi
    if [ "$attempt" -eq 10 ]; then
      echo "health check failed for ${HEALTH_URL}; pm2 logs http remote-http --lines 20" >&2
      pm2 logs http remote-http --lines 20 --nostream || true
      exit 1
    fi
    echo "health attempt ${attempt}/10 failed for ${HEALTH_URL}; retry in ${attempt}s"
    sleep "$attempt"
  done
done
SPA_ORIGIN="https://nava.legacyhotels.co.za"
SPA_HOST="${SPA_ORIGIN#https://}"
if ! curl --disable --noproxy '*' -fsS \
  --resolve "${SPA_HOST}:443:127.0.0.1" \
  "${SPA_ORIGIN}/health" >/dev/null; then
  echo "TLS vhost health check failed for ${SPA_ORIGIN}" >&2
  exit 1
fi
REMOTE_ADMIN_HOST="nava-admin.trynava.io"
REMOTE_ALB_TARGET_PRIVATE_IP="172.31.12.112"
if ! curl --disable --noproxy '*' -fsS \
  --connect-to "${REMOTE_ADMIN_HOST}:8443:${REMOTE_ALB_TARGET_PRIVATE_IP}:8443" \
  -H "Host: ${REMOTE_ADMIN_HOST}" \
  "http://${REMOTE_ADMIN_HOST}:8443/" >/dev/null; then
  echo "remote :8443 vhost health check failed" >&2
  exit 1
fi
assert_http_loopback_only || {
  echo "raw HTTP processes must listen only on 127.0.0.1" >&2
  exit 1
}
echo
echo "deploy ok"
