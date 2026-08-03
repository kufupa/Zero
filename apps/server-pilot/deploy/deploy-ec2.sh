#!/usr/bin/env bash
# Deploy server-pilot + mail SPA to EC2 (SSM-friendly, run as ubuntu).
set -euo pipefail

REPO_ROOT="${REPO_ROOT:-/home/ubuntu/repos/zero}"
SERVER_PILOT="${REPO_ROOT}/apps/server-pilot"
MAIL_APP="${REPO_ROOT}/apps/mail"
WEB_ROOT="${WEB_ROOT:-/var/www/nava-mail}"
ENV_FILE="${ENV_FILE:-${REPO_ROOT}/apps/server-pilot/.env.production}"
if [ ! -f "$ENV_FILE" ] && [ -f /home/ubuntu/.env.production ]; then
  ENV_FILE=/home/ubuntu/.env.production
fi

QUIESCED=0
for arg in "$@"; do
  case "$arg" in
    --quiesced) QUIESCED=1 ;;
    -h|--help)
      echo "usage: $0 [--quiesced]"
      echo "  default: install/build/sync + PM2 start + HTTP health"
      echo "  --quiesced: install/build/sync only; assert http/worker/ai-worker stopped; no PM2 mutation; no HTTP health"
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

if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi
: "${BETTER_AUTH_URL:?BETTER_AUTH_URL required before SPA build}"

export PATH="${HOME}/.local/share/pnpm:${HOME}/.nvm/versions/node/$(ls "${HOME}/.nvm/versions/node" 2>/dev/null | sort -V | tail -1)/bin:${PATH}"

echo "== pnpm install =="
pnpm install --frozen-lockfile

echo "== build server-pilot =="
pnpm --filter @zero/server build

echo "== build mail SPA =="
# Empty string = same-origin /api via nginx. Unset becomes literal "undefined" in the bundle.
export VITE_PUBLIC_BACKEND_URL="${VITE_PUBLIC_BACKEND_URL-}"
# Absolute app origin for RR redirects / metadata. Unset → literal "undefined/login" 404s.
export VITE_PUBLIC_APP_URL="${VITE_PUBLIC_APP_URL:-$BETTER_AUTH_URL}"
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
  echo "== quiesced: assert http, worker, ai-worker stopped =="
  for app in http worker ai-worker; do
    if command -v pm2 >/dev/null 2>&1 && pm2 describe "$app" >/dev/null 2>&1; then
      status="$(pm2 jlist 2>/dev/null | node -e "
        const apps=JSON.parse(require('fs').readFileSync(0,'utf8')||'[]');
        const hit=apps.find(a=>a.name===process.argv[1]);
        process.stdout.write(hit?.pm2_env?.status || '');
      " "$app")"
      # Absent process OK; any known non-stopped status (online/launching/errored/stopping/…) refuses.
      if [ -n "$status" ] && [ "$status" != "stopped" ]; then
        echo "quiesced deploy refused: ${app} status=${status} (must be stopped)" >&2
        exit 1
      fi
    fi
  done
  echo "quiesced: http/worker/ai-worker stopped"
  echo "quiesced deploy ok (assets synced; no PM2 mutation; no HTTP health)"
  exit 0
fi

echo "== pm2 =="
# Fixture prod: do not keep a broken POP3 worker in the dump after reboot.
TRANSPORT_MODE="${MAIL_TRANSPORT_MODE:-fixture}"
export NAVA_BUILD_COMMIT="${NAVA_BUILD_COMMIT:-$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || true)}"

# Always keep HMS off on generic deploy — ops-hms-shadow.sh start is sole HMS starter.
# Invalidate canary/shadow proofs on build identity change.
pm2 delete hms-ai-worker 2>/dev/null || true
rm -f /opt/nava/shared/hms-reservation-canary-proof.v1.json \
  /opt/nava/shared/hms-reservation-shadow-proof.v1.json 2>/dev/null || true

if [ "$TRANSPORT_MODE" = "fixture" ]; then
  echo "== pm2: fixture mode — delete worker if present =="
  pm2 delete worker 2>/dev/null || true
fi

if command -v pm2 >/dev/null 2>&1; then
  if [ "$TRANSPORT_MODE" = "fixture" ]; then
    pm2 delete worker 2>/dev/null || true
    # delete+start so --update-env actually replaces process env (reload keeps stale).
    # Never start hms-ai-worker here.
    pm2 delete http ai-worker hms-ai-worker 2>/dev/null || true
    pm2 start "${SERVER_PILOT}/deploy/pm2.config.cjs" --only http --update-env
    pm2 start "${SERVER_PILOT}/deploy/pm2.config.cjs" --only ai-worker --update-env
  else
    pm2 delete http worker ai-worker hms-ai-worker 2>/dev/null || true
    pm2 start "${SERVER_PILOT}/deploy/pm2.config.cjs" --only http --update-env
    pm2 start "${SERVER_PILOT}/deploy/pm2.config.cjs" --only worker --update-env
    pm2 start "${SERVER_PILOT}/deploy/pm2.config.cjs" --only ai-worker --update-env
  fi
  pm2 save
  bash "${SERVER_PILOT}/deploy/pm2-startup.sh"
  pm2 status
else
  echo "pm2 not installed; installing globally"
  npm install -g pm2
  if [ "$TRANSPORT_MODE" = "fixture" ]; then
    pm2 delete worker 2>/dev/null || true
    pm2 delete http ai-worker hms-ai-worker 2>/dev/null || true
    pm2 start "${SERVER_PILOT}/deploy/pm2.config.cjs" --only http --update-env
    pm2 start "${SERVER_PILOT}/deploy/pm2.config.cjs" --only ai-worker --update-env
  else
    pm2 delete http worker ai-worker hms-ai-worker 2>/dev/null || true
    pm2 start "${SERVER_PILOT}/deploy/pm2.config.cjs" --only http --update-env
    pm2 start "${SERVER_PILOT}/deploy/pm2.config.cjs" --only worker --update-env
    pm2 start "${SERVER_PILOT}/deploy/pm2.config.cjs" --only ai-worker --update-env
  fi
  pm2 save
  bash "${SERVER_PILOT}/deploy/pm2-startup.sh"
  pm2 status
fi

echo "== health =="
HEALTH_URL="http://127.0.0.1:8788/health"
for attempt in $(seq 1 10); do
  if curl -fsS "$HEALTH_URL"; then
    echo
    echo "deploy ok"
    exit 0
  fi
  echo "health attempt ${attempt}/10 failed; retry in ${attempt}s"
  sleep "$attempt"
done
echo "health check failed after retries; pm2 logs http --lines 20"
pm2 logs http --lines 20 --nostream || true
exit 1
