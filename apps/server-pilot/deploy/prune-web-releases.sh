#!/usr/bin/env bash
set -euo pipefail

fail() { echo "$1" >&2; exit 1; }
DRY_RUN=0
if [[ $# -eq 1 && "$1" == "--dry-run" ]]; then
  DRY_RUN=1
elif [[ $# -ne 0 ]]; then
  echo "usage: prune-web-releases.sh [--dry-run]" >&2
  exit 2
fi

WEB_ROOT="${WEB_ROOT:-/var/www/nava-mail}"
WEB_ROOT="${WEB_ROOT%/}"
[[ "$WEB_ROOT" == /* && "$WEB_ROOT" != "/" && -d "$WEB_ROOT" && ! -L "$WEB_ROOT" ]] ||
  fail "unsafe or missing web root; refusing release pruning"
RELEASE_ROOT="${WEB_ROOT}/releases"
[[ -d "$RELEASE_ROOT" && ! -L "$RELEASE_ROOT" ]] ||
  fail "unsafe or missing release root; refusing release pruning"
WEB_ROOT_REAL="$(sudo realpath -e -- "$WEB_ROOT")" || fail "web root could not be resolved"
RELEASE_ROOT_REAL="$(sudo realpath -e -- "$RELEASE_ROOT")" || fail "release root could not be resolved"
[[ "$RELEASE_ROOT_REAL" == "${WEB_ROOT_REAL}/releases" ]] ||
  fail "release root resolves outside the web root"
NGINX_CONFIG="$(sudo nginx -T 2>/dev/null)" || fail "active nginx configuration could not be read"
ACTIVE_REFS="$(printf '%s\n' "$NGINX_CONFIG" |
  grep -F "${RELEASE_ROOT}/" |
  grep -oE 'releases/[A-Za-z0-9._-]+' |
  sed 's#^releases/##' | sort -u)" ||
  fail "active nginx release reference was not found"

entries_file="$(mktemp "${TMPDIR:-/tmp}/nava-web-releases.XXXXXX")"
trap 'rm -f -- "$entries_file"' EXIT
sudo find "$RELEASE_ROOT" -mindepth 1 -maxdepth 1 -print0 >"$entries_file" ||
  fail "release entries could not be listed"
mapfile -d '' -t entries <"$entries_file"
release_ids=()
declare -A present_ids=() keep_set=()
for entry in "${entries[@]}"; do
  id="${entry##*/}"
  [[ "$id" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ && ! -L "$entry" && -d "$entry" ]] ||
    fail "release root contains an unsafe entry"
  [[ "$(sudo realpath -e -- "$entry")" == "${RELEASE_ROOT_REAL}/${id}" ]] ||
    fail "release path resolves outside the release root"
  links="$(sudo find "$entry" -type l -print -quit)" || fail "release contents could not be checked"
  [[ -z "$links" ]] || fail "release contains a symlink"
  release_ids+=("$id")
  present_ids["$id"]=1
done

keep_refs() {
  local refs="$1" required="${2:-0}" id
  while IFS= read -r id; do
    [[ -n "$id" ]] || continue
    if [[ -z "${present_ids[$id]+yes}" ]]; then
      [[ "$required" == 0 ]] || fail "nginx references a missing release"
    else
      keep_set["$id"]=1
    fi
  done <<<"$refs"
}
keep_refs "$ACTIVE_REFS" 1
RELATIVE_REFS="$(printf '%s\n' "$NGINX_CONFIG" |
  grep -oE '/releases/[A-Za-z0-9._-]+' | sed 's#^.*/##' | sort -u || true)"
keep_refs "$RELATIVE_REFS"

sudo find "$RELEASE_ROOT" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %f\0' |
  sort -z -nr >"$entries_file" || fail "release timestamps could not be read"
mapfile -d '' -t newest_first <"$entries_file"
other_kept=0
for record in "${newest_first[@]}"; do
  id="${record#* }"
  if [[ -z "${keep_set[$id]+yes}" ]] && ((other_kept < 2)); then
    keep_set["$id"]=1
    other_kept=$((other_kept + 1))
  fi
done

removed=0
for id in "${release_ids[@]}"; do
  [[ -z "${keep_set[$id]+yes}" ]] || continue
  path="${RELEASE_ROOT}/${id}"
  [[ ! -L "$path" && -d "$path" ]] || fail "release path changed during pruning"
  [[ "$(sudo realpath -e -- "$path")" == "${RELEASE_ROOT_REAL}/${id}" ]] ||
    fail "release path resolves outside the release root"
  if ((DRY_RUN == 0)); then sudo rm -rf -- "$path" || fail "release deletion failed"; fi
  removed=$((removed + 1))
done
trap - EXIT
rm -f -- "$entries_file"
printf 'prune-web-releases: candidates=%d previous=%d dry_run=%d\n' "$removed" "$other_kept" "$DRY_RUN"
