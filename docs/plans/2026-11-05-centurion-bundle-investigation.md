---
title: Centurion native bundle usage investigation
execution: knowledge-work
owner: this chat
date: 2026-11-05
---

# Goal

Determine which native Meal Plans, Non-Room Bundles and Non-Room Items Centurion
actually uses, how saved rows relate to rate plans and bundle components, and
whether a separate bundle workflow is worth building. Preserve the entire
investigation in reusable private JSON, including failures and incomplete reads.

The owner authorized deep planning followed by autonomous implementation and
live read-only collection. This chat owns the investigation. Other chats own
guest-profile work and Add-On insert/edit/remove work. Do not direct, interrupt
or modify their worktrees. Deployment and all HMS writes are outside scope.

## Known evidence

- PR #1047 merged `readStay360AddOns(page, confirmation, {detailIds})` and the
  Non-Room Item catalogue/preparation/save tools. The reader retains native grid
  fields and completeness; the catalogue currently binds `itemtype=ITEM`.
- A captured native OSENEX response exposed type options `MEAL` (Meal Plan),
  `PACK` (Non-Room Bundle) and `ITEM` (Non-Room Item), with saved-grid fields
  `itemtype`, `bundleid`, `enhancedbundleid` and `packageitem`.
- The existing corpus is
  `/home/orca/.local/share/zero/research/halloween/raw-data/stay360-1a-1b-1c-20261029-run01.json`.
  SHA-256: `85e6891ce4bdda359b4ca01092467573797b4914b915974fd9b62b2e4257a085`.
  It contains 894 distinct confirmation candidates, 892 successful historical
  reads and two failures. All 894 have arrival hints. The 492 E-Mail stays used
  by the profile investigation are a subset; 440 profile identities are not the
  bundle-analysis denominator.
- Historical statuses: Checked Out 616, Cancelled 144, Reserved 76, In-house 37,
  No Show 19. Of 892 historical records, 885 show breakfast/dinner-inclusive
  meal-plan labels. These labels are not proof of manually attached PACK rows.
- The old shallow snapshots captured an unexpanded Add-Ons card. Two current
  real-confirmation pilot reads returned complete empty Add-On grids. Neither
  observation establishes hotel-wide absence of bundles.
- The cohort derives from outbound confirmation PDFs, not a random sample or
  a complete hotel census. Current state is not booking-time history.

## Questions and acceptance

1. What native categories and current catalogue entries exist? Catalogue
   configuration must be separated from saved usage.
2. Which cohort confirmations currently have MEAL/PACK/ITEM rows? Report the
   denominator of complete reads, not just attempted confirmations.
3. Which parent/component links and package flags are actually present?
   Preserve raw IDs; count a bundle once rather than treating each child as a
   separate bundle. Ambiguous/orphan relationships remain explicit.
4. How do current rows and meal-plan labels relate to current/historical rate
   plans? Correlation is not proof of automatic creation or pricing rules.
5. What native bundle read/write operations would be needed next? A catalogue
   row, enabled control or saved value is not proof of supported writes.

## Implementation sequence

### U1. Freeze the cohort and save historical analysis

- Owner: this chat.
- Inputs: the exact corpus above, existing private pilot evidence and current
  merged reader code.
- Files: new `diagnostics/analyze-centurion-bundles.py`; private manifest,
  candidates and historical-analysis JSON.
- Validate source hash, confirmation uniqueness, successful identity checks,
  date hints and historical fields. Preserve source PDF linkage and both failed
  records; use hints for lookup, not as current truth.
- Acceptance: 894 candidates accounted for, source hash preserved, reproducible
  historical distributions saved as JSON.

### U2. Inspect native categories and catalogue coverage

- Owner: this chat. Dependency: U1.
- Reuse saved-confirmation lookup, existing Add-On reader and native parsers.
  Inspect current type options and native read requests under a persistent
  write fence. Read MEAL/PACK catalogues and the ITEM catalogue for comparison.
- Add only missing typed catalogue/detail operations, in a separate small
  read module if necessary. Keep existing insert/edit/remove contracts intact.
- Capture applied type, current codes/names/IDs, labels, component options,
  native metadata, loaded/total/completeness and observation time. Pagination
  must be correlated to the current lookup; capped results remain incomplete
  until all pages are verified.
- Acceptance: categories are verified live and each catalogue has honest
  coverage. A missing/unsupported read is recorded rather than called empty.

### U3. Build a resumable read-only batch wrapper

- Owner: this chat. Dependency: U1; U2 informs extra detail fields.
- Files: new `diagnostics/batch-read-addons.mjs`; narrowly scoped reader or
  lifecycle export changes only if native proof establishes the need.
- Input: `{propertyCode, sourceSha256, candidates:[{confirmation, guestName,
  arrivalDate, historical, provenance}]}`.
- Each item performs exact confirmation lookup and captures its current
  shallow fields before `readStay360AddOns`. The Add-On reader binds a page to
  one confirmation; never retarget that page's existing authority/state.
- Try fresh pages in a guarded authenticated context only after proving their
  login/navigation and Notes lifecycle. Otherwise use the already proven fresh
  browser/session per confirmation. Prefer a simple wrapper to a new framework.
- Start one worker. Increase to two only when observed HMS behavior and host
  headroom permit. Bound record/session waits; restart a failed page/session.
  Hold every chunk's results provisional until context/browser cleanup passes.
- Checkpoint individual private JSON snapshots and an atomic progress index.
  Resumption verifies the input hash and retains previous attempts. Do not
  overwrite earlier evidence or silently skip failures.
- Acceptance: concurrent/fresh targets cannot cross, completed results survive
  interruption, and guard/cleanup failures cannot become verified reads.

### U4. Prove the batch on varied records

- Owner: this chat. Dependencies: U2 and U3.
- Select a small stratified pilot across historical statuses and meal/rate
  labels. Include an already populated owned Labtest Add-On as reader-positive
  evidence, but exclude Labtest from hotel-usage counts.
- Verify native identities, current context, full/empty grids, row types and
  relationship fields. Read existing details without applying changes.
- Acceptance: positive and empty reads work, failures stay explicit, and any
  target/page or completeness gap is fixed before the census.

### U5. Read all 894 confirmations

- Owner: this chat. Dependency: U4.
- Run the full candidate list, including the two historically failed lookups.
  Keep source-confirmation identity and use date/name hints when required.
- Preserve every first attempt. Retry ordinary transient failures in a fresh
  session, at most twice; use returned identity choices only when evidence
  resolves them. Persistent ambiguity, unavailable records and incomplete
  capture remain outcomes, not zero-bundle observations.
- Acceptance: all 894 have an attempted, checkpointed outcome. Report complete
  reads, partial reads, failures, retries and unverified sessions separately.
  Full attempt coverage is not full successful coverage.

### U6. Inspect populated examples and rate relationships

- Owner: this chat. Dependencies: U2 and useful U5 results.
- Read full detail for bundle-bearing records, each distinct code and varied
  parent/component structures. Compare selected examples with fresh readers.
- Inspect relevant current rate/meal associations only through established
  read surfaces. Do not update a stay or calculate a local pricing rule.
- If no PACK rows exist in the completed cohort, retain that finding and the
  configured catalogue separately; do not manufacture a fake bundle write.
- Acceptance: reported relationship semantics have native examples, or are
  explicitly unknown. Detail samples and selection rationale are saved.

### U7. Build the reusable analysis and recommendation

- Owner: this chat. Dependencies: U1, U2, U5 and U6.
- Produce JSON distributions by saved type/code, confirmation, status and rate;
  parent/component counts; historical/current disagreements; and coverage.
  Deduplicate by confirmation and native saved-row ID. Preserve contradictory
  or missing values instead of assigning convenient defaults.
- Produce a short aggregate Markdown report in `docs/research/halloween/`,
  linking private JSON paths and giving the next-tool recommendation.
- Acceptance: every aggregate can be reproduced from saved JSON. Conclusions
  distinguish current observation, historical evidence, configuration and
  inference. No credentials or raw guest data enter tracked files.

### U8. Verify the delivered scripts and artifacts

- Owner: this chat. Dependencies: relevant code units and U7.
- Run syntax and existing focused reader/lookup/guard checks only; no new
  tests. Unset all test DB environment variables. Use remote server-pilot
  typecheck on a clean committed final head; no local tsc/tsgo.
- Review changed code for read boundaries, identity, timeout/cleanup handling,
  coverage and resumability. Preserve a local commit if needed for durable
  code and final-head checks. No push, PR, merge or deployment is required by
  this investigation request.
- Verify artifact permissions, candidate/result accounting, JSON parseability,
  input hashes and output hashes. Report any unresolved read limitation.

## JSON deliverable

Private root:
`/home/orca/.local/share/zero/research/halloween/bundle-investigation-20261105/`.
Create a unique run directory beneath it; preserve the earlier pilot files.

- `manifest.json`: run ID, source/revision/hash, configuration, times, artifact
  paths and final hashes, scope and explicit limitations.
- `candidates.json`: the complete 894-confirmation input with lookup hints,
  historical fields and source provenance.
- `historical-analysis.json`: offline baseline counts and missing coverage.
- `catalogues.json`: current typed catalogue snapshots and coverage.
- `records/<confirmation>/attempt-<n>.json`: full structured lookup/Add-On
  snapshots or an explicit failure, with timestamps and session attestation.
- `progress.json`: resumable accounting, not a substitute for raw snapshots.
- `reads.json`: finalized all-candidate outcomes and raw artifact references.
- `details.json`: selected populated detail reads and relationship evidence.
- `analysis.json`: reproducible aggregate results, evidence links and the
  recommendation, including uncertainty rather than just headline counts.

Directory mode 0700; JSON files 0600. Keep decimal representations and calendar
dates unchanged. Never serialize credential controls, auth tokens or full
request URLs. Raw guest-containing snapshots remain outside Git.

## Autonomous execution and completion

Run all units inline in this chat. Resolve routine implementation decisions and
read-only retries from evidence. Adapt concurrency and narrow unsupported read
operations without asking for repetitive approval. Keep progress updates tied
to completed counts and findings. Completion time is unknown: the fresh-page
pilot and observed failure rate will establish collection throughput.

The investigation is complete when all candidates are accounted for, the native
catalogue/location questions are answered to their proven scope, analysis is
reproducible from JSON, verification is complete and the recommendation clearly
states what remains unknown. It does not require successful access to every
historical stay, a write canary or production deployment.
