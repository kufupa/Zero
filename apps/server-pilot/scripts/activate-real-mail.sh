#!/usr/bin/env bash
# Activate real Exchange POP3/SMTP on EC2 pilot.
# Parameterized — pass host/user/secret ARNs via env; never pass passwords on CLI.
set -euo pipefail

REPO_ROOT="${REPO_ROOT:-/home/ubuntu/repos/zero}"
SERVER_PILOT="${REPO_ROOT}/apps/server-pilot"
AWS_REGION="${AWS_REGION:-af-south-1}"

: "${POP3_HOST:?POP3_HOST required}"
: "${POP3_PORT:?POP3_PORT required}"
: "${POP3_USER:?POP3_USER required}"
: "${SMTP_HOST:?SMTP_HOST required}"
: "${SMTP_PORT:?SMTP_PORT required}"

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
export POP3_TLS="${POP3_TLS:-true}"
export SMTP_SECURE="${SMTP_SECURE:-false}"

echo "== activate-real-mail: validating connectivity =="
cd "$SERVER_PILOT"

if [[ -f "${SERVER_PILOT}/.env.production" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "${SERVER_PILOT}/.env.production"
  set +a
fi

export POP3_HOST POP3_PORT POP3_USER POP3_TLS
export SMTP_HOST SMTP_PORT SMTP_USER SMTP_SECURE
export POP3_SECRET_ARN="${POP3_SECRET_ARN:-}"
export SMTP_SECRET_ARN="${SMTP_SECRET_ARN:-}"

bash deploy/vpn-route-check.sh

echo "== POP3 port reachability =="
nc -vz "$POP3_HOST" "$POP3_PORT"

echo "== SMTP port reachability =="
nc -vz "$SMTP_HOST" "$SMTP_PORT"

echo "== build server-pilot (required for smoke + worker) =="
cd "$REPO_ROOT"
pnpm --filter @zero/server build

echo "== POP3 auth smoke (no password logged) =="
cd "$SERVER_PILOT"
node --input-type=module -e "
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
console.log('POP3 auth OK');
"

echo "== SMTP EHLO smoke =="
node --input-type=module -e "
import nodemailer from 'nodemailer';
const port = Number(process.env.SMTP_PORT);
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port,
  secure: process.env.SMTP_SECURE === 'true',
});
await transporter.verify();
console.log('SMTP EHLO OK');
"

echo "== writing .env.production with MAIL_TRANSPORT_MODE=real =="
if [[ "$(id -u)" -eq 0 ]]; then
  deploy/write-ec2-env.sh
else
  sudo -E deploy/write-ec2-env.sh
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
