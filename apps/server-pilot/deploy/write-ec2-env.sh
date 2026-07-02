#!/usr/bin/env bash
# Write /home/ubuntu/repos/zero/apps/server-pilot/.env.production on EC2.
# Run as root (sudo) so install -o ubuntu works. Pulls DATABASE_URL from
# Secrets Manager via the EC2 instance profile; S3_BUCKET and BETTER_AUTH_SECRET
# must be passed in via env. File is owned by ubuntu, mode 600, untracked.
set -euo pipefail

: "${AWS_REGION:=af-south-1}"
: "${DB_SECRET_NAME:=nava-zero/server-pilot/database-url}"
: "${S3_BUCKET:?S3_BUCKET required}"
: "${BETTER_AUTH_URL:=http://127.0.0.1:8788}"
: "${BETTER_AUTH_SECRET:?BETTER_AUTH_SECRET required}"
: "${POP3_POLL_INTERVAL_MS:=30000}"
: "${POP3_MAX_MESSAGES_PER_CYCLE:=500}"

DATABASE_URL="$(
  aws secretsmanager get-secret-value \
    --region "$AWS_REGION" \
    --secret-id "$DB_SECRET_NAME" \
    --query SecretString \
    --output text \
    | node -e 'let data=""; process.stdin.on("data", c => data += c); process.stdin.on("end", () => process.stdout.write(JSON.parse(data).DATABASE_URL));'
)"

ENV_PATH="/home/ubuntu/repos/zero/apps/server-pilot/.env.production"
install -o ubuntu -g ubuntu -m 600 /dev/null "$ENV_PATH"

cat > "$ENV_PATH" <<EOF
NODE_ENV=production
PORT=8788
DATABASE_URL=${DATABASE_URL}
BETTER_AUTH_URL=${BETTER_AUTH_URL}
BETTER_AUTH_SECRET=${BETTER_AUTH_SECRET}
AWS_REGION=${AWS_REGION}
S3_BUCKET=${S3_BUCKET}
POP3_POLL_INTERVAL_MS=${POP3_POLL_INTERVAL_MS}
POP3_MAX_MESSAGES_PER_CYCLE=${POP3_MAX_MESSAGES_PER_CYCLE}
PILOT_OPEN_SIGNUP=0
EOF

chown ubuntu:ubuntu "$ENV_PATH"
chmod 600 "$ENV_PATH"
echo "Wrote $ENV_PATH owned by ubuntu with mode 600"
