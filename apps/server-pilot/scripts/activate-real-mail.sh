#!/usr/bin/env bash
# Activate real hotel mail on EC2 pilot:
#   POP3 → Zimbra 172.24.0.10 (AUTH required)
#   SMTP → Rocketseed 172.24.0.8:587 STARTTLS (IP-trust, never AUTH)
# Parameterized — pass POP3 secret via env; never pass passwords on CLI.
set -euo pipefail

REPO_ROOT="${REPO_ROOT:-/home/ubuntu/repos/zero}"
SERVER_PILOT="${REPO_ROOT}/apps/server-pilot"
AWS_REGION="${AWS_REGION:-af-south-1}"
ROCKETSEED_SMTP_HOST="172.24.0.8"

: "${POP3_HOST:=172.24.0.10}"
: "${SMTP_HOST:=172.24.0.8}"
: "${POP3_USER:=navaai@legacyhotels.co.za}"
: "${SMTP_USER:=navaai@legacyhotels.co.za}"

if [[ -z "${POP3_SECRET_ARN:-}" && -z "${POP3_PASSWORD:-}" ]]; then
  echo "POP3_SECRET_ARN or POP3_PASSWORD required" >&2
  exit 1
fi

export AWS_REGION
export MAIL_TRANSPORT_MODE=real

echo "== activate-real-mail: validating connectivity =="
cd "$SERVER_PILOT"

# Staged values must survive sourcing an empty/stale .env.production (staged wins).
STAGED_POP3_PASSWORD="${POP3_PASSWORD:-}"
STAGED_SMTP_PASSWORD="${SMTP_PASSWORD:-}"
STAGED_SMTP_HOST="${SMTP_HOST:-}"
STAGED_POP3_HOST="${POP3_HOST:-}"

if [[ -f "${SERVER_PILOT}/.env.production" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "${SERVER_PILOT}/.env.production"
  set +a
fi

if [[ -n "${STAGED_POP3_PASSWORD}" ]]; then
  export POP3_PASSWORD="${STAGED_POP3_PASSWORD}"
fi
if [[ -n "${STAGED_SMTP_PASSWORD}" ]]; then
  export SMTP_PASSWORD="${STAGED_SMTP_PASSWORD}"
fi
if [[ -n "${STAGED_SMTP_HOST}" ]]; then
  export SMTP_HOST="${STAGED_SMTP_HOST}"
fi
if [[ -n "${STAGED_POP3_HOST}" ]]; then
  export POP3_HOST="${STAGED_POP3_HOST}"
fi

# Re-apply defaults after source (host/user may have been unset in .env).
: "${POP3_HOST:=172.24.0.10}"
: "${SMTP_HOST:=172.24.0.8}"
: "${POP3_USER:=navaai@legacyhotels.co.za}"
: "${SMTP_USER:=navaai@legacyhotels.co.za}"

if [[ "${SMTP_HOST}" != "${ROCKETSEED_SMTP_HOST}" ]]; then
  echo "SMTP_HOST must be 172.24.0.8 (Rocketseed); got ${SMTP_HOST}" >&2
  exit 1
fi

export POP3_HOST POP3_USER
export SMTP_HOST SMTP_USER
export POP3_SECRET_ARN="${POP3_SECRET_ARN:-}"
export SMTP_SECRET_ARN="${SMTP_SECRET_ARN:-}"

bash deploy/vpn-route-check.sh

probe_tcp() {
  local host="$1" port="$2"
  nc -z -w 3 "$host" "$port" >/dev/null 2>&1
}

echo "== POP3 port probe (995 then 110) =="
POP3_PORT=""
POP3_TLS=""
for candidate in 995 110; do
  if probe_tcp "$POP3_HOST" "$candidate"; then
    POP3_PORT="$candidate"
    if [[ "$candidate" == "995" ]]; then
      POP3_TLS=true
    else
      POP3_TLS=false
    fi
    echo "POP3 reachable on ${POP3_HOST}:${POP3_PORT} (POP3_TLS=${POP3_TLS})"
    break
  fi
done
if [[ -z "${POP3_PORT}" ]]; then
  echo "POP3 port probe failed (tried 995, 110 on ${POP3_HOST})" >&2
  exit 1
fi

echo "== SMTP port probe (Rocketseed 587 only) =="
SMTP_PORT=587
SMTP_SECURE=false
if ! probe_tcp "$SMTP_HOST" "$SMTP_PORT"; then
  echo "SMTP port probe failed (tried ${SMTP_PORT} on ${SMTP_HOST})" >&2
  exit 1
fi
echo "SMTP reachable on ${SMTP_HOST}:${SMTP_PORT} (SMTP_SECURE=${SMTP_SECURE})"

export POP3_PORT POP3_TLS
export SMTP_PORT SMTP_SECURE

# POP3 (Zimbra) may need loose TLS for expired hotel certs.
# Rocketseed SMTP smoke below forces rejectUnauthorized=true independently.
export MAIL_TLS_REJECT_UNAUTHORIZED="${MAIL_TLS_REJECT_UNAUTHORIZED:-false}"

echo "== build server-pilot (required for smoke + worker) =="
cd "$REPO_ROOT"
pnpm --filter @zero/server build

echo "== POP3 auth smoke (no password logged) =="
cd "$SERVER_PILOT"
POP3_AUTH_OK=0
# Prefer probed port; on TLS cert failure fall through 995→110.
for try_port in "${POP3_PORT}" 995 110; do
  case "$try_port" in
    995) try_tls=true ;;
    110) try_tls=false ;;
    *) try_tls="${POP3_TLS}" ;;
  esac
  export POP3_PORT="$try_port" POP3_TLS="$try_tls"
  if node --input-type=module -e "
import { createPop3Client } from './dist/mail/ingest/pop3-client.js';
const client = createPop3Client({
  MAIL_TRANSPORT_MODE: 'real',
  POP3_HOST: process.env.POP3_HOST,
  POP3_PORT: Number(process.env.POP3_PORT),
  POP3_USER: process.env.POP3_USER,
  POP3_PASSWORD: process.env.POP3_PASSWORD,
  POP3_SECRET_ARN: process.env.POP3_SECRET_ARN,
  POP3_TLS: process.env.POP3_TLS === 'true',
});
if (!client) throw new Error('createPop3Client returned null');
await client.connect();
await client.quit();
console.log('POP3 auth OK on ' + process.env.POP3_HOST + ':' + process.env.POP3_PORT + ' (POP3_TLS=' + process.env.POP3_TLS + ')');
"; then
    POP3_AUTH_OK=1
    break
  fi
  echo "POP3 auth failed on :${try_port}; trying next candidate..." >&2
done
if [[ "$POP3_AUTH_OK" -ne 1 ]]; then
  echo "POP3 auth smoke failed on all candidates" >&2
  exit 1
fi

echo "== SMTP STARTTLS smoke (Rocketseed IP-trust, no AUTH) =="
node --input-type=module -e "
import nodemailer from 'nodemailer';
const host = process.env.SMTP_HOST;
if (host !== '172.24.0.8') {
  throw new Error('SMTP_HOST must be 172.24.0.8 for Rocketseed smoke');
}
const transporter = nodemailer.createTransport({
  host,
  port: Number(process.env.SMTP_PORT),
  secure: false,
  requireTLS: true,
  auth: undefined,
  tls: {
    rejectUnauthorized: true,
    servername: 'branding.legacyhotels.co.za',
  },
});
await transporter.verify();
console.log('SMTP STARTTLS OK');
"

export AI_DRAFTS_ENABLED=false
export AI_WRITE_GATE_ENABLED=true

echo "== writing .env.production with MAIL_TRANSPORT_MODE=real =="
WRITE_ENV="${SERVER_PILOT}/deploy/write-ec2-env.sh"
if [[ "$(id -u)" -eq 0 ]]; then
  bash "$WRITE_ENV"
else
  sudo -E bash "$WRITE_ENV"
fi

echo "== redeploy =="
bash deploy/deploy-ec2.sh

echo "== one real ingest cycle (max 1 message) =="
cd "$SERVER_PILOT"
set -a
# shellcheck disable=SC1091
source .env.production
set +a
export WORKER_ONE_SHOT=1
export WORKER_MAX_MESSAGES=1
node dist/mail/ingest/worker.js

echo "== activate-real-mail complete =="
echo "MAIL_TRANSPORT_MODE=real SMTP=${SMTP_HOST}:${SMTP_PORT} (Rocketseed) POP3=${POP3_HOST} — verify pm2 logs and navaai-real-mail-smoke.md"
