#!/usr/bin/env bash
set -euo pipefail

if [[ ${0##*/} == fake-gh ]]; then
  printf '%s\n' "$*" >>"$FAKE_GH_LOG"
  case "${1:-} ${2:-}" in
    'repo view') printf '%s\n' 'owner/repo' ;;
    'pr view') printf '%s\t%s\t%s\n' '0123456789abcdef0123456789abcdef01234567' owner repo ;;
    'pr merge') exit 0 ;;
    'api graphql')
      if [[ ${FAKE_GH_SCENARIO:-success} == threads ]]; then
        printf '%s\n' '{"data":{"repository":{"pullRequest":{"headRefOid":"0123456789abcdef0123456789abcdef01234567","reviewThreads":{"nodes":[{"isResolved":false,"comments":{"nodes":[{"author":{"login":"greptile-apps[bot]"},"body":"P1: issue"}],"pageInfo":{"hasNextPage":false}}}],"pageInfo":{"hasNextPage":false}}}}}}'
      else
        printf '%s\n' '{"data":{"repository":{"pullRequest":{"headRefOid":"0123456789abcdef0123456789abcdef01234567","reviewThreads":{"nodes":[{"isResolved":true,"comments":{"nodes":[{"author":{"login":"greptile-apps[bot]"},"body":"P1: resolved"}],"pageInfo":{"hasNextPage":false}}}],"pageInfo":{"hasNextPage":false}}}}}}'
      fi ;;
    'api repos/owner/repo/commits/'*)
      if [[ ${FAKE_GH_SCENARIO:-success} == pending ]]; then
        printf '%s\n' '{"check_runs":[{"id":1,"name":"Greptile Review","app":{"slug":"greptile-apps"},"status":"in_progress","conclusion":null}]}'
      else
        printf '%s\n' '{"check_runs":[{"id":1,"name":"Greptile Review","app":{"slug":"greptile-apps"},"status":"completed","conclusion":"success"}]}'
      fi ;;
    'api repos/{owner}/{repo}/pulls/'*)
      if [[ ${FAKE_GH_SCENARIO:-success} == over-limit ]]; then
        printf '%s\n' '[{"filename":"src/app.ts","additions":501,"deletions":0}]'
      else
        printf '%s\n' '[{"filename":"src/app.ts","additions":20,"deletions":10},{"filename":"tests/fixtures/gold.md","additions":900,"deletions":0},{"filename":"src/app.test.ts","additions":900,"deletions":0},{"filename":"scripts/orch/test-orch.sh","additions":900,"deletions":0}]'
      fi ;;
    *) exit 90 ;;
  esac
  exit 0
fi
if [[ ${1:-} == -h || ${1:-} == --help ]]; then printf 'usage: %s\nRuns the isolated Bash orchestration self-test.\n' "${0##*/}"; exit 0; fi
[[ $# == 0 ]] || { printf 'usage: %s [--help]\n' "${0##*/}" >&2; exit 2; }

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
tmp=$(mktemp -d)
trap 'rm -rf -- "$tmp"' EXIT
fake="$tmp/fake-gh"
ln -s "$script_dir/test-orch.sh" "$fake"
export FAKE_GH_LOG="$tmp/gh.log"
: >"$FAKE_GH_LOG"
sha=0123456789abcdef0123456789abcdef01234567
gate_root="$tmp/or2"
mkdir -p "$gate_root/gates"
: >"$gate_root/gates/123-$sha.ok"

check() { [[ $1 == "$2" ]] || { printf 'FAIL: %s\n' "$3" >&2; exit 1; }; }
run_gate() {
  local want=$1 scenario=$2 root=$3 output rc
  if output=$(GH="$fake" FAKE_GH_SCENARIO="$scenario" OR2_ROOT="$root" MAX_PRODUCT_LINES=500 "$script_dir/merge-gate.sh" 123 2>&1); then rc=0; else rc=$?; fi
  check "$rc" "$want" "merge-gate scenario $scenario returned $rc: $output"
  printf '%s\n' "$output"
}

for name in merge-gate.sh deploy-train.sh dispatch.sh; do bash "$script_dir/$name" --help >/dev/null; done
bash "$script_dir/test-orch.sh" --help >/dev/null
out=$(run_gate 0 success "$gate_root")
[[ $out == PASS* ]] || { printf 'FAIL: expected pass verdict: %s\n' "$out" >&2; exit 1; }
grep -Fxq "pr merge 123 --squash --match-head-commit $sha" "$FAKE_GH_LOG"
for scenario in pending threads over-limit; do
  : >"$FAKE_GH_LOG"
  out=$(run_gate 1 "$scenario" "$gate_root")
  [[ $out == BLOCKED* ]] && ! grep -q '^pr merge ' "$FAKE_GH_LOG"
done
: >"$FAKE_GH_LOG"
out=$(GH="$fake" FAKE_GH_SCENARIO=over-limit OR2_ROOT="$gate_root" PURE_MOVE=1 "$script_dir/merge-gate.sh" 123)
[[ $out == PASS* ]] || { printf 'FAIL: PURE_MOVE did not skip the line cap\n' >&2; exit 1; }
rm -f -- "$gate_root/gates/123-$sha.ok"
ln -s /dev/null "$gate_root/gates/123-$sha.ok"
out=$(run_gate 1 success "$gate_root")
[[ $out == BLOCKED* ]] || { printf 'FAIL: symlinked gate record passed\n' >&2; exit 1; }
rm -f -- "$gate_root/gates/123-$sha.ok"
out=$(run_gate 1 success "$gate_root")
[[ $out == BLOCKED* ]] || { printf 'FAIL: missing gate record passed\n' >&2; exit 1; }

mkdir -p "$tmp/lastrow"
printf 'a\tmail\t-\tapps/x.ts\tluna\t/tmp/a.md\trunning\nb\tmail\t-\tapps/x.ts\tluna\t/tmp/b.md\tpending\n' >"$tmp/lastrow/units.tsv"
out=$(OR2_ROOT="$tmp/lastrow" "$script_dir/dispatch.sh") || { printf 'FAIL: conflicting last row aborted dispatch\n' >&2; exit 1; }
mkdir -p "$tmp/dispatch/state"
printf 'base\tmail\t-\tapps/a.ts\tluna\t/tmp/base.md\tpending\nchild\tmail\tbase\tapps/c.ts\tluna\t/tmp/child.md\tpending\nlive\tmail\t-\tapps/l.ts\tluna\t/tmp/live.md\trunning\nconflict\tmail\t-\tapps/l.ts\tluna\t/tmp/conflict.md\tpending\ndifferent\tmail\t-\tapps/d.ts\tluna\t/tmp/different.md\tpending\n' >"$tmp/dispatch/units.tsv"
if out=$(OR2_ROOT="$tmp/dispatch" "$script_dir/dispatch.sh" --idle-check 2>&1); then rc=0; else rc=$?; fi
check "$rc" 3 'idle-check should flag one lane with work startable'
[[ $out == *'running_lanes=1'* && $out == *'startable id=base'* && $out == *'startable id=different'* && $out != *'startable id=child'* && $out != *'startable id=conflict'* ]] || { printf 'FAIL: unexpected idle-check units: %s\n' "$out" >&2; exit 1; }
printf '%s\n' merged >"$tmp/dispatch/state/base.status"
out=$(OR2_ROOT="$tmp/dispatch" "$script_dir/dispatch.sh")
[[ $out == *'startable id=child'* ]] || { printf 'FAIL: merged dependency did not unlock child\n' >&2; exit 1; }
export LAUNCH_LOG="$tmp/launched"
out=$(OR2_ROOT="$tmp/dispatch" MAX_LANES=2 LAUNCH_CMD='printf "%s\n" "$ID" >>"$LAUNCH_LOG"' "$script_dir/dispatch.sh" --launch)
[[ $(<"$LAUNCH_LOG") == child && $(<"$tmp/dispatch/state/child.status") == starting ]] || { printf 'FAIL: launch did not count starting against MAX_LANES\n' >&2; exit 1; }
[[ $out == *'running_lanes=1 active_lanes=2'* ]] || { printf 'FAIL: starting lane was not included in the launch cap\n' >&2; exit 1; }
if out=$(OR2_ROOT="$tmp/dispatch" "$script_dir/dispatch.sh" --idle-check 2>&1); then rc=0; else rc=$?; fi
check "$rc" 3 'idle-check should count only running, not starting, lanes'
[[ $out == *'running_lanes=1'* && $out == *'startable id=different'* ]] || { printf 'FAIL: idle-check lost its running/startable counts\n' >&2; exit 1; }

out=$(OR2_ROOT="$tmp/deploy" DEPLOY_TREE="$tmp/no-deploy-tree" "$script_dir/deploy-train.sh" --once --dry-run)
[[ $out == DRY-RUN* && ! -e "$tmp/deploy/deploy/last-sha" && ! -e "$tmp/deploy/deploy/log.tsv" ]]
printf 'PASS: orch self-test\n'
