#!/usr/bin/env bash
set -euo pipefail

usage() { printf 'usage: %s <pr-number>\nChecks Greptile, unresolved P0/P1 threads, product-line cap (PURE_MOVE=1 skips it), and /tmp/or2 gate record; then squash-merges.\n' "${0##*/}"; }
if [[ ${1:-} == -h || ${1:-} == --help ]]; then usage; exit 0; fi
blocked() { printf 'BLOCKED pr=%s reason=%s\n' "${pr:-unknown}" "$1"; exit 1; }
pr=${1:-unknown}
[[ $# == 1 && $pr =~ ^[0-9]+$ ]] || { usage >&2; blocked invalid-pr; }
limit=${MAX_PRODUCT_LINES:-500}
[[ $limit =~ ^[0-9]{1,9}$ ]] || blocked invalid-line-limit
limit_num=$((10#$limit))
gh_bin=${GH:-gh}
command -v "$gh_bin" >/dev/null 2>&1 || blocked gh-unavailable
command -v jq >/dev/null 2>&1 || blocked jq-unavailable

repo=$($gh_bin repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null) || blocked repo-lookup
[[ $repo =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || blocked invalid-repository
head=$($gh_bin pr view "$pr" --json headRefOid,headRepositoryOwner,headRepository --jq '[.headRefOid,.headRepositoryOwner.login,.headRepository.name] | @tsv' 2>/dev/null) || blocked pr-lookup
IFS=$'\t' read -r sha head_owner head_name <<<"$head"
[[ $sha =~ ^[0-9a-fA-F]{40,64}$ ]] || blocked invalid-head
[[ $head_owner =~ ^[A-Za-z0-9_.-]+$ && $head_name =~ ^[A-Za-z0-9_.-]+$ ]] || blocked invalid-head-repository

check_json=$($gh_bin api "repos/$head_owner/$head_name/commits/$sha/check-runs?per_page=100" --paginate 2>/dev/null) || blocked greptile-check-unavailable
check_state=$(jq -sr '
  [.[] | (if type == "array" then .[] else .check_runs[]? end)
   | select(.name == "Greptile Review" and .app.slug == "greptile-apps")]
  | sort_by(.id) | last // {}
  | [.status // "", .conclusion // ""] | @tsv
' <<<"$check_json" 2>/dev/null) || blocked invalid-check-response
[[ $check_state == $'completed\tsuccess' ]] || blocked greptile-check-not-success

owner=${repo%/*}; name=${repo#*/}
query='query($owner:String!, $name:String!, $number:Int!) { repository(owner:$owner, name:$name) { pullRequest(number:$number) { headRefOid reviewThreads(first:100) { nodes { isResolved comments(first:100) { nodes { author { login } body } pageInfo { hasNextPage } } } pageInfo { hasNextPage } } } } }'
thread_json=$($gh_bin api graphql -f query="$query" -F owner="$owner" -F name="$name" -F number="$pr" 2>/dev/null) || blocked review-threads-unavailable
thread_count=$(jq -er --arg sha "$sha" '
  (if .errors then error("graphql errors") else .data.repository.pullRequest end) as $pr |
  if $pr == null or $pr.headRefOid != $sha or $pr.reviewThreads.pageInfo.hasNextPage != false then error("incomplete review threads")
  elif any($pr.reviewThreads.nodes[]?; .comments.pageInfo.hasNextPage != false) then error("incomplete thread comments")
  elif any($pr.reviewThreads.nodes[]?; (.isResolved | type) != "boolean" or (.comments.nodes | type) != "array") then error("invalid review thread")
  else [$pr.reviewThreads.nodes[]? | select(.isResolved == false) | select(any(.comments.nodes[]?; (.author.login == "greptile-apps" or .author.login == "greptile-apps[bot]") and (.body | test("P[01]"))))] | length
  end
' <<<"$thread_json" 2>/dev/null) || blocked invalid-review-threads
[[ $thread_count == 0 ]] || blocked unresolved-greptile-p0-p1

files_json=$($gh_bin api 'repos/{owner}/{repo}/pulls/'"$pr"'/files?per_page=100' --paginate 2>/dev/null) || blocked changed-files-unavailable
product_lines=$(jq -sr '
  def excluded:
    (.filename | test("(^|/)(tests?|fixtures?|__tests__|__fixtures__)(/|$)"; "i")) or
    (.filename | test("(^|/)(test|tests)[_-][^/]+\\.[^/]+$"; "i")) or
    (.filename | test("(^|/)[^/]+[-_]test\\.[^/]+$"; "i")) or
    (.filename | test("\\.(test|spec)\\.[^.]+$"; "i")) or
    (.filename | test("\\.md$"; "i"));
  [.[] | (if type == "array" then .[] else . end)
   | select(excluded | not) | (.additions + .deletions)] | add // 0
' <<<"$files_json" 2>/dev/null) || blocked invalid-changed-files
[[ $product_lines =~ ^[0-9]+$ ]] || blocked invalid-product-line-count
# PURE_MOVE=1: coordinator-verified file moves (split monoliths) skip the line cap only.
[[ ${PURE_MOVE:-0} == 1 ]] || (( product_lines <= limit_num )) || blocked product-line-limit

or2_root=${OR2_ROOT:-/tmp/or2}
gate_dir="$or2_root/gates"; gate_file="$gate_dir/$pr-$sha.ok"
[[ -d $gate_dir && ! -L $gate_dir && -O $gate_dir ]] || blocked gate-dir-untrusted
[[ -f $gate_file && ! -L $gate_file && -O $gate_file ]] || blocked gate-record-missing
if $gh_bin pr merge "$pr" --squash --match-head-commit "$sha" >/dev/null 2>&1; then
  printf 'PASS pr=%s head=%s product_lines=%s\n' "$pr" "$sha" "$product_lines"
else
  blocked merge-failed
fi
