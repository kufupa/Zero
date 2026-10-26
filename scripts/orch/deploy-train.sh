#!/usr/bin/env bash
set -euo pipefail
umask 077

usage() { printf 'usage: %s [--once] [--dry-run]\nPolls origin/main and serializes fast-forward deploys from the recover-parse-failure worktree.\n' "${0##*/}"; }
once=0; dry_run=0
while (($#)); do
  case "$1" in
    --once) once=1 ;;
    --dry-run) dry_run=1 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
  shift
done
poll=${POLL_SECONDS:-30}
[[ $poll =~ ^[1-9][0-9]{0,3}$ ]] && ((poll <= 3600)) || { printf 'BLOCKED reason=invalid-poll-interval\n'; exit 2; }
command -v flock >/dev/null 2>&1 || { printf 'BLOCKED reason=flock-unavailable\n'; exit 1; }
or2_root=${OR2_ROOT:-/tmp/or2}
deploy_dir="$or2_root/deploy"
mkdir -p "$deploy_dir"
[[ ! -L $deploy_dir && -O $deploy_dir ]] || { printf 'BLOCKED reason=deploy-dir-untrusted\n'; exit 1; }
[[ ! -L $deploy_dir/lock ]] || { printf 'BLOCKED reason=lock-symlink\n'; exit 1; }
exec {lock_fd}<>"$deploy_dir/lock"
flock -n "$lock_fd" || { printf 'SKIP reason=deploy-lock-held\n'; exit 0; }

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd "$script_dir/../.." && pwd)
tree=${DEPLOY_TREE:-/home/ubuntu/projects/zero/.worktrees/recover-parse-failure}
last_file="$deploy_dir/last-sha"
log_file="$deploy_dir/log.tsv"
last_sha=
if [[ -f $last_file ]]; then
  last_sha=$(<"$last_file")
  [[ $last_sha =~ ^[0-9a-fA-F]{40,64}$ ]] || { printf 'BLOCKED reason=invalid-last-sha\n'; exit 1; }
fi

deadletter_only() {
  local output=$1 report
  # Allow rc=1 only for the sole measured dead-letter gate after the health phase.
  # Staff-hours jobs in flight also trip workflowNonterminalBacklogEmpty; health/pm2 still decide liveness.
  [[ $output == *'== ops-deploy: health =='* && ( $output == *'launch-readiness NOT_READY; criticalFailures=workflowDeadLetterBacklogEmpty;'* || $output == *'launch-readiness NOT_READY; criticalFailures=workflowNonterminalBacklogEmpty,workflowDeadLetterBacklogEmpty;'* ) ]] || return 1
  report=$(grep -F '"workflowDeadLetterBacklogEmpty"' <<<"$output" | tail -n 1 || true)
  [[ -n $report ]] || return 1
  command -v jq >/dev/null 2>&1 || return 1
  jq -e '
    .status == "NOT_READY" and
    ((.failures == ["workflowDeadLetterBacklogEmpty"]) or (.failures == ["workflowNonterminalBacklogEmpty","workflowDeadLetterBacklogEmpty"])) and
    .checks.httpHealthy == true and .checks.httpsHealthy == true and .checks.tlsValid == true and
    .checks.pm2HttpOnline == true and .checks.pm2WorkerOnline == true and .checks.pm2AiWorkerOnline == true and
    .checks.strictHotelProbe == true and
    (.observations.workflowDeadLetterRecentCount | type == "number" and . > 0) and
    (.observations.workflowDeadLetterWindowStart | type == "string" and length > 0)
  ' <<<"$report" >/dev/null 2>&1
}

run_once() {
  local main_sha dirty current output rc timestamp tmp
  if ((dry_run)); then
    main_sha=$(git -C "$repo_root" rev-parse --verify refs/remotes/origin/main 2>/dev/null) || { printf 'BLOCKED reason=origin-main-unavailable\n'; return 1; }
    if [[ $main_sha == "$last_sha" ]]; then printf 'DRY-RUN sha=%s action=already-deployed\n' "$main_sha"; else printf 'DRY-RUN sha=%s action=deploy\n' "$main_sha"; fi
    return 0
  fi
  git -C "$repo_root" fetch --no-tags origin refs/heads/main:refs/remotes/origin/main >/dev/null 2>&1 || { printf 'BLOCKED reason=fetch-failed\n'; return 1; }
  main_sha=$(git -C "$repo_root" rev-parse --verify refs/remotes/origin/main 2>/dev/null) || { printf 'BLOCKED reason=origin-main-unavailable\n'; return 1; }
  if [[ $main_sha == "$last_sha" ]]; then printf 'SKIP sha=%s reason=already-deployed\n' "$main_sha"; return 0; fi
  [[ -d $tree && -f $tree/apps/server-pilot/deploy/ops-deploy.sh ]] || { printf 'BLOCKED reason=deploy-tree-missing\n'; return 1; }
  dirty=$(git -C "$tree" status --porcelain --untracked-files=all 2>/dev/null) || { printf 'BLOCKED reason=deploy-tree-unreadable\n'; return 1; }
  [[ -z $dirty ]] || { printf 'BLOCKED reason=deploy-tree-dirty\n'; return 1; }
  git -C "$tree" merge-base --is-ancestor HEAD refs/remotes/origin/main >/dev/null 2>&1 || { printf 'BLOCKED sha=%s reason=not-fast-forward\n' "$main_sha"; return 1; }
  git -C "$tree" merge --ff-only refs/remotes/origin/main >/dev/null 2>&1 || { printf 'BLOCKED sha=%s reason=fast-forward-failed\n' "$main_sha"; return 1; }
  current=$(git -C "$tree" rev-parse HEAD 2>/dev/null) || { printf 'BLOCKED reason=deploy-head-unavailable\n'; return 1; }
  [[ $current == "$main_sha" ]] || { printf 'BLOCKED sha=%s reason=deploy-head-mismatch\n' "$main_sha"; return 1; }
  if output=$(cd "$tree" && bash apps/server-pilot/deploy/ops-deploy.sh 2>&1); then rc=0; else rc=$?; fi
  timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  local attempt_log="$deploy_dir/attempt-${timestamp//:/}-${main_sha:0:12}.log"
  printf '%s\n' "$output" >"$attempt_log" || true
  printf '%s\t%s\t%s\n' "$main_sha" "$timestamp" "$rc" >>"$log_file" || { printf 'BLOCKED sha=%s reason=log-write-failed\n' "$main_sha"; return 1; }
  local deploy_ok=0
  if ((rc == 0)); then deploy_ok=1
  elif ((rc == 1)) && deadletter_only "$output"; then
    # ops-deploy exits at readiness before its VPN assert and last-good marker; run the VPN assert here.
    if (cd "$tree" && bash apps/server-pilot/deploy/ssm-run-command.sh 'bash /home/ubuntu/repos/zero/apps/server-pilot/deploy/vpn-health-assert.sh') >>"$attempt_log" 2>&1; then
      deploy_ok=1; printf 'NOTE sha=%s reason=deadletter-gate vpn=ok marker=not-recorded\n' "$main_sha"
    else
      printf 'FAILED sha=%s reason=vpn-assert-after-deadletter log=%s\n' "$main_sha" "$attempt_log"; return 1
    fi
  fi
  if ((deploy_ok)); then
    tmp=$(mktemp "$deploy_dir/.last-sha.XXXXXX") || { printf 'BLOCKED sha=%s reason=state-write-failed\n' "$main_sha"; return 1; }
    printf '%s\n' "$main_sha" >"$tmp" && mv -f -- "$tmp" "$last_file" || { rm -f -- "$tmp"; printf 'BLOCKED sha=%s reason=state-write-failed\n' "$main_sha"; return 1; }
    last_sha=$main_sha
    printf 'DEPLOYED sha=%s rc=%s log=%s\n' "$main_sha" "$rc" "$attempt_log"
    return 0
  fi
  printf 'FAILED sha=%s rc=%s log=%s\n' "$main_sha" "$rc" "$attempt_log"
  return 1
}

while :; do
  if run_once; then rc=0; else rc=$?; fi
  ((once)) && exit "$rc"
  sleep "$poll"
done
