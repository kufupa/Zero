#!/usr/bin/env bash
# Suggested nightly EC2 cron (install separately):
# 15 2 * * * cd /home/ubuntu/repos/zero && /usr/bin/env bash apps/server-pilot/deploy/archive-hms-evidence.sh
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../../.." && pwd -P)"
EVIDENCE_ROOT="${EVIDENCE_ROOT:-${REPO_ROOT}/.private/playwright-quote}"
S3_PREFIX="s3://nava-zero-mail-845242190536-af-south-1/ops-dumps/hms-evidence/"
AWS_REGION="af-south-1"
[[ -d "$EVIDENCE_ROOT" && ! -L "$EVIDENCE_ROOT" ]] || {
  echo "hms-evidence-archive: evidence root missing or unsafe" >&2
  exit 1
}
command -v aws >/dev/null 2>&1 || { echo "hms-evidence-archive: aws cli unavailable" >&2; exit 1; }

directories_file="$(mktemp "${TMPDIR:-/tmp}/nava-hms-evidence-dirs.XXXXXX")"
trap 'rm -f -- "$directories_file"' EXIT
find "$EVIDENCE_ROOT" -mindepth 1 -type d -print0 2>/dev/null >"$directories_file" || {
  echo "hms-evidence-archive: evidence directories could not be listed" >&2
  exit 1
}
status=0
item=0
report() { printf 'hms-evidence-archive: item=%d %s\n' "$item" "$1"; }
while IFS= read -r -d '' directory; do
  [[ -d "$directory" && ! -L "$directory" ]] || continue
  item=$((item + 1))

  subdirectories="$(find "$directory" -mindepth 1 -type d -print -quit 2>/dev/null)" ||
    { report "status=structure_check_failed"; status=1; continue; }
  if [[ -n "$subdirectories" ]]; then report "status=not_leaf"; continue; fi
  newer_file="$(find "$directory" -type f -newermt '-14 days' -print -quit 2>/dev/null)" ||
    { report "status=age_check_failed"; status=1; continue; }
  if [[ -n "$newer_file" ]]; then report "status=contains_recent"; continue; fi

  metadata="$(stat -c '%Y %i' -- "$directory" 2>/dev/null)" || { report "status=stat_failed"; status=1; continue; }
  [[ "$metadata" =~ ^[0-9]+[[:space:]]+[0-9]+$ ]] || { report "status=stat_failed"; status=1; continue; }
  read -r directory_mtime inode <<<"$metadata"
  files="$(find "$directory" -type f -printf x 2>/dev/null | wc -c | tr -d '[:space:]')" ||
    { report "status=count_failed"; status=1; continue; }
  relative="$(realpath --relative-to="$EVIDENCE_ROOT" -- "$directory")" ||
    { report "status=path_failed"; status=1; continue; }
  destination="$S3_PREFIX$relative/$directory_mtime-$inode/"
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

  subdirectories="$(find "$directory" -mindepth 1 -type d -print -quit 2>/dev/null)" ||
    { report "status=structure_check_failed"; status=1; continue; }
  if [[ -n "$subdirectories" ]]; then report "status=not_leaf"; continue; fi
  newer_file="$(find "$directory" -type f -newermt '-14 days' -print -quit 2>/dev/null)" ||
    { report "status=age_check_failed"; status=1; continue; }
  if [[ -n "$newer_file" ]]; then report "status=contains_recent"; continue; fi

  if rm -rf -- "$directory"; then report "files=$files status=archived"
  else report "files=$files status=delete_failed"; status=1
  fi
done <"$directories_file"
trap - EXIT
rm -f -- "$directories_file"
exit "$status"
