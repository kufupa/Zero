# HMS Cloud box 1 findings

## Real requests

A read-only sample of 20 recent inbound Centurion booking extractions from
October 30–November 1, 2026 was mapped to prepare inputs and run without saving.
At create-tool commit `09fd43c`, all 20 returned `needs_input`: dates and adult
counts were staged for all 20; a guest was selected for 7, 3 were ambiguous,
8 were not found and 2 lacked a usable surname. None was saved.

All 20 lacked confirmed child ages, native room and rate codes, and a guarantee
choice. The extractor's empty child-age arrays did not distinguish zero children
from unknown ages, so the mapping used `null` rather than assuming zero.
Seven names carried titles; an offline comparison after stripping those titles
found three single loaded matches, one of which had incomplete coverage. Raw
inputs and results remain private under `/tmp/hms-cloud-inputs-Wq5uDfLm/`.

This is one extractor version and a convenience sample, not an accuracy or
production-pass measurement. Source mail was not independently checked.

## Box 2 observation

On one existing Proof Labtest stay, unsaved date and adult changes cleared 12
displayed pricing/tax values and two lifetime values. No repricing was observed
in the 1.5-second snapshots; a fresh read confirmed the original record was
unchanged. The Folio tab showed an empty grid, but filtering, pagination and
payment clearance were not established. The Documents UI exposed Browse and
Submit controls; no file was selected or uploaded.

Date and occupancy amendments therefore need explicit form/model, repricing,
availability and readback proof. Folio coverage and an authorized guarded
upload remain separate work. Private screenshots and field evidence are in
`/tmp/hms-box2-scout-ILas7h/`.

The saved-record reader captured a raw note in a live read of an existing fake
stay. Exact padded-note comparison was exercised with test data, without making
an additional live save just for whitespace.
