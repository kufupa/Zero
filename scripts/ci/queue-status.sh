#!/usr/bin/env bash
set -Eeuo pipefail

if (($# > 1)); then
  printf 'Usage: queue-status.sh [worktree]\n' >&2
  exit 2
fi

script_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)
worktree=$(git -C "${1:-$script_root}" rev-parse --show-toplevel 2>/dev/null) || {
  printf 'queue-status: not a git worktree: %s\n' "${1:-$script_root}" >&2
  exit 2
}
common_dir=$(git -C "$worktree" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || {
  printf 'queue-status: could not resolve git common directory\n' >&2
  exit 2
}

queue_dir="$common_dir/local-ci/queue"
shopt -s nullglob
state_files=("$queue_dir"/*.state)
if ((${#state_files[@]} == 0)); then
  printf 'local-ci queue empty\n'
  exit 0
fi

for state_file in "${state_files[@]}"; do
  mapfile -d '' -t fields < "$state_file"
  if ((${#fields[@]} < 7)); then
    printf 'STALE state=%q reason=malformed\n' "$state_file"
    continue
  fi
  pid=${fields[0]}; phase=${fields[1]}; step=${fields[2]}; branch=${fields[3]}
  sha=${fields[4]}; path=${fields[5]}; started=${fields[6]}
  if [[ ! $pid =~ ^[0-9]+$ ]] || ! kill -0 "$pid" 2>/dev/null; then
    state=STALE
  elif [[ $phase == waiting-lock ]]; then
    state=WAITING
  else
    state=HOLDER
  fi
  printf '%s pid=%s phase=%q branch=%q sha=%.12s step=%q worktree=%q started=%q\n' \
    "$state" "$pid" "$phase" "$branch" "$sha" "$step" "$path" "$started"
done
