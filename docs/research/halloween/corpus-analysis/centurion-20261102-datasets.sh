#!/usr/bin/env bash
# Recreate either final candidate dataset at a new private output path.
set -euo pipefail
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
cd "$repo_dir"
doc=docs/research/halloween/corpus-analysis
base=.private/centurion-opportunity-october-20261101
period="${1:?use main or earlier}"
output="${2:?provide a new .private output JSONL path}"
if [[ "$period" == main ]]; then
  d="$base/bulk-v22-effective"
  exec python3 "$doc/mailbox-dataset-join.py" \
    --labeled "$d/labeled-final-v30.jsonl" --action-input "$d/action-input-final-v30.jsonl" \
    --prior-action-input "$d/action-input-final-v28.jsonl" \
    --prior-action-input "$d/action-v29-rerun-input.jsonl" \
    --prior-action-input "$d/action-v6-sample-input.jsonl" \
    --prior-action-input "$d/action-v6-remainder-input.jsonl" \
    --prior-action-input "$d/action-v30-changed-input.jsonl" \
    --action-results "$d/action-v28-full-results.jsonl" \
    --action-results "$d/action-v29-rerun-results.jsonl" \
    --action-results "$d/action-v6-sample-target-results.jsonl" \
    --action-results "$d/action-v6-remainder-results.jsonl" \
    --action-results "$d/action-v30-changed-results.jsonl" \
    --action-prompt "$doc/2026-11-02-luna-action-details-prompt-v4.md" \
    --action-prompt "$doc/2026-11-02-luna-action-details-prompt-v6.md" \
    --classification-results "$d/results-inbound.jsonl" \
    --classification-results "$d/attachment-v22-deferred-results.jsonl" \
    --classification-results "$base/bulk-v18-effective/attachment-v22-noninvoice-results.jsonl" \
    --classification-results "$d/envelope-v23/results-v23-all.jsonl" \
    --classification-results "$d/semantic-v24-full-results.jsonl" \
    --classification-results "$d/reply-v24-allcandidate-results.jsonl" \
    --group-context-manifest "$d/group-context-final-v30-manifest.json" --output "$output"
elif [[ "$period" == earlier ]]; then
  d="$base/pre-sep26-v24"
  exec python3 "$doc/mailbox-dataset-join.py" \
    --labeled "$d/labeled-final-v4.jsonl" --action-input "$d/action-input-final-v4.jsonl" \
    --prior-action-input "$d/action-input-pre-group-review.jsonl" \
    --prior-action-input "$d/action-rerun-input.jsonl" \
    --prior-action-input "$d/action-new-v2-input.jsonl" \
    --prior-action-input "$d/action-v7-sample-input.jsonl" \
    --prior-action-input "$d/action-v7-remainder-input.jsonl" \
    --prior-action-input "$d/action-v3-changed-input.jsonl" \
    --prior-action-input "$d/action-v4-changed-input.jsonl" \
    --action-results "$d/action-initial-results.jsonl" \
    --action-results "$d/action-rerun-results.jsonl" \
    --action-results "$d/action-new-v2-results.jsonl" \
    --action-results "$d/action-v7-sample-results.jsonl" \
    --action-results "$d/action-v7-remainder-results.jsonl" \
    --action-results "$d/action-v3-changed-results.jsonl" \
    --action-results "$d/action-v4-changed-results.jsonl" \
    --action-prompt "$doc/2026-11-02-luna-action-details-prompt-v4.md" \
    --action-prompt "$doc/2026-11-02-luna-action-details-prompt-v7.md" \
    --classification-results "$d/results-inbound.jsonl" \
    --classification-results "$d/available-attachment-reviewed-results.jsonl" \
    --classification-results "$d/group-review-v26-results.jsonl" \
    --group-context-manifest "$d/group-context-final-v4-manifest.json" --output "$output"
else
  printf 'unknown period: %s\n' "$period" >&2
  exit 2
fi
