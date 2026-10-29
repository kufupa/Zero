---
title: 'Stagehand Centurion Labtest booking'
date: 2026-10-28
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
execution: code
product_contract_source: ce-plan-bootstrap
---

## Goal Capsule

Determine, by direct use of Centurion's live HMS and a fake Labtest guest, whether self-hosted Stagehand can navigate and make one booking, how its read navigation compares with the existing deterministic reader, and whether its recorded-action repair works. Report booking and email evidence separately. This plan is not permission to execute: wait for an explicit go for this scoped trial. The existing product, hotel lock and user instructions remain authoritative. No real-guest writes, penalty-dialog acceptance, other-property work, product deploy or other sends are included. If the owner later approves this scoped run, the requested CMS send to their test address is part of it.

## Product Contract

### Requirements

- **R1.** Run one HRCEN Labtest create in the real PMS using a future eligible stay and the exact fake profile. Stagehand must open the create flow, reach and select the profile, select the stay, fill booking fields, select the CMS letter, set Send Mail and Save. Playwright may log in, perform separate read-only preflight and identity checks, inspect the CMS list, verify form values, and perform independent readback. Maintain an actor ledger for every booking action. Any Playwright booking action is a hybrid result, not a Stagehand booking pass.
- **R2.** Use the owner-supplied test recipient from `.private/stagehand-labtest-f777f33d/2026-10-28-owner-new-request.txt`. Set CMS Send Mail. Display and record the loaded Message ID choices and select the second visible option, recording its code and description without substituting a different option. Report Save, checkbox, send request and actual email delivery as separate facts. The owner-provided recipient is not to be copied into a tracked document or an unrelated provider.
- **R3.** Before Save, search for a duplicate and verify property, fake profile, dates, rate and CMS fields. Navigation and form-filling must not submit or send. Dispatch Save at most once per attempted booking, even if the Stagehand call reports an error. Do not call Stagehand again on the create page after Save. Reconcile using read-only tools. An ambiguous outcome stops all further Saves; an empty search alone is not proof of failure. A fresh attempt within the approved trial is permissible only after an authoritative not-saved outcome, fresh duplicate and identity checks, and a new attempt record. Read back confirmation, identity, dates, status, CMS recipient, Message ID and checkbox. Preserve the created Labtest booking for inspection unless the owner separately directs cleanup.
- **R4.** Compare Stagehand and the deterministic reader on the same fake record and read task. Reset and verify the same start state between arms; verify the same target and end state. Record elapsed time, exact task, outputs, model calls and available dollar cost. One sample is exploratory, not a speed or accuracy guarantee.
- **R5.** After leaving the create page, capture one Stagehand Action on a non-write HMS control. Demonstrate clean recorded replay without inference, the same Action with a broken selector failing without healing, and the same broken Action recovering with healing enabled. Count model calls and independently verify each UI postcondition. Distinguish Stagehand's own recovery from a hand-coded retry.
- **R6.** Use the configured Azure model route and locally retained diagnostics as the owner permits. Avoid unnecessary synthetic-page trials and avoid leaking credentials. Keep telemetry on a local endpoint; user-approved private logs may be retained on the VPS.
- **R7.** Acquire and monitor all currently observed HRCEN property lock identities, including both if still distinct; fail closed on lock loss. Do not interact with HMS after lock loss until the appropriate property lease is reacquired; a Save interrupted by lock loss is ambiguous pending protected reconciliation. Verify HRCEN and Labtest identity before Save. Never accept a cancellation-penalty dialog. Do not disturb the parallel HRDAV lane.
- **R8.** Explicitly report failures, unknowns and no-email-access rather than claiming a booking or delivery from a click alone. Stop at the requested trial; application integration and real-guest booking remain separate work.

### Acceptance examples

- The second live CMS option has an unexpected payment-related description: choose that exact option as requested, disclose its code and description, and do not claim a normal booking-confirmation template unless verified.
- Stagehand fills the form but Playwright clicks Save: report hybrid result, not an independently Stagehand-executed booking.
- Save times out or the Stagehand Save call errors: never call Save again for that attempt. Under the property lease, reconcile the exact fake profile and date. An ambiguous result stops; an empty search is not authoritative proof of no save. A visible confirmation without independent readback is unverified.
- The HMS checkbox is saved but the recipient inbox is inaccessible: report delivery unknown; do not call it delivered.
- Clean Action replay has zero model calls and reaches the intended safe control. The same Action with a broken selector fails with healing off, leaves the UI unchanged, then recovers with healing on and a model call. A fresh instruction, a Playwright click or a success flag alone is not self-healing proof.

## Planning Contract

### Known evidence

| Evidence | Observation | Boundary |
|---|---|---|
| `docs/research/2026-10-28-stagehand-labtest-fable-f777f33d.md` | Existing Stagehand 4.1 / Azure extracted six matching fields; model extraction 4.130 s; entire trial 54.675 s; profile extraction failed. | Playwright found and opened the stay first. No Stagehand booking, navigation or self-healing result. |
| Same source | Existing isolated browser / Playwright bridge, login and guard were exercised. Two observed HRCEN advisory keys were held and released. | Scope and active lock identities must be rechecked at execution. Existing read-only guard is not a create guard. |
| Installed Stagehand 4.1 worker and `.private/stagehand-labtest-f777f33d/azure-adapter.mjs` | Static source inspection: normal `act` and `observe` use text plus JSON-schema generation with no tools/images, a request shape the existing callback accepts. | Actual Azure schema acceptance, action correctness and HMS create remain untested. |
| `apps/server-pilot/tooling/playwright-quote/create-lab-stay.mjs` | Existing create implementation has pre-save checks, CMS selection, one Save and readback. | Much is internal; HRCEN SaaS create is not established by HRDAV proof. |
| `docs/research/2026-10-28-hrdav-cms-message-id-codes.md` | Prior other-property options include guest and agency booking letters and payment-confirmation templates. | Neither current HRCEN order nor the second option's label is proven. |
| `docs/research/2026-10-23-g1023-retro/L1.md` | Earlier HRCEN create plus independent find took about 12 min. | Pre-cloud, existing deterministic tooling. Not a Stagehand benchmark. |
| `docs/context/ledger/2026-10-22-sr3-overnight-retro.md` | Earlier HRCEN proof took 140 min to first Save, 184 min to first confirmation. | Pre-cloud, different run; shows substantial tail risk, not a current median. |
| `https://docs.stagehand.dev/v4/basics/act` | A recorded action can be replayed without inference and, with selfHeal enabled, a failed selector can be re-inferred. | Validate this against installed 4.1.0; the docs may describe newer v4 behaviour. |
| `https://docs.stagehand.dev/v4/best-practices/caching` | Browserbase server-side action caching does not apply to local browsers. | No Browserbase service or cloud cache is planned. |

### Key technical decisions

- **K1.** Reuse the existing private spike, model callback, guard and Stagehand-owned browser. Do not install, upgrade, build an MCP server, create a generalized platform or integrate the pane for this checkpoint.
- **K2.** Use Stagehand `observe` to propose each action, validate its resolved target, method and expected values against the current form before executing the recorded Action with Stagehand `act`, and reject unexpected submit, Save, send or other-record targets. Only the explicitly verified final Save may commit the booking. This retains Stagehand navigation while bounding model-selected actions. Installed 4.1 source uses the text/JSON-schema request shape already supported by the Azure callback; attempt that first without a speculative adapter rewrite. If actual Azure schema compatibility fails, fix the specific missing shape or report the failed checkpoint, never silently switch providers. If the installed Action representation cannot be validated reliably, stop before writes rather than infer safety.
- **K3.** The existing guard may derive a different number of keys if runtime changes. Check current key sources and HRCEN ownership rather than assuming the old two-key snapshot stays valid. A child environment marker alone is not a lock. Under the actual parent-held lease, prefer the exported open-page lookup helpers. Do not nest a second independent database lease that can self-deadlock; if using the supported parent-held token, verify that the parent really owns and monitors every required lock.
- **K4.** Installed 4.1 configures `selfHeal` per Stagehand instance, not per action. Run the entire booking with `selfHeal:false`; verify the exact Save target and issue the Stagehand action once. After that call, issue no further Stagehand actions on the create page. Reconcile under the property lease. After leaving the create page, use separate `selfHeal:false` and `selfHeal:true` instances for non-write replay, retaining the exact same explicit Action and verifying lifecycle before reuse. If same-browser reattachment fails, close the first owned browser before opening a fresh one under the same property lease, on a non-create page. `cache:true` alone does not persist actions on the local browser. Healing may use an unscoped page snapshot through the owner-approved Azure route.
- **K5.** Select a simple one-night future stay, one adult and an actual available room/rate in the property. Do not invent a fixed rate, confirmation number, CMS option ordering or no-charge guarantee. Do not accept charge/penalty prompts.
- **K6.** Use the existing mailbox/authorized trace route if available. The specified external recipient inbox has not been shown accessible here; report delivery pending rather than holding or fabricating the booking result.

### Scope and assumptions

Local development and controlled test code are private to the experiment. No fresh synthetic page is a prerequisite to the first HMS attempt. Targeted safety checks may execute on approved Product EC2, concurrently with independent setup, and must not delay the first live attempt except when needed to prevent a wrong-guest write or duplicate Save. Staff-facing integration, production deployment, additional properties, Add-Ons and real-guest writes are follow-up work. Unknown current availability, model-action request compatibility and inbox access are execution-time facts, not silently resolved assumptions.

## High-Level Technical Design

Existing private lock owner + local Stagehand browser -> deterministic verified login -> Stagehand actions on verified Labtest profile -> one Stagehand Save -> independent HMS readback -> CMS delivery check if accessible. A separate read-only comparison and a recorded non-write selector replay follow after leaving the create page, under the same HRCEN lease, never in parallel with another HRCEN browser lane. Comparison code may be prepared in parallel with booking code on disjoint files, but live HRCEN use stays serial.

## Implementation Units

### U1. Bridge actions and retain the property lease

**Goal:** Make the installed local Stagehand instance capable of the requested create interaction without rebuilding the existing framework. **Requirements:** R1, R6, R7. **Dependencies:** none. **Files:** `.private/stagehand-labtest-f777f33d/azure-adapter.mjs`, `.private/stagehand-labtest-f777f33d/guarded-stagehand-booking.mjs`, `.private/stagehand-labtest-f777f33d/action-bridge.test.mjs`. **Approach:** Inspect callback and action shapes first; reuse supported paths. Adjust model response handling only if installed 4.1 actually needs it. Copy and adapt the existing parent-owned guard to launch the new trial and monitor the current HRCEN locks, while preserving owned-process cleanup and the previously executed guard as evidence. Do not apply the read-only network guard to a permitted create and do not infer safety from a child token. **Patterns:** existing private spike, `apps/server-pilot/tooling/playwright-quote/write-cli-lease.mjs`, `apps/server-pilot/tooling/playwright-quote/session-reuse.mjs`. **Test scenarios:** supported action request returns a valid action; unsupported format is surfaced rather than faked; wrong property, missing/changed lock and invalid Labtest identity refuse; loss of lock ends the owned browser; logs exclude credentials. **Verification:** action request and lease work under the installed version; no HMS write is needed for setup verification.

### U2. Create one Labtest stay and record the letter

**Goal:** Make and independently verify the requested booking and CMS settings. **Requirements:** R1–R3, R6–R8. **Dependencies:** U1. **Files:** `.private/stagehand-labtest-f777f33d/stagehand-booking-trial.mjs`, `.private/stagehand-labtest-f777f33d/stagehand-booking-trial.test.mjs`. **Approach:** Fresh authenticated HRCEN page; Stagehand navigates to New Record and the verified fake profile, chooses an available simple stay, fills required fields and owner recipient, enumerates and selects the actual second CMS option, and sets send. Native-read the exact guest immediately after profile selection, before entry. Enumerate the ordered visible CMS choices, have Stagehand select row two, and native-read the matching code and form immediately before the single Stagehand Save. Maintain the actor ledger. Independently read back and separately check accessible delivery. Reconcile any ambiguous outcome, with no further Save unless an authoritative not-saved outcome supports a fresh attempt. **Patterns:** `apps/server-pilot/tooling/playwright-quote/create-lab-stay.mjs`, `create-request.mjs`, `save-wait.mjs`, `stay-lookup.mjs`. **Test scenarios:** correct profile and second loaded CMS row are selected; missing options or bad profile refuse before Save; no available rate returns explicit incomplete; missing/ambiguous Save or readback cannot be reported as confirmed or trigger blind retry; wrong saved CMS fields fail comparison; absent inbox access is delivery unknown; a cancellation-penalty dialog is not accepted. **Verification:** a Stagehand-attributed ledger for every booking action plus one successful independent HMS readback with actual CMS choices and recipient settings. Any native booking click is hybrid, not a Stagehand pass. Mailbox delivery is a separate outcome.

### U3. Compare navigation and recorded-action repair

**Goal:** Measure the same real-HMS read task and the native Stagehand healing path, without another booking. **Requirements:** R4, R5, R7, R8. **Dependencies:** U1; live HMS access serial with U2. **Files:** `.private/stagehand-labtest-f777f33d/stagehand-compare.mjs`, `.private/stagehand-labtest-f777f33d/stagehand-compare.test.mjs`. **Approach:** Record matching start/end states and measured clock segments, first for the existing deterministic reader then for Stagehand navigation to the same fake record. Use the same authenticated Guest Stay search screen as the timed starting state; call the exported open-page reader under the parent lease, then reset that screen before the Stagehand arm. If a booking was not verified, use the already-known fake Labtest reservation as an explicitly labeled fallback for comparison; do not claim a successful new booking. Keep setup and login time separately visible and record model calls and available dollars. After leaving the create page, capture an observed Action for a non-write control. Reset its UI state between cases. Show clean replay with zero model calls, then deliberately break the same selector and show no-heal failure with unchanged UI, then replay the same broken Action with a separately configured healing instance. Require a model call, the intended control and an independently verified postcondition. No cloud cache or Save replay. **Patterns:** `apps/server-pilot/tooling/playwright-quote/stay-lookup.mjs`, installed Stagehand 4.1 `observe` / `act` implementation. **Test scenarios:** wrong target or different task fails comparison; clean replay with no model call is proven; missing recovery call is not reported as healing; invalid selector with healing disabled leaves the UI unchanged; enabled recovery reaches the intended control; repeated execution does not Save or send. **Verification:** timings and correct outcomes are separately labeled, with explicit incomplete or fail for unsupported recovery.

## Verification Contract

- Use approved remote execution and current test/typecheck rules. No GitHub Actions. No standalone unguarded live child. Run cheap guard checks alongside preparation, not a mandatory fake-page campaign.
- Record actual property, selected profile, preflight, ordered CMS option list, saved fields, confirmation, timing segments, model route/calls/cost where available, failure reason and cleanup privately. Redact credentials; user permits retaining guest test evidence locally.
- Verify the intended email's actual arrival only with an authorized recipient inbox or mail trace. Otherwise record unknown. Do not block reporting booking success on inbox access.
- After the run, confirm this trial's lock release and owned-browser cleanup. Leave the HRCEN slot and parallel HRDAV lane untouched.

## Definition of Done

- **Booking checkpoint:** The guarded attempt ends with a Stagehand-attributed action ledger and independently verified saved fake booking plus CMS fields, or a precise failure and the result of any protected ambiguous-write reconciliation. An unresolved ambiguity is reported as unresolved, not failed or saved. Report delivery separately. Failure is an outcome, not a successful booking.
- **Comparison checkpoint:** Matching Stagehand / deterministic task timings and outputs are reported, and recorded-action healing is demonstrated or explicitly failed. Do not claim broad speed, accuracy, recovery, or production readiness from one sample.
- **Handoff:** Record evidence in a dated private trial report and concise status in `docs/context/ACTIVE.md`; no deployment or real-guest enablement occurs in this plan.

## Review decisions and final sizing

The full unedited [Grok 4.7 review](../research/2026-10-28-stagehand-booking-grok-review-f777f33d.md) reviewed a sanitized draft only. It did not inspect the repository, installed package, ledger, HMS or private inputs. The exact reviewed draft is retained privately with SHA-256 `3d375256cc452f3c39021ad66ff3af86014af44ae8d44241d82a4b0414cc9103`.

- **Accept:** Make Stagehand attribution explicit for every booking action; identify the guest immediately; validate the actual second CMS row; reset the comparison baseline; demand replay, failure, model-assisted recovery and independent postconditions for the same Action. End Stagehand actions on the create page after the Save call.
- **Accept:** The earlier 65/100-minute user estimate and 120/160-minute draft were optimistic, not measured Stagehand booking midpoints. Raise the conditional code allowance and keep the long-tail risk visible. Grok's 135-minute code plus 90-minute live breakdown totals 225 minutes, not its stated 210 before calibration. Its proposed LOC components total 550–930, not 450–900. The corrected components below are estimates, not observed diffs.
- **Adapt:** Grok recommends another owner approval for every further Save. The owner requested autonomous testing and Labtest is permitted. An explicitly authorized trial may make a fresh attempt only after authoritative evidence that the earlier attempt did not save, fresh preflight and a new attempt record. Ambiguity stops all further Saves. No retry is inferred from an empty search.
- **Adapt:** Grok says reconcile even after lock loss. First stop every HMS interaction. Reacquire the relevant lease before read-only reconciliation; otherwise report unresolved.
- **Reject:** Serial U3 development is not required. A second writer can prepare comparison on disjoint files after the bridge interface is fixed. Its live work must wait for the booking lane and same property lease. Do not present a native-write hybrid as a Stagehand success.
- **Retain:** Direct real-HMS test, approved Azure route and private local logs. No new synthetic-page privacy campaign or generalized platform is a prerequisite.

### LOC estimate

Incremental authored lines, excluding reused code. Estimates, not measured diffs:

| Work | Implementation LOC | Test LOC | Notes |
|---|---:|---:|---|
| Guard and lease changes | 80–160 | included below | Copy and adapt, retain previous evidence |
| Full Stagehand booking and actor ledger | 350–550 | included below | Includes CMS verification and reconciliation orchestration; some existing helpers are internal |
| Comparison and recorded-action healing | 120–220 | included below | Two instance configurations, model-call and UI evidence |
| Base total | **550–930** | **140–260** | Full requested proof, not hybrid |
| Azure adapter contingency | **0–120 extra** | unknown | Only if real action schema is incompatible |

### Conditional elapsed planning estimates

| Checkpoint | With parallel comparison preparation | Evidence and assumptions |
|---|---:|---|
| First terminal booking attempt plus readback or explicit failure | **210 min** | 150 raw code and essential safety-check min × 0.85 + 15 raw focused review min × 0.87 + 90 raw live min × 0.79 = 211.65 min. Assumes initial model shape, property lock and rate availability do not cause major rework. |
| Booking outcome plus matched read and healing result | **250 min total** | Comparison development and its tests: 90 raw code min × 0.85, in parallel with the main lane after the bridge interface is stable. After the first result, 50 raw live min × 0.79 = 39.5 more min. Same property browser use is serial. |
| If comparison preparation cannot overlap | **330 min total** | Add the 76.5 scaled code min to the 250-minute path, rounded. |

These are conditional planning scenarios, not statistically grounded Stagehand booking midpoints or promises of success. Ledger medians at planning time were 0.85 for code-server, n=157; 0.79 for live-hms, n=49; and 0.87 for review, n=23. They are heterogeneous generic ratios, not a Stagehand booking distribution. The only 12-minute HRCEN create and 140/184-minute tail examples were pre-cloud deterministic runs under different conditions. Stagehand Azure action acceptance, current HRCEN availability, helper integration and reattachment remain unproven. A schema rejection can yield a useful failure earlier; lock contention, rework, an ambiguous Save and recipient delivery can make the run much longer. No defensible production ETA follows from this spike.

No implementation, live booking, email, deploy or flag flip is authorized by this planning request. The requested test send becomes authorized only with the owner's scoped execution go.

## Sources

- `docs/research/2026-10-28-stagehand-labtest-fable-f777f33d.md`
- `docs/research/2026-10-28-stagehand-booking-grok-review-f777f33d.md`
- `docs/research/2026-10-28-centurion-saas-stagehand-parity-codex-93f4b8e2.md`
- `docs/research/2026-10-28-hrdav-cms-message-id-codes.md`
- `docs/solutions/workflow-issues/hms-live-write-preflight-and-long-jobs.md`
- `docs/context/ledger/2026-10-22-sr3-overnight-retro.md`
- `https://docs.stagehand.dev/v4/basics/act`
- `https://docs.stagehand.dev/v4/best-practices/caching`
