#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "== vpn HARD (unit/route/STS) =="
bash "${SCRIPT_DIR}/vpn-health-assert.sh"

echo "== identity =="
hostname
whoami

echo "== routes =="
ip route

echo "== aws sts =="
aws sts get-caller-identity --region "${AWS_REGION:-af-south-1}" >/tmp/aws-sts.json
cat /tmp/aws-sts.json

echo "== rds =="
psql "$DATABASE_URL" -c "select 1;"

echo "== s3 =="
aws s3 ls "s3://$S3_BUCKET" --region "${AWS_REGION:-af-south-1}" >/dev/null

echo "== pop3/smtp =="
if [ -n "${POP3_HOST:-}" ] && [ -n "${POP3_PORT:-}" ]; then
  nc -vz "$POP3_HOST" "$POP3_PORT"
else
  echo "POP3_HOST/POP3_PORT unset; skipped because real mail connection is deferred"
fi

if [ -n "${SMTP_HOST:-}" ] && [ -n "${SMTP_PORT:-}" ]; then
  nc -vz "$SMTP_HOST" "$SMTP_PORT"
else
  echo "SMTP_HOST/SMTP_PORT unset; skipped because real mail connection is deferred"
fi
