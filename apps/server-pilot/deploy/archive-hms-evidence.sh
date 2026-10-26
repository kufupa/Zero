#!/usr/bin/env bash
# Suggested nightly EC2 cron (install separately):
# 15 2 * * * cd /home/ubuntu/repos/zero && /usr/bin/env bash apps/server-pilot/deploy/archive-hms-evidence.sh
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../../.." && pwd -P)"
EVIDENCE_ROOT="${EVIDENCE_ROOT:-${REPO_ROOT}/.private/playwright-quote}"
S3_PREFIX="s3://nava-zero-mail-845242190536-af-south-1/ops-dumps/hms-evidence/"
AWS_REGION="af-south-1"
RETENTION_SECONDS=$((14 * 24 * 60 * 60))
[[ -d "$EVIDENCE_ROOT" && ! -L "$EVIDENCE_ROOT" ]] || {
  echo "hms-evidence-archive: evidence root missing or unsafe" >&2
  exit 1
}
command -v aws >/dev/null 2>&1 || { echo "hms-evidence-archive: aws cli unavailable" >&2; exit 1; }

directories_file="$(mktemp "${TMPDIR:-/tmp}/nava-hms-evidence-dirs.XXXXXX")"
trap 'rm -f -- "$directories_file"' EXIT
find "$EVIDENCE_ROOT" -mindepth 1 -maxdepth 1 -type d -print0 >"$directories_file" || {
  echo "hms-evidence-archive: evidence directories could not be listed" >&2
  exit 1
}
mapfile -d '' -t directories <"$directories_file"
cutoff=$(( $(date +%s) - RETENTION_SECONDS ))
status=0
item=0
report() { printf 'hms-evidence-archive: item=%d %s\n' "$item" "$1"; }
for directory in "${directories[@]}"; do
  item=$((item + 1))
  mtime="$(stat -c '%Y' -- "$directory" 2>/dev/null)" || { report "status=stat_failed"; status=1; continue; }
  if ((mtime >= cutoff)); then report "status=recent"; continue; fi
  files="$(find "$directory" -type f -printf x 2>/dev/null | wc -c)" ||
    { report "status=count_failed"; status=1; continue; }
  files="${files//[!0-9]/}"
  destination="${S3_PREFIX}${directory##*/}/"
  if ! aws --region "$AWS_REGION" s3 sync "$directory" "$destination" \
    --storage-class STANDARD_IA --no-follow-symlinks >/dev/null 2>&1; then
    report "files=$files status=sync_failed"; status=1; continue
  fi
  listing="$(aws --region "$AWS_REGION" s3 ls "$destination" --recursive 2>/dev/null)" ||
    { report "files=$files status=list_failed"; status=1; continue; }
  objects="$(printf '%s\n' "$listing" | awk 'NF { n++ } END { print n + 0 }')"
  if [[ "$files" != "$objects" ]]; then
    report "files=$files s3_objects=$objects status=count_mismatch"; status=1; continue
  fi
  if rm -rf -- "$directory"; then report "files=$files status=archived"
  else report "files=$files status=delete_failed"; status=1
  fi
done
trap - EXIT
rm -f -- "$directories_file"
exit "$status"
