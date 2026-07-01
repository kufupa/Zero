#!/usr/bin/env bash
# S3 smoke test: list mail bucket root. Run on EC2 as ubuntu.
# Usage: bash apps/server-pilot/deploy/s3-smoke.sh
set -euo pipefail

ENV_PATH="${ENV_PATH:-/home/ubuntu/repos/zero/apps/server-pilot/.env.production}"

if [ -z "${S3_BUCKET:-}" ] && [ -r "$ENV_PATH" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_PATH"
  set +a
fi

: "${S3_BUCKET:?S3_BUCKET required (set in env or .env.production)}"
: "${AWS_REGION:=af-south-1}"

echo "Listing s3://${S3_BUCKET}/ (region ${AWS_REGION})"
aws s3 ls "s3://${S3_BUCKET}" --region "$AWS_REGION"
echo "s3-smoke OK"
