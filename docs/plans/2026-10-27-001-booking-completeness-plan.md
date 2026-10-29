---
title: Booking completeness - Plan
type: feat
date: 2026-10-27
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: owner-ask-275
execution: code
---

# Booking completeness - Plan

## Goal Capsule

- **Objective:** Staff review prefilled new-booking details in the existing Nava pane, approve the write, and see what HMS actually saved. Native Add-Ons are part of that target, not a substitute note.
- **Source authority:** `PRODUCT.md` and ask 275 in `docs/context/OWNER-ASKS.md`. Original words: `docs/context/asks/2026-10-27-booking-completeness-owner-voice.md`. This document proposes the next run. It does not launch it or transfer another session's authority.
- **Execution posture:** Bounded experiments and source-backed repairs. No hard stop based on PR count. Preserve the complete target when the working window ends and report the remaining acceptance checks.
- **Tail owner:** The executing coordinator owns merged-head review, deploy, current-SHA live proof, both pane surfaces, screenshots, and outcome reconciliation. A writer finishing is not the workflow finishing.
- **Safety:** Read-only real-guest HMS inspection is permitted. Writes use fake Proof Labtest guests with 2027+ stays unless the executing session has its own applicable real-guest authority. No Nava email sends. An HMS confirmation send needs separate applicable authority in that session. Never accept penalty Waive/OK.
- **Stop conditions:** Unknown property, lost lock, wrong stay, uncertain native Add-On identity, missing provider readiness, or possible commit means stop that action and reconcile. After two failed HMS write loops, preserve the DOM diagnosis and change the approach before another loop.
- **Readiness meaning:** Units have executable starting points and fail-closed dependency gates. U5 is a readiness experiment, not evidence that U6 can write today. Execution-time preflight failure holds dependent units without expanding scope. The required Argon plan review is currently blocked by subscription quota; no launch proceeds until that review passes or the executing session receives an explicit decision about that gate.

---

## Product Contract

### Summary

Complete the existing new-booking workflow rather than rebuild the pane.
Carry prepared HMS results into editable fields, preserve staff choices, support child-bearing stays, bind actual native parties, and display native booking status.
Trial Pomerado for native Add-On authoring behind Nava's existing write safeguards.
Integrate a proven Add-On operation into the same pane.
Keep multi-room and confirmation proofs with Phase 1 until ownership is handed over.

### Problem Frame

Current code supports most child-free standard-rate create fields, but source presence does not establish staff-ready booking completeness.
Child-bearing rooms are refused by both pane and server.
Native Add-Ons have no request, pane control, writer, or independent row readback.
V2 party results omit the property field required by the pane reader.
Rates and availability prepare for quotes, not new-booking mail.
Actual HMS status is read internally but omitted from the pane receipt.
These gaps leave staff entering or rechecking information in HMS.

### Requirements

**Booking field parity**

- R1. Keep the existing canonical Stay, Guest, Contact, and Agency/company sections. Staff edit each fact once, then review it before Book.
- R2. Support each child's individual age and retain existing age arrays without silently dropping children. Enable child-bearing Preview/Book only with valid ages and native age-dialog coverage.
- R3. Validate every configured required create field against its supplied value. Unknown required fields stay visibly unsupported rather than accepting a guessed default.
- R4. Bind company/agency to the selected native HMS record and verify the saved association. A name typed into a field is not proof of binding.
- R5. Return actual native status, confirmation, selected recipient, and review screenshots. Multi-room partial success must preserve each saved confirmation and never recreate successful rooms.
- R6. Every required or routinely used field for the target property's new-booking workflow must be present, editable, and verified after native save. Determine that set from actual HMS and staff workflow, including rate overrides, Authorised by, A/R account, billing reference, guest profile, market segment, opt-in, and approved arrival/special-request notes. An inventory alone does not satisfy this requirement. Unused fields and policy-held writes remain explicitly deferred and excluded from the completeness claim.

**Native Add-Ons**

- R7. Trial Pomerado on native Add-On catalog/rows, not meal plans, rate extras, a folio summary, or prose notes.
- R8. Add, remove, and independently read back one exact native row on Labtest A. Inspect the generated operation and replay add/remove on distinct Labtest B before pane integration.
- R9. A proven Add-On operation uses separate preview, explicit action approval, commit, screenshot, and per-row outcome. A partial Add-On failure must not recreate the reservation.
- R10. Use native item codes, units, dates, amount/currency, charge semantics, and row identity. Unknown semantics block writes instead of becoming invented defaults.

**Prepared-on-arrival review**

- R11. Eligible inbound new-booking mail schedules the same property-scoped party preparation needed by quotes. Stored results hydrate the correct pane without overwriting a staff pick.
- R12. Prepare availability and rates for plannable new bookings using existing quote preparation, including agency-dependent sequencing. Persist those rate results and hydrate the correct request's editable pane rate state without replacing staff choices. No job is scheduled for incomplete or ineligible mail.
- R13. Deferred party/availability reads remain durable and eventually visible. Pending pane reads refresh within the selected request lifecycle and stop on mail switch or terminal failure.

**Other workflows and proof**

- R14. Reuse Phase 1's multi-room quote, partial-create, HMS confirmation, and HRCEN access evidence. Repeat only when the deployed SHA or changed behavior makes it stale.
- R15. Repair cancellation approval binding and fail closed when fee timing is uncertain. A penalty dialog left untouched does not mean cancellation was prevented.
- R16. Diagnose the supported native date-amend route before changing the deterministic driver. Do not replace working tools with Pomerado merely because an amend path failed.
- R17. Every pane feature works on Outlook and webmail. Current-SHA live proof and the product's golden-set bars remain separate from unit-test or merge progress.

### Actors and flows

- A1. Reservations staff review extracted/prepared facts, edit choices, approve writes, and inspect the actual outcome.
- A2. The executing coordinator owns readiness, property locks, deploy/proof tails, and unresolved policy holds.
- A3. Pomerado authors a reviewed deterministic operation in a Labtest-only experiment. It does not replace staff authorization at runtime.
- F1. Inbound extraction schedules eligible reads. Durable property/request-matching results hydrate canonical fields. Staff changes take precedence.
- F2. Staff review a new-booking preview, approve once, and see per-room saved status and confirmations after fresh HMS readback.
- F3. Staff select a native Add-On row, review its exact item/quantity/dates/charge, approve once, and see independently reconciled per-row status.
- F4. An uncertain outcome stops automatic retry. Nava shows the known booking and asks staff to check HMS without implying nothing happened.

### Acceptance examples

- AE1. A booking request with two children exposes an age input for each child. Missing or invalid age blocks Preview without deleting another age.
- AE2. A saved HRDAV party result hydrates HRDAV only. HRCEN/missing-property results never auto-bind, and a staff-selected party survives a late response.
- AE3. A hotel requiring market segment accepts a supplied valid value. An unsupported required native field names the missing setup and blocks Book.
- AE4. Room A saves and room B times out. Room A's confirmation persists after reopen. No retry creates room A again.
- AE5. Add-On Save times out after reaching HMS. Fresh row readback determines whether it applied before any further action.
- AE6. A cancellation's reason OK changes status before a fee dialog. Nava reports the applied cancellation and pending fee rather than saying cancellation was blocked.
- AE7. Rates prepared for a new-booking request appear when that mail opens. The displayed property, stay, room and rate match the persisted result. A late result cannot replace a staff-edited selection.

### Scope and tradeoffs

- **Target:** Complete new-booking parity and native Add-Ons. Finish original quote/multi-room acceptance before changing the active workflow; protective fixes may run separately when they do not touch that workflow's files.
- **First allocation:** Use the next 120 minutes for the highest-value startable units, not a promise that the full target fits. Start Pomerado readiness early while current proof lanes finish.
- **Not a rewrite:** No new review desk, general agent loop, party matching algorithm, browser fleet, orchestration framework, GitHub Actions workflow, or pilot database migration is proposed.
- **Not cut:** Date amend, cancel safety, optional-field parity, override writes, and rate preparation remain named units even when outside the first allocation.
- **Paid/guaranteed/unknown-money changes:** Remain held. Labtest technical inspection does not need a staff policy answer, but it does not authorize real-guest fee decisions.

### Evidence and current ownership

Source snapshot is `92be0e5d2`.
The report `docs/research/2026-10-27-next-run/run-delta.md` classifies 35 merged execution PRs: 17 original-scope, 4 splits, 11 completion repairs, 2 infrastructure dependencies, and 1 new behavior.
No tangent was identified in that classification.
The latest Phase 1 handoff in `origin/main` at `69ce8fc45` reports #654 deployed at 11:17Z, E3 running, and E4's first attempt refused before Save because the proof runner omitted market segment and confirmation recipient.
That is another session's reported evidence, not this planning session's runtime verification.
E3 belongs to proof2 and E4 to booking-ui on the same HRDAV slot; do not duplicate or repair their proof runner from this lane.
The multi-room rerun remains unpassed in that handoff.
HRCEN login/find are reported working, but cloud availability fails and the owner paused that quote work.
The same handoff reports an actionable external booking forwarded by a hotel sender skipped by party prefetch, another copy classified other, and a guest/booking name mistaken for Company.
No complete automatic party/rate-readiness claim follows from the existence of queued jobs.
Confirm current ownership before any executing lane uses those files or the property slot.
The newer main changes are handoff documentation, not changes to the product source snapshot above.

---

## Planning Contract

### Key technical decisions

- KTD1. **Keep deterministic HMS runtime.** Pomerado is the requested authoring tool for Add-Ons. It does not supply missing fee policy, native date semantics, or pane wiring.
- KTD2. **Pin the inspected npm artifact.** Use `pomerado@0.4.0-canary.439` with the integrity in `docs/research/2026-10-27-next-run/pomerado-trial.md`. Stable/latest is `.399`; `.439` has no matching Git tag. Do not install a moving tag. Validate Node `>=24.21.0 <25` before execution.
- KTD3. **Choose the supported browser boundary.** Use a Pomerado-owned Playwright `launchServer` browser for the experiment. Do not build a custom CDP host. Hold Nava's existing PostgreSQL tenant/property advisory lock for the entire browser/model/write/readback window. A private Pomerado lock or separate browser does not provide exclusion. If shared-lock ownership/liveness cannot be demonstrated, do not author live.
- KTD4. **Prove all provider roles.** Bridge the OpenAI Agents `ModelProvider` interface to the approved Azure configuration. Explicitly route minter, guardian, and outcome reviewer. Test routing with non-sensitive input before any HMS observation enters a model request. No default public endpoint, credentials in artifacts, or private mail payload.
- KTD5. **Reader before writer.** U5 must establish a fresh native Add-On row reader and native identity/charge semantics. A manifest mentioning Add-Ons or a folio total is insufficient.
- KTD6. **Separate reservation and Add-On transactions.** U6/U7 act only on an existing verified stay. Preview and commit require existing server-side mailbox/property access and staff write authorization. Approval binds the authenticated approver, property, confirmation, arrival, row identity, action, and the displayed input/snapshot. Commit re-authorizes that approver and consumes the one-time grant. Results persist against that action. Uncertain results block automatic replay until reconciliation.
- KTD7. **Canonical UI and full race classes.** Update existing editors. New fields mount inside existing steps. Pending refresh is selected-request scoped. Staff-edited sections stay held during asynchronous replacement. Late responses cannot mutate another mail, property, revision, or already-approved action.
- KTD8. **Repair preparation, not matching.** Carry V2 property metadata, complete pending readers, and durably defer overflow. Extending new-booking rate preparation uses existing profile strategies and agency readiness, not a second pricing algorithm.
- KTD9. **Correct cancel disposition.** Preview approval binds the full approved stay, and the existing `expectStay` support is forwarded to commit. A pre-OK absence of a visible penalty is not positive evidence that no fee will be created. Unknown fee timing routes the consequential step to staff.
- KTD10. **No assumed safe HMS status.** Display the reopened native status. Keep the current fail-closed payment/status eligibility unless the executing session receives a new policy decision.

### High-level design

Directional state sketch, not implementation code:

```text
Inbound read preparation
  Eligibility and property resolution
  Durable queued/deferred job
  Fresh matching result
  Canonical editable pane state
  Staff edit wins over late preparation

Reservation write
  Current stay preview
  Explicit matching approval
  One commit per unsaved room
  Fresh native readback
  Per-room saved or uncertain receipt

Native Add-On write
  Existing verified reservation
  Fresh native Add-On rows and catalog
  Exact one-row preview and approval
  Author or replay once under shared property lock
  Fresh native row readback
  Applied, absent, or uncertain disposition
  Never recreate reservation on Add-On failure
```

### Sequencing, file ownership, and execution risk

- The first booking area lane owns U2/U3/U4/U12 in order because they share `booking-card.tsx`. Prepare later tests while the previous slice gates, then incorporate the preceding green head before final verification.
- The preparation area lane owns U1/U9/U11 in order because they share `hms-jobs.ts`. U10 is independent UI work but must not edit a file simultaneously owned by the booking lane.
- The Add-On lane starts U5 immediately when the HRDAV slot is released. U6 requires U5's passing readiness evidence. U7 requires U6's proven operation and typed result contract.
- One booking integration owner serializes every edit to `booking-card.tsx`, `pane-stay-bind.ts`, `pane-stay-save.ts`, `create-request.mjs`, and `create-lab-stay.mjs`. Its shared-file order is U2, U3, U4, U12, U8, U7, then U13. U8 also waits for Phase 1's runner release; U7 also waits for U6. Independent new-file authoring in U5/U6 does not take ownership of these shared files. These are file-ownership queues, not invented API dependencies. No concurrent writer touches the same file.
- U15 is a separate protective fix lane with disjoint cancellation files. U16 is read-only diagnosis until native route discovery succeeds.
- Distinct property slots permit independent HRCEN and HRDAV reads. Browsers on the same hotel do not permit parallel HMS ownership.
- Current chats share a checkout. Product writers need their own branch/worktree from current main; documentation edits here are not a license to commit another session's work.
- New/replacement feature units target at most 200 product lines where the existing sizing supports that. Larger coupled behavior is split before first review. Test/fixture lines are excluded. Unknown sizing is a discovery gate, not a fabricated range.
- Each change uses existing gates, retention, screenshots, and deploy tooling. Missing orchestration improvements are not inserted into this product run.

### Timing basis and allocation

These are measured task durations, not a commitment for the proposed run.
Closed ledger rows starting on or after 2026-10-22 provide:

| Kind | Rows | Actual median | Actual upper quartile |
|---|---:|---:|---:|
| Server code | 26 | 32 min | 45 min |
| UI code | 5 | 52 min | 62 min |
| Deploy | 2 | 18 min | 18 min |
| Live HMS | 4 | 64 min | 321 min |

Code clocks often include review/gates. Do not add another full review median to them.
The recent live-HMS sample is small and mixes simple proof with difficult diagnosis.
Older measured Apex runs are approximately 3 minutes; that is not total review repair time.
The ledger's calibration medians at this snapshot are server 0.85, UI 0.87, deploy 0.83, live-HMS 0.88, orchestration 1.20.
Before launch, record the executing scope's estimate and longest dependency chain in the ledger.
Do not claim a full Add-On elapsed-to-production ETA until U5 establishes browser/provider/native-row readiness and implementation size.
The first 120-minute allocation can overlap a small preparation repair, the first booking slice, and Add-On readiness with Phase 1's remaining proofs.
It does not guarantee children, all native fields, Add-Ons, both surfaces, and current-SHA proof are all complete.

---

## Implementation Units

| Unit | One behavior | Primary files | Real dependency |
|---|---|---|---|
| U1 | Property-matching party hydration | `apps/server-pilot/src/ai/hms-jobs.ts` | None |
| U2 | Individual child ages and child-bearing create | `apps/mail/components/quote-workflow/requirement-card.tsx`, `apps/mail/components/quote-workflow/booking-card.tsx` | None |
| U3 | Supplied property-required fields pass validation | `apps/mail/components/quote-workflow/booking-card.tsx` | None; shared file queued |
| U4 | Native HMS status in saved receipt | `apps/server-pilot/src/ai/pane-stay-save.ts` | None; shared file queued |
| U5 | Pomerado/native Add-On readiness experiment | Proposed `apps/server-pilot/tooling/playwright-quote/addons-read.mjs` | Free property slot |
| U6 | Guarded native Add-On add/remove operation | Proposed `apps/server-pilot/src/ai/pane-stay-addons.ts` | U5 passing evidence |
| U7 | Native Add-On control mounts in existing pane | Proposed `apps/mail/components/quote-workflow/native-addons-fields.tsx` | U6 result contract and replay proof |
| U8 | Native party association on create | `apps/server-pilot/tooling/playwright-quote/create-request.mjs` | Phase 1 runner release |
| U9 | New-booking rate/availability preparation | `apps/server-pilot/src/ai/hms-jobs.ts` | U1 identity seam |
| U10 | Pending availability reader completes while selected | `apps/mail/components/quote-workflow/quote-stay-step.tsx` | None |
| U11 | Durable party/availability overflow | `apps/server-pilot/src/ai/prefetch-capacity.ts` | None; shared hub queued |
| U12 | Approved special requests reach reservation note | `apps/mail/lib/quote-workflow/pane-stay-bind.ts` | None; shared file queued |
| U13 | Remaining manual-field parity | `apps/mail/components/quote-workflow/booking-card.tsx` | Native mapping/policy evidence |
| U14 | Multi-room/confirmation and surface proof | Existing Phase 1 proof ownership | Relevant merged/deployed head |
| U15 | Full-stay cancellation approval and honest disposition | `apps/server-pilot/src/ai/pane-stay-cancel.ts` | None |
| U16 | Supported date-amend route discovery | `apps/server-pilot/tooling/playwright-quote/amend-stay.mjs` | Free property slot; native route before code |

### U1. Property-matching party hydration

- **Goal / trace:** R11, AE2. Persist the target property in V2 results so the existing reader accepts the correct saved result.
- **Files:** `apps/server-pilot/src/ai/hms-jobs.ts`; `apps/mail/components/quote-workflow/party-picker.tsx` only if reader changes are necessary.
- **Approach:** Carry the existing resolved target into result payloads. Do not infer missing property in old results or weaken the pane guard.
- **Test scenarios:** HRCEN and HRDAV matching results hydrate; wrong/missing property stays unbound; late response cannot replace staff choice; auto-start is not recorded as a staff pick. Characterize a hotel-sender forward containing an external booking request separately from the payload-property defect. If it never queues, record the exact eligibility reason rather than calling hydration fixed.
- **Tests / verification:** `apps/mail/tests/party-picker-results.test.tsx`, `apps/server-pilot/tests/hms-jobs.test.ts`. Remote gates, then one existing persisted result per property opened in both surfaces.
- **Sizing / routing:** Source-lane estimate 5–15 product and 15–25 test LOC. Luna max; Greptile Apex on the exact head.

### U2. Individual child ages and child-bearing create

- **Goal / trace:** R1/R2, AE1. Replace comma-only age entry with individual children and stop rejecting valid child-bearing stays.
- **Files:** `apps/mail/components/quote-workflow/requirement-card.tsx`, `apps/mail/components/quote-workflow/booking-card.tsx`, `apps/server-pilot/src/ai/pane-stay-save.ts`; existing `create-lab-stay.mjs` age-dialog path only if live proof identifies a defect.
- **Approach:** Keep the current canonical work-item contract: whole years 0–17 inclusive, at most 9 children per room row, as enforced by `apps/server-pilot/src/ai/work-items.ts:386-387`. The native create schema accepts a wider technical range; do not treat that as hotel child-pricing policy or silently widen the saved contract. Every child gets a labeled Age in years input. Blank/unknown, decimal, negative, or out-of-range age blocks Preview with a field-level explanation while preserving all entered values. Exceeding the count limit blocks explicitly rather than truncating. Pane and server use the same contract. Fresh native age-dialog/readback proof is still required before removing the create refusal.
- **Test scenarios:** No children; one age zero; multiple ages; missing/invalid age; add/remove child; switch mail during preview; saved native child count/ages equal approved input.
- **Tests / verification:** `apps/mail/tests/stay-room-builder.test.tsx`, `apps/mail/tests/booking-card.test.tsx`, `apps/server-pilot/tests/pane-stay-save.test.ts`, `apps/server-pilot/tests/create-preflight.test.ts`. Labtest create then fresh child-age readback and screenshots.
- **Sizing / routing:** Older UI estimate 60–100 product plus 40–60 test LOC is inherited, not a measured total. Re-size the server/native seam before coding. Luna UI plus Grok write-path ownership in one isolated area lane.

### U3. Property-required field validation

- **Goal / trace:** R3, AE3. A supplied supported required field must not produce generic missing-field refusal.
- **Files:** `apps/mail/components/quote-workflow/booking-card.tsx`, `apps/mail/lib/quote-workflow/pane-stay-bind.ts`.
- **Approach:** Use a typed native-field-to-input mapping with actual supplied-value checks. Keep unknown required fields fail-closed. Boolean false must follow native requiredness semantics, not string truthiness. Use observed property choices where available.
- **Test scenarios:** Required reservation note; supplied/missing market segment; supported boolean field; unsupported field; no extra required fields; property switch invalidates incompatible options.
- **Tests / verification:** `apps/mail/tests/booking-card.test.tsx`, `apps/server-pilot/tests/create-preflight.test.ts`. Demonstrate missing versus supplied fields in both surfaces.
- **Sizing / routing:** Source estimate 25–45 product, 25–40 test LOC. Luna max.

### U4. Native status in the saved receipt

- **Goal / trace:** R5, AE4. Staff see reopened HMS status rather than generic booked/unknown.
- **Files:** `apps/server-pilot/src/ai/pane-stay-save.ts`, `apps/mail/lib/quote-workflow/pane-stay-bind.ts`, `apps/mail/components/quote-workflow/booking-card.tsx`; create result schema/runner only for the already-read status field.
- **Approach:** Carry native status through wire result and persisted receipt. An absent status remains unknown. Do not change HMS status as part of this unit.
- **Test scenarios:** Reserved/provisional/confirmed labels; missing status; receipt reopen; partial multi-room save; duplicate-click refusal; uncertain second room retains first confirmation.
- **Tests / verification:** `apps/server-pilot/tests/pane-stay-save.test.ts`, `apps/mail/tests/booking-card-reload.test.tsx`, `apps/mail/tests/booking-card.test.tsx`. Fresh lookup agrees with receipt after reload.
- **Sizing / routing:** Source estimate 25–45 product, 25–40 test LOC. Luna wiring with Grok review of write-result seam.

### U5. Pomerado and native Add-On readiness experiment

- **Goal / trace:** R7/R10, KTD2–KTD5. Establish readiness before authoring can mutate HMS.
- **Files:** Proposed `apps/server-pilot/tooling/playwright-quote/addons-read.mjs`; proposed `apps/server-pilot/tooling/pomerado/azure-provider.mjs` and `trial-readiness.mjs`; reuse `apps/server-pilot/src/hms/property-read-lock.ts` and approved Azure configuration rather than editing host scripts.
- **Approach:** Pin package/Node, acquire the existing property lock, launch the supported isolated browser, and prove competing property work remains excluded. Route all provider roles with non-sensitive smoke input. Read native catalog and current rows on two existing Labtest stays through fresh navigation. Document native charge/removal semantics. No live author/mint until every readiness check passes.
- **Test scenarios:** Wrong property; incompatible Node; missing provider; default endpoint attempt; lock lost/contention; missing catalog; duplicate/ambiguous rows; read-only navigation accidentally presenting a consequential dialog; no-write smoke checks.
- **Tests / verification:** Proposed `apps/server-pilot/tests/pomerado-trial-readiness.test.ts` and `apps/server-pilot/tests/addons-read.test.ts`. Outcome is a dated readiness report with either a verified native row contract or an explicit blocker. Do not count package inspection as a successful trial.
- **Sizing / routing:** No defensible full LOC or elapsed estimate before this experiment. Grok 4.6 high. Split any product adapters into separate green behavior PRs; experiment evidence is not a monolithic feature PR.

### U6. Native Add-On add/remove operation

- **Goal / trace:** R8/R9, AE5. Prove one guarded native Add-On operation using Pomerado.
- **Files:** Proposed `apps/server-pilot/src/ai/pane-stay-addons.ts`, proposed `apps/server-pilot/tooling/playwright-quote/addons-operation.mjs`; U5 native reader and provider adapter.
- **Approach:** Use U5's native contract and existing stay approval patterns. Author on Labtest A once, treating mint as a write. Reconcile independently, remove exact row, verify absence. Inspect generated operation and replay on Labtest B; verify both add and removal. No substitute authoring-tool fallback. If Pomerado is incompatible, hold native Add-On writes and report the precise blocker.
- **Test scenarios:** Stale approved stay/row; approval consumed twice; quantity/date/charge mismatch; add success; remove success; timeout after Save; row already present; ambiguous readback; browser lock loss; no reservation-create call on failure.
- **Tests / verification:** Proposed `apps/server-pilot/tests/pane-stay-addons.test.ts`. Private native evidence plus scrubbed result/screenshot locators. No blind retry or unrelated reservation cleanup.
- **Sizing / routing:** Prior wrapper-only estimate 120–200 product, 80–120 test LOC excludes provider, reader, package, and native DOM discovery. Grok 4.6 high. Split add/removal if native contracts require separate behavior PRs.

### U7. Native Add-On controls mount in the existing pane

- **Goal / trace:** R1/R9, F3/F4. Make the proven operation available for reviewed existing/newly-created stays.
- **Files:** Proposed `apps/mail/components/quote-workflow/native-addons-fields.tsx`; mount in `apps/mail/components/quote-workflow/booking-card.tsx`; bind in `apps/mail/lib/quote-workflow/pane-stay-bind.ts`; existing work-item persistence seam only as required.
- **Approach:** Present real native catalog choices and saved rows. Show item, unit, quantity, dates, charge and recipient-independent outcome once. Persist the exact requested row selection and receipt using current request/work-item storage. Approval happens after reservation identity is real. Meal-plan and shuttle drafts remain distinct.
- **Rendered states:** Loading shows “Loading HMS Add-Ons” with no write control. A successfully read empty catalog says “No Add-Ons available for this hotel”; existing saved rows remain visible. Setup or read failure says “Add-Ons are not available right now” with a retry-read action, not an empty-catalog claim. Lock busy says “HMS is busy. Your request is waiting.” Partial/uncertain write says “Some changes may have saved. Check HMS before trying again”, shows known per-row results, and offers fresh reconciliation only. Successful add/removal shows the verified native row disposition. Reservation creation and unrelated saved rooms remain intact.
- **Test scenarios:** Loading/empty catalog; setup missing; lock busy; invalid quantity/dates; selected row preview; add/remove success; partial/uncertain outcome; pane reopen; stale response after mail/property switch; keyboard and screen-reader operation.
- **Tests / verification:** Proposed `apps/mail/tests/native-addons-fields.test.tsx`, `apps/mail/tests/booking-card.test.tsx`, `apps/mail/tests/mail-nava-panel.test.tsx`. The mount render test must find the control on both surfaces. Viewers then approve a Labtest row and compare native readback.
- **Sizing / routing:** Re-size after U6 result contract. Luna UI; Grok owns approval/server seam. No migration implied.

### U8. Native party association on create

- **Goal / trace:** R4. Selected native company/agency must bind to the saved stay.
- **Files:** `apps/mail/lib/quote-workflow/pane-stay-bind.ts`, `apps/server-pilot/tooling/playwright-quote/create-request.mjs`, `apps/server-pilot/tooling/playwright-quote/create-lab-stay.mjs`.
- **Approach:** First inspect native selection/readback on Labtest. Carry actual native identity rather than only display text. Duplicate-name rows retain their disambiguating HMS fields. Unknown identity requires staff confirmation, not arbitrary selection.
- **Test scenarios:** Same-name native rows; wrong property; agency and organization independently selected; no party; stale party choice; reopened stay's association equals the approved native record.
- **Tests / verification:** `apps/server-pilot/tests/create-preflight.test.ts`, `apps/mail/tests/booking-card.test.tsx`; add seam test to proposed `apps/server-pilot/tests/create-request-party.test.ts`. Native binding readback is separate from party matcher accuracy.
- **Sizing / routing:** Source seam estimate 30–50 product, 25–40 test LOC excludes native discovery. Grok 4.6 high.

### U9. New-booking rate and availability preparation

- **Goal / trace:** R12. New-booking mail gets property-scoped prepared rates/availability when plannable.
- **Files:** `apps/server-pilot/src/ai/hms-jobs.ts`, existing extraction eligibility seam, `apps/mail/components/nava-pane/nava-pane.tsx` only if current prepared reader cannot bind booking intent.
- **Approach:** Generalize existing quote-only eligibility to quote plus plannable booking intent. Reuse profile strategies, party prerequisites, batch capacity, durable results, and edit-revision guards. Inspect legacy/V2 party terminal handling and make required party completion resume pricing without inventing entitlement. Characterize forwarded external requests and booking-name/company confusion from the newer handoff. Eligibility/extraction repairs require their own class-level tests and one-behavior slices before dispatch; no sender/company-specific patch or whole-classifier rewrite is included.
- **Test scenarios:** Quote unchanged; complete booking schedules; missing dates/room/party refuses or waits visibly; channel/self-prestay stays excluded; legacy/V2 completion and failure; property switch; edited rate not replaced.
- **Tests / verification:** `apps/server-pilot/tests/hms-jobs.test.ts`, `apps/server-pilot/tests/prepared-quote-cap.test.ts`, `apps/mail/tests/booking-card.test.tsx`. Trace a fresh eligible booking extraction to persisted jobs and visible results before opening; use no send or real-guest write.
- **Sizing / routing:** Not yet source-sized. Grok cross-cutting queue logic. Do not relabel a pane-side auto-start as pre-open completion.

### U10. Pending availability reader follows selected mail

- **Goal / trace:** R13. A prepared result that finishes after first pane read appears without reopening.
- **Files:** `apps/mail/components/quote-workflow/quote-stay-step.tsx`.
- **Approach:** Refresh queued/running status within the existing reader lifecycle. Stop on terminal success/failure, request revision, mail switch, or unmount. Keep snapshot matching and staff edit precedence.
- **Rendered states:** Pending says “Checking availability in HMS”; if waiting exceeds 30 seconds, explain that HMS is still busy. Complete shows dated native availability as a read-only snapshot, not a priced quote. Absent/ineligible says “Availability has not been checked” and identifies missing stay details when known. Failure names the cause class and allows retry of the read only. Stale says “Availability needs refreshing” and keeps previous data labeled stale. Partial says “Some rooms have not been checked” and never claims full-stay availability. None replaces staff edits or permits an unreviewed write.
- **Test scenarios:** Pending to complete; pending to failure; absent result; stale snapshot; ordered-room request changes; switch mail during refresh; no polling after unmount.
- **Tests / verification:** Proposed `apps/mail/tests/stay-availability-reader.test.tsx`, `apps/mail/tests/quote-workflow-multi-stay.test.ts`. Both-surface selected-mail viewer proof.
- **Sizing / routing:** Not source-sized. Luna max; one behavior PR.

### U11. Durable overflow for party and availability

- **Goal / trace:** R13. Cap exhaustion must not silently lose eligible preparation.
- **Files:** `apps/server-pilot/src/ai/hms-jobs.ts`, `apps/server-pilot/src/ai/prefetch-capacity.ts`.
- **Approach:** Reuse prepared-quote atomic deferral patterns where appropriate. Persist deferred intent and a reason. Ensure an ordinary worker can resume it without a staff click or synthetic work item. Respect property/staff priority and retry bounds.
- **Test scenarios:** Exact cap; overflow; two mailbox transports sharing a property; worker restart; deferred resume; duplicate extraction; unsupported hotel; staff job supersedes background pressure.
- **Tests / verification:** `apps/server-pilot/tests/hms-jobs.test.ts`, `apps/server-pilot/tests/prepared-quote-cap.test.ts`, `apps/server-pilot/tests/prefetch-capacity.test.ts`. Controlled read-only deferred-to-visible proof after runtime readiness.
- **Sizing / routing:** Source estimate 30–50 product, 40–70 test LOC is provisional. Grok queue ownership. Do not assume deferral storage already exists for every path.

### U12. Approved requests reach the native reservation note

- **Goal / trace:** R6. Staff-approved arrival/special-request notes should not remain copy-only when the native note field is already supported.
- **Files:** `apps/mail/lib/quote-workflow/pane-stay-bind.ts`, `apps/mail/components/quote-workflow/booking-card.tsx`, existing `create-request.mjs` reservation-note mapping.
- **Approach:** Merge only reviewed content into the canonical editable reservation note. Preserve staff wording and avoid duplication. Do not claim a shuttle or dinner native Add-On was created by copying prose.
- **Test scenarios:** Existing note; empty requests; duplicate request; staff edited note; mail switch; native note readback.
- **Tests / verification:** `apps/mail/tests/booking-card.test.tsx`, `apps/server-pilot/tests/create-preflight.test.ts`. Labtest saved note matches approved content.
- **Sizing / routing:** Source note-only estimate 15–30 combined product/test LOC. Luna max.

### U13. Remaining manual-field parity

- **Goal / trace:** R6. Close all relevant field gaps rather than call the child-free path complete.
- **Files:** `apps/mail/components/quote-workflow/booking-card.tsx`, `apps/mail/lib/quote-workflow/pane-stay-bind.ts`, `apps/server-pilot/tooling/playwright-quote/create-tool.schema.json`, `create-request.mjs`, `create-lab-stay.mjs`.
- **Approach:** Use current native schema/required-field evidence and a read-only staff workflow walk-through to classify each listed field as already supported, required/frequent to wire, policy-held, or unused here. Wire A/R, billing reference, profile and native option pickers in separate one-behavior slices when evidenced. An approved quote override needs native rate-write/readback and Authorised by, not silent reuse of the standard HMS amount. Extra title/VIP/settlement fields are included only when native/staff evidence requires them.
- **Test scenarios:** Supplied optional fields persist; missing fields remain absent; invalid property option blocked; no inferred opt-in; override grant binds actual amount/authorizer; overridden saved rate equals preview; failure stays explicit.
- **Tests / verification:** `apps/mail/tests/booking-card.test.tsx`, `apps/server-pilot/tests/create-preflight.test.ts`, proposed `apps/server-pilot/tests/create-field-parity.test.ts`. Produce a parity table and fresh saved-field proof for every wired field.
- **Sizing / routing:** Discovery-sized backlog, not one monolithic PR. Luna owns the bounded native inventory; Grok owns write paths. Before dispatching field wiring, turn every property-used missing field into an owned one-behavior slice with its native mapping, exact test, and saved-field acceptance. Inventory completion is not R6 completion. No full field-completeness claim until required/routine fields are wired and the client-policy boundary is resolved.

### U14. Multi-room, HMS confirmation, and both-surface proof

- **Goal / trace:** R5/R14/R17, AE4. Consume existing Phase 1 evidence and close only missing current-head acceptance.
- **Files:** Existing Phase 1 proof scripts and results; `apps/mail/tests/quote-workflow-multi-stay.test.ts`, `apps/mail/tests/mail-nava-panel.test.tsx`, `apps/mail/tests/booking-card-reload.test.tsx` only for new coverage justified by those results.
- **Approach:** Retain proof2/E3, booking-ui/E4, and coordinator ownership until explicitly handed over. Multi-room quote checks room counts, joint inventory, per-night price/board/rate, PDF/Excel and unsent draft. Create checks native fields and partial outcomes. An HMS-email canary uses Labtest plus authorized collector recipient only, never a real client recipient.
- **Test scenarios / verification:** Both surfaces load the last bundle; saved booking and screenshots survive reload; one/multiple room groups; insufficient inventory; partial create. HMS recipient/checkbox plus actual email arrival are distinct checks. A screenshot of the checkbox is not delivery proof.
- **Sizing / routing:** Existing proof lane, no duplicate product unit. Property-specific script canaries; executing coordinator owns tail.

### U15. Cancellation approval binding and disposition

- **Goal / trace:** R15, AE6. Prevent stale full-stay approval and report side effects honestly.
- **Files:** `apps/server-pilot/src/ai/pane-stay-cancel.ts`, `apps/server-pilot/tooling/playwright-quote/cancel-stay-rules.mjs`, cancellation pane copy seam only as required.
- **Approach:** Bind the approved full stay snapshot and forward existing `expectStay` to the spawn request. Maintain exact confirmation/arrival checks. Require an established pre-commit fee determination for auto-commit eligibility; otherwise route to staff without pressing reason OK. Keep penalty Waive/OK prohibited. A previously applied cancellation remains applied/pending-fee in the receipt.
- **Test scenarios:** Same confirmation/arrival but changed guest, dates, status, deposit or guarantee; stale/used grant; unknown fee; post-OK penalty after applied cancel; no hidden retry; no penalty acceptance.
- **Tests / verification:** `apps/server-pilot/tests/pane-stay-cancel.test.ts`, `apps/server-pilot/tests/aop-amend-cancel-payload.test.ts`. Read-only timing/preview inspection before any new write. No new cancellation commit is needed to prove the already-recorded sequencing hazard.
- **Sizing / routing:** Not source-sized. Grok 4.6 high. Protective disjoint fix; no flag change implied.

### U16. Native date-amend route discovery

- **Goal / trace:** R16. Discover the supported native route after two failed persistence loops.
- **Files:** `apps/server-pilot/tooling/playwright-quote/amend-stay.mjs`; dated DOM diagnosis under `docs/research/` with private captures outside git.
- **Approach:** Reuse F2e evidence. Inspect Stay Wizard / Room Type and Rate Availability read-only on Labtest. Identify the request/record semantics before a dedicated deterministic date branch. Do not merge the parked #651 merely because UI values changed. Keep adult amend separate.
- **Test scenarios / verification:** Proposed `apps/server-pilot/tests/amend-date-route.test.ts` only after native route discovery; existing `apps/server-pilot/tests/pane-stay-amend.test.ts` stays green. Later Labtest Save must reopen with approved dates, price/availability consequences, and no unauthorized fee action.
- **Sizing / routing:** No honest code estimate before native route evidence. Grok diagnosis. Unknown route produces explicit unsupported-date disposition, not a fourth variation on blind field filling.

---

## Verification Contract

- Run only targeted remote tests and typecheck on Product EC2. No Vitest or typecheck on the coding VPS. Unset `DATABASE_URL`, `VITEST_ALLOW_PILOT_RDS`, and `TEST_DATABASE_URL` before any test. No pilot RDS tests.
- Approved host wrappers use the committed worktree HEAD. Confirm that HEAD is the one under review. Wrapper usage is `remote-typecheck.sh <worktree> --app <app>` and `remote-vitest.sh <worktree> <app> <test files relative to app>`.
- For this plan's UI units, remote tests include `tests/booking-card.test.tsx`, `tests/booking-card-reload.test.tsx`, `tests/stay-room-builder.test.tsx`, and `tests/mail-nava-panel.test.tsx` plus the unit's targeted file. Do not run a project-wide format/lint command.
- For server units, remote tests include the named unit file rather than a full-suite invocation. Reproduce a claimed baseline failure on clean matching main before treating it as pre-existing. Old baseline notes are evidence locators, not a blanket pass.
- Run targeted Oxlint/format checks on changed files only. Greptile Apex succeeds on the exact PR head with no unresolved confirmed P0/P1. The coordinator reads the full product diff. Never bypass hooks.
- Unit code review and background gates overlap where wrappers permit. Remote install/typecheck/test access is shared; do not assume unlimited parallel EC2 clones or remove its lock.
- Use `scripts/orch/merge-gate.sh` and existing deploy tooling only after their own documented readiness. Deploy only through `apps/server-pilot/deploy/ops-deploy.sh` from the authorized recovery checkout. Record last-good SHA, warn the owner, and obtain executing-session authority where required.
- Before enabling new behavior, verify target descriptors, origin/tenant, secret configuration, provider route, and every process reading a touched flag. Existing unset/off values remain unchanged by this plan.
- Every HMS canary uses the target property lock and runtime path. Write proof records the deployed SHA, approved Labtest input class, screenshot locators, and fresh native readback. No private guest/mail/credential payload enters git or external research services.
- If any write may have applied, reconcile before retry or cleanup. Never delete or cancel unrelated stays created by another lane.
- Quantitative workflow claims use the `PRODUCT.md` answer-key bars: prices on at least 10 independent plannable threads; classifier/party evaluation on at least 100 independent truth rows when those algorithms change. This run does not claim new matcher accuracy from hydration tests.

---

## Definition of Done

- Every relevant booking field is prefilled where facts exist, editable once, validated against the active property, sent through the approved tool, and compared with native readback.
- Children are not silently dropped, and native child-age readback matches approved input.
- Native Add-Ons pass author/add/remove/replay/readback before their controls are called usable. Rate extras and notes are not counted as Add-On proof.
- Party/rate/availability preparation has an ingest-to-durable-result-to-visible-pane trace. Report measured readiness and waits, not an inferred finish-before-open guarantee.
- Actual HMS status and per-room/per-row uncertain outcomes survive pane reopen. Successful reservations are never recreated because a later action failed.
- The owner/client policy questions below are answered for any behavior whose production readiness depends on them. Labtest or read-only work continues independently where safe.
- Both Outlook and webmail viewer runs pass. Staff availability is not marked complete until post-deploy nginx evidence shows the current bundle loaded through the relevant staff surface. Owner/test loads remain labeled separately and cannot substitute for the staff-load gate. A load is not adoption or proof of every booking field.
- Product acceptance bars remain unpassed until the appropriate current-SHA golden/price proof passes. Merged/deployed/unit-green is reported as progress.
- Remove abandoned experimental code from product diffs. Stop only processes started by the lane, by PID. Preserve failed-attempt evidence privately and useful diagnosis in the repo.
- At the allocation boundary, report each unmet requirement and dependency. Do not silently narrow the completeness target or add an unrelated feature.

### Policy questions and launch holds

These are deferred for Labtest/read-only development, but block affected real-guest behavior.

| Question only owner/client can settle | Safe posture until answered |
|---|---|
| May cancellation proceed when HMS only reveals a fee after reason confirmation? Who approves charge/waiver? | Unknown-fee auto-commit stays off; never accept penalty Waive/OK |
| Which statuses and guarantee types count as eligible unpaid bookings? | Keep existing strict status/payment gates |
| Which native Add-Ons are used, and what quantity/date/charge/cancellation rules should staff review? | Catalog/readback discovery proceeds; no guessed fee policy |
| Which new-booking fields are mandatory or routinely entered beyond current pane fields, including billing/profile/market choices? | Native/profile evidence first; mark unused versus required versus policy-held |
| Who may authorize discounts and what native rate amount should Book apply? | Show override/manual action accurately; no silent rate override write |
| Which recipient should receive the provisional HMS confirmation for each staff member? | Preserve per-user self/client/custom choice; test only authorized collector |

This planning session grants no install, deployment, environment, flag, real-guest write, or email-send authority.
A later execution request must identify the accepted run scope and use authority available in that executing session.

---

## Appendix

### Evidence anchors

- `docs/research/2026-10-27-next-run/run-delta.md`: complete PR ledger, importance, and latest Phase 1 ownership.
- `docs/research/2026-10-27-next-run/booking-parity.md`: current source field gaps and provisional seam sizing.
- `docs/research/2026-10-27-next-run/prefetch-parity.md`: quote/new-booking trigger matrix, persisted readers, property metadata, overflow.
- `docs/research/2026-10-27-next-run/amend-cancel.md`: current source and saved native persistence/penalty-timing evidence.
- `docs/research/2026-10-27-next-run/pomerado-trial.md`: pinned package/browser/provider/readback blockers and exact safe trial.
- `docs/plans/2026-10-26-007-dv-faith-run-plan.md`: original acceptance and ownership. Necessary completion repairs are not new features merely because they require another PR.
- `docs/solutions/workflow-issues/hms-live-write-preflight-and-long-jobs.md`: full preflight, background long jobs, independent readback.
- `docs/solutions/ui-bugs/2026-10-25-stay-contact-canonical.md`: canonical field ownership.
- Pomerado: https://github.com/Pomerado/pomerado and https://registry.npmjs.org/pomerado/0.4.0-canary.439

### Applied retrospective lessons

| Observed problem | Change in this plan |
|---|---|
| PR count was treated as scope growth | Classify each added unit by requirement and acceptance necessity |
| Live field looked changed but saved record did not | Fresh native readback is a required outcome |
| Proof tail was mistaken for finished work | Executing coordinator retains deploy/viewer/native-proof ownership |
| New pane component can ship unmounted | U7 names its mounter and both-surface render test |
| Broad workers rediscovered known context | One question, exact current source/prior result, owned output, explicit exclusions |
| Parallel chats can duplicate work | Phase 1 retains named files/proofs/slot until handover |
| Failed amend encouraged another tool rewrite | Native route diagnosis first; Pomerado reserved for the requested Add-On trial |
| Fee refusal was overclaimed | Cancellation side effect and penalty acceptance are reported separately |

Worker briefing guidance was updated in the existing bounded-subagent memory.
That improves briefing; it is not proof that every research worker used fewer tool calls.
