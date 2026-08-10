#!/usr/bin/env bash
# Post-boot / post-deploy health: nginx, both loopback HTTP processes, :443.
set -euo pipefail

LOG="${NAVA_POST_BOOT_SMOKE_LOG:-/var/log/nava-post-boot-smoke.log}"
MAX_ATTEMPTS="${SMOKE_MAX_ATTEMPTS:-3}"
SLEEP_SECS="${SMOKE_SLEEP_SECS:-5}"

log() {
  local line="[$(date -Is)] $*"
  echo "$line"
  if touch "$LOG" 2>/dev/null || sudo touch "$LOG" 2>/dev/null; then
    if [ -w "$LOG" ]; then
      echo "$line" >>"$LOG"
    else
      echo "$line" | sudo tee -a "$LOG" >/dev/null || true
    fi
  fi
}

fail() {
  log "FAIL: $*"
  exit 1
}

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
export PATH="${HOME}/.local/share/pnpm:${HOME}/.nvm/versions/node/$(ls "${HOME}/.nvm/versions/node" 2>/dev/null | sort -V | tail -1)/bin:${PATH}"

ENV_FILE="${ENV_FILE:-/home/ubuntu/repos/zero/apps/server-pilot/.env.production}"
if [ -r "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi
CANONICAL_ORIGIN="https://nava.legacyhotels.co.za"
: "${BETTER_AUTH_URL:?BETTER_AUTH_URL missing from production environment}"
case "$BETTER_AUTH_URL" in
  "$CANONICAL_ORIGIN"|"$CANONICAL_ORIGIN/")
    ;;
  *)
    echo "refusing: BETTER_AUTH_URL must be canonical HTTPS origin" >&2
    exit 2
    ;;
esac
BETTER_AUTH_URL="$CANONICAL_ORIGIN"
PUBLIC_HOST="${CANONICAL_ORIGIN#https://}"
REMOTE_ORIGIN="https://nava-admin.trynava.io"

attempt=1
while [ "$attempt" -le "$MAX_ATTEMPTS" ]; do
  ok=1

  if ! systemctl is-active --quiet nginx; then
    log "attempt ${attempt}: nginx not active"
    ok=0
  fi

  if ! curl --disable --noproxy '*' -fsS \
    "http://127.0.0.1:8788/health" >/dev/null; then
    log "attempt ${attempt}: :8788/health failed"
    ok=0
  fi

  if ! curl --disable --noproxy '*' -fsS \
    "http://127.0.0.1:8789/health" >/dev/null; then
    log "attempt ${attempt}: :8789/health failed"
    ok=0
  fi

  # Prefer /health on each TLS vhost; fall back to its SPA root.
  for spa_origin in "$BETTER_AUTH_URL" "$REMOTE_ORIGIN"; do
    spa_host="${spa_origin#https://}"
    if ! curl --disable --noproxy '*' -fsS \
      --resolve "${spa_host}:443:127.0.0.1" \
      "${spa_origin%/}/health" >/dev/null 2>&1 \
      && ! curl --disable --noproxy '*' -fsS \
      --resolve "${spa_host}:443:127.0.0.1" \
      "${spa_origin%/}/" >/dev/null 2>&1; then
      log "attempt ${attempt}: trusted TLS vhost probe failed for ${spa_origin}"
      ok=0
    fi
  done

  if command -v pm2 >/dev/null 2>&1; then
    for process_name in http remote-http; do
      if ! pm2 jlist 2>/dev/null | grep -q "\"name\":\"${process_name}\""; then
        log "attempt ${attempt}: pm2 ${process_name} missing"
        ok=0
      elif ! pm2 jlist 2>/dev/null | PM2_PROCESS_NAME="$process_name" node -e '
      let s=""; process.stdin.on("data",d=>s+=d); process.stdin.on("end",()=>{
        try {
          const apps=JSON.parse(s);
          const name=process.env.PM2_PROCESS_NAME;
          const app=apps.find(a=>a.name===name);
          if (!app || app.pm2_env?.status!=="online") process.exit(1);
        } catch { process.exit(1); }
      });
    '; then
        log "attempt ${attempt}: pm2 ${process_name} not online"
        ok=0
      fi
    done
    # Conditional HMS check: hms-ai-worker must stay off after boot.
    # Sole starter = ops-hms-shadow.sh. Stale proofs invalidated by pm2-boot.
    if pm2 jlist 2>/dev/null | grep -q '"name":"hms-ai-worker"'; then
      log "attempt ${attempt}: unexpected hms-ai-worker present (HMS_OFF required after boot)"
      ok=0
    fi
  else
    log "attempt ${attempt}: pm2 missing"
    ok=0
  fi

  # VPN HARD checks (hotel SOFT). Wait briefly for tun after boot race.
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  VPN_WAIT_SECS="${VPN_WAIT_SECS:-30}"
  vpn_ready=0
  for _i in $(seq 1 "$VPN_WAIT_SECS"); do
    if systemctl is-active --quiet openvpn-client@nava \
      && ip -4 route | grep -qE '172\.24\.0\.0/16'; then
      vpn_ready=1
      break
    fi
    sleep 1
  done
  if [ "$vpn_ready" -ne 1 ]; then
    log "attempt ${attempt}: VPN not ready after ${VPN_WAIT_SECS}s"
    ok=0
  elif ! bash "${SCRIPT_DIR}/vpn-health-assert.sh"; then
    log "attempt ${attempt}: vpn-health-assert HARD fail"
    ok=0
  fi

  if [ "$ok" -eq 1 ]; then
    log "PASS: nginx + :8788 + :8789 + :443 + pm2 HTTP processes online + VPN_HARD_OK"
    exit 0
  fi

  if [ "$attempt" -lt "$MAX_ATTEMPTS" ]; then
    sleep "$SLEEP_SECS"
  fi
  attempt=$((attempt + 1))
done

fail "smoke failed after ${MAX_ATTEMPTS} attempts"
