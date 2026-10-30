---
title: Centurion Evidence Investigation - Plan
type: feat
date: 2026-10-30
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
---

# Centurion Evidence Investigation - Plan

## Goal Capsule

Build an internal, PDF-first investigation of relationships between saved Centurion mail, selected confirmation documents and available later HMS observations. The immediate deliverable is a private casebook and an assistant-inspected baseline. Then add individual PDF and inbound-first lookup. This is not a staff workflow or a production release.

The owner has requested planning and adversarial review only. This plan is not authority to execute code, run a data batch, commit, push, query live HMS, send mail, deploy or change flags. Preserve all existing worktree changes and saved sources. New raw-source copies, casebook data and inspection artifacts stay under ignored `.private`; never send guest mail, PDF text, guest identifiers or credentials to a model or external service. Existing source captures elsewhere must not be moved, deleted or overwritten.

## Product Contract

### Requirements

**Cases and sources**

- R1. Make one case per selected PDF attachment, including zero-candidate cases, with its saved parent message where available. Preserve every source-row occurrence and treat ambiguous identity as unresolved.
- R2. Include the reviewed window for checked examples and the broader saved Centurion snapshot for candidate discovery. Retain missing metadata as unknown without an old-ingest repair project.
- R3. Preserve every saved email, PDF version and HMS observation as a separate item. Preserve capture time, source references, multiple associations and contradictions.
- R4. Link saved HMS observations only when an existing, auditable source association exists. Never equate a later read with earlier HMS state.

**Candidate and evidence behavior**

- R5. Generate cross-thread candidates from exact normalized participant-address overlap. Do not use domains alone, provider alias guesses, time cutoffs or automatic booking merges.
- R6. Preserve attachment-parent, same-thread and exact-header relationships independently. Record each claim's evidence and status separately.
- R7. Preserve all address candidates and every reason, including hotel-mailbox-only overlaps. Provide scalable access with no silent output or inspection truncation.
- R8. Treat a captured PDF as a captured document, not proof of successful delivery or booking-entry time. Treat saved thread membership as structure, not proof of business relevance.

**Private investigation and lookup**

- R9. Use deterministic local processing for the full casebook and assistant inspection of privacy-safe evidence packets. Keep any uninspected or insufficiently evidenced claim unknown; report inspection coverage.
- R10. Report zero/one/many candidate counts, fan-out, evidence types, conflicts, missing signals, source exclusions and coverage for both the reviewed window and the full snapshot. Separate a completed search with zero matches from an unavailable or incomplete search. Label judgments assistant-adjudicated, not independent precision or recall.
- R11. After inspecting the PDF-first batch, add individual PDF lookup and inbound-first lookup against the same private saved sources.
- R12. Keep this internal. Do not change pane, ingest, schema, HMS, production, deployment, outbound mail or feature flags.

### Acceptance examples

- AE1. A PDF with no matching participant still produces a case. Its result is zero only when the available-source search completed; otherwise it is incomplete or unknown.
- AE2. Two messages share only a mailbox verified as belonging to the hotel. The pair remains visible with a weak, hotel-only address reason, not a confirmed booking.
- AE3. A parent email holds multiple PDFs. Each PDF receives its own case and retains the shared parent without merging the PDFs.
- AE4. Exact headers link messages with different recipients. The header relationship remains visible even if no address-based candidate exists.
- AE5. A later HMS observation disagrees with a PDF. Both values and their observation times remain visible as conflicting evidence.
- AE6. Missing message headers, raw MIME or extracted PDF text become unavailable evidence, not proof of nonexistence or a trigger for production repair.

## Planning Contract

### Evidence and constraints

The saved all-mail snapshot contains 16,041 rows. The filename-filtered selection has 1,880 PDF records. The reviewed window contains 5,229 messages and 473 selected PDF records. These are selected saved-source counts, not complete attachment or booking counts. The all-mail export has no raw MIME objects or attachment descriptors. Previously documented PDF text extraction spans differ and must be reconciled before joining. See `docs/research/halloween/corpus-experiments/month-source-inventory.md:44-61` and `docs/research/halloween/centurion-confirmation-pdf-dataset.md`.

The existing offline PDF dataset builder emits one record per attachment and already records parent, thread and header links. A missing parent ID yields no link edges, but the builder still writes the PDF record; treat its search as incomplete, not as a dropped record or verified zero. Its cross-thread candidates use confirmation-number tokens; it does not currently index participant addresses. Those existing candidates are review-required, not a verified answer key. Its pair-level aggregation takes the strongest tier and combines review flags, so reuse must not transfer that aggregate state to separate claims. See `apps/server-pilot/scripts/build-centurion-confirmation-pdf-dataset.ts:317-318` and `apps/server-pilot/scripts/centurion-confirmation-pdf-links.ts:133-168`.

The snapshot holds role-specific current and original addresses but not the separately queried transport identity set. See `apps/server-pilot/src/ops/centurion-thread-corpus-snapshot.ts:35-40` and `apps/server-pilot/src/ops/centurion-thread-corpus-postgres-reader.ts:690-722`. If saved identity metadata cannot be verified, hotel-only classification stays unknown. Prior evidence linked the five-day subset of 92 PDFs to 87 distinct later HMS results. A separate added-period check linked 381 selected records to later saved captures by attachment ID and filename-derived token. Neither check proves historical state, parsed PDF content, full field correctness or HMS coverage for the 1,880-record selection. See `docs/research/halloween/corpus-experiments/month-source-inventory.md:46-61`.

PDF-first sampling excludes requests that never produced selected confirmations. The 60-message inbound sample was stratified, not representative. Source: `docs/research/halloween/corpus-experiments/month-decision.md`.

### Provisional execution forecast

**Planning estimate: approximately 200 minutes elapsed**, with a rough 150–300 minute planning range. This is a low-confidence forecast for the complete internal slice, not a measured runtime, a statistical interval or a hard stop. It assumes two coding lanes can work in parallel after the shared contracts are set, the saved inputs reconcile, and same-version checks are available under the eventual execution authority. It includes the offline batch, an assistant-inspected spread, both lookups, integration and targeted checks. It excludes new PR review, merge, deploy, live HMS work and external or human-approval waits.

| Critical-path stage | Raw working estimate | Calibrated estimate |
| --- | ---: | ---: |
| Source contract and adapter | 35 min | 30 min |
| Address core and safe output in parallel | 75 min | 65 min |
| Saved batch and assistant inspection | 50 min | 40 min |
| PDF and inbound lookup | 30 min | 25 min |
| Integration and targeted verification | 45 min | 40 min |
| **Elapsed total, rounded** | **235 min** | **200 min** |

The components are informed judgment calls, not measured durations for these units. The closest prior PDF re-extraction processed 432 PDFs and took 23 minutes 18 seconds including integration and audit. A separate journey review took 29 minutes 23 seconds and inspected 10 selected PDF anchors and 3 request-first journeys. A prior index lane took 10.7 minutes; a different extractor lane took 90 minutes, including 40 minutes stuck. These are distinct scopes, models and samples, not a proven speed for this build. The host ledger's mixed-scope median actual-to-estimate ratios are 0.85 for 157 server-code observations and 0.80 for 50 research observations. Apply those separately to the raw code and research components, then round: `(185 × 0.85) + (50 × 0.80) = 197.25` minutes.

Actual address fan-out, source reconciliation, inspection throughput and review rework remain unknown. The first measured proof must revise the forecast. If sources or same-version checks are unavailable, report the specific hold rather than silently declaring the full slice complete. See `docs/research/halloween/corpus-experiments/month-run-retro.md` and the host ETA ledger.

### Key technical decisions

- KTD1. Keep separate source items and separately typed evidence claims. A strong attachment or header relation does not upgrade a different same-stay inference.
- KTD2. Match exact normalized participant addresses across saved roles. Index the snapshot's existing canonical address arrays, which already use lowercase normalization; retain original source values only in private storage. Normalize a parent outside the snapshot consistently, without provider aliases or plus-tag equivalence. Never discard an already saved canonical match solely because its original formatting is ambiguous; flag ambiguous or unparseable source fields as incomplete. Lowercasing is a practical matching convention, not proof that case-distinct local parts are the same mailbox. The snapshot retains address roles but does not itself retain the transport identity set. Obtain the mailbox identity only from separately saved, attributable configuration if available; never query live systems, hard-code an address or infer authoritative identity from direction alone. A pair is hotel-only only when every overlap is known to belong to the hotel; otherwise mark classification unknown where identity is insufficient. Never suppress those candidates. Show the parent and known same-thread messages as structural context rather than counting the parent as its own cross-thread candidate. If either thread ID is missing, retain an address match with cross-thread status unknown rather than dropping it.
- KTD3. Default to a factorized casebook: an address-to-message posting index plus PDF anchors, not a stored PDF/message cross-product. Page a deterministic sorted union of postings and reconstruct every role-specific reason for each pair. Count distinct PDF/message pairs over that union, with resumable cursor state tied to the source manifest. Model-visible cursor tokens must be opaque and must not embed source identifiers or paths; keep their position mapping private. Benchmark actual fan-out and resource use before committing to the storage representation. Provide complete candidate access; do not materialize a cross-product in RAM or silently cap it. As an illustration only, the theoretical full cross-product is 30,157,080 pairs; at the existing link file's approximately 321 bytes per link that would be approximately 9.68 GB before new evidence. Actual candidate volume and output size are unknown.
- KTD4. Join sources only with documented IDs and snapshot provenance. Key cases by source-scoped attachment identity, retain all source-row occurrences, and preserve distinct attachment versions. The existing linker's `byDbId` map overwrites a prior occurrence when the same `sourceRowId` repeats; do not reuse it as the authoritative source index. Preserve both occurrences and report conflicting ID reuse as ambiguous. If attachment identity is missing or ambiguous, retain a row-scoped unresolved case instead of guessing whether two documents are duplicates. Do not collapse source rows from content or provenance fingerprints alone. Record private input checksums and verify them before processing and resuming; changed inputs invalidate the checkpoint. Manifest missing, invalid and unreadable inputs separately.
- KTD5. Generate model packets via a fail-closed allowlisted schema with enum facts, coarse relationships and keyed opaque IDs. No raw/free text, names, original identifiers, exact guest dates or source paths in model context. Keep ID mapping and key local and private. Process output visible to a model must use the same allowlist, including error paths; store detailed diagnostics privately and emit fixed safe error codes. Reject unexpected fields and test synthetic canaries.
- KTD6. Do not claim all candidates were semantically reviewed when only deterministic processing ran. Report eligible, inspected, unknown and uninspected counts separately; allow an assistant-adjudicated baseline without independent truth. Completeness is relative to a named saved snapshot and each evidence signal, not all historical mail. Count missing participant fields and distinguish them from a known empty address set. If the saved schema does not distinguish an empty array from missing or failed parsing, report the field's completeness as unknown rather than inventing a known-empty result.
- KTD7. Use confirmation-number and saved HMS evidence only to support or challenge already surfaced claims and exact structural relations. The existing mail linker scans arbitrary six-to-ten-digit tokens, so an unlabeled numeric match is only a weak numeric-token reason, not a confirmed reservation number. A labeled or structured confirmation field may provide stronger corroboration when its provenance supports that claim. Do not silently add a new cross-thread candidate heuristic to v0.

Each private case contains a case key, source-scoped PDF identity, parent availability, per-signal search-completeness states, independent relationship claims and references to saved evidence. Each claim records its exact proposition, evidence type, source reference, reason and inspection state. A search is complete only within the named snapshot and for available fields; missing fields or sources produce a partial or unavailable signal. The private source manifest records input versions and omissions.

A model-facing packet is a separate, strictly validated object with per-run opaque IDs and allowlisted enum or boolean facts only. Allowed facts may include source role, header relation, mailbox-only classification, exact confirmation-token equality, coarse date relation and later-observation conflict. Values, source paths, free-form reasons and exact dates stay local. Count bands are allowed only as defined enum values. Unknown or unsupported fields fail closed rather than falling back to redacted text.

Statuses attach to the specific proposition, not to a combined pair. `supported` requires evidence and provenance for that proposition that the assistant can evaluate from the safe packet; `candidate` means a plausible but unconfirmed proposition; `conflicting` means comparable observations disagree; `unknown` covers insufficient or uninspected evidence. A bare inferred same-stay boolean is not a substitute for its underlying evidence. An exact-address overlap can be structurally supported while the separate same-stay proposition remains unknown. Same-thread membership, a captured PDF or a common hotel address alone never proves the same stay. Any supported judgment is still research evidence, not independent proof of historical truth.

### Sequence and ownership

One coordinator owns the source schema, integration and reports. Independent coding can begin only after agreeing the source and packet contracts and naming file owners. Avoid concurrent edits to shared files. Current existing scripts are untracked or modified; do not assume another worktree contains them. A small proof checks one synthetic and one privately available source case before the full saved batch. The full batch and assistant inspection precede the PDF and inbound-first lookup work.

### Provisional code budget

These are rough incremental line-change estimates, not measured diffs. They use existing file sizes as a scale check, not a universal lines-per-minute conversion. Existing untracked code is excluded and must be accounted for separately if incorporated into a clean implementation. A bare extension to the old linker would be smaller but would omit the requested source reconciliation, safe packets, baseline, recovery and both lookup paths.

| Unit | Product changes | Test and fixture changes |
| --- | ---: | ---: |
| U1. Manifest and source adapter | 250–400 | 180–280 |
| U2. Candidate and relationship index | 350–550 | 250–400 |
| U3. Private casebook and safe packets | 250–400 | 200–320 |
| U4. Batch and baseline reporting | 150–250 | 80–150 |
| U5. PDF and inbound lookups | 150–250 | 100–160 |
| Total incremental forecast | 1,150–1,850 | 810–1,310 |

The existing untracked PDF builder, field extractor and linker contain 469, 94 and 244 lines, respectively. Their corresponding tests contain 162, 36 and 70 lines. If all six are incorporated unchanged into a clean version, that adds 807 existing product lines and 268 existing test lines to its diff. Under that illustrative no-overlap scenario, the full clean diff would be approximately 1,957–2,657 product lines and 1,078–1,578 test lines. The actual included subset remains unmeasured. The budget was raised after adversarial review identified uncounted source reconciliation, occurrence preservation, packet failure handling and synthetic tests; it remains an expert forecast rather than a measured diff. If a later PR is authorized, the merge gate counts product additions plus deletions and excludes qualifying tests, fixtures and Markdown. Partition any applicable PRs to respect the current approximately 500-product-line cap without treating untracked files as already merged. See `scripts/orch/merge-gate.sh:45-58`.

## Implementation Units

### U1. Establish source manifest and case identity

- **Owner:** Data adapter implementer.
- **Goal:** Produce a stable, reproducible per-PDF inventory, with parent and available saved HMS pointers.
- **Requirements:** R1–R4, R8.
- **Dependencies:** Existing saved source manifests and compatible formats.
- **Files:** New `apps/server-pilot/scripts/centurion-evidence-sources.ts` and `apps/server-pilot/tests/centurion-evidence-sources.test.ts`. Existing PDF field and link scripts are references, with reuse subject to clean-version ownership.
- **Approach:** Identify saved inputs without reading guest data into model context. Reconcile snapshot identity and selected-PDF extraction coverage. Emit source status for unavailable parents, files and metadata. Preserve source-row identity and independently saved PDF versions.
- **Patterns to follow:** Existing offline PDF extractor and corpus snapshot contract, without changing the fixed-window production reader.
- **Test scenarios:** Distinct PDF versions and multiple PDFs per parent; missing attachment, missing parent, empty snapshot and malformed record; repeated source-row ID with contradictory payloads; duplicate-looking but distinct source rows; empty address array with unknown completeness; later HMS attachment with source provenance.
- **Verification:** Every selected PDF has its own case, including unavailable or unreadable source files. Malformed source rows that cannot be mapped to a PDF are reported separately and make the run partial, not complete. Manifest and input version identifiers reproduce the result.

### U2. Generate evidence and complete candidate access

- **Owner:** Linker implementer.
- **Goal:** Preserve exact structural relations and role-aware address candidates with all independent reasons.
- **Requirements:** R3, R5–R8.
- **Dependencies:** U1 case and source contract.
- **Files:** New `apps/server-pilot/scripts/centurion-evidence-linker.ts` and `apps/server-pilot/tests/centurion-evidence-linker.test.ts`. Reuse exact-message-ID helpers if compatible.
- **Approach:** Normalize addresses conservatively, index by exact address, preserve all roles and reasons, and mark verified hotel-only overlaps as weak. Keep structural edges independent of inferred same-stay claims. Start with factorized access and benchmark fan-out before choosing whether additional streaming or storage is needed.
- **Patterns to follow:** `apps/server-pilot/src/mail/ingest/message-id.ts`; existing offline linker for structural evidence, with relationship-level rather than collapsed review state.
- **Test scenarios:** Same hotel mailbox across unrelated stays, unknown hotel identity, exact same external participant, domain-only false match, case normalization, multiple match reasons, duplicate message headers with multiple plausible targets, a structural and weak candidate reason on the same pair, missing thread ID, missing participant fields, a phone or date mistaken for a confirmation token, multiple confirmations and contradictory versions.
- **Verification:** Synthetic results preserve every selected PDF and every candidate reason; no domain-only match or booking merge appears; output is stable and fully pageable.

### U3. Create private casebook and safe inspection packets

- **Owner:** Privacy/output implementer.
- **Goal:** Write a local private casebook and strictly allowlisted packets that cannot accidentally carry source text.
- **Requirements:** R1–R4, R6–R10.
- **Dependencies:** U1 schema and U2 relationship contract.
- **Files:** New `apps/server-pilot/scripts/centurion-evidence-casebook.ts`, `apps/server-pilot/scripts/centurion-evidence-packets.ts` and corresponding synthetic tests under `apps/server-pilot/tests/`.
- **Approach:** Create a new owner-only run directory under ignored `.private` with exclusive creation; reject symlinked output targets and never overwrite inputs or another run. Keep source IDs and keyed mapping local. Emit only fixed schema fields and fail closed on unsafe content. Write a partial manifest before processing and mark it complete atomically only after all required stages finish. Resume only against the same verified inputs. Use factorized access, streaming or pagination according to measured fan-out.
- **Patterns to follow:** Existing snapshot manifest and PDF dataset naming/record conventions where compatible.
- **Test scenarios:** Canary text in subject/body/name/filename/error and cursor; unexpected nested keys; path leaks; interrupted output; a changed input on resume; symlinked target; duplicate reasons; malformed or partial sources.
- **Verification:** No source text, guest identifiers, exact dates, paths, or non-allowlisted fields reach assistant packets or model-visible logs. A failed or partial run cannot be mistaken for complete. Casebook results reproduce against the same source manifest; opaque packet IDs may change with the per-run key.

### U4. Run the offline batch and inspect a baseline

- **Owner:** Coordinator and assistant inspector.
- **Goal:** Build all eligible selected-PDF cases and review a documented spread without staff reviewing the candidate list.
- **Requirements:** R1, R2, R8–R10.
- **Dependencies:** U1–U3 and explicit later execution authorization.
- **Files:** New `apps/server-pilot/scripts/centurion-evidence-batch.ts` and `apps/server-pilot/tests/centurion-evidence-batch.test.ts`; new private run directory; a sanitized research summary only if it carries no guest data.
- **Approach:** Validate source manifest and run a small end-to-end check. Measure source reconciliation, posting-list fan-out and safe-packet inspection throughput during an initial documented spread of case types. Use those measurements to calibrate and report an updated completion estimate without silently limiting the run or claiming the spread is representative. Process the full selected inventory using only saved data. Inspect sanitized packets across zero-match, weak-only, high-fan-out, structural, version-conflict and multi-stay cases. Count automated versus assistant-reviewed claims; record unknowns, failures and partial coverage.
- **Patterns to follow:** `docs/research/halloween/corpus-experiments/month-sample-protocol.md` for source and selection discipline, without claiming its stratified sample is representative.
- **Test scenarios:** Known contradictory document versions, multiple stays, repeated sender, missing headers, missing extraction and distinct exact structural links.
- **Verification:** Counts reconcile to the frozen selection and all partial failures are explicit. Report limitations and absence of independent truth; do not set an invented pass bar.

### U5. Add item lookup and inbound-first lookup

- **Owner:** Lookup implementer.
- **Goal:** Reuse the casebook index to investigate one PDF or start from one inbound message after the batch review.
- **Requirements:** R5–R11.
- **Dependencies:** U2–U4 and actual batch observations.
- **Files:** New `apps/server-pilot/scripts/centurion-evidence-lookup.ts` and `apps/server-pilot/tests/centurion-evidence-lookup.test.ts`.
- **Approach:** Query the same snapshot and claim model. Keep source pointers, signal availability, multiple PDF versions and all candidate reasons. Preserve pagination and make zero results distinct from absent data.
- **Patterns to follow:** U2–U3 index and manifest contracts.
- **Test scenarios:** Existing and missing PDF, inbound message with zero/one/multiple PDFs, one inbound tied to multiple candidate stays, absent metadata and high fan-out.
- **Verification:** Both lookups agree with batch results for the same versioned sources and never mutate source records or infer a canonical booking.

## Verification Contract

- Test synthetic data only using the targeted Vitest files. Unset `DATABASE_URL`, `VITEST_ALLOW_PILOT_RDS` and `TEST_DATABASE_URL` in the same shell before invoking Vitest. Never test against pilot RDS. From the repository root, the planned targeted invocation is:

  ```bash
  unset DATABASE_URL VITEST_ALLOW_PILOT_RDS TEST_DATABASE_URL
  pnpm --filter=@zero/server exec vitest run --maxWorkers=1 \
    tests/centurion-evidence-sources.test.ts \
    tests/centurion-evidence-linker.test.ts \
    tests/centurion-evidence-casebook.test.ts \
    tests/centurion-evidence-packets.test.ts \
    tests/centurion-evidence-batch.test.ts \
    tests/centurion-evidence-lookup.test.ts
  ```

  These files are planned, not present or run. Respect current host capacity and project test guidance.
- Check memory, CPU and active workloads before potentially heavy local tests. Reduce test scope or use the approved Product EC2 route if capacity is tight; do not interrupt another session.
- The approved `/home/orca/bin/remote-typecheck.sh` requires a clean tracked worktree and checks only committed HEAD. It ignores untracked files. The approved remote Vitest helper has the same prerequisite and may continue after a typecheck failure, so record both results independently. Do not silently commit or claim a check passed without explicit authority and same-version proof.
- No tests, data processing, live queries or production operations are authorized by this planning request. If remote checks or an input are unavailable during a future authorized run, report the specific hold rather than substituting another source or claiming completion.
- If a later explicitly authorized PR or merge is pursued, follow `AGENTS.md`, current product-line limits, same-head checks, required Greptile Apex and the merge gate. Do not add or trigger GitHub Actions.

## Definition of Done

- The private batch accounts for every selected PDF attachment and source-row occurrence, and preserves each document version, source observation and candidate reason. Ambiguous identity is reported as unresolved.
- The assistant-inspected baseline reports coverage, missing data, unknowns, conflicts and any incomplete work without independent-accuracy claims.
- PDF and inbound-first lookup return the same evidence as the frozen batch and remain internal.
- Targeted synthetic tests and applicable same-version checks pass on the implemented version. If a required input or check is unavailable or unauthorized, report the work as partial with the exact hold; do not silently skip it or declare completion.
- No guest data appears in model packets, logs, external services or public artifacts. No production system, staff surface or unrelated worktree file is changed.
