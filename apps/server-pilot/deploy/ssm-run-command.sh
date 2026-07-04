#!/usr/bin/env bash
set -euo pipefail

: "${AWS_REGION:=af-south-1}"
: "${INSTANCE_ID:=i-008f737974a9ba9b3}"
: "${SSM_POLL_INTERVAL_SECONDS:=2}"
: "${SSM_MAX_POLL_SECONDS:=1800}"
: "${SSM_MAX_EMPTY_POLLS:=120}"

print_invocation() {
  node "${SCRIPT_DIR}/ssm-format-invocation.cjs" "$COMMAND_ID"
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

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

START_EPOCH="$(date +%s)"
EMPTY_POLLS=0

while true; do
  NOW_EPOCH="$(date +%s)"
  ELAPSED="$((NOW_EPOCH - START_EPOCH))"
  if [ "$ELAPSED" -ge "$SSM_MAX_POLL_SECONDS" ]; then
    echo "ssm poll exceeded ${SSM_MAX_POLL_SECONDS}s (command ${COMMAND_ID})" >&2
    exit 1
  fi

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
      EMPTY_POLLS=0
      sleep "$SSM_POLL_INTERVAL_SECONDS"
      ;;
    Success|Failed|Cancelled|TimedOut|Cancelling)
      print_invocation
      case "$STATUS" in
        Success) exit 0 ;;
        *) exit 1 ;;
      esac
      ;;
    "")
      EMPTY_POLLS="$((EMPTY_POLLS + 1))"
      if [ "$EMPTY_POLLS" -ge "$SSM_MAX_EMPTY_POLLS" ]; then
        # Invocation may exist before Status is populated; one more read before abort.
        RETRY_STATUS="$(
          aws ssm get-command-invocation \
            --region "$AWS_REGION" \
            --command-id "$COMMAND_ID" \
            --instance-id "$INSTANCE_ID" \
            --query 'Status' \
            --output text 2>/dev/null || true
        )"
        case "$RETRY_STATUS" in
          Pending|InProgress|Delayed)
            EMPTY_POLLS=0
            sleep "$SSM_POLL_INTERVAL_SECONDS"
            continue
            ;;
          Success|Failed|Cancelled|TimedOut|Cancelling)
            INVOCATION="$(
              aws ssm get-command-invocation \
                --region "$AWS_REGION" \
                --command-id "$COMMAND_ID" \
                --instance-id "$INSTANCE_ID" \
                --query '{Status:Status,Stdout:StandardOutputContent,Stderr:StandardErrorContent}' \
                --output json 2>/dev/null || true
            )"
            print_invocation
            case "$RETRY_STATUS" in
              Success) exit 0 ;;
              *) exit 1 ;;
            esac
            ;;
          *)
            echo "ssm poll got ${SSM_MAX_EMPTY_POLLS} empty statuses (command ${COMMAND_ID})" >&2
            exit 1
            ;;
        esac
      fi
      sleep "$SSM_POLL_INTERVAL_SECONDS"
      ;;
    *)
      print_invocation
      exit 1
      ;;
  esac
done
