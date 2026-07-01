#!/usr/bin/env bash
set -euo pipefail

: "${AWS_REGION:=af-south-1}"
: "${INSTANCE_ID:=i-008f737974a9ba9b3}"

if [ "$#" -eq 0 ]; then
  echo "usage: $0 'hostname && whoami'" >&2
  exit 2
fi

COMMAND_ID="$(
  aws ssm send-command \
    --region "$AWS_REGION" \
    --instance-ids "$INSTANCE_ID" \
    --document-name AWS-RunShellScript \
    --timeout-seconds "${SSM_TIMEOUT_SECONDS:-900}" \
    --comment "nava zero command" \
    --parameters "$(node -e 'console.log(JSON.stringify({commands:[`sudo -u ubuntu bash -lc ${JSON.stringify(process.argv[1])}`]}))' "$1")" \
    --query 'Command.CommandId' \
    --output text
)"

aws ssm get-command-invocation \
  --region "$AWS_REGION" \
  --command-id "$COMMAND_ID" \
  --instance-id "$INSTANCE_ID" \
  --query '{Status:Status,Stdout:StandardOutputContent,Stderr:StandardErrorContent}' \
  --output json
