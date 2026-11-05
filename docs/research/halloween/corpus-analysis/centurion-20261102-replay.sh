#!/usr/bin/env bash
# Replay the recorded, attachment-inclusive Centurion classifications.
# Pass optional review layers and private output paths as aggregator arguments.
set -euo pipefail
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
cd "$repo_dir"
doc_dir=docs/research/halloween/corpus-analysis
run_dir=.private/centurion-opportunity-october-20261101/bulk-v22-effective
source_dir=.private/centurion-opportunity-october-20261101/bulk-v18-effective

exec python3 "$doc_dir/centurion-aggregate-opportunity.py" \
  --directory "$run_dir" \
  --inbound-prompt "$doc_dir/2026-11-02-centurion-opportunity-prompt-v17.md" \
  --allowed-inbound-prompt "$doc_dir/2026-11-02-centurion-opportunity-prompt-v18.md" \
  --allowed-inbound-prompt "$doc_dir/2026-11-02-centurion-opportunity-prompt-v18-reply-review.md" \
  --allowed-inbound-prompt "$doc_dir/2026-11-02-centurion-opportunity-prompt-v18-conference-review.md" \
  --allowed-inbound-prompt "$doc_dir/2026-11-02-centurion-group-review-v18.md" \
  --allowed-inbound-prompt "$doc_dir/2026-11-02-centurion-opportunity-prompt-v22-combined-review.md" \
  --recovered-prompt "$doc_dir/2026-11-02-centurion-opportunity-prompt-v22-combined-review.md" \
  --recovered-input "$source_dir/attachment-v22-noninvoice-input.jsonl" \
  --recovered-results "$source_dir/attachment-v22-noninvoice-results.jsonl" \
  --recovered-input "$run_dir/attachment-v22-deferred-input.jsonl" \
  --recovered-results "$run_dir/attachment-v22-deferred-results.jsonl" \
  --allowed-failures "$run_dir/provider-blocked.json" "$@"
