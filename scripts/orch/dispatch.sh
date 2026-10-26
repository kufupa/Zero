#!/usr/bin/env bash
set -euo pipefail

usage() { printf 'usage: %s [--idle-check|--launch]\nReads $OR2_ROOT/units.tsv and status files under $OR2_ROOT/state.\n' "${0##*/}"; }
mode=report
case "${1:-}" in
  '') ;;
  --idle-check) mode=idle ;;
  --launch) mode=launch ;;
  -h|--help) usage; exit 0 ;;
  *) usage >&2; exit 2 ;;
esac
[[ $# -le 1 ]] || { usage >&2; exit 2; }
root=${OR2_ROOT:-/tmp/or2}; units_file="$root/units.tsv"; state_dir="$root/state"
max=${MAX_LANES:-6}
[[ $max =~ ^[0-9]{1,2}$ ]] && ((10#$max <= 99)) || { printf 'BLOCKED reason=invalid-max-lanes\n'; exit 2; }
max=$((10#$max))
[[ -f $units_file ]] || { printf 'BLOCKED reason=units-file-missing\n'; exit 1; }

ids=(); areas=(); deps=(); files=(); coders=(); briefs=(); statuses=(); startable=(); active_count=0; running_count=0
while IFS= read -r line || [[ -n $line ]]; do
  line=${line%$'\r'}
  [[ -z $line || $line == id$'\t'* ]] && continue
  encoded=${line//$'\t'/$'\034'}
  IFS=$'\034' read -r -a col <<<"$encoded"
  (( ${#col[@]} == 7 )) || { printf 'BLOCKED reason=invalid-units-row\n'; exit 1; }
  id=${col[0]}; [[ $id =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] || { printf 'BLOCKED reason=invalid-unit-id\n'; exit 1; }
  for old in "${ids[@]}"; do [[ $old != "$id" ]] || { printf 'BLOCKED reason=duplicate-unit-id\n'; exit 1; }; done
  status=${col[6]:-pending}
  if [[ -f $state_dir/$id.status ]]; then status=$(<"$state_dir/$id.status"); fi
  [[ -n $status ]] || status=pending
  [[ $status != *$'\n'* && $status != *$'\t'* && $status != *$'\r'* ]] || { printf 'BLOCKED reason=invalid-unit-status\n'; exit 1; }
  ids+=("$id"); areas+=("${col[1]}"); deps+=("${col[2]}"); files+=("${col[3]}")
  coders+=("${col[4]}"); briefs+=("${col[5]}"); statuses+=("$status")
done <"$units_file"

shares_file() {
  local a b; local -a left right
  IFS=, read -r -a left <<<"$1"; IFS=, read -r -a right <<<"$2"
  for a in "${left[@]}"; do
    [[ -n $a ]] || continue
    for b in "${right[@]}"; do [[ -n $b && $a == "$b" ]] && return 0; done
  done
  return 1
}
collect() {
  local i j dep dep_index ready conflict
  startable=(); active_count=0; running_count=0
  for i in "${!ids[@]}"; do
    if [[ ${statuses[i]} == running ]]; then ((running_count+=1)); ((active_count+=1));
    elif [[ ${statuses[i]} == starting ]]; then ((active_count+=1)); fi
  done
  for i in "${!ids[@]}"; do
    [[ ${statuses[i]} == running || ${statuses[i]} == starting || ${statuses[i]} == merged ]] && continue
    ready=1
    if [[ -n ${deps[i]} && ${deps[i]} != - ]]; then
      IFS=, read -r -a required <<<"${deps[i]}"
      for dep in "${required[@]}"; do
        dep_index=-1
        for j in "${!ids[@]}"; do [[ ${ids[j]} == "$dep" ]] && { dep_index=$j; break; }; done
        if ((dep_index < 0)) || [[ ${statuses[dep_index]} != merged ]]; then ready=0; break; fi
      done
    fi
    ((ready)) || continue
    conflict=0
    for j in "${!ids[@]}"; do
      if [[ ${statuses[j]} == running || ${statuses[j]} == starting ]] && shares_file "${files[i]}" "${files[j]}"; then conflict=1; break; fi
    done
    ((conflict == 0)) && startable+=("$i")
  done
  return 0
}
write_status() {
  local id=$1 status=$2 tmp
  mkdir -p "$state_dir"
  tmp=$(mktemp "$state_dir/.$id.status.XXXXXX") || return 1
  printf '%s\n' "$status" >"$tmp" && mv -f -- "$tmp" "$state_dir/$id.status" || { rm -f -- "$tmp"; return 1; }
}
if [[ $mode == launch ]]; then
  # Serialize launch decisions so overlapping runs cannot pick the same unit.
  command -v flock >/dev/null 2>&1 || { printf 'BLOCKED reason=flock-unavailable\n'; exit 1; }
  [[ ! -L $root/dispatch.lock ]] || { printf 'BLOCKED reason=lock-symlink\n'; exit 1; }
  exec {dispatch_fd}<>"$root/dispatch.lock"
  flock "$dispatch_fd"
  for i in "${!ids[@]}"; do [[ -f $state_dir/${ids[i]}.status ]] && statuses[i]=$(<"$state_dir/${ids[i]}.status"); done
fi
collect
if [[ $mode == launch ]]; then
  if ((active_count < max && ${#startable[@]} > 0)) && [[ -z ${LAUNCH_CMD:-} ]]; then printf 'BLOCKED reason=launcher-not-configured\n'; exit 1; fi
  while ((active_count < max && ${#startable[@]} > 0)); do
    i=${startable[0]}; id=${ids[i]}
    write_status "$id" starting || { printf 'BLOCKED id=%s reason=status-write-failed\n' "$id"; exit 1; }
    statuses[i]=starting
    if ID="$id" AREA="${areas[i]}" DEPENDS="${deps[i]}" FILES="${files[i]}" CODER="${coders[i]}" BRIEF_PATH="${briefs[i]}" bash -c "$LAUNCH_CMD" >/dev/null 2>&1; then
      printf 'LAUNCHED id=%s\n' "$id"
    else
      write_status "$id" failed || true
      printf 'FAILED id=%s reason=launcher-failed\n' "$id"
      exit 1
    fi
    collect
  done
fi
collect
printf 'running_lanes=%s active_lanes=%s startable_units=%s\n' "$running_count" "$active_count" "${#startable[@]}"
for i in "${startable[@]}"; do printf 'startable id=%s area=%s files=%s\n' "${ids[i]}" "${areas[i]}" "${files[i]}"; done
if [[ $mode == idle ]] && ((running_count < 2 && ${#startable[@]} > 0)); then exit 3; fi
