---
title: Modular HMS Cloud Tools - Plan
type: feat
date: 2026-11-01
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
origin: docs/plans/2026-10-31-002-feat-hms-cloud-broad-tools-plan.md
---

# Modular HMS Cloud Tools - Plan

> **Superseded for execution (2026-11-01):** run [Box 1](2026-11-01-002-hms-cloud-create-e2e-box-plan.md) instead. This file remains the evidence and requirements reference; its lock-narrowing unit, native multi-room pilot, separate CMS lane and 3,000-minute ETA are withdrawn.

## Goal Capsule

**Outcome:** Give Nava reusable Centurion SaaS HMS capabilities for finding the right existing stay and profile, quoting, preparing and saving a new reservation, amending stay details, and handling useful documents and finance context. Include a bounded multi-room pilot. Existing staff surfaces and complete product release remain separate from this tooling pass.

**Authority:** This is a plan, not permission to start a build, deploy, change flags, send a message, or repeat a denied action. `PRODUCT.md`, `AGENTS.md`, and current owner direction govern live work. Fake Proof Labtest stays in 2027 or later are the standing live-write proof target under `PRODUCT.md`; real-guest writes require the applicable current authority. Never send from Nava or accept a cancellation-penalty dialog.

**Research safety:** The owner permits opening and editing forms without saving, including forms for real stays. An unsaved UI change can still issue a server request. Keep the read-only/context fences installed, permit only inspected data-only requests, and prevent persistent real-guest mutations or sends. Closing a tab alone is not proof that no side effect occurred. The previously denied room-amend browser probe and separate linker source-manifest write/later-association check remain held. Never retry, rephrase, delegate, or route around them.

**Direction to every future coordinator and lane:** Start the brief with this capsule and the relevant unit, exact hold, ownership, and current evidence. Carry the capsule and decisions through compaction and handoff. Give each subagent one bounded question or owned slice. Make reversible evidence-backed decisions without inventing blockers; record what, why, evidence, and any deferred fields. Do not silently narrow scope or start implementation from this planning approval.

**Lane-brief minimum:** Build modular Cloud tools for Centurion SaaS, not old business tools or Labtest-only product code. Preserve current property/identity guards, human approval for product writes, no-send, Labtest-only live-write proof and both named holds. Use existing Cloud capabilities when fit; keep session ownership and same-target conflicts safe without a property-wide browser assumption. Match existing profiles; do not create or change shared profiles in this pass. CMS checkbox, ID and email are optional; `03` may be changed or cleared. Report evidence, omissions and native side effects, and keep this brief through compaction. Each worker receives only its owned unit and relevant paths.

**Design:** New business capabilities are modular Cloud tools for the Centurion SaaS interface, composed on a caller-owned property-specific browser session. Archived Playwright business tools are historical references only: do not edit them, call them as the new business implementation, or build new features on their behavior. Check existing newer Cloud tools for fitness and reuse before duplicating them. Existing Cloud modules currently import some older-directory browser, notes, and request-guard helpers; those are real infrastructure dependencies, not evidence that the old business tools are acceptable. Preserve protections while replacing or isolating dependencies as needed. Never disable a guard just to satisfy a folder rule.

**Scope choices:** CMS send checkbox, message ID, and email are optional. `03` may be a changeable default, not a mandatory or immutable code. Find and select existing guest profiles; creating or amending shared guest profiles is outside this pass. Do not silently mutate them. Generic Cloud document attachment and a bounded multi-room pilot are in the plan. OCR, POP intake, group/XLSX, and pane redesign remain parked. Existing pane behavior is not proof of a completed Cloud workflow.

**Concurrency:** No blanket one-browser-per-property rule for new Cloud sessions. The owner reports parallel Chromium logins using the same credentials; historical evidence independently shows a separate HRCEN browser operating while the slot remained open, but does not establish every same-login state-isolation case. A single page's operations remain ordered. Use separate sessions and distinct targets where feasible; prevent simultaneous conflicting writes to the same reservation using the smallest existing coordination mechanism. Some current product paths still acquire a property advisory lock. Do not claim it is gone or bypass it; investigate and remove or narrow unnecessary serialization in an authorized implementation after confirming its actual callers and safety role.

---

## Product Contract

### Summary and problem

Reservation staff need correct, reviewable stay data and HMS actions, not another set of isolated demos. Current Cloud readers and draft selectors cover useful parts of the flow, but broad saved create, reservation amendment, agreed-price application, documents, multi-room behavior, and ordinary integration are not established. The [field audit](../research/halloween/2026-11-01-hms-field-scope-audit.md) inventories observed controls without claiming that every field can or should be written. The [prior run retro](../research/halloween/2026-11-01-hms-17h-retro.md) shows why shared-framework work, stacked prerequisites and oversized tests must not displace direct tools.

### Requirements

**Read and identify**

- R1. Find an exact existing reservation or return distinguishable candidates and incomplete-search coverage without guessing.
- R2. Find and explicitly select an existing guest profile and preserve source and ambiguity; do not create or alter a shared profile in this pass.
- R3. Independently search and select agency, organization and accounts receivable when requested; do not infer one from another or silently clear an existing link.
- R4. Preserve useful HMS fields, source, observation time, coverage and conflicting observations without treating an unreturned field as empty.

**Quote and price**

- R5. Use Cloud Hotel Availability with the actual property, dates, per-room occupancy including child ages, room quantity, room/rate choices and relevant party context.
- R6. Return nightly price, inventory, restriction and criterion evidence separately. Preserve partial results and mark missing nights, unknown values and incomplete coverage; missing does not mean zero or sold out.
- R7. Keep rate plan, eligibility, room stock, per-night price, taxes, total, hold status and payment status distinct. A rate picker is not an availability quote, and a nightly sum is not automatically the official stay total.
- R8. Support choosing current rate options and, where HMS actually offers it, applying a staff-approved agreed or overridden price. Require an `Authorised by` value for discounts. Do not claim a metadata-only amount was applied to HMS.
- R9. Keep background quote results retrievable after staff navigate away using existing job/result storage when compatible; do not rely only on a page-scoped handle. Restrict results and screenshot access to the authorized actor and property, and apply existing guest-data and retention protections. This tooling requirement does not authorize a pane redesign.

**Create, amend and CMS**

- R10. Prepare and execute a staff-approved new stay with the relevant reservation fields and a selected existing guest profile, without imposing a single rate or guarantee across all bookings.
- R11. Prepare and execute reservation-specific changes for the requested stay, preserving unspecified fields and surfacing native dependent changes. Group compatible changes into one authorized save where the native flow permits.
- R12. Provide the CMS send-confirmation checkbox, message ID and recipient email as optional controls. `03` can be proposed by default when present in the current picker and can be changed or cleared. These controls do not authorize sending.
- R13. Preserve explicit zero children, a known child count with unknown ages, and known ages as different states. Do not invent child ages or guest allocations.
- R14. Bind every write to the correct property, intended target, approved changes and permitted native requests. Capture a screenshot and independently reopen after a dispatched save. Reconcile an uncertain result before retrying.

**Documents, finance and multiple rooms**

- R15. Read the finance information HMS exposes with its source and coverage. Distinguish displayed balances/deposits from posted transactions or cleared funds.
- R16. List available document metadata and attach an approved file to the exact authorized stay through a new Cloud capability when the native flow supports it. Do not claim document bytes or complete coverage from a partial list.
- R17. Pilot a small multi-room case using the native Cloud workflow, preserving one confirmation and outcome per room and the verified relationship where HMS exposes it. A partial success remains partial.

### Key flows and acceptance examples

- F1. **Quote then create:** Resolve the guest and optional parties; obtain Hotel Availability for actual stay criteria; return options and coverage; prepare the selected room, rate, stay details and any approved agreed price; obtain staff approval; perform an authorized save; reopen and compare the saved stay. If an existing guest cannot be identified, return candidates or a needs-profile outcome rather than silently create a shared profile.
- F2. **Amend:** Locate the exact confirmation and current stay, prepare only the requested reservation changes, show native repricing or dependent changes, obtain approval, save once where supported, and reopen. If the held room-amend probe is implicated, leave that operation held and continue unrelated work.
- F3. **Partial quote:** For a three-night stay with rates for two nights, return those two prices and mark one night missing. Do not display their average as a verified three-night price or call the missing night sold out. Recover missing data in the background when possible.
- F4. **Uncertain save:** One Labtest Booker update persisted even though the tool returned `uncertain` after a blocked request. A separate adult amendment returned HTTP 200 and `uncertain`, but a fresh read found its requested change absent. [Observed cases](../research/halloween/2026-10-31-hms-coverage-run.md#resume-after-lean-replan-utc), [adult readback](../research/halloween/2026-10-31-hms-coverage-run.md#current-run-snapshot--2132-utc). Reopen the exact stay before any retry; do not assume either success or failure.
- F5. **Two-room pilot:** Prepare two room requests with their own occupancy and rate. Use the supported native association path if independently established and not part of a held probe. Preserve the first confirmation if a later room fails. Never report two linked reservations from two unlinked or unverified rows.
- F6. **Document:** Given an approved synthetic file and verified Labtest stay, attach it through the Cloud UI, then reopen the Documents tab and report what can actually be verified. Metadata proves only the observed metadata, not file-byte equality or payment clearance.

### Scope boundaries and evidence

| Decision | What and why | Evidence and limit |
|---|---|---|
| Existing profile | Search/select it; do not create or amend shared profiles in this pass. Stay-owned contact fields are in scope only when verified to be stay-owned. | Owner direction, 2026-11-01. The [audit](../research/halloween/2026-11-01-hms-field-scope-audit.md) found different contact observations across saved surfaces, but that does not establish which is newer. |
| Stay fields | Include dates, adults, children, room/rate/board, reservation contacts, notes, source, reason, party links, guarantee, useful billing references and requested CMS controls. Verify actual editability and side effects by field family. | The [434-row per-surface audit](../research/halloween/2026-11-01-hms-field-scope-audit.md#11-per-key-cloud-createamend-crosswalk) covers 892 selected stays, not all HMS screens or an inbound prevalence sample. |
| Other fields and tabs | Preserve values in reads. Do not invent setters for loyalty, revenue totals, profile history, system status, card data or obscure flags without an evidenced reservation workflow. Defer each with a reason rather than silently dropping it. | DOM read-only/editable flags alone do not prove ownership or persistence; many fields are calculated, profile-owned or system-managed. |
| Parties | Include A/R alongside agency and organization; keep them distinct. The current create writer requires A/R blank rather than clearing it. | Selected records show agency 596/892, organization 548/892, A/R 174/892, with independent combinations. Later snapshots are not a booking-time policy. [Audit](../research/halloween/2026-11-01-hms-field-scope-audit.md#3-cross-field-checks-on-the-892-saved-records). |
| Stay amendments | Prioritize requested dates, occupancy and other reservation details, not only notes or shared-profile edits. | An older heuristic found 223 candidate amend events, including 67 mentioning people/occupancy and 17 added nights, with five in both groups. These are not human-verified prevalence. [Baseline](../research/halloween/2026-10-31-hms-inbound-automation-baseline.md#existing-corpus-baselinenot-a-new-mix-estimate). |
| Rates and guarantees | Offer actual current choices rather than hard-coding one rate or treating NGI as the product rule. | A selected 612-stay source cohort spans multiple rate codes and guarantee types; rate does not determine guarantee. [Cohort](../research/halloween/memory-experiments/2026-10-30-source-cohort-and-cloud-tool-design.md#rate-plans-change-with-source). |
| CMS | Optional checkbox, ID and recipient; changeable `03` suggestion. No sending. | `03` occurred in 840/892 selected records; other codes also occurred. The old nonblank owner rule is superseded. Picker and checkbox draft operations already exist. [Audit](../research/halloween/2026-11-01-hms-field-scope-audit.md#further-claim-checks). |
| Multi-room | Build a bounded pilot, not a complete group/rooming system. Do not infer links from shared dates or guest. | 24 selected same-profile/date clusters contain 61 records with differing assigned rooms; this is a pilot signal, not association proof or population prevalence. One historical HRDAV Labtest case had linked rooms. [Evidence](../research/halloween/2026-11-01-hms-tooling-parked-items.md#multi-room-booking). |
| Finance and documents | Reuse Cloud display reads; add useful missing folio access and generic approved attachment, without claiming payment posting or automatic reconciliation. | Existing [finance projection](../../apps/server-pilot/tooling/hms-cloud/guest-stay-finance-preflight.mjs) reads displayed fields. The [document reader](../../apps/server-pilot/tooling/hms-cloud/stay360-documents.mjs) lists loaded metadata, not file contents. |
| Parked | Shared-profile create/edit, OCR/POP intake, group and XLSX rooming, automatic payment posting, outbound messages, cancellation commits and pane redesign. | Owner direction and [parked work](../research/halloween/2026-11-01-hms-tooling-parked-items.md). Generic finance/document tools remain in scope. |

---

## Planning Contract

### Key technical decisions

- KTD1. **Compose capabilities, not a framework.** Keep operation-specific search/read/select, draft-edit, submit and readback functions with structured inputs and results. Use existing Cloud session modules when fit. Do not create a new tool for every field or rebuild a working reader merely to rename it.
- KTD2. **Preserve identities and evidence.** A lookup returns current candidate IDs, distinguishing fields, search scope, coverage and ambiguity. Selection uses the current result in that session. Inputs distinguish omitted, explicitly blank, and unknown. Outputs distinguish `selected`, `partial`, `unsupported`, `failed`, and `uncertain` as applicable; exact names remain implementation choices.
- KTD3. **Separate authorization from mechanics.** General Cloud functionality must not hard-code fake guests or NGI as permanent product requirements. The current live-write fence still permits only its authorized Labtest cases. Broader real-guest execution remains disabled until the applicable owner authority and runtime checks exist. Staff approval is always required for product writes.
- KTD4. **Limit the safety contract to real consequences.** Verify property, target, approval and intended values; preserve send suppression, protected-request fencing, meaningful native side effects, and fresh readback. Where a native operation uses one save, allow the one matching request. An attachment may need a different proven request sequence. Unknown full-form fields may carry side effects: classify them before changing the current strict matcher. Do not make all 985 captured keys permanent product policy or build a new generic guard framework by default.
- KTD5. **Represent price honestly.** The existing [booking packet](../../apps/server-pilot/src/ai/reservationist-booking-packet.ts) explicitly stores agreed price as metadata and does not apply it in its native create request. This does not prove that HMS cannot store a price. Observe the actual Cloud price control, apply an agreed amount when supported, then verify one representative approved Labtest save and readback. Do not create a combinatorial proof matrix for every price or rate.
- KTD6. **Let independent Cloud sessions run concurrently.** Do not introduce a property-global lock as a prerequisite for every new Cloud tool. Order actions within each page and use isolated sessions. Coordinate conflicting writes to the same record. Inspect current product advisory-lock consumers before narrowing any lock; concurrent logins alone do not establish shared-state or same-record safety. Preserve old consumers until a safe authorized change is ready.
- KTD7. **No email by accident.** Default the CMS send checkbox to off for Nava's create. A checked box is permitted as unsaved form state, but the writer must not dispatch a save that can send. Browser interception does not prove HMS did not queue mail server-side. Establish the native save side effect safely before supporting any checked-on save; otherwise return an explicit unsupported/needs-review outcome. The message-code suggestion never requires the checkbox to be checked.
- KTD8. **Make partial evidence usable.** Preserve observations and their coverage, not just an all-or-nothing answer. The current older [BAR-board projection](../../apps/server-pilot/src/ai/hms-availability.ts) can summarize only the nights it received, while a [separate strict sellability path](../../apps/server-pilot/src/ai/rate-options.ts) requires complete nightly evidence. Trace the actual calling path before fixing; do not assert a live incident. Reuse [Cloud quote views](../../apps/server-pilot/tooling/hms-cloud/quote-view.mjs), not a second quote engine.
- KTD9. **Use direct, representative proofs.** Prove different side-effect classes and major workflow combinations, not every visible field, rate code or permutation. Group compatible fields into the same Labtest save. Increase proof only when a real change or safety boundary warrants it.
- KTD10. **Own only actual shared seams.** One coordinator owns each shared session/dispatcher integration file. Independent feature owners propose narrow patches against stable input/output contracts. Start useful standalone tools now; do not block all lanes on a speculative shared helper or UI rewrite.

### Current capabilities and gaps

| Capability | Existing Cloud evidence | Important gap |
|---|---|---|
| Stay and profile | Stay 360, Record View, Guest Details and selected guest-form readers; profile search/select on blank draft. | Full coverage and saved amendment identity remain case-specific. Shared profile mutation is out of scope. |
| Party and form | Independent agency/org/A/R lookups; supported draft text, dates, child ages, dropdowns, CMS, source and room/rate selectors. | Draft interaction is not saved proof. Current A/R create restriction and fake-specific safety do not define final product scope. |
| Create | Narrow Labtest creates with dates, occupancy, source, room/rate and note; one company readback. | Current writer requires NGI and fake identity, and has a strict native-body matcher. General fields, A/R and agreed price are not established. Exact proof execution SHA was not retained. |
| Amend | Note and Booker contact adapters on fake saved stays; independent paired Booker readback exists. | Dates, occupancy, price, party and most other stay changes lack general saved Cloud proof. The held room-amend probe stays held. |
| Quote | Cloud Hotel Availability reader and nightly quantity-aware projection retain criteria and observations. | Current staff/runtime routing and recovery after page closure need confirmation. A separate typed quote registry exists but is not live-promoted. |
| Documents/finance | Documents lists loaded tree metadata; finance projects existing visible balances/deposits. | No demonstrated Cloud attachment or complete live ledger; neither metadata nor displayed balances prove bytes or payment settlement. |
| Linked rooms | Associated Reservations reader exists. | Centurion sample did not establish a populated association or complete grid; native multi-room create remains unproved. |

### Parallel ownership and real dependencies

| Owner / lane | Units and primary ownership | Can start independently | Shared seam |
|---|---|---|---|
| Coordinator / session | U1 and U9; `booking-lookup-session.mjs`, `saved-stay-agent-session.mjs`, minimal tool dispatch and integration | Contract inspection and runtime-lock audit | Own shared session/dispatcher files and final integration. |
| Identity and create | U2 and U4; `guest-profile.mjs`, `lookup.mjs`, Cloud create modules | Guest/party reads and create draft mechanics | Coordinate form changes and session exports with U6/coordinator. |
| Quote and price | U3; `hotel-availability.mjs`, `quote-view.mjs`, targeted Cloud quote wiring | Availability and partial coverage without waiting for create | Agree price/coverage shape with create and amend; coordinator owns shared dispatch. |
| Saved amendments | U5; new Cloud saved-reservation field-family modules and current amend adapters | Safe non-held stay-field observations and offline code | Coordinate guard changes with U1; never repeat held room probe. |
| CMS | U6; CMS-specific Cloud form functions and tests | Draft control and optional-input contract | One owner per shared form file; create owner integrates its save semantics. |
| Documents and finance | U7; `stay360-documents.mjs`, `guest-stay-finance-preflight.mjs`, new Cloud document/folio modules | Read-side work and native UI discovery | Saved-stay session wiring by coordinator; document upload uses authorized writer boundary. |
| Multi-room pilot | U8; new Cloud multi-room module and association reader | Contract, read-only discovery and independent new-stay design | Parent create/save contract from U4; do not use held probes or legacy runner. |

These are roles, not a fixed headcount or a mandate to launch agents. Use isolated worktrees for concurrent writers. Multiple independent Cloud browsers may overlap. Same-page operations serialize because they share mutable page state; distinct record writes should not wait behind a property-global mutex when safe. Verify the actual runner, shared test machine and any lock consumers before scheduling; do not claim parallelism that the chosen path does not provide. The approved remote test/typecheck route uses a shared lock, so its jobs may queue while coding and review overlap.

**Critical path:** shared session/identity contract and first native observation; one real tool workflow through create or non-held amend; final-head targeted tests and review; representative authorized Labtest save and fresh readback; Cloud tool integration and its final checks. Quote, documents, non-held amendments and multi-room discovery overlap until they need a specific shared seam. Multi-room child creation depends on a confirmed parent and the native association operation. A final product release adds a separately authorized integration/deploy/evaluation tail.

### LOC and timing evidence

Counts use **added plus deleted** product/config lines, excluding test/fixture paths and Markdown, matching `scripts/orch/merge-gate.sh`. Test changes are counted separately. The following observed diffs are analogues, not promises that future work will have the same size:

| Historical slice | Product changes | Test changes | First commit to merge |
|---|---:|---:|---:|
| Finance display projection, #823 | 57 | 115 | 19m42s |
| Quote provider integration, #813 | 163 | 145 | 1h00m24s |
| Shared saved-stay route extraction, #804 | 277 | 0 | 12m13s |
| Paired Booker amendment, #807 | 352 | 183 | 28m16s |
| Initial Booker amendment, #797 | 450 | 329 | 1h03m02s |
| Strict create proof, #800 | 484 | 332 | 6h33m22s; broader live create proof about 17h03 after first commit |

Diffs are local parent-to-commit `git diff --numstat`; clocks include review, waiting and rework, exclude unrecorded preparation, and overlap. [Retro](../research/halloween/2026-11-01-hms-17h-retro.md#clock-and-where-it-went). One clean create probe took 90.3s from start through independent readback, excluding preparation; this is not the time to develop or release a writer. [Run evidence](../research/halloween/2026-10-31-hms-coverage-run.md#0922-utc-checkpoint--broad-create-proof).

| Unit | Product LOC estimate | Test LOC estimate | Basis / uncertainty |
|---|---:|---:|---|
| U1 session and concurrency | 100–300 | 80–250 | Rough planning allowance from #804 shared-route extraction and #813 integration. Actual product lock reach and safe replacement may change it. |
| U2 identity and parties | 100–350 | 100–300 | Existing Cloud lookup code is substantial; #823 and #807 bound nearby small change examples, not full identity accuracy. |
| U3 quote and price | 150–450 | 120–350 | #813 plus #823 give integration/projection scale. Native price override behavior is not yet established and is an additional unknown. |
| U4 create | 350–1,000 | 250–800 | #800 changed 484 product / 332 test lines for a narrow strict path. Generalized fields, native effects and guard changes may require several slices. |
| U5 amend | 400–1,200 | 300–1,000 | #797 and #807 cover small Booker cases; dates, occupancy, parties and pricing have broader unknown behavior. Held room work is not estimated as available. |
| U6 CMS controls | 100–350 | 80–300 | Existing draft controls reduce new UI work; #807 is a nearby saved-field change, not proof of CMS send semantics. |
| U7 finance and attachment | Unknown | Unknown | #823 is a 57-product/115-test-line projection only. No comparable new Cloud upload or complete ledger slice was located. |
| U8 multi-room | Unknown | Unknown | No comparable proved Centurion Cloud associated-create module. Native workflow and proof availability determine size. |
| U9 workflow composition | 150–500 | 120–400 | #813 is an integration anchor. Scope is Cloud tool access and results, not rebuilding intake or the pane. |

These ranges are preliminary sizing judgments, not measured future diffs or upper bounds. Adding the seven stated unit budgets gives 1,350–4,150 product/config line changes and 1,050–3,400 test line changes. That is a partial per-PR planning allowance, not a final diff or complete-suite estimate: it excludes U7/U8 and the unknown native override component, and repeated edits to a shared line can be counted more than once. Re-estimate after directly observing those flows and fixing the integration contract. Split any unit into behavior-focused PRs under the approximately 500 changed-product-line gate; never drop scope to force one PR under it.

**Delivery ETA: unknown.** The dated ledger has 159 `code-server` ratios with median 0.85, 52 `live-hms` ratios with median 0.67, and 42 `orchestration` ratios with median 1.04. The five `live-hms` passes have median 1.75; eight entries were superseded. Those different cohorts are a warning against treating the overall 0.67 as a delivery forecast. The latest recorded live-HMS entry starts on 2026-10-28. These heterogeneous records do not supply the missing raw durations. The first broad create proof took about 14h44 after the previous replan, while the connected workflow was still absent at the retro snapshot. Known unknowns include native saved date/price consequences, Cloud upload and linked-room flow, real lock contention, and final-head review/rework. Applying a median to an invented raw duration would not produce a reliable total. Refresh the estimate as uncertain native actions, integration and review become measurable. Estimate the longest actual chain plus non-overlapping test, review and proof tails, apply the ledger's relevant median, and record any quoted ETA in the ledger. Do not require a separate proof for every uncertain family just to make a forecast. No numeric delivery ETA is stated or logged because the evidence does not support one.

### Critical review: prevent another 17-hour drift

| Proposal or risk | Decision |
|---|---|
| Verify every field, rate and combination with its own save | Reject. One representative save can cover compatible fields; add cases only for different material native behavior or safety boundaries. |
| Treat a stored price as proof HMS received it | Reject. One normal approved set-price save and readback is enough for the observed case; metadata alone is not a write. |
| Assume uncertain means HMS failed | Reject. Historical Booker update persisted despite the uncertain result. Fresh readback before retry is the narrow fix. |
| Make a new all-purpose guard, fixture system or queue first | Reject. Reuse existing fit-for-purpose components and extract shared code only when actual consumers need it. Preserve the existing safety boundary until an equivalent is demonstrated. |
| Treat the old property-wide lock as mandatory for all Cloud browsers | Reject. Use isolated sessions and target-specific conflict protection; inspect and narrow real current product locks instead of pretending they disappeared. |
| Finish one entire product workflow before starting another | Reject. Start independent capability lanes together and integrate when contracts stabilize. |
| Declare every visible field supported | Reject. Target useful stay workflows; preserve read data, document deliberate low-ROI omissions and return unsupported when HMS or proof does not support a change. |
| Rebuild the old pane, OCR and group stack inside this HMS pass | Reject. They are separate scope; define the integration contract and do not claim a staff-ready product from standalone tools. |
| Defer all new folio reading because payment workflows rank later | Reject for this plan. The owner specifically asked about a folio reader and finance context; a bounded read is distinct from implementing payment-proof intake, posting or reconciliation. Reuse existing reads and report unavailable data rather than building a ledger framework. |
| Remove safety checks to go faster | Reject. Keep property/identity, explicit write authority, no-send, exact target, protection from unapproved mutation, and fresh readback. |

---

## Implementation Units

### U1. Session ownership and Cloud concurrency

- **Goal:** Run independent Cloud capabilities in isolated sessions without a blanket property-global browser bottleneck.
- **Requirements:** R4, R14. **Owner:** coordinator/session lane. **Dependencies:** none for inspection; changes to existing product locks require the owning path's actual contract.
- **Files:** `apps/server-pilot/tooling/hms-cloud/booking-lookup-session.mjs`, `saved-stay-agent-session.mjs`, Cloud guard/session helpers; inspect `apps/server-pilot/src/hms/property-read-lock.ts` and its actual callers before any runtime change.
- **Approach:** Keep operations ordered within one page. Separate browser state by session and coordinate conflicts on the same stay using a small existing mechanism where needed. Map current Cloud versus legacy business imports; retain generic login/guard protections while isolating any necessary infrastructure without editing archived tools. Record current product lock behavior and safely remove/narrow only proven unnecessary serialization in authorized code work.
- **Patterns to follow:** Existing Cloud sessions and `page-request-fence.mjs`; no global mutex or new framework by default.
- **Test scenarios:** Two isolated independent sessions; same-page concurrent calls ordered; stale/closed session and same-target conflict handled; unrelated mutations and sends blocked. Confirm behavior without assuming same-login server-side isolation.
- **Verification:** Focused session/fence checks on the final head; one appropriate read-only or unsaved concurrent Cloud check when authorized. Preserve existing product locks until replacement is proven.

### U2. Stay, guest and party identity

- **Goal:** Match the correct stay and existing profile, then resolve agency, organization and A/R independently.
- **Requirements:** R1–R4. **Owner:** identity/create lane. **Dependencies:** existing Cloud sessions; no dependency on U4 save completion.
- **Files:** `apps/server-pilot/tooling/hms-cloud/guest-profile.mjs`, `lookup.mjs`, `stay360-confirmation.mjs`, `stay360-record-view.mjs`, relevant tests.
- **Approach:** Accept property, confirmation/name/date hints or profile/party search criteria. Return candidates, current native IDs, distinguishing fields, provenance, coverage and ambiguity. Select a uniquely identified candidate from current results; present ambiguous choices for staff review. Preserve existing party links and avoid inferring A/R from agency. If no correct profile exists, return an explicit needs-profile result instead of silently creating one.
- **Patterns to follow:** Existing Cloud profile and party picker search IDs, not archived lookup tools.
- **Test scenarios:** Duplicate guest names, incomplete picker page, empty result versus failure, stale selection token, agency plus organization plus A/R, unchanged existing links, explicit blank versus omitted.
- **Verification:** Existing read-only or unsaved Cloud cases plus targeted tests; no shared-profile create/edit and no guessed identity.

### U3. Hotel Availability, partial results and price controls

- **Goal:** Return usable current pricing/inventory evidence and support actual agreed-price application when HMS allows it.
- **Requirements:** R5–R9, R13. **Owner:** quote/price lane. **Dependencies:** identity contract for party context; no need to wait for saved create.
- **Files:** `apps/server-pilot/tooling/hms-cloud/hotel-availability.mjs`, `availability-view.mjs`, `quote-view.mjs`, `guest-stay-rate-plan.mjs`; inspect the actual selected staff/runtime adapter before touching `apps/server-pilot/src/ai/hms-availability.ts` or result storage.
- **Approach:** Input property, dates, per-room adults and known child ages, requested quantity, selected room/rate and party IDs. Return applied criteria, each night's observed price/stock/restrictions, coverage and unknowns. Retain known partial observations and re-fetch missing data through existing jobs where appropriate. Explore the native rate/price override field without saving; report whether it is per-night, per-room, tax-inclusive, selectable and writable. Pass any supported explicit amount and required authorization through the shared create/amend contract.
- **Patterns to follow:** Existing Cloud Hotel Availability and quote projection, not the legacy Rate Shop catalog as a quote. Treat `count_sufficient` as observed stock, not a guarantee or hold.
- **Test scenarios:** Missing night, zero stock with price, closed rate, mixed currency, unknown child age, party mismatch, multiple nights/rates, no invented total; navigation/reopen preserves a queued result; explicit agreed price reaches the native form when supported.
- **Verification:** One representative read-only Cloud quote with actual criteria and a later authorized Labtest price save plus fresh readback. One proof is sufficient for that observed case; unknown native price behavior remains explicit until discovered.

### U4. New reservation draft and save

- **Goal:** Prepare and save a useful reservation using modular Cloud mechanics, with general product inputs and an enforced current Labtest write boundary.
- **Requirements:** R2, R3, R8, R10, R13, R14. **Owner:** identity/create lane. **Dependencies:** U1 session contract and U2 identity selections; price value from U3 when a price is supplied; CMS contract from U6 only for CMS fields.
- **Files:** `apps/server-pilot/tooling/hms-cloud/guest-stay-form.mjs`, `guest-stay-save.mjs`, `guest-stay-source-business.mjs`, `guest-stay-room-rate.mjs`, `guest-stay-rate-plan.mjs`, focused tests; new Cloud files if they make ownership cleaner.
- **Approach:** Input dates, existing profile, adults/children, requested room and rate, approved price if any, guarantee, source/reason, booking contacts, notes, billing instructions and independently optional agency/org/A/R/CMS choices. Populate supported current native controls and return proposed values plus dependent changes. Preserve unknown/omitted versus explicit clear. Build toward a reusable authorized create boundary without embedding Labtest as business identity; current real-guest saves stay disabled. Do not require NGI or blank A/R as a permanent product rule merely because the current fake writer does.
- **Patterns to follow:** Current Cloud selectors and request fences when appropriate. Archived create business tool is reference only; no edits or calls as foundation.
- **Test scenarios:** No/one/multiple children; unknown ages; independent parties including A/R; multiple current rate and guarantee options; no-send; duplicate prevention; approved price versus metadata; native dependent-field drift; one save and uncertain outcome. Group scenarios rather than one test per value.
- **Verification:** Targeted final-head tests and a small representative set of authorized Labtest saves with screenshots and independent exact-record readback. Confirm a configured amount in HMS when actually supported. Do not claim universal coverage from those examples.

### U5. Amend reservation-specific fields

- **Goal:** Change requested saved-stay fields without silently changing unrelated stay data or a shared profile.
- **Requirements:** R1, R3, R8, R11, R13, R14. **Owner:** saved-amend lane. **Dependencies:** U1 session contract and exact U2 identity. Room-amend browser probe remains specifically held.
- **Files:** `apps/server-pilot/tooling/hms-cloud/guest-stay-amend.mjs`, `guest-stay-amend-contact.mjs`, `labtest-record.mjs`, new focused Cloud amend modules and tests.
- **Approach:** Accept an exact confirmation, current before-state and intended field changes. Start with note/Booker and investigate non-held dates, occupancy, rate, guarantee, party and reservation-owned billing/contact fields. Show HMS-driven repricing and other dependent changes before staff approval; preserve unrequested party links. Detect unsupported and profile-owned fields instead of changing a shared profile. Keep room-type amendment explicitly blocked from the denied probe until a separate valid clearance exists.
- **Patterns to follow:** Existing Cloud saved-stay preimage, save route and fresh-record reader; do not add a writer/save per text field.
- **Test scenarios:** Multi-field save, unchanged linked parties, explicit clear versus no change, repricing, unknown children, stale preimage, same-record conflict, blocked request after dispatch and readback before retry.
- **Verification:** Focused tests and representative allowed Labtest amend/readback, grouped by genuinely distinct side effects. No real-guest save, prohibited probe, or penalty dialog acceptance.

### U6. Optional CMS controls

- **Goal:** Expose optional CMS checkbox, message ID and recipient while preserving Nava's no-send rule.
- **Requirements:** R12, R14. **Owner:** CMS lane. **Dependencies:** U1 page contract; coordinate with U4/U5 for saved behavior, without blocking unrelated create work.
- **Files:** `apps/server-pilot/tooling/hms-cloud/guest-stay-form.mjs`, Cloud CMS-specific module if useful, booking/saved session exports owned by coordinator, focused tests.
- **Approach:** Accept omitted/explicit checkbox, selectable current code and optional email. Suggest `03` only if present and allow another choice or no code. Read back draft controls. Investigate the actual safe side-effect boundary: a checked draft must never lead to a save that could send or to an actual send. Until that is established, refuse that saved combination with an understandable result; independent optional code/recipient saving remains subject to its own real safety behavior.
- **Patterns to follow:** Existing Cloud `listCmsMessageIds`, `selectCmsMessageId`, `setCmsSendCheckbox` and text setter; do not replace the picker with a generic text setter.
- **Test scenarios:** All omitted, default changed or cleared, current code absent, optional recipient, unchecked save, checked draft, potential send request and server-side unknown. No rule forces a nonblank ID.
- **Verification:** Representative unsaved Cloud interaction and targeted no-send/optional-input tests; authorized fake save only where send suppression is established. A browser network log alone cannot prove no server-side send.

### U7. Finance and generic document attachment

- **Goal:** Return useful financial context and attach a staff-approved document to the correct stay using new Cloud tooling.
- **Requirements:** R1, R4, R14–R16. **Owner:** documents/finance lane. **Dependencies:** exact stay identity and shared saved-stay session; read and UI discovery can start independently.
- **Files:** `apps/server-pilot/tooling/hms-cloud/stay360-documents.mjs`, `stay360-record-tabs.mjs`, `guest-stay-finance-preflight.mjs`, new Cloud attachment/folio modules and focused tests.
- **Approach:** Input exact stay and, for upload, a staff-authorized file reference or staged payload, filename/type and intended document category. Bind approval to the actual file and exact stay, validate the payload against the applicable upload policy, and do not accept an unrestricted server path. Reuse the existing loaded-tree reader and display projection where fit; inspect the native Cloud upload and folio tab, then implement missing mechanics from scratch without the legacy uploader. Return upload outcome and observed document identity/coverage. Read accessible transaction details only when actually exposed; otherwise return unavailable. Do not post payments or infer cleared funds from a voucher or displayed balance.
- **Patterns to follow:** Current Cloud record-tab navigation and structured outcomes; Linux-compatible browser file input, not a desktop file-manager dependency.
- **Test scenarios:** Wrong stay, unauthorized or changed file, unrestricted path, unsupported file/type, partial tree, duplicate-looking document, no transactions visible, upload failure/uncertain dispatch, no silent retry, displayed deposit distinct from cleared funds.
- **Verification:** Targeted tests and one authorized synthetic Labtest attachment with fresh document-tab readback. State whether bytes, metadata and complete list are separately established. Read-only finance observation uses existing safe paths.

### U8. Bounded multi-room pilot

- **Goal:** Create a small set of separately identifiable room reservations and preserve a verified native relationship when supported.
- **Requirements:** R3, R5, R13, R14, R17. **Owner:** multi-room lane. **Dependencies:** independent safe discovery can start now; a pilot write depends on U4 parent create and native Cloud association evidence. The separate denied linker source-manifest/later-association probe and room-amend probe remain held.
- **Files:** New `apps/server-pilot/tooling/hms-cloud/` multi-room capability, `stay360-associated-reservations.mjs`, coordinator session wiring and focused tests. Legacy Add Record is historical reference only.
- **Approach:** Accept per-room guest/profile, dates, occupancy, room/rate and shared versus individual facts; return each confirmation and verified relation, plus per-room partial failures. Discover a distinct permitted native create/association path. Do not infer a linked relationship from similar dates or a self-row. If the only viable proof would repeat a held probe, stop that specific action and report the hold; continue independent units.
- **Patterns to follow:** Cloud create and exact association reader after confirming its identity and coverage semantics.
- **Test scenarios:** Two rooms, different occupancy, shared versus room-specific choices, separate confirmation IDs, first room saved/second fails, parent uncertain, self-row, incomplete linked grid.
- **Verification:** One authorized fake two-room pilot and independent readbacks when the native path is established and not held. Record an explicit partial result if association cannot be verified.

### U9. Compose useful tool workflows

- **Goal:** Expose the new Cloud tools as a coherent callable create/amend/quote workflow without rebuilding the pane or intake.
- **Requirements:** R1–R17 as applicable to the composed operation. **Owner:** coordinator. **Dependencies:** Stable U1/U2 contracts; integrate U3–U8 incrementally rather than waiting for every unit.
- **Files:** `apps/server-pilot/tooling/hms-cloud/booking-lookup-session.mjs`, `saved-stay-agent-session.mjs`, relevant Cloud adapters and targeted tests; inspect existing typed runtime integration before selecting its seam.
- **Approach:** One session may compose lookup, select, prepare, approval-bound act and review; long-lived results use an existing durable job/result path where appropriate rather than page handles. Return per-action status, confirmation, screenshot reference, readback, warnings and any uncompleted work. Do not wire the legacy create business tool merely because an existing packet imports its schema; establish a Cloud-native contract without weakening validation. Keep unrelated requests visible when one action completes. Pane work and production activation are separate follow-on scope.
- **Patterns to follow:** Existing same-session Cloud runners and existing job/approval machinery when suitable, not a second queue or another extraction framework.
- **Test scenarios:** Quote survives navigation/session closure; result and screenshot access respects actor and property; create and amend process selected target; one action succeeds while another stays pending; partial results remain available; uncertainty cannot turn into duplicate action; no send or silent profile mutation.
- **Verification:** Exercise a realistic request through the callable Cloud workflow, including an authorized Labtest save and independent readback. This is a tool-chain proof, not a claim of end-user production completion.

---

## Verification Contract

- Work from current main in isolated owned worktrees. Before first review of a long-lived branch, merge current main as required by `AGENTS.md`.
- Run targeted tests using the approved Product EC2 route. For Vitest, the installed wrapper accepts `bash /home/orca/bin/remote-vitest.sh <clean-worktree> <server-pilot|mail> <test-file>...`; verify its separate typecheck result and final test result on the exact head. Before Vitest unset `DATABASE_URL`, `VITEST_ALLOW_PILOT_RDS`, and `TEST_DATABASE_URL`. Never test against pilot RDS.
- Cloud tooling also has `node:test` files, including `guest-stay-save.test.mjs`; the Vitest wrapper does not run them as Node tests. Run the targeted `node --test <test-file>...` on Product EC2 against the exact committed head, with database variables unset and an isolated clean checkout or the existing shared-checkout lock held throughout checkout and execution. Verify the runner/checkout and capture its exit status; do not modify the live checkout or another session's work.
- Run typechecks through `bash /home/orca/bin/remote-typecheck.sh <clean-worktree> --app <server-pilot|mail>`; never run local `tsc`, `tsgo` or repo-wide lint/format. Review the actual scripts and target at execution time; remote checks can queue on the shared lock.
- For each behavior-focused PR, count additions plus deletions as the merge gate does, excluding tests/fixtures and Markdown. Keep product changes at or below the configured 500-line gate unless the explicitly authorized pure-move exception applies. No GitHub Actions except the authorized Outlook installer workflows.
- Before merge, the coordinator reads the product diff, independently checks final-head remote test and typecheck evidence, obtains Greptile Apex on that same head, and validates/fixes P0/P1 findings. Merge through `scripts/orch/merge-gate.sh`; its gate-file existence alone does not validate the evidence. Never use `--no-verify`.
- Preserve exact property, target, current authority, no-send and penalty boundaries. No production flag/deploy is authorized by this plan. Never repeat the two denied probes. Keep guest information, files and credentials private.
- For each claimed native behavior, name property, code version, input, UI observation, dispatch state and independent readback. A draft, mock, registry entry, HTTP 200, or document metadata alone is not proof of a complete saved action. A representative Labtest proof covers only its actual case.
- For a future authorized deployment, use the approved `PRODUCT.md` deploy path, verify durable and effective flags for all affected processes, property readiness and a final-SHA live canary. Both Outlook pane and webmail apply to any later pane feature; reload the staff bundle. Apply product evaluation and owner-confirmed bars only within their proper scope. Proposed bars remain proposals.

---

## Definition of Done

- Each in-scope tool has a documented input, output, ambiguity and failure behavior; its relevant reservation fields are supported or explicitly reported as unsupported with reason and evidence. No field is silently dropped and no shared guest profile is silently changed.
- Representative quote, create and non-held amend tool chains work against the Cloud UI. Each claimed saved case has an authorized Labtest result, screenshot and independent exact-stay readback. Agreed price is verified in HMS for the case that claims it.
- Optional CMS inputs work without forcing an ID or enabling an actual send. Any checked-save path that may send remains blocked and honestly reported.
- Finance results label their source and completeness. Generic document attachment has an authorized fake-file proof with independently observed metadata or an explicit native/platform hold; no claim of cleared payment or unverified bytes.
- The bounded multi-room pilot has separate per-room outcomes and verified relationships, or explicitly records the exact held/unavailable portion without falsely reporting pilot completion. Other units can finish independently.
- Appropriate exact-head tests, typechecks and review gates pass, with no valid unresolved P0/P1. Remove abandoned experimental code owned by the run without deleting other sessions' work.
- Tool completion is not staff-ready product completion. An actual product workflow is complete only after its separately authorized integration, deployment, applicable evaluation and final-SHA property canary. No bundle load or small fake sample alone proves adoption or product success.
