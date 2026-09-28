#!/usr/bin/env bash
# Poll Luna pidfile until all workers exit. Counts on stdout. No bodies.
set -euo pipefail
PASS="${1:?pass}"
BASE="/home/ubuntu/projects/zero/.worktrees/centurion-dashboard-tools"
OUT="$BASE/.private/centurion-corpus/centurion-tool-demand-20260919"
PIDS="$OUT/extracts/${PASS}.pids"
if [ ! -f "$PIDS" ]; then
  echo "{\"pass\":\"$PASS\",\"alive\":0,\"missingPids\":true}"
  exit 0
fi
alive=0
while read -r pid; do
  [ -z "$pid" ] && continue
  if kill -0 "$pid" 2>/dev/null; then
    alive=$((alive + 1))
  fi
done < "$PIDS"
echo "{\"pass\":\"$PASS\",\"alive\":$alive}"
exit 0
