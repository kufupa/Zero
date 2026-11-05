#!/usr/bin/env bash
# Replay the available pre-26-Sep Centurion archive and its readable documents.
set -euo pipefail
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
cd "$repo_dir"
doc_dir=docs/research/halloween/corpus-analysis
run_dir=.private/centurion-opportunity-october-20261101/pre-sep26-v24
exec python3 "$doc_dir/centurion-aggregate-opportunity.py" \
  --directory "$run_dir" \
  --inbound-prompt "$doc_dir/2026-11-02-centurion-opportunity-prompt-v24-quote-review.md" \
  --recovered-prompt "$doc_dir/2026-11-02-centurion-opportunity-prompt-v26-general.md" \
  --recovered-input "$run_dir/available-attachment-reviewed-input.jsonl" \
  --recovered-results "$run_dir/available-attachment-reviewed-results.jsonl" \
  --allowed-failures "$run_dir/unclassified.json" "$@"
