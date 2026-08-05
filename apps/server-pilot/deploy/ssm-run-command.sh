#!/usr/bin/env bash
set -euo pipefail

: "${AWS_REGION:=af-south-1}"
: "${INSTANCE_ID:=i-008f737974a9ba9b3}"
: "${SSM_POLL_INTERVAL_SECONDS:=2}"
: "${SSM_MAX_POLL_SECONDS:=1800}"
: "${SSM_MAX_EMPTY_POLLS:=120}"
: "${SSM_DELIVERY_TIMEOUT_SECONDS:=60}"
: "${SSM_EXECUTION_TIMEOUT_SECONDS:=900}"
: "${SSM_CANCEL_WAIT_SECONDS:=60}"

print_invocation() {
  node "${SCRIPT_DIR}/ssm-format-invocation.cjs" "$COMMAND_ID"
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ "$#" -ne 1 ]; then
  echo "usage: $0 'hostname && whoami'" >&2
  exit 2
fi

case "$SSM_DELIVERY_TIMEOUT_SECONDS:$SSM_EXECUTION_TIMEOUT_SECONDS:$SSM_CANCEL_WAIT_SECONDS" in
  *[!0-9:]*|:*|*::*|*:) echo "invalid SSM timeout configuration" >&2; exit 2 ;;
esac

COMMAND_ID=""
on_signal() {
  trap - HUP INT TERM
  if [ -n "$COMMAND_ID" ] && declare -F cancel_command_and_wait >/dev/null; then
    echo "ssm runner interrupted; cancelling command ${COMMAND_ID}" >&2
    cancel_command_and_wait ||
      echo "ssm cancellation did not reach terminal state (command ${COMMAND_ID})" >&2
  else
    echo "ssm runner interrupted before command id was available" >&2
  fi
  exit 70
}
trap on_signal HUP INT TERM

if ! COMMAND_ID="$(
  aws ssm send-command \
    --region "$AWS_REGION" \
    --instance-ids "$INSTANCE_ID" \
    --document-name AWS-RunShellScript \
    --timeout-seconds "$SSM_DELIVERY_TIMEOUT_SECONDS" \
    --comment "nava zero command" \
    --parameters "$(node -e 'const b64=Buffer.from(process.argv[1]).toString("base64"); const executionTimeout=process.argv[2]; console.log(JSON.stringify({commands:[`sudo -u ubuntu bash -lc "echo ${b64} | base64 -d | bash -s"`],executionTimeout:[executionTimeout]}))' "$1" "$SSM_EXECUTION_TIMEOUT_SECONDS")" \
    --query 'Command.CommandId' \
    --output text
)"; then
  echo "ssm command submission failed" >&2
  exit 70
fi
case "$COMMAND_ID" in
  ""|None) echo "ssm command submission returned no command id" >&2; exit 70 ;;
esac

poll_status() {
  aws ssm get-command-invocation \
    --region "$AWS_REGION" \
    --command-id "$COMMAND_ID" \
    --instance-id "$INSTANCE_ID" \
    --query 'Status' \
    --output text 2>/dev/null || true
}

cancel_command_and_wait() {
  local cancel_deadline status
  aws ssm cancel-command \
    --region "$AWS_REGION" \
    --command-id "$COMMAND_ID" >/dev/null 2>&1 || return 1
  cancel_deadline="$(($(date +%s) + SSM_CANCEL_WAIT_SECONDS))"
  while [ "$(date +%s)" -lt "$cancel_deadline" ]; do
    status="$(poll_status)"
    case "$status" in
      Success|Failed|Cancelled|TimedOut) return 0 ;;
      Pending|InProgress|Delayed|Cancelling|""|None)
        sleep "$SSM_POLL_INTERVAL_SECONDS"
        ;;
      *) return 1 ;;
    esac
  done
  return 1
}

START_EPOCH="$(date +%s)"
EMPTY_POLLS=0
export PYTHONUTF8=1
export PYTHONIOENCODING=utf-8

while true; do
  NOW_EPOCH="$(date +%s)"
  ELAPSED="$((NOW_EPOCH - START_EPOCH))"
  if [ "$ELAPSED" -ge "$SSM_MAX_POLL_SECONDS" ]; then
    echo "ssm poll exceeded ${SSM_MAX_POLL_SECONDS}s (command ${COMMAND_ID})" >&2
    cancel_command_and_wait ||
      echo "ssm cancellation did not reach terminal state (command ${COMMAND_ID})" >&2
    exit 70
  fi

  # Status-only poll: Windows AWS CLI charmap dies when Stdout has vitest unicode.
  STATUS="$(poll_status)"

  case "$STATUS" in
    Pending|InProgress|Delayed|Cancelling)
      EMPTY_POLLS=0
      sleep "$SSM_POLL_INTERVAL_SECONDS"
      ;;
    Success|Failed|Cancelled|TimedOut)
      if ! INVOCATION_JSON="$(print_invocation)"; then
        echo "ssm invocation formatting failed (command ${COMMAND_ID})" >&2
        exit 70
      fi
      echo "$INVOCATION_JSON"
      RESPONSE_CODE="$(
        node -e 'const j=JSON.parse(process.argv[1]); process.stdout.write(String(j.ResponseCode ?? ""))' "$INVOCATION_JSON"
      )"
      case "$STATUS" in
        Success)
          [ "$RESPONSE_CODE" = "0" ] && exit 0
          exit 70
          ;;
        TimedOut|Cancelled)
          exit 70
          ;;
        *)
          if [ -n "$RESPONSE_CODE" ] && [ "$RESPONSE_CODE" != "null" ]; then
            case "$RESPONSE_CODE" in
              3|10|20) exit "$RESPONSE_CODE" ;;
            esac
          fi
          exit 70
          ;;
      esac
      ;;
    ""|None)
      EMPTY_POLLS="$((EMPTY_POLLS + 1))"
      if [ "$EMPTY_POLLS" -ge "$SSM_MAX_EMPTY_POLLS" ]; then
        echo "ssm poll got ${SSM_MAX_EMPTY_POLLS} empty statuses (command ${COMMAND_ID})" >&2
        cancel_command_and_wait ||
          echo "ssm cancellation did not reach terminal state (command ${COMMAND_ID})" >&2
        exit 70
      fi
      sleep "$SSM_POLL_INTERVAL_SECONDS"
      ;;
    *)
      cancel_command_and_wait ||
        echo "ssm cancellation did not reach terminal state (command ${COMMAND_ID})" >&2
      exit 70
      ;;
  esac
done
