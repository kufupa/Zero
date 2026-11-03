#!/usr/bin/env bash
# Put the restart boundary first: SSM may truncate the remainder of build output.
set -uo pipefail

deploy_log="$(mktemp "${TMPDIR:-/tmp}/nava-deploy-output.XXXXXX")" || exit 1
error_log="$(mktemp "${TMPDIR:-/tmp}/nava-deploy-error.XXXXXX")" || { rm -f "$deploy_log"; exit 1; }
trap 'rm -f "$deploy_log" "$error_log"' EXIT

args=()
if bash apps/server-pilot/deploy/deploy-ec2.sh --skip-install --help >/dev/null 2>&1; then
  args+=(--skip-install)
fi
if bash apps/server-pilot/deploy/deploy-ec2.sh "${args[@]}" >"$deploy_log" 2>"$error_log"; then
  status=0
else
  status=$?
fi
awk '/^NAVA_PM2_RESTART_STARTED_AT=/ { line=$0 } END { if (line != "") print line }' "$deploy_log"
cat "$deploy_log"
if [ "$status" -ne 0 ]; then
  # SSM exposes only the beginning of stderr; put both useful tails there.
  printf '%s\n' 'deploy stderr tail:' >&2
  tail -c 3500 "$error_log" >&2
  printf '\n%s\n' 'deploy stdout tail:' >&2
  tail -c 3500 "$deploy_log" >&2
else
  cat "$error_log" >&2
fi
exit "$status"
