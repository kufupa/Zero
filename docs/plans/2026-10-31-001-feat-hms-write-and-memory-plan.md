---
title: HMS Cloud Labtest Writes and Memory - Plan
type: feat
date: 2026-10-31
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
---

# HMS Cloud Labtest Writes and Memory - Plan

## Goal Capsule

Build reusable Cloud HMS tools for a fake Labtest create, amend and cancel sequence, expand agent-queryable reservation-note memory, and investigate and advance inbound-to-booking linkage. Work autonomously and quickly: inspect the live UI, reuse working Cloud modules, prove behavior in headless HMS, then broaden only where it helps. The owner expects speed, authorizes Labtest writes, and prefers useful evidence to synthetic test padding. Eight hours is available, not a requirement to spend eight hours.

## Product Contract

### Requirements

- R1. Save a new fake Proof Labtest stay at HRCEN for 2027 or later, with CMS sending disabled, and independently read back its confirmation and record.
- R2. Amend that fake stay using at least one useful supported field, read back the changed values and preserve unexpected or unverified outcomes.
- R3. Cancel that exact fake stay, return the cancellation status and reason, and leave any penalty dialog untouched.
- R4. Permit guarantee selection after both a verified fake guest and a verified A/R selection when current live evidence establishes the safe request and readback.
- R5. Let the agent retrieve historical Reservation Note / Billing Instructions examples and meaningful repeated patterns from matching private memory, preserving provenance, conflicting instructions and material amounts.
- R6. Inspect the prior inbound/outbound evidence work and advance independent permitted linkage analysis without disrupting its worktree, bypassing denied actions or misrepresenting inferred links as verified.
- R7. Keep tools composable and agent-facing: current search IDs, native identifiers, useful response context, explicit stale/incomplete/uncertain states and same-page ordering where HMS requires it.
- R8. Retain correct Hotel Availability for quotes, and keep the current app/pane integration, deployment and automatic staff-facing activation outside this run.

## Autonomous Execution Mandate

Make ordinary reversible decisions and continue independent lanes without waiting for the owner. Reassess and pivot when live evidence disproves an assumption or a lane takes about twice its provisional checkpoint. Report the decision and evidence in the durable plan or private checkpoint. AI may read real guest records; new writes are confined to the fake Proof Labtest guest with 2027+ stay dates. Never send email, accept a cancellation-penalty dialog, alter real guest bookings, bypass existing hooks or checks, test on pilot RDS, or expose guest details, credentials or private evidence in Git or external reviews. User-authorized Labtest creation, amendment and cancellation need no further approval. Unknown fee-policy examples are not hotel policy. Treat a possible dispatched write or timeout as uncertain; reconcile the exact Labtest record before any retry.

## Planning Contract

The existing `apps/server-pilot/tooling/hms-cloud/` readers, `booking-lookup-session.mjs`, selectors and guarded Guest Stay form are the starting point. The session installs a read-only context guard, so a save is not currently enabled merely by clicking its button; inspect the live action and narrowly authorize only a verified Labtest write without weakening general reads. Existing `tooling/playwright-quote/create-lab-stay.mjs`, `amend-stay.mjs` and `cancel-lab-stay.mjs` are references to inspect, not assumed correct Cloud implementations.

At HRCEN, the previous run verified quote -> selected room/rate on an unsaved draft and separate fake-guest -> rate -> guarantee and A/R -> guarantee sequences. It did not prove combined guest+A/R guarantee, a save, an amendment, or a cancellation. In the current run, a live blank form exposed nine required controls (arrival, departure, adults, source, room, rate, track, first name, last name); later dynamic requirements remain unknown. A combined guest+A/R draft preserved both verified identities, and an intercepted guarantee request contained both IDs; the existing guard rejected it before dispatch, so successful selection is not yet proven. The sample had 491/492 E-Mail-source stays with a Reservation Note / Billing Instructions value and 416/491 had an exact or near-text neighbour; similarity does not establish identical amounts or instructions. See `docs/research/halloween/memory-experiments/2026-10-30-email-reservation-note-patterns.md` and `docs/research/halloween/pre-autonomous-build-new-tools-md-30-oct.md`.

**Parallelism.** One write lane owns new save/amend/cancel modules and the new fake stay lifecycle; one lane owns `guest-stay-form.mjs` for combined guarantee; one lane owns memory query files; the coordinator owns the shared session seam and integrates changes when needed. Inbound-linkage research uses its own tree and private evidence. Do not edit the same shared file from multiple lanes, write the same stay from multiple browsers, or drive one page concurrently. Separate headless read/unsaved sessions can run concurrently: prior runs exercised multiple parallel sessions, although that does not establish concurrent writes are safe. Keep each lane accountable for its processes and adapt to host pressure. Start same-head remote checks and Greptile Apex concurrently for each coherent feature slice; merge only after both and diff review finish. Small documentation-only changes may be committed and pushed directly under the owner's current instruction.

**Timing.** The owner targets approximately 15 minutes for the first save module and about one hour for save plus cancel; treat these as targets, not evidence of completed work. In the prior run, 26 feature/fix PRs had a median 11.8 minutes from PR open to merge (range 5.8–35 minutes), excluding development; one first new picker merged around 35 minutes after work began. Current save/cancel timing is unknown until the live UI and request are inspected. Overlap independent work and checks; do not extrapolate precise total time from unrelated PR durations.

## Implementation Units

### U1. Create and verify one fake stay

- **Owner:** write lane. **Requirements:** R1, R7. **Dependencies:** current Cloud bootstrap and unsaved form.
- **Files:** focused new Cloud save module, its usage and a reusable private diagnostic; wire into session only when the capability and ownership are clear.
- **Approach:** inspect the live Save control and requests; confirm exact fake profile, dates, HRCEN, blank prior confirmation, CMS Send unchecked and recipient blank. Before saving, search for matching fake stays on the chosen dates to establish the preimage. Allow only the observed, verified Labtest action on that page; do not turn on writes globally. Expose a single clear save action and independently reopen the resulting confirmation to verify identity, dates, room/rate and CMS state. Capture whether browser-side send requests were observed; this alone cannot prove what HMS may queue server-side. If save may have fired but is unconfirmed, return uncertainty and reconcile against the preimage before any retry.
- **Patterns to follow:** native request/readback binding, page lifetime fences and explicit uncertainty in current Cloud selectors.
- **Test scenarios:** one real fake Labtest save; read-only reopening by returned confirmation; no accidental email; wrong/unknown identity, unexpected dialog and timeout do not become success.
- **Verification:** live request/response, same-form readback and independent confirmation lookup; retain private evidence.

### U2. Amend and cancel the saved fake stay

- **Owner:** write lane. **Requirements:** R2, R3, R7. **Dependencies:** the newly created U1 fake-stay confirmation. The earlier 2027-12-08 fake stay has a recorded hold to leave it reserved; use it only for non-mutating exploration.
- **Files:** separate focused Cloud amend and cancel modules and usage; reuse existing readers.
- **Approach:** re-open the exact fake stay and verify confirmation, guest and dates. Inspect the record's actual writable controls; first amend one non-identity field with a synthetic run marker and read it back, leaving dates, room, rate and identities untouched. Inspect cancellation reasons and fee prompts. A prior HRCEN Labtest cancellation took effect after the reason was confirmed, before a later penalty dialog appeared (`docs/research/2026-10-22-sr3-proofs.md`); do not assume the penalty dialog precedes the cancellation. Do not accept any fee/penalty dialog during amend or cancel. Cancel only the newly created fake stay; reconcile and separately report status and any pending fee/dialog, without inventing rules or retrying an uncertain mutation.
- **Patterns to follow:** explicit current native IDs, state/readback and narrow action authorization; previous scripts are hints only.
- **Test scenarios:** saved fake stay -> amendment -> reopen/readback -> cancel -> reopen/status; already-cancelled, identity mismatch, unexpected warning or fee, and dispatched-but-uncertain outcomes remain distinct.
- **Verification:** live HMS screenshots/requests/readbacks privately; no second click after ambiguous writes without reconciliation.

### U3. Support verified guest plus A/R guarantee

- **Owner:** separate guarantee lane. **Requirements:** R4, R7. **Dependencies:** current same-page fake guest and A/R selectors; independent of U1 implementation.
- **Files:** `guest-stay-form.mjs` and its guide; coordinate any shared selector changes.
- **Approach:** capture the actual fake-draft state and native request after both selections; bind both current proofs and IDs to the same page, form and session. Preserve invalidation after new searches and the page-lifetime request fence. Read back guest, A/R, guarantee and any previously selected rate after the action; record the selection order. This experiment remains unsaved and does not introduce A/R into the U1 fake save. Accept only the verified path and report unsupported or uncertain paths clearly.
- **Patterns to follow:** previous separate guest-first and A/R-first guarantee proofs.
- **Test scenarios:** fake guest + A/R -> guarantee -> readback; replacing either search invalidates its proof; duplicate/late requests cannot be mistaken for success.
- **Verification:** live unsaved HRCEN fake draft, native and visible readback and repository-required final-head checks.

### U4. Expose historical note and billing memory

- **Owner:** separate memory lane. **Requirements:** R5, R7. **Dependencies:** existing private corpus and memory query.
- **Files:** `hms-booking-memory*.mjs`, memory usage and separate private diagnostics as needed.
- **Approach:** trace where the source note lives and add bounded matching-cohort observations to `queryHmsBookingMemory`. Preserve raw meaningful wording, source, date and conflicts in private responses; optionally summarize repeated exact wording without treating it as current policy. Respect E-Mail, Voice Call and Call Center source labels and distinguish outbound recipient from actual inbound sender.
- **Patterns to follow:** current private memory paths, cohort filters, frequency hints and role-aware address query.
- **Test scenarios:** real corpus cohort with repeated notes; different amounts/negations; blank note; missing source; bounded output; no guest data written to Git.
- **Verification:** compare private query output against source observations; report scope, counts and limits.

### U5. Advance inbound-to-booking linkage

- **Owner:** separate research/integration lane. **Requirements:** R6, R7. **Dependencies:** read-only audit of the prior evidence work and available private corpus. The prior source-location manifest write, later-observation association check, inspection edits and PR 764 merge command were explicitly denied; do not retry, rephrase, delegate or reroute those actions until the execution-policy hold is resolved.
- **Files:** focused source/linkage module or private diagnostic and usage as justified by the audit; never overwrite another session's uncommitted work.
- **Approach:** recover the owner's original intended dataset, latest state, concrete blockers and prior evidence. Advance only independent analysis using already-available permitted evidence; separate verified identifiers, plausible matches, no-match and conflicting candidates. Do not access held inputs or perform the denied source, association or inspection operations via an alternative path. Keep all raw messages and guest data private. Do not interpret a filename or outbound recipient as proof of the original inbound sender.
- **Patterns to follow:** provenance-aware corpus and existing read-only message access.
- **Test scenarios:** where allowed, inspect real in-distribution examples with source IDs; distinguish ambiguous, missing and conflicting links and report no match as such. Preserve any permission hold on the denied actions.
- **Verification:** source-level inspection and reproducible private evidence; report actual sample and uncertainty.

### U6. Integration and useful coverage

- **Owner:** coordinator with lane owners. **Requirements:** R1–R8. **Dependencies:** landed units as applicable.
- **Files:** focused session wiring and docs; add no speculative database or pane integration.
- **Approach:** show one composable fake-stay lifecycle using current modules; extend read-only corpus checks if they expose real gaps. Remember historical child counts do not supply exact ages. Preserve unrelated worktrees, clean only finished owned trees when closure is verified, and synchronize main checkout only when other work is safe.
- **Patterns to follow:** existing JSONL session and private diagnostics.
- **Test scenarios:** save -> reopen -> amend -> reopen -> cancel -> reopen, plus bounded notes memory and combined guarantee; separately inspect blocked and unclear cases.
- **Verification:** final-head live evidence for claimed paths, exact-head required remote checks and review, actual commit/PR references and explicit remaining limitations.

## Verification Contract

Start with live headless HMS and existing real corpus observations. Do not create mock tests just to mirror code; use applicable existing project checks. Run typechecks via `bash /home/orca/bin/remote-typecheck.sh <clean worktree>` and applicable tests via the approved Product EC2 route with `DATABASE_URL`, `VITEST_ALLOW_PILOT_RDS` and `TEST_DATABASE_URL` unset. Typecheck and the remote Vitest helper share an EC2 lock, so run them as one lane, not as competing jobs; `remote-vitest.sh <clean worktree> server-pilot <test>` runs typecheck followed by the selected test. Run Greptile Apex in parallel with that lane on the same frozen commit while other work proceeds in separate trees. No repo-wide lint/formatting, no GitHub Actions, and no deployment for this run. For substantive PRs, validate P0/P1s, inspect the product diff, and merge using `scripts/orch/merge-gate.sh`. Independently verify the exact-head evidence before merging: the gate script checks that a record exists but does not validate its contents. No artificial tests or reviews for docs-only commits.

## Independent plan review and decisions

Grok 4.7 at xhigh reviewed a sanitized draft on 31 October; it did not inspect the repository or HMS. Adopted: establish a date-specific fake-stay preimage and fresh-session readbacks; keep save authorization action-scoped; distinguish incomplete, uncertain and penalty-blocked outcomes; keep the initial amendment non-identity; verify CMS state before and after; and distinguish safety from capability completion. The reviewer correctly warned that a timeout or pending penalty does not prove a write failed.

Not adopted as universal rules: serializing all HMS sessions (earlier isolated read-only sessions ran concurrently; only writes to the same stay need serialization), prohibiting useful exact-note frequency counts (these are historical evidence, not a booking recommendation), requiring one large create/cancel PR regardless of the repository's slice limit, or inferring that a lookup of a confirmation proves an inbound-email link. A browser network trace and an unchecked CMS flag do not themselves prove that HMS sent or queued nothing server-side; report precisely what was observed. Existing action-specific permission holds still apply regardless of the review.

## Definition of Done

- Capability completion: the new fake stay is created, amended and cancelled with independent readback. Safety completion is distinct: a fee/penalty or uncertain write stops further mutation, leaves the dialog untouched, and is reconciled and reported as a hold rather than called success.
- Note/billing history is queryable with provenance and bounded private output; combined guest+A/R guarantee is either live verified or its concrete blocker is recorded without weakening guards.
- Prior linkage work is audited and a useful real-data linkage path is advanced, or the precise non-routine blocker and evidence are recorded.
- Coherent code slices are reviewed and landed under the project gates; the final report distinguishes live-proven, unsupported and deferred behavior, gives evidence paths and reports any remaining holds.
