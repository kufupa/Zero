---
title: Staff-Reviewed Quote Pilot - Plan
date: 2026-10-06
type: feat
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
---

# Staff-Reviewed Quote Pilot - Plan

## Goal Capsule

- Deliver the existing Outlook quote pane connected to real read-only HMS pricing, an authoritative PDF and a staff-edited unsent reply.
- Make actual unanswered questions and failed business-document extraction obvious, specific and actionable. A shuttle question must not prevent an otherwise qualified accommodation quote.
- Reuse the existing extraction, review summary, PMS owner, pricing/revision, PDF, saved-reply and native insertion paths. Do not build another agent, workflow engine, pricing engine or document store.
- Work code-first, then perform one bounded end verification pass. No mandatory TDD, broad corpus rerun, repeated full suites, design-system rebuild or speculative edge-case expansion.
- Backend owner works in `centurion-dashboard-tools`; UI owner works in `reservationist-quote-ui`. All paths below are repo-relative; the owning tree is identified per unit. Preserve both dirty worktrees and unrelated work.
- No PMS writes/holds, booking creation or email sends. Deployment is a separate explicitly authorized step, not a consequence of completing this plan.
- Target a connected pilot candidate in approximately 90–120 minutes after execution starts, conditional on reusing the installed service composition. This is an engineering estimate, not a measured guarantee. A warning-only component is not a working quote pilot.

## Product Contract

### Summary and Problem Frame

Staff should approve extracted or manually corrected stay requirements, run the relevant existing read-only tools, inspect real prices, review a PDF/reply and insert an unsent Outlook response without opening HMS for the supported quoting cases.
The product does not need to answer every secondary customer-support question automatically before becoming useful.
It does need to preserve those questions rather than silently omit them or block all accommodation work.

Product Contract clarification: quote-only staff review is the immediate scope; broad reservationist accuracy and booking writes remain follow-up work. This plan supplements, rather than overwrites, the broader reservationist plan and the UI integration plan.

### Requirements

#### Inputs and staff actions

- R1. Preserve available dates, rooms, occupancy, meals and party facts when analysis is incomplete. An authorized selected message may enter manual correction without successful model extraction; an unsynced or unauthorized message may not.
- R2. Run the exact current staff-approved requirements. Staff corrections are explicit staff input, not fabricated evidence that the original email said something it did not.
- R3. Show a compact top-level “Items for you” list containing the actual outstanding request, its source and the next action. Example: “Answer: Is an airport shuttle available?” with “View request”, “Edit reply” and “Mark handled”. Do not manufacture this example unless it exists in the source.
- R4. Report actual failed/unavailable business documents by filename and reason, with retained usable facts. Distinguish a failed email batch from an attachment failure. Suppress only positively identified signature/logo noise; do not classify an unread unknown image as noise by extension alone.
- R5. Keep handling status bound to the selected message/source revision. “Mark handled” is staff acknowledgment, not a pricing approval or proof that the model answered correctly. Editing stay inputs invalidates downstream quote/PDF results; editing the reply does not discard the selected quote.

#### Pricing, PDF and draft

- R6. Qualify accommodation independently of unresolved secondary questions, using the existing authorization, current input, selected-allocation, rate eligibility, availability, freshness and exact-money checks. A missing pricing-critical fact or unresolved party/rate authority still blocks the affected quote, with a specific action.
- R7. Use server-owned quote revisions and artifact references. No UI typed room prices, client-supplied “reconciled” flags, summing alternative options, guessed tax additions or blanket removal of existing readiness guards.
- R8. Review and persist the complete edited reply and exact selected PDF, then perform explicit unsent native insertion. Never insert only the first paragraph, replace staff text on hydration, silently duplicate an uncertain native outcome or send mail.
- R9. Support currently qualified public, government and party-rate cases through their real existing tools. Do not substitute BAR when entitlement is unresolved. Restrict only a specifically unsupported allocation/scope; do not add a generic “AI may be wrong” banner to correct results.

### Scope Boundaries

- Included: exact staff action projection; partial/manual requirements; staff-approved execution seam; quote-specific qualification; existing UI adapters, PDF and unsent reply integration.
- Deferred: create-booking writes/UI, autonomous sends, full agent omission repair, broad corpus evaluation, new voucher parsers, generic workflow builders, commercial discount automation and cosmetic redesign.
- Existing unsupported child/meal or combined-inventory scopes remain explicit staff work where evidence is missing. This plan does not invent support or remove already working support.
- “80/20 MVP” means a smaller feature scope, not 80% acceptable pricing correctness. Supported pricing and artifact checks remain exact.

## Planning Contract

### Current Code Evidence

| Finding | Evidence | Consequence |
|---|---|---|
| New UI Run step returns unavailable | UI tree: `apps/server-pilot/src/trpc/routes/quote-workflow.ts`, `runStep` | A live endpoint connection is essential, not cosmetic work |
| Existing generic enqueue derives requests from mail rather than edited requirements | Backend tree: `apps/server-pilot/src/trpc/routes/ai.ts`, HMS enqueue input/handler | Do not wire staff edits through this route unchanged |
| Review tasks/recoveries and pricing proof already exist | Backend tree: `apps/server-pilot/src/trpc/routes/drafts.ts`, `buildReservationistReviewSummary` | Extend this projection rather than build another task service |
| Secondary asks currently lack handling status and are permanently called unanswered | UI tree: `apps/mail/lib/quote-workflow/types.ts`; `apps/mail/components/quote-workflow/document-review.tsx` | Replace duplicated generic notices with source-bound actions |
| Several panel early returns hide correction/review controls | UI tree: `apps/mail/components/quote-workflow/quote-workflow-panel.tsx` | Keep source actions and authorized manual correction visible on partial analysis |
| Qualified proposal guard currently requires whole-result readiness | Backend tree: `apps/server-pilot/src/trpc/routes/workstation.ts`, `resolveLedgerProposal` | Add narrowly scoped quote qualification; do not simply accept every blocked run |
| Exact revision pricing and rendered PDF builder already exist | Backend tree: `apps/server-pilot/src/quote-proposal/quote-lines.ts`; `proposal-pdf.ts`, `buildRevisionProposalPdf` | Reuse the current HTML/PDF path, not the old Excel repair project |

### Key Technical Decisions

- KTD1. Extend the existing review-summary DTO with source-bound outstanding actions. Carry the original validated request clause/source reference through runtime projection where needed; never infer outstanding questions from generated reply text alone.
- KTD2. Use the existing extraction pass to inventory requests; do not add a second model call per message just to generate warning text. Reuse validated task/recovery output and known answered status. An analysis failure gets an honest named review action, not an invented list of missed questions.
- KTD3. Add the smallest server seam needed for approved inputs and quote-specific qualification. Prefer an existing authorized service entry point; if none fits, one small composition module is acceptable. No new generic interface hierarchy, browser owner, DB store or queue.
- KTD4. Staff quote approval must be authorized and bound to mailbox, message, source selection, input revision and canonical request digest. The UI must not provide its own price authority. Existing extracted-source execution requires `text_verified` facts and can block on incomplete extraction; use an explicit server-attested staff-input path beneath the same native/revision/money checks rather than relabel corrections or inherit unrelated extraction failures. Reuse installed execution/lease protections; test-only service setters and disposable harness composition are not production wiring.
- KTD5. A quote-specific persisted result may qualify while secondary tasks remain open, but only when its selected quote task and all applicable pricing prerequisites passed. Retain legacy whole-result gates for other actions and inherited results lacking that attestation.
- KTD6. Keep one selected allocation and its qualified revision/fact/run references. Prices come from the existing qualified PMS evidence; rendered values must match exact cents. Reuse existing VAT/levy/inclusion authority without adding tax again.
- KTD7. Reuse existing session/reply persistence. Actions can use the existing session store; preserve acknowledgments on reload if the current draft store supports this without a new storage system. Otherwise state the session-only limit explicitly in the pilot handoff.
- KTD8. UI owner owns components, adapter mappings, session reducers and its thin route binding. Backend owner owns admission/extraction/review projection, installed service composition, PMS execution and qualification. UI owner must not repair backend policy or create a second execution path.

### Data Flow

```text
Authorized selected email + available documents
                 |
       Existing analysis / manual correction
                 |
       Staff-approved current stay inputs
                 |
       Existing party/quote tools, one PMS owner
                 |
       Qualified selected revision -> PDF
                 |
       Staff-edited full reply -> unsent Outlook draft

Actual outstanding asks / failed documents -> Items for you
Non-pricing questions do not block a qualified accommodation PDF.
Pricing-critical gaps block only the affected quotation.
```

### UI Contract

Reuse the existing narrow pane, colors, typography, inputs, buttons and editor. No new design system or dashboard.

```text
Selected email
Items for you (only if actual open items exist)
  Question/document · source · Edit reply/View source · Mark handled
Stay requirements (editable; missing pricing facts called out inline)
Approved tool steps -> real selected rate/allocation
Quotation PDF + complete editable reply
Insert unsent reply
```

- Show the actual question clause, not just “Transfer” or “Answer question”. Long source text may expand inline; do not silently truncate the meaning.
- Rank missing pricing facts first, unread business sources second, unanswered secondary requests third. Use one compact list, not repeated banners in each section.
- Open non-blocking tasks are amber; pricing-blocking fields explain the exact required correction. Never rely on color alone. A clean case has no warning list.
- “View source” uses the existing original-message/attachment action; do not build a new document viewer. “Edit reply” focuses the existing saved-reply editor, which must remain reachable for authorized partial/failed-analysis quote candidates even before offers or a PDF exist. “Mark handled” changes only the action state, with an accessible way to undo.
- A failed business attachment does not automatically invalidate verified email facts or staff-confirmed inputs. Its missing information cannot be silently treated as evidence of a contract, voucher price or inclusion.
- Preserve manual correction for authorized quote candidates whose analysis fails. Do not auto-open a quote workflow for unrelated non-quote mail or bypass authorization on unsynced mail.

| State | What staff see | Available action |
|---|---|---|
| Analysing | Existing progress text; known facts retained | Wait or correct available fields |
| No selected/synced mail | Specific select/sync message | Select/sync message; no execution |
| Partial facts | Populated known fields; exact missing fields inline | Complete only missing facts |
| Failed relevant source | Filename, reason, source link; partial form remains | Inspect source and confirm requirements |
| Verified signature noise | No business failure warning | Continue |
| Qualified quote, open secondary ask | Real prices/PDF plus exact “Items for you” row | Prepare PDF, edit reply, insert unsent draft |
| Pricing evidence unavailable | Exact affected scope/authority issue, no invented total | Correct facts/rate context or handle manually |
| Staff changes stay inputs | Old results visibly stale; PDF insertion disabled | Rerun the affected tools |
| Native insertion uncertain | Existing “check Outlook” outcome | Check first; no blind retry |

- Retain the current supported pane width (approximately 360–400px); rows wrap without horizontal scrolling and retain the same single-column order. No new 320px layout target or separate mobile navigation.
- All actions have accessible names and visible focus; status updates use polite announcements. Source text is rendered as text, never executable attachment/HTML instructions. Maintain contrast and practical touch targets without adding an accessibility framework.
- Journey: in five seconds staff can identify the outstanding work; in one session they can correct facts, approve tools and edit the reply; repeated use should not teach them to ignore permanent generic warnings.

### Parallel Handoff and Integration

The backend owner publishes the real DTO/export names and one sanitized example in `docs/plans/handoff-reports/2026-10-06-staff-quote-pilot-backend-handoff.md` as soon as the contract is chosen, then adds the scoped snapshot references when implemented.
The DTO must cover: selected source identity, current input revision, known/missing facts, actionable source-bound review items, approved-step request identity, authentic results, selected qualified proposal references and actual artifact metadata.
Do not predeclare fictional wire names as an existing API; the backend export is authoritative.

The UI owner starts U3 independently, using these semantics and the existing integration plan, then binds the published backend contract.
Integration uses an owner-published scoped snapshot or isolated integration tree with explicit overlapping-file resolution, not wholesale copying either dirty checkout.
The UI owner gets one initial task and reports completion or an exact backend dependency once. There is no periodic reporting deadline or repeated supervisor steering.
An unavailable backend dependency stops only connected verification; useful UI work can finish, but it must not be reported as a live quote tool.

## Implementation Units

### U1. Backend Staff Review Projection and Contract

- Owner: backend. Covers R1, R3–R5. Independent of UI component work.
- Files: `apps/server-pilot/src/trpc/routes/drafts.ts`; `apps/server-pilot/src/ai/reservationist-runtime.ts`; `reservationist-execution.ts`; existing extraction/source-recovery projection only where necessary; the backend handoff document above.
- Approach: retain validated original task/request source clauses, use existing known recovery codes, add actual business-document failures to the review DTO with source identifiers and display filenames. Preserve known facts. Do not broaden keyword heuristics to all signature/history text or repair the full agent pipeline.
- Tests: extend `apps/server-pilot/tests/reservationist-review-summary.test.ts` and the existing relevant source/runtime regression file only if its projection changes.
- Scenarios: exact unresolved shuttle/comparison question; answered task absent from open list; real failed attachment named; failed email not mislabeled; verified signature ignored; unknown unread image not silently ignored; missing checkout asks only for checkout, retaining arrival/rooms.
- Done: small stable DTO and sanitized handoff example published; no false claim that the code inventories every possible omitted question.

### U2. Approved-Input Quote Execution and Qualified PDF Seam

- Owner: backend. Covers R2, R6–R9. Depends on U1 contract, not completed UI.
- Files: existing `apps/server-pilot/src/ai/reservationist-provider.ts`, `reservationist-business-services.ts` and installed composition as required; `apps/server-pilot/src/trpc/routes/workstation.ts`; a new `apps/server-pilot/src/ai/staff-quote-workflow.ts` only if no existing narrow entry point fits. Reuse existing request normalizer, revision/lines and PDF services.
- Approach: accept canonical staff-confirmed stay requirements through existing mailbox authorization and serial PMS execution, with server attestation of the approved input scope. Do not send these corrections unchanged through `assertRevisionSourceFacts` as fabricated `text_verified` email facts or through the extraction-completeness guard in `reservationist-execution.ts`; reuse the underlying native request/revision/money validation through the narrow staff path. Publish the smallest approved-execution/PDF references seam. Persist quote-task-specific qualification with exact revision/input binding; secondary task failures remain visible without being price authority. Keep party resolution and eligibility checks and legacy action gates.
- Tests: add `apps/server-pilot/tests/staff-quote-workflow.test.ts` if a new seam is created; otherwise extend the owning service test. Extend `apps/server-pilot/tests/quote-proposal-pdf.test.ts` only for the changed qualification boundary; reuse existing money/render checks.
- Scenarios: edited dates/occupancy actually reach PMS; cross-mailbox and stale input rejected; valid accommodation plus unresolved secondary ask can generate exact PDF; missing pricing fact cannot; no new typed-price override; public/government/party eligibility retained; alternative options not summed; zero/missing prices rejected; quantity/date-varying totals match existing exact cents.
- Done: installed real composition reachable from the authorized route and bound to current approved inputs; usable qualified references published. A private replay harness or fixture-only endpoint does not satisfy this unit.

### U3. UI Staff Actions and Real Backend Binding

- Owner: UI tree only. Covers R1–R9 presentation/integration. Start action-list work immediately; final service binding depends on U1/U2 publication.
- Files: `apps/mail/lib/quote-workflow/types.ts`, `session.ts`, `backend-bind.ts`; `apps/mail/components/quote-workflow/quote-workflow-panel.tsx`, `document-review.tsx`; pane integration callbacks; `apps/server-pilot/src/trpc/routes/quote-workflow.ts` as a thin binding to the backend-owned seam.
- Approach: optional source-bound action rows in existing analysis/session types, handling reducers, one reusable top list above applicable partial/error rendering, existing reply/source actions. Make the existing reply editor reachable without offers/PDF for authorized partial or failed-analysis quote candidates; the action must have a real focus target. Remove duplicate permanently-unanswered text. Connect staff-edited inputs and real proposal/artifact references; do not invent a second engine or a “centsReconciled: true” response.
- Tests: extend `apps/mail/tests/quote-workflow-session.test.ts`, `quote-workflow-panel.test.tsx`, `quote-workflow-backend-bind.test.ts`; existing native-draft test only if insertion behavior changes.
- Scenarios: clean case no warnings; exact question and failed filename visible; completed action removable/undoable; partial facts editable; changing selected mail invalidates action handling/evidence; changing stay inputs invalidates old PDF; edited reply survives hydration; secondary asks do not block otherwise valid unsent insertion; stale/cross-source results rejected.
- Done: existing panel works with real contract, not just fixtures. Source actions and correct quote results coexist visibly. Report independent UI completion separately if backend binding is genuinely unavailable.

### U4. Bounded End Verification and Pilot Handoff

- Owners: backend for service/money checks; UI for browser/native path and integration report. Depends on U1–U3.
- Approach: code first, run affected test files once, fix demonstrated failures, rerun only affected failures, then one connected browser/PDF scenario. Use existing authentic recordings for other covered price shapes rather than rerunning PMS for each historical email.
- Proof files: existing focused tests above; an integration report under `docs/plans/handoff-reports/2026-10-06-staff-quote-pilot-verification.md`; private artifacts for message/source IDs, screenshots and PDF text/hash.
- Done: record exact commands/results, installed route/composition, one real successful path and any unavailable external acceptance step. Clean up owned temporary browser/tunnel processes. No fictitious “production ready” claim from component tests alone.

## Verification Contract

One focused end pass is mandatory. No TDD requirement; no broad corpus pass or repeated repository-wide suites for this pilot.

| Check | Minimum evidence | Why retained |
|---|---|---|
| Exact money/revision | Existing deterministic checks for quantity, varying nights, selected allocation, zero-price rejection and rendered values; changed qualification regression | Wrong client prices are the highest-priority failure |
| Edited inputs and isolation | Targeted service/adapter check for actual edited request, stale and cross-mailbox rejection | Prevent silently quoting the original uncorrected email or wrong source |
| Staff action behavior | Clean case, actual secondary ask, business failure vs signature, partial known facts, handling/undo | Prevent noise and hidden customer work |
| Real quote/PDF/reply | One authorized connected quote through real PMS owner, selected revision, actual PDF conversion/text/hash and full edited reply | Proves the integrated path beyond mocks |
| Additional enabled pricing lane | Reuse exact authentic government/party recording and existing qualification tests; fresh read only if installation/native behavior changed or evidence is insufficient | Avoid one PMS execution per corpus email without guessing eligibility |
| UI/native insertion | Browser form/actions/stale-result proof plus existing native protocol regression; Windows explicit unsent insertion if a connected supported workstation is available | Browser proof alone cannot establish the Outlook host works |
| Build/typing | Backend affected typecheck and one relevant UI build/typecheck pass | Catch integration errors without looping on unrelated existing full-mail failures |

Keep actual failing checks visible. Distinguish pre-existing unrelated build failures from failures in touched code with concrete diagnostics; never ignore a relevant compile error because the repo is already dirty.
No need for a second fresh live quote when unchanged native behavior already has exact authentic evidence; use a second shape if the changes affect that lane.
If supported Windows insertion cannot be exercised here, label the result “connected browser pilot candidate; Outlook acceptance pending”, with the exact short client-side acceptance steps. Do not call deployment/Outlook acceptance complete.

## Definition of Done

- All R1–R9 implemented for the enabled quote scopes, with the small backend/UI seam actually connected.
- All changed money, authorization, input-revision, review-action and artifact/insertion checks pass; one actual connected quote/PDF/reply demonstrated.
- Actual unanswered work is visible, actionable and source-bound; correct accommodation work proceeds independently. Missing pricing authority is not waived by staff acknowledgment of an unrelated question.
- Reply edits and exact artifact identity preserved; no PMS writes/holds or email sends.
- Backend and UI handoffs identify their scoped changes, exact integration contract and any genuine platform acceptance dependency.
- Abandoned experimental implementations and owned temporary resources removed without touching unrelated user work.
- No universal accuracy percentage, full-corpus completion or production deployment claim. Those are separate work, not hidden prerequisites for this scoped candidate.

## Appendix

### Design Review Scope and Decisions

This is a focused plan-level review of the existing narrow pane, not a rendered visual audit or a redesign. The user has already specified the key decision: show exact outstanding questions, keep correct quoting usable, and optimize time to pilot.

| Dimension | Plan treatment | Execution proof still needed |
|---|---|---|
| Information architecture | Single top action list followed by requirements/tools/PDF/reply | Actual narrow-pane rendering |
| State coverage | Explicit clean, partial, failed-source, stale and native-uncertain states | Targeted UI tests/browser |
| User journey | Identify work, correct facts, approve tools, edit and insert unsent | Connected staff-path check |
| Generic-design risk | Reuse existing pane; no new cards/dashboard/design abstractions | Check no unnecessary restyling |
| Design-system alignment | Existing controls/tokens retained; no standalone DESIGN.md found in UI tree | Existing component styling/contrast |
| Responsive/accessibility | Narrow wrapping, keyboard/focus, labels and polite status | Browser keyboard and width check |
| Unresolved decisions | No new product decision needed; actual installed composition and Outlook host availability are execution checks | Report factual dependency, not a redesign discussion |

No full interactive seven-pass design-review completion or mockup approval is claimed by this table. Those ceremonies are not required to start the user-approved scoped implementation; the plan retains the requested design checks and mandatory practical end verification.

### Timing and Stop Rule

- Backend seam/projection: approximately 45–90 minutes; UI actions/adapters: approximately 35–60 minutes concurrently; final connected verification/integration: approximately 20–30 minutes. Do not add these parallel estimates serially.
- A 45-minute end-to-end delivery is not supported by current missing route/approved-input composition. Faster completion is welcome when reuse proves easier; do not occupy a time budget with extra tests.
- If installed composition cannot be reused quickly, report the exact missing production adapter/export and finish independent UI work. Do not spend hours expanding replay, building a framework or producing more mock demonstrations.
- Deploy the scoped quote pilot only after explicit rollout authorization and the relevant host acceptance; keep further corpus/agent improvements out of this release path.
