#!/usr/bin/env bash
set -euo pipefail

usage() { printf 'usage: %s <pr-number>\nBlocks known unresolved P0/P1 review threads, then squash-merges the exact PR head.\n' "${0##*/}"; }
if [[ ${1:-} == -h || ${1:-} == --help ]]; then usage; exit 0; fi
blocked() { printf 'BLOCKED pr=%s reason=%s\n' "${pr:-unknown}" "$1"; exit 1; }
pr=${1:-unknown}
[[ $# == 1 && $pr =~ ^[0-9]+$ ]] || { usage >&2; blocked invalid-pr; }
gh_bin=${GH:-gh}
command -v "$gh_bin" >/dev/null 2>&1 || blocked gh-unavailable
command -v jq >/dev/null 2>&1 || blocked jq-unavailable

repo=$($gh_bin repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null) || blocked repo-lookup
[[ $repo =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || blocked invalid-repository
head=$($gh_bin pr view "$pr" --json headRefOid,headRepositoryOwner,headRepository --jq '[.headRefOid,.headRepositoryOwner.login,.headRepository.name] | @tsv' 2>/dev/null) || blocked pr-lookup
IFS=$'\t' read -r sha head_owner head_name <<<"$head"
[[ $sha =~ ^[0-9a-fA-F]{40,64}$ ]] || blocked invalid-head
[[ $head_owner =~ ^[A-Za-z0-9_.-]+$ && $head_name =~ ^[A-Za-z0-9_.-]+$ ]] || blocked invalid-head-repository

owner=${repo%/*}; name=${repo#*/}
query='query($owner:String!, $name:String!, $number:Int!) { repository(owner:$owner, name:$name) { pullRequest(number:$number) { headRefOid reviewThreads(first:100) { nodes { isResolved comments(first:100) { nodes { author { login } body } pageInfo { hasNextPage } } } pageInfo { hasNextPage } } } } }'
thread_json=$($gh_bin api graphql -f query="$query" -F owner="$owner" -F name="$name" -F number="$pr" 2>/dev/null) || blocked review-threads-unavailable
thread_count=$(jq -er --arg sha "$sha" '
  (if .errors then error("graphql errors") else .data.repository.pullRequest end) as $pr |
  if $pr == null or $pr.headRefOid != $sha or $pr.reviewThreads.pageInfo.hasNextPage != false then error("incomplete review threads")
  elif any($pr.reviewThreads.nodes[]?; .comments.pageInfo.hasNextPage != false) then error("incomplete thread comments")
  elif any($pr.reviewThreads.nodes[]?; (.isResolved | type) != "boolean" or (.comments.nodes | type) != "array") then error("invalid review thread")
  else [$pr.reviewThreads.nodes[]? | select(.isResolved == false) | select(any(.comments.nodes[]?; ((.body // "") | test("\\bP[01]\\b"; "i"))))] | length
  end
' <<<"$thread_json" 2>/dev/null) || blocked invalid-review-threads
[[ $thread_count == 0 ]] || blocked unresolved-review-p0-p1

if $gh_bin pr merge "$pr" --squash --match-head-commit "$sha" >/dev/null 2>&1; then
  printf 'PASS pr=%s head=%s\n' "$pr" "$sha"
else
  blocked merge-failed
fi
