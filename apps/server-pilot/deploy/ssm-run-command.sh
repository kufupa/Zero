#!/usr/bin/env bash
set -euo pipefail

: "${AWS_REGION:=af-south-1}"
: "${INSTANCE_ID:=i-008f737974a9ba9b3}"
: "${SSM_POLL_INTERVAL_SECONDS:=2}"

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
    --parameters "$(node -e 'const b64=Buffer.from(process.argv[1]).toString("base64"); console.log(JSON.stringify({commands:[`sudo -u ubuntu bash -lc "echo ${b64} | base64 -d | bash -s"`]}))' "$1")" \
    --query 'Command.CommandId' \
    --output text
)"

while true; do
  INVOCATION="$(
    aws ssm get-command-invocation \
      --region "$AWS_REGION" \
      --command-id "$COMMAND_ID" \
      --instance-id "$INSTANCE_ID" \
      --query '{Status:Status,Stdout:StandardOutputContent,Stderr:StandardErrorContent}' \
      --output json 2>/dev/null || true
  )"

  STATUS="$(printf '%s' "$INVOCATION" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{try{console.log(JSON.parse(s).Status||"")}catch{console.log("")}})')"

  case "$STATUS" in
    Pending|InProgress|Delayed)
      sleep "$SSM_POLL_INTERVAL_SECONDS"
      ;;
    Success|Failed|Cancelled|TimedOut|Cancelling)
      printf '%s\n' "$INVOCATION"
      case "$STATUS" in
        Success) exit 0 ;;
        *) exit 1 ;;
      esac
      ;;
    "")
      sleep "$SSM_POLL_INTERVAL_SECONDS"
      ;;
    *)
      printf '%s\n' "$INVOCATION"
      exit 1
      ;;
  esac
done
