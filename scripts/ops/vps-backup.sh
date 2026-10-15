#!/usr/bin/env bash
# vps-backup.sh: repeatable dev-VPS backup to S3 (owner, 2026-10-15).
# Makes two timestamped tarballs (paths stored relative to /, restore with `tar -xzf X -C /`):
#   nava-research-backup-<UTC>.tgz : /home/orca/nava-research (minus node_modules, .worktrees)
#   claude-backup-<UTC>.tgz        : ~/.claude memory + transcripts (projects/), hooks, skills,
#                                    CLAUDE.md, settings.json, eta-ledger.jsonl, /home/orca/bin,
#                                    and the zero ops-run.sh helper (not in git)
# Uploads with SSE AES256, then keeps only the newest $KEEP of each kind. Pruning only touches
# keys under $PREFIX that match this script's exact naming; the *-vps-migration-20261015.tgz
# originals never match and are never deleted.
# Cron (user orca): flock -n /tmp/vps-backup.lock so runs never overlap.
set -euo pipefail
shopt -s inherit_errexit
export PATH=/usr/local/bin:/usr/bin:/bin:$PATH  # cron PATH lacks /usr/local/bin (aws)

BUCKET=${VPS_BACKUP_BUCKET:-nava-zero-mail-845242190536-af-south-1}
PREFIX=${VPS_BACKUP_PREFIX:-vps-migration/}
KEEP=${VPS_BACKUP_KEEP:-5}
REGION=${AWS_REGION:-af-south-1}
TS=$(date -u +%Y%m%dT%H%M%SZ)
TMP=$(mktemp -d "${TMPDIR:-/tmp}/vps-backup.XXXXXX")
trap 'rm -rf "$TMP"' EXIT

log() { echo "$(date -u +%FT%TZ) $*" >&2; }

# Only add paths that exist, so a missing optional file does not kill the run.
existing() { local p; for p in "$@"; do if [ -e "/$p" ]; then printf '%s\n' "$p"; fi; done; }

make_tar() { # name, then paths relative to /; "--" then paths appended WITHOUT excludes
  local out="$TMP/$1" raw="$TMP/${1%.tgz}.tar"; shift
  local main=() extra=() p
  while [ $# -gt 0 ]; do [ "$1" = -- ] && { shift; extra=("$@"); break; }; main+=("$1"); shift; done
  existing "${main[@]}" > "$TMP/list.txt"
  [ -s "$TMP/list.txt" ] || { log "nothing to back up for $out"; return 1; }
  # nice/ionice keep the 4-vCPU VPS responsive; -h follows the skills symlink.
  # tar exit 1 = "file changed while reading" (live transcripts): accept it.
  nice -n 15 ionice -c3 tar -C / -h \
    --exclude='node_modules' --exclude='.worktrees' \
    --warning=no-file-changed --warning=no-file-removed \
    -cf "$raw" -T "$TMP/list.txt" || [ $? = 1 ]
  # Extra paths live under a .worktrees dir, so they must skip the excludes above.
  for p in "${extra[@]}"; do if [ -e "/$p" ]; then tar -C / -rf "$raw" "$p"; fi; done
  nice -n 15 pigz -p 2 -c "$raw" > "$out"; rm -f "$raw"
  echo "$out"
}

upload() { # local file, kind prefix
  local f=$1 key="$PREFIX$(basename "$1")"
  aws s3 cp --only-show-errors --sse AES256 --region "$REGION" "$f" "s3://$BUCKET/$key"
  log "uploaded s3://$BUCKET/$key ($(stat -c %s "$f") bytes)"
}

prune() { # kind, e.g. nava-research-backup
  local kind=$1
  # aws s3 ls output: date time size name. Strict regex = only this script's own objects.
  mapfile -t keys < <(aws s3 ls --region "$REGION" "s3://$BUCKET/$PREFIX" \
    | awk '{print $4}' | grep -E "^${kind}-[0-9]{8}T[0-9]{6}Z\.tgz$" | sort -r)
  local i
  for ((i = KEEP; i < ${#keys[@]}; i++)); do
    aws s3 rm --only-show-errors --region "$REGION" "s3://$BUCKET/$PREFIX${keys[$i]}"
    log "pruned s3://$BUCKET/$PREFIX${keys[$i]}"
  done
}

R=$(make_tar "nava-research-backup-$TS.tgz" home/orca/nava-research)
upload "$R"; rm -f "$R"

C=$(make_tar "claude-backup-$TS.tgz" \
  home/orca/.claude/projects home/orca/.claude/hooks home/orca/.claude/skills \
  home/orca/.claude/CLAUDE.md home/orca/.claude/settings.json home/orca/.claude/eta-ledger.jsonl \
  home/orca/bin \
  -- home/ubuntu/projects/zero/.worktrees/ops-run.sh)
upload "$C"; rm -f "$C"

prune nava-research-backup
prune claude-backup
log "done $TS"
