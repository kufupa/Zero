#!/usr/bin/env bash
# Replay the reviewed Centurion window; choose new private export paths.
# --before-reply omits only the later reply-link overlay, for blind comparison.
set -euo pipefail
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
cd "$repo_dir"
run_dir=.private/centurion-opportunity-october-20261101/bulk-v22-effective
base_dir=.private/centurion-opportunity-october-20261101/general-v14
doc_dir=docs/research/halloween/corpus-analysis
reply_args=(
  --reply-review-input "$run_dir/reply-v24-allcandidate-input.jsonl"
  --reply-review-results "$run_dir/reply-v24-allcandidate-results.jsonl"
  --reply-review-prompt "$doc_dir/2026-11-02-centurion-opportunity-prompt-v24-quote-review.md"
  --post-reply-corrections "$run_dir/reply-audit-corrections-v25.json"
)
if [[ "${1:-}" == --before-reply ]]; then
  reply_args=()
  shift
fi
exec bash "$doc_dir/centurion-20261102-replay.sh" \
  --envelope-review-input "$run_dir/envelope-v23/direction-targeted-v23-all.jsonl" \
  --envelope-review-results "$run_dir/envelope-v23/results-v23-all.jsonl" \
  --envelope-review-prompt "$doc_dir/2026-11-02-centurion-opportunity-prompt-v23-envelope-review.md" \
  --envelope-index "$run_dir/envelope-v23/inbound-envelope-index.jsonl" \
  --envelope-source "old=$base_dir/normalized-old.jsonl" \
  --envelope-source "tail=$base_dir/normalized-tail.jsonl" --include-envelope-all \
  --semantic-review-input "$run_dir/semantic-v24-full-input.jsonl" \
  --semantic-review-results "$run_dir/semantic-v24-full-results.jsonl" \
  --semantic-review-prompt "$doc_dir/2026-11-02-centurion-opportunity-prompt-v24-quote-review.md" \
  --audit-corrections "$run_dir/audit-corrections-v29.json" \
  "${reply_args[@]}" "$@"
