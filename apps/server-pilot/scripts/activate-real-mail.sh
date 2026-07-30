#!/usr/bin/env bash
# Activate real Exchange/Zimbra POP3/SMTP on EC2 pilot.
# Parameterized — pass host/user/secret ARNs via env; never pass passwords on CLI.
set -euo pipefail

REPO_ROOT="${REPO_ROOT:-/home/ubuntu/repos/zero}"
SERVER_PILOT="${REPO_ROOT}/apps/server-pilot"
AWS_REGION="${AWS_REGION:-af-south-1}"

# Non-empty caller values win over stale .env.production values.
STAGED_MAIL_KEYS=(
  POP3_HOST
  POP3_PORT
  POP3_TLS
  POP3_TLS_REJECT_UNAUTHORIZED
  POP3_USER
  POP3_SECRET_ARN
  POP3_PASSWORD
  SMTP_HOST
  SMTP_PORT
  SMTP_SECURE
  SMTP_REQUIRE_TLS
  SMTP_TLS_SERVERNAME
  SMTP_USER
  SMTP_SECRET_ARN
  SMTP_PASSWORD
)
declare -A STAGED_MAIL_ENV=()
for key in "${STAGED_MAIL_KEYS[@]}"; do
  value="${!key:-}"
  if [[ -n "$value" ]]; then
    STAGED_MAIL_ENV["$key"]="$value"
  fi
done

if [[ -f "${SERVER_PILOT}/.env.production" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "${SERVER_PILOT}/.env.production"
  set +a
fi

for key in "${STAGED_MAIL_KEYS[@]}"; do
  if [[ -n "${STAGED_MAIL_ENV[$key]+set}" ]]; then
    export "$key=${STAGED_MAIL_ENV[$key]}"
  fi
done

# POP3 retains hotel defaults and a POP3-only certificate exception.
: "${POP3_HOST:=172.24.0.10}"
: "${POP3_USER:=navaai@legacyhotels.co.za}"
: "${POP3_TLS_REJECT_UNAUTHORIZED:=false}"

# Rocketseed SMTP cutover values must be explicit. No direct-Zimbra fallback.
: "${SMTP_HOST:?SMTP_HOST required}"
: "${SMTP_PORT:?SMTP_PORT required}"
: "${SMTP_TLS_SERVERNAME:?SMTP_TLS_SERVERNAME required}"
: "${SMTP_USER:?SMTP_USER required}"
: "${SMTP_REQUIRE_TLS:?SMTP_REQUIRE_TLS=true required}"
if [[ "${SMTP_REQUIRE_TLS}" != "true" ]]; then
  echo "SMTP_REQUIRE_TLS must be true" >&2
  exit 1
fi
: "${SMTP_SECURE:=false}"
if [[ "${SMTP_SECURE}" != "false" ]]; then
  echo "SMTP_SECURE must be false for STARTTLS" >&2
  exit 1
fi

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
export POP3_HOST POP3_USER POP3_TLS_REJECT_UNAUTHORIZED
export SMTP_HOST SMTP_PORT SMTP_SECURE SMTP_REQUIRE_TLS SMTP_TLS_SERVERNAME SMTP_USER
export POP3_SECRET_ARN="${POP3_SECRET_ARN:-}"
export SMTP_SECRET_ARN="${SMTP_SECRET_ARN:-}"

echo "== activate-real-mail: validating connectivity =="
cd "$SERVER_PILOT"

bash deploy/vpn-route-check.sh

probe_tcp() {
  local host="$1" port="$2"
  nc -z -w 3 "$host" "$port" >/dev/null 2>&1
}

echo "== POP3 port probe (995 then 110) =="
if [[ -n "${POP3_PORT:-}" ]]; then
  if [[ -z "${POP3_TLS:-}" ]]; then
    if [[ "$POP3_PORT" == "995" ]]; then
      POP3_TLS=true
    else
      POP3_TLS=false
    fi
  fi
  if ! probe_tcp "$POP3_HOST" "$POP3_PORT"; then
    echo "POP3 port probe failed (${POP3_HOST}:${POP3_PORT})" >&2
    exit 1
  fi
else
  POP3_TLS=""
  for candidate in 995 110; do
    if probe_tcp "$POP3_HOST" "$candidate"; then
      POP3_PORT="$candidate"
      if [[ "$candidate" == "995" ]]; then
        POP3_TLS=true
      else
        POP3_TLS=false
      fi
      break
    fi
  done
  if [[ -z "${POP3_PORT:-}" ]]; then
    echo "POP3 port probe failed (tried 995, 110 on ${POP3_HOST})" >&2
    exit 1
  fi
fi
echo "POP3 reachable on ${POP3_HOST}:${POP3_PORT} (POP3_TLS=${POP3_TLS})"

echo "== SMTP port probe (${SMTP_PORT}) =="
if ! probe_tcp "$SMTP_HOST" "$SMTP_PORT"; then
  echo "SMTP port probe failed (${SMTP_HOST}:${SMTP_PORT})" >&2
  exit 1
fi
echo "SMTP reachable on ${SMTP_HOST}:${SMTP_PORT} (STARTTLS required)"

export POP3_PORT POP3_TLS

echo "== build server-pilot (required for smoke + worker) =="
cd "$REPO_ROOT"
pnpm --filter @zero/server build

echo "== POP3 auth smoke (no password logged) =="
cd "$SERVER_PILOT"
if ! node --input-type=module -e "
import { createPop3Client } from './dist/mail/ingest/pop3-client.js';
const client = createPop3Client({
  MAIL_TRANSPORT_MODE: 'real',
  POP3_HOST: process.env.POP3_HOST,
  POP3_PORT: Number(process.env.POP3_PORT),
  POP3_USER: process.env.POP3_USER,
  POP3_PASSWORD: process.env.POP3_PASSWORD,
  POP3_SECRET_ARN: process.env.POP3_SECRET_ARN,
  POP3_TLS: process.env.POP3_TLS === 'true',
  POP3_TLS_REJECT_UNAUTHORIZED: process.env.POP3_TLS_REJECT_UNAUTHORIZED !== 'false',
});
if (!client) throw new Error('createPop3Client returned null');
await client.connect();
await client.quit();
console.log('POP3 auth OK on ' + process.env.POP3_HOST + ':' + process.env.POP3_PORT + ' (POP3_TLS=' + process.env.POP3_TLS + ')');
"; then
  echo "POP3 auth smoke failed" >&2
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
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port,
  secure: false,
  requireTLS: true,
  connectionTimeout: 10_000,
  greetingTimeout: 10_000,
  socketTimeout: 60_000,
  auth: { user, pass },
  tls: {
    rejectUnauthorized: true,
    servername: process.env.SMTP_TLS_SERVERNAME,
  },
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
