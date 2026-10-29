---
title: Centurion overnight first wave - Plan
type: feat
date: 2026-10-29
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: Centurion Wayfinder decisions 676, 677 and 678
execution: code
---

# Centurion overnight first wave - Plan

## Goal Capsule

Advance the Centurion reservation agent through independently verifiable code slices while the native Add-On investigation and pane prototype continue.
This first wave is not the full product: quote, create, prepaid/payment, amend and cancel remain in scope until each has its own end-to-end evidence.
The coordinator owns integration, review, evidence, and the next wave.

**Execution posture:** Overnight autonomous; make ordinary reversible decisions, implement, verify, fix and continue without routine user questions.

## Product Contract

### Requirements

- R1. One selected email can cover distinct reservation cases and rooms; retain existing and new work, correct property/party attribution, unresolved matches and staff edits.
- R2. An uncertain HMS save must not be counted as confirmed or lead to a dependent room being created without an established parent. Retain known confirmations.
- R3. Support the current SaaS and older Infor availability controls without weakening the read-only guard. Display only independently supported room and nightly rate facts.
- R4. A staff-approved plan identifies its property, cases, hotel-native choices, intended actions, charges, and any intended confirmation recipient. Reconcile an uncertain save while the job is alive; defer automatic crash recovery.
- R5. Native Add-Ons, the complete CMS/payment-link amount, payment handling, and final live workflow behavior remain unproved until observed in the relevant property.

The owner chose one approval for the displayed plan, hotel-specific options, and non-atomic execution with per-step verification. These decisions and detailed examples are in [case boundaries](https://github.com/kufupa/Zero/issues/676#issuecomment-6484963848), [execution](https://github.com/kufupa/Zero/issues/677#issuecomment-6484643064), and [approval](https://github.com/kufupa/Zero/issues/678#issuecomment-6484755966).

## Global Constraints

- Follow the current owner request, `AGENTS.md`, `PRODUCT.md`, `docs/context/START-HERE.md`, and relevant product details from the coordinator's shared working tree. Other worktrees may contain older versions.
- Preserve existing user changes, active sessions, other workers' files, and unsubmitted terminal drafts. Coordinate overlapping files before editing.
- Use isolated worktrees for concurrent writers and the owner-requested Codex Terra Max configuration for existing chats. A different model is a task-specific choice, not an assumption of availability.
- Never test against pilot or production RDS. Before Vitest unset `DATABASE_URL`, `VITEST_ALLOW_PILOT_RDS`, and `TEST_DATABASE_URL`. Use the approved Product EC2 route for tests and `/home/orca/bin/remote-typecheck.sh` for typechecks; do not run heavy checks on the VPS.
- Never bypass Git/test hooks, enable GitHub Actions, make a real-guest HMS write, send a message, change a production flag, push a schema, deploy, or delete another session's work without the applicable owner authority. Proof Labtest fake guests with 2027+ stays remain allowed under `PRODUCT.md`.
- Only one actual HRCEN browser owner at a time. Before a direct CLI probe, verify the property, coordinate known drivers, and hold and monitor every currently configured applicable lock identity, including remote-http if reachable. A process-local fallback alone is not a hotel-wide lease. Stop the owned child if the guard is lost. Record that this does not exclude arbitrary uncooperative callers; do not treat hypothetical custom overrides as an active collision. The normal staff-pane route needs its own compatible lease proof. Staff-facing runtime work must not be obstructed by background discovery.

## Autonomous Execution Mandate

Work until the first-wave units are implemented and independently reviewed or a specific genuine hold is reached. A failed check means reproduce, identify the mechanism, fix, and rerun. Do not ask the owner to resolve ordinary implementation choices or repeat settled product decisions.

Workers may make scoped code changes, commit their isolated branches, and prepare PRs. The coordinator integrates and merges only after the project gates pass. Uncertain provider access, human-only authority, or inability to prove a required lease stops the dependent action, not unrelated work. Do not restart a possibly committed HMS action blindly.

The owner permits guest details in compliant internal model and machine logs. Keep credentials out of output and avoid putting unnecessary guest information into shared artifacts.

Record the exact commit, tests, typecheck, observed behavior, outstanding risks, and next action for every slice. A green synthetic test, merged PR, or prototype alone is not proof of the live product.

## Planning Contract

- Start U1, U2 and U3 independently. U1 owns its quote-reader files; U2 owns case/prefill files; U3 owns execution safety and the booking card. Coordinate any shared work-item, session, schema or pane file before touching it.
- Continue the existing Add-On and pane sessions without taking their files or browser. Serialize HRCEN live inspection; a queued handoff or an idle snapshot is not a property-wide lease.
- The two-file SaaS patch in commit `4614002afdab5169e2ae191fb63b418ca428c882` applies on the current baseline but is unverified. Port the commit's patch only, not the difference between the old branch and main.
- Use existing runners and jobs; do not hold delivery for a Stagehand/Pomerado framework comparison. Continue the full workflow scope after these first slices.

## Implementation Units

### U1. SaaS availability compatibility

- **Goal:** Adapt the existing read-only Hotel Availability path for both current cloud and older forms.
- **Owner:** rates writer. **Dependencies:** none for offline code; HRCEN lease for a live proof.
- **Files:** `apps/server-pilot/tooling/playwright-quote/fetch-quote.mjs`, `hms-read-only-guard.mjs` and their focused tests in the same directory.
- **Approach:** Port the two-file WIP selectively. Detect the visible date control, including a hidden old control alongside the new range. Permit only the exact read-only inquiry paths needed; do not relax mutation protection.
- **Test scenarios:** Old and cloud date controls, hidden-old/visible-cloud controls, exact same-origin inquiry matches, rejection of write requests, nightly values and applied date/occupancy where existing fixtures support them.
- **Verification:** Run focused tests through an approved remote route on the committed head. A later live read must compare every displayed night, inventory, room/rate, property and occupancy with HMS; do not infer contract-rate support from BAR.

### U2. Case and prefill boundary

- **Goal:** Deliver the first focused production slice of the approved email/case model without overwriting staff choices.
- **Owner:** intake writer. **Dependencies:** none for synthetic/offline work; live party/rate evidence is separate.
- **Files:** `apps/server-pilot/src/ai/quote-ready.ts`, `apps/server-pilot/src/ai/work-items.ts`, `apps/mail/lib/quote-workflow/session.ts`, and focused tests as needed. Coordinate before adding other shared files.
- **Approach:** Reuse extraction and work-item revisions. Choose the smallest reviewable case-boundary fix supported by existing contracts; split follow-up PRs rather than stacking an oversized change. Keep native matches unresolved when evidence is ambiguous.
- **Test scenarios:** Mixed existing and new stays in one email, same dates with distinct cases, correct property and party, explicit staff clears surviving late prefill and reopen, no invented ages, and self-mail never offering create. Cover the scenarios affected by each slice and report the rest as outstanding.
- **Verification:** Run focused relevant server/mail tests and typechecks on the final committed head. Report exactly which case behavior is implemented versus still missing.

### U3. Unknown-save safety

- **Goal:** Correct false success reporting and prevent dependent room actions after an unresolved parent save.
- **Owner:** execution writer. **Dependencies:** none for offline work; coordinate before touching U2-owned files.
- **Files:** `apps/mail/components/quote-workflow/booking-card.tsx`, the relevant server commit guard/route and focused tests.
- **Approach:** Reuse the [recovery characterization](https://github.com/kufupa/Zero/issues/674#issuecomment-6484464584); invert unsafe assertions into regressions instead of merging the old characterization tests unchanged. Preserve any confirmed result and known confirmation. Enforce the dependency at the server boundary as well as in the pane; if the existing contract cannot do this safely, make the hold explicit and report the missing seam.
- **Test scenarios:** An unknown first room is not counted as booked; a later batch or single-room action cannot bypass its unresolved parent; a confirmed first room remains visible after a later failure; reloaded state and direct requests cannot bypass the guard.
- **Verification:** Run the changed mail/server cases and typechecks on the final committed head. Test the current job's reconciliation behavior where the existing readback makes it possible; no crash-resume promise.

### U4. Native flow and staff pane

- **Goal:** Continue the already-running native Add-On investigation and the existing-style pane prototype, then implement only supported choices and actions.
- **Owner:** existing Add-On and pane sessions; coordinator owns their handoff and shared-file ordering.
- **Dependencies:** Actual HRCEN property-wide lease and native observation for Add-On claims. Pane implementation follows the current demo and U2/U3 contracts; do not overwrite the prototype session.
- **Test scenarios:** Hotel-specific catalog, amount/scope/readback; multiple rooms, child, ambiguous match and partial result; prevent an incomplete confirmation. Distinguish an unsent preview from an authorized actual send.
- **Verification:** A fake 2027+ Proof Labtest case proves only the observed case. Actual confirmation delivery requires separate applicable authority in the executing session.

## Verification Contract

Use `bash /home/orca/bin/remote-typecheck.sh <clean-worktree> --app <mail|server-pilot>` and the applicable approved remote test route against committed heads. The remote Vitest wrapper can return success when its preliminary typecheck failed: verify both results independently. Ensure database-dependent tests actually ran against a disposable database rather than being skipped.

Before merge, the coordinator reads each product diff; require applicable same-head tests, separate typecheck evidence, Greptile Apex on that head, and validation of all P0/P1 findings. Merge only through `scripts/orch/merge-gate.sh`. Its gate-record existence alone is not evidence of valid test contents or Apex.

## Remaining delivery estimate — 2026-10-29 01:50 UTC

These are broad planning ranges for **additional changed product lines**, not a lines-per-hour promise. Each duration is one lane's elapsed work including its focused checks and review; lanes overlap. Numbers exclude external waits and any work found after seeing the HMS screen. Re-estimate after the first guarded SaaS quote and create/readback. Preserve the user's preference for minimal, meaningful tests: exercise state and failure boundaries that matter, plus actual HMS readback; do not add brittle implementation-mirroring tests.

| Remaining deliverable | Dependencies / main risk | Additional product lines | Lane hours |
| --- | --- | ---: | ---: |
| Correct the test-result exit status and establish a monitored HRCEN guard over configured lock identities | Existing Vitest wrapper returned zero for a failing run; do not change a shared script while others own active invocations | 20–150 | 1–3 |
| Finish SaaS rates and hotel-specific agency/company/CMS prelookups; preserve native company ID through create | U1 PR is open; live cloud price, contract eligibility and native company readback remain unproved | 300–900 | 6–15 |
| Finish case/prefill and preserve unknown child ages; map distinct guests to rooms | U2 is in review; do not infer a room identity from roster order or stale drafts | 250–700 | 4–10 |
| Complete save safety and server-owned, immutable approved plan with step results | U3's current per-work-item hold is useful but a different work item can bypass it; split from U3's near-500-line PR | 350–800 | 4–10 |
| Wire the real Outlook and webmail pane to complete plan review, one approval and partial results | Prototype exists; coordinate U2/U3 files, don't treat the demo as product | 250–600 | 3–7 |
| Discover and implement hotel-specific Add-On catalog/actions and Guest Details, with readback | Actual Centurion screen, charge semantics and single CMS confirmation timing are unknown | 600–1,400 | 8–20 |
| Prove linked multi-room execution and confirmation behavior | Existing Add Record path is HRDAV proof and same-guest only; 13–17 child band and different guests need evidence | 100–400 | 3–8 |
| Prepaid/proof of payment: match, attachment, actual staff payment steps and readback | Current folio role masks money; no proven payment posting path; access/policy can block this | 500–1,400 | 8–20 |
| Amend and cancel against Centurion SaaS | Existing drivers are reusable; date amendments and cancellation side effects need actual proof; cancel remains lab-only | 200–700 | 5–12 |
| Integrate, run representative corpus and independent HMS canaries, verify release | Requires a stable combined head and current authority; allow follow-up fixes | 0–200 | 4–10 |

Very rough total: 2,500–7,000 further changed product lines; use existing code and narrow when screen evidence permits. Tests are additional and intentionally limited to meaningful risks. These are not a commitment to write that many lines.

Planning checkpoints, conditional on unattended coordination, access and no major SaaS incompatibility:

1. **First simple fake-guest email → live BAR quote → pane approval → one-room create → separate HMS readback:** roughly 6–14 elapsed hours. The immediate chain is lock/test harness → live quote → safe create/readback, while intake and save work continue in parallel. This proves only that case.
2. **One reviewed plan for two rooms with the native Add-On and verified partial results:** roughly 18–36 elapsed hours. Native screen discovery and whether HMS can send one complete confirmation are the largest unknowns.
3. **All requested quote, create/prepaid, payment, amend and cancel workflows implemented and demonstrated:** roughly 30–80 elapsed hours with 3–4 productive lanes. This is a scenario, not a bound: a masked folio, unavailable HMS role, incompatible CMS behavior or missing authority can extend it indefinitely. Staff-ready release additionally requires the applicable product accuracy bars, final deployment and live canary.

Historical anchors are a 548-minute, 11-link critical path (~50 minutes/link) and a later 16-unit launch-to-merge p50 of 88.5 minutes / p75 107 minutes; they include overlapping coding, checks and review and are not Centurion SaaS forecasts. See `docs/context/ledger/2026-10-26-or2-retro.md` and `docs/context/ledger/2026-10-26-or2-retro-pm.md`.

Use the existing Terra Max/bypass sessions for implementation as requested. The coordinator reads product diffs; run one explicit Greptile Apex review per final PR head, validate P0/P1 findings, and avoid redundant broad reviews. Keep the HRCEN browser and shared EC2 test clone serialized; overlap independent coding, review and corpus work. Mastra and deterministic Playwright remain the default; limit Stagehand/Pomerado investigation to a short read-only experiment when it directly removes a blocker.

## Definition of Done

- U1–U3 have reviewable committed slices, explicit same-head test/typecheck evidence, and accurate limits; applicable gates pass before merge.
- U4 has a truthful current handoff, with native facts distinguished from assumptions and the pane prototype distinguished from product code.
- Coordinator records partial outcomes and next owners. No claim of complete staff readiness until the final deployed SHA, both pane surfaces, independent HMS readback and applicable product accuracy bars are proven for each supported workflow.
