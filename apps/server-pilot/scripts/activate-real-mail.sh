#!/usr/bin/env bash
# Activate real Exchange/Zimbra POP3/SMTP on EC2 pilot.
# Parameterized — pass host/user/secret ARNs via env; never pass passwords on CLI.
set -euo pipefail

REPO_ROOT="${REPO_ROOT:-/home/ubuntu/repos/zero}"
SERVER_PILOT="${REPO_ROOT}/apps/server-pilot"
AWS_REGION="${AWS_REGION:-af-south-1}"

: "${POP3_HOST:=172.24.0.10}"
: "${SMTP_HOST:=172.24.0.10}"
: "${POP3_USER:=navaai@legacyhotels.co.za}"
: "${SMTP_USER:=navaai@legacyhotels.co.za}"

if [[ -z "${POP3_SECRET_ARN:-}" && -z "${POP3_PASSWORD:-}" ]]; then
  echo "POP3_SECRET_ARN or POP3_PASSWORD required" >&2
  exit 1
fi
if [[ -z "${SMTP_SECRET_ARN:-}" && -z "${SMTP_PASSWORD:-}" ]]; then
  echo "SMTP_SECRET_ARN or SMTP_PASSWORD required" >&2
  exit 1
fi

export AWS_REGION
export MAIL_TRANSPORT_MODE=real

echo "== activate-real-mail: validating connectivity =="
cd "$SERVER_PILOT"

# Staged secrets must survive sourcing an empty/stale .env.production (staged wins).
STAGED_POP3_PASSWORD="${POP3_PASSWORD:-}"
STAGED_SMTP_PASSWORD="${SMTP_PASSWORD:-}"

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

# Re-apply defaults after source (host/user may have been unset in .env).
: "${POP3_HOST:=172.24.0.10}"
: "${SMTP_HOST:=172.24.0.10}"
: "${POP3_USER:=navaai@legacyhotels.co.za}"
: "${SMTP_USER:=navaai@legacyhotels.co.za}"

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

echo "== SMTP port probe (587 then 25) =="
SMTP_PORT=""
SMTP_SECURE=""
for candidate in 587 25; do
  if probe_tcp "$SMTP_HOST" "$candidate"; then
    SMTP_PORT="$candidate"
    # 587 = STARTTLS submission; 25 = clear/relay — neither is implicit TLS (465).
    SMTP_SECURE=false
    echo "SMTP reachable on ${SMTP_HOST}:${SMTP_PORT} (SMTP_SECURE=${SMTP_SECURE})"
    break
  fi
done
if [[ -z "${SMTP_PORT}" ]]; then
  echo "SMTP port probe failed (tried 587, 25 on ${SMTP_HOST})" >&2
  exit 1
fi

export POP3_PORT POP3_TLS
export SMTP_PORT SMTP_SECURE

# Hotel Zimbra over VPN often has expired TLS certs (CERT_HAS_EXPIRED / ESOCKET).
# Pilot default: accept for private hotel path; override with MAIL_TLS_REJECT_UNAUTHORIZED=true.
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

echo "== SMTP auth smoke =="
node --input-type=module -e "
import nodemailer from 'nodemailer';
const port = Number(process.env.SMTP_PORT);
const user = process.env.SMTP_USER;
let pass = process.env.SMTP_PASSWORD;
if (!pass && process.env.SMTP_SECRET_ARN) {
  const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
  const client = new SecretsManagerClient({ region: process.env.AWS_REGION ?? 'af-south-1' });
  const out = await client.send(new GetSecretValueCommand({ SecretId: process.env.SMTP_SECRET_ARN }));
  const raw = out.SecretString ?? '';
  try {
    const parsed = JSON.parse(raw);
    pass = parsed.SMTP_PASSWORD ?? parsed.password ?? raw;
  } catch {
    pass = raw;
  }
}
if (!user || !pass) throw new Error('SMTP_USER and SMTP_PASSWORD (or SMTP_SECRET_ARN) required for auth smoke');
const rejectUnauthorized = process.env.MAIL_TLS_REJECT_UNAUTHORIZED !== 'false';
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port,
  secure: process.env.SMTP_SECURE === 'true',
  auth: { user, pass },
  tls: { rejectUnauthorized },
});
await transporter.verify();
console.log('SMTP auth OK');
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
echo "MAIL_TRANSPORT_MODE=real — verify pm2 logs and exchange-smoke.md"
