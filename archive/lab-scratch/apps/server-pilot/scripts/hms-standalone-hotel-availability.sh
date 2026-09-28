#!/usr/bin/env bash
set -euo pipefail

# One native OS lock for one authenticated PMS owner. Keep this wrapper on the
# private EC2 staging path; never run it from the deployed mail app.
if [[ "${HMS_HOTEL_AVAILABILITY_ALLOW_LIVE:-}" != "1" ]]; then
  echo 'refused: set HMS_HOTEL_AVAILABILITY_ALLOW_LIVE=1' >&2
  exit 1
fi
lock_path="${HMS_LIVE_OPERATION_LOCK_PATH:-/opt/nava/shared/hms-runtime/.hms-live-operation.v2.lock}"
mkdir -p "$(dirname "$lock_path")"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
workspace_root="$(cd "$script_dir/../../.." && pwd)"

# Resolve the runner from this wrapper, not from the caller's current working
# directory.  SSM/cron invokes this wrapper from several staging directories;
# the old relative path silently selected a nonexistent script there.
exec flock -n "$lock_path" bash -lc 'cd "$1" && pnpm --filter=@zero/server exec tsx "$2"' \
  -- "$workspace_root" "$script_dir/hms-standalone-hotel-availability.ts"
