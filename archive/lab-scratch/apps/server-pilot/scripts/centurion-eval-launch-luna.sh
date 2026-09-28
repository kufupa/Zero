#!/usr/bin/env bash
# Launch ≤7 gpt-6-luna Codex workers for a named eval pass. No bodies on stdout.
# Unlimited sequential waves — call again after this wave exits. Never >7 live.
set -euo pipefail
PASS="${1:?pass name e.g. pass3}"
PROMPT_FILE="${2:?prompt txt}"
SHARDS="${3:-7}"
if [ "$SHARDS" -gt 7 ]; then
  echo "refusing SHARDS=$SHARDS; max 7 parallel" >&2
  exit 1
fi
BASE="/home/ubuntu/projects/zero/.worktrees/centurion-dashboard-tools"
OUT="$BASE/.private/centurion-corpus/centurion-tool-demand-20260919"
PROMPT="$(cat "$PROMPT_FILE")"
mkdir -p "$OUT/extracts"
cd "$BASE"
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS || true
: > "$OUT/extracts/${PASS}.pids"
for i in $(seq 0 $((SHARDS - 1))); do
  shard="$OUT/shards/${PASS}-${i}-bodies.jsonl"
  dest="$OUT/extracts/${PASS}-${i}.jsonl"
  if [ ! -s "$shard" ]; then
    echo "skip empty pass=$PASS shard=$i"
    continue
  fi
  p="${PROMPT/REPLACE_SHARD/$shard}"
  p="${p/REPLACE_OUT/$dest}"
  log="$OUT/extracts/${PASS}-${i}.codex.log"
  nohup env -u DATABASE_URL -u VITEST_ALLOW_PILOT_RDS \
    codex exec --dangerously-bypass-approvals-and-sandbox \
      -m gpt-6-luna \
      -c model_reasoning_effort="max" \
      -C "$BASE" \
      --skip-git-repo-check \
      "$p" >"$log" 2>&1 &
  echo $! >> "$OUT/extracts/${PASS}.pids"
  echo "started pass=$PASS shard=$i pid=$!"
done
