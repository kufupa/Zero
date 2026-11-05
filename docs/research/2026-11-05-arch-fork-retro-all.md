# Arch fork: complete overnight plan retrospective

**Scope:** owner's overnight request and execution plan W1–W14; UI first was audited with owner, then owner authorized every remaining task, prioritizing Create, native rates, voucher, Amend, review/deploy/proof. This index is canonical; detailed linked reports contain source-linked 5–20-minute rows, model/cost estimates, qualitative benefit/gap for **each** window, tests, PRs, causes and limits. Overlapping lanes/intervals are never additive.

**Core conclusion:** substantial backend features and guarded proofs shipped, but whole-UI redesign and staff-pane acceptance were not demonstrated; visible Undo remained broken in an independent deployed-reducer diagnostic. Partial backend wins and an unmet user outcome coexist. Several plan contracts remain partial or unverified; exact outcome and confidence are itemized below, not inferred from PR merges.

**Scope changes:** plan first milestone was source-correct one-room Create plus native price and readback, followed by independent ready workflows. At 07:48 owner said they were okay to downscope/cancel after the elapsed time ([message](/home/orca/.codex/sessions/2026/11/05/rollout-2026-11-05T01-12-38-01a1a943-d9d0-7e11-b9c7-2659e9af7287.jsonl:8383)); that permission did not individually approve every omitted requirement. UI retro clarified owner expected entire UI rewrite; original degree of rewrite was ambiguous. Agent's initial overnight worker delegations are encrypted in local records, so exact worker prompts and internal intent cannot be asserted.

## Source map and linked deep evidence

- [Overnight execution plan and W packets](/home/ubuntu/projects/zero/docs/plans/2026-11-05-001-feat-centurion-core-completion-plan.md:171) · [product contract C1–C14](/home/ubuntu/projects/zero/docs/plans/2026-11-05-001-feat-centurion-core-completion-plan.md:27) · [original design](/home/ubuntu/projects/zero/design_draft.md:172) · [earlier plan](/home/ubuntu/projects/zero/docs/plans/2026-11-04-002-feat-nava-pane-prefill-rate-parity-plan.md).
- Coordinator [overnight transcript](/home/orca/.codex/sessions/2026/11/05/rollout-2026-11-05T01-12-38-01a1a943-d9d0-7e11-b9c7-2659e9af7287.jsonl:1); A [Create](/home/orca/.codex/sessions/2026/11/05/rollout-2026-11-05T01-47-58-01a1a964-30ee-7e90-852d-9b8bf28177e2.jsonl:1); B [rates](/home/orca/.codex/sessions/2026/11/05/rollout-2026-11-05T01-48-14-01a1a964-71c3-73b2-940a-00c578d0ae37.jsonl:1); C [saved workflows](/home/orca/.codex/sessions/2026/11/05/rollout-2026-11-05T01-48-30-01a1a964-b172-7181-8374-0069d89c96e3.jsonl:1). Immutable code boundary: deployed `20e17dd0137e8791e76c06bd5fb16fdbd9cfbd20`; root checkout can be stale/dirty.
- **UI/state W1/W2 + shared UI:** [combined UI retro: original intent, code, models, 92 assessed windows](/home/ubuntu/projects/zero/docs/research/2026-11-05-arch-fork-retro-ui-combined.md).
- **Create / parties / batch W1/W6/W8/W10:** [Create deep retro](/home/ubuntu/projects/zero/docs/research/2026-11-05-arch-fork-retro-create.md).
- **Native rates and Quote W3/W5/W7:** [rates and Quote deep retro](/home/ubuntu/projects/zero/docs/research/2026-11-05-arch-fork-retro-rates-quote.md).
- **Amend / Cancel / Filing W4/W9:** [saved workflow deep retro](/home/ubuntu/projects/zero/docs/research/2026-11-05-arch-fork-retro-saved-workflows.md).
- **Voucher / triage W13/W14:** [voucher and triage deep retro](/home/ubuntu/projects/zero/docs/research/2026-11-05-arch-fork-retro-voucher-triage.md).
- **Review / deployment / proof W11/W12:** [release and proof deep retro](/home/ubuntu/projects/zero/docs/research/2026-11-05-arch-fork-retro-release-proof.md).
- [Repeat method, owner asks and UI calibration](/home/ubuntu/projects/zero/docs/research/2026-11-05-arch-fork-retro-playbook.md) · [read-only token cost calculator](/home/ubuntu/projects/zero/docs/research/2026-11-05-arch-fork-usage-audit.py).

## Coverage: every W packet

Budgets below are the plan's **remaining active-lane** estimates. Outcomes are bounded by cited deep reports; observed elapsed includes dependencies/rework and is often shared across packets. Do not compare totals directly. `Sample verified` means one specified proof only; `partial` includes delivered pieces with material gaps; `unverified` means insufficient evidence, not definite failure.

| Unit | Planned time / owner-model | Recorded lane/model | Result / key boundary | Evidence |
|---|---|---|---|---|
| W1 candidate integration | 20–35m; A Terra xhigh | A Terra xhigh | **Partial:** inherited candidate #1020; assignment→merge 35m01s includes W2/W6/W10 and checks; no full UI redesign. | UI + Create |
| W2 Undo/reset | 10–20m; A Terra medium | A Terra xhigh | **Failed visible Undo:** cursor fixes landed, but deployed reducer diagnostic returned displayed 3→3→3 when history input restored 2→1→2. Pre-existing defect left unresolved; actual browser end-to-end not reproduced here. | UI |
| W3 Quote freshness | 10–25m; A Terra xhigh | A Terra xhigh; B Sol high review | **Partial/unverified:** source/revision and own-reply fixes landed; broader Quote interaction and actual pane not established. | UI + rates/Quote |
| W4 Filing native Prepare | 0–20m audit, 25–45m conditional; C/Sol if native gap | C Terra xhigh; B review | **Sample verified:** #1017 + #1021; original PDF metadata readback, not stored bytes. First change→#1017 merge 17m15s mixed work. | Saved workflows |
| W5 native selected rates | 25–55m; B Terra xhigh | B Sol high | **Partial:** first implementation handoff ~10m54s; #1020 merge 34m45s after worker start. Paid native price observed; first-code frequency/party recommendation from earlier plan is unreachable in the checked pane path. Full UX/coverage unproved. | Rates/Quote |
| W6 editable Create | 40–70m; A Terra xhigh | A Terra xhigh | **Partial:** #1020 plus failed-read manual path #1039; paid Create sample succeeded on `7b4360cb` after #1040; no fresh Create Save on final `20e17dd`. Full staff-pane overhaul/interaction not demonstrated. | UI + Create |
| W7 Quote output | 15–30m; A Terra xhigh | A Terra xhigh | **Sample verified / partial:** chosen offer, PDF and Excel reported; Outlook/Webmail draft insertion unproved. Proof reported 12m06s, not build time. | Rates/Quote |
| W8 batch continuation | 10–25m; A Terra xhigh | A Terra xhigh | **Unverified:** existing batch path inspected; no fresh multi-room Save/readback found. | Create |
| W9 Amend / Cancel | 25–50m shared; C Terra xhigh + Sol if needed | C Terra xhigh; B review | **Amend sample verified:** paid stay extended, R4,560 readback. **Cancel partial:** cancelled, R4,560 warning unapproved, fee posting unknown. #1032 zero-notice branch still needs fresh matching proof. | Saved workflows |
| W10 native party binding | 15–30m; A Terra xhigh | A Terra xhigh | **Partial:** explicit picker and numeric-ID guard exist. The successful Create sample had no agency/company; a positive bound-party Save remains unproved. | Create |
| W11 final-head checks/review | 15–30m; R + reviewer Luna→Sol | R Sol xhigh, B Sol high, other reviewers; Apex model unknown | **Partial:** meaningful checks and fallback reviews ran; 11/26 Greptile checks completed after merge. Late #1020 findings led to fixes. Exact-head review disposition not fully reconciled. | Release |
| W12 release / native proof | 55–105m; R + owners | R Sol xhigh→high, A Terra, B Sol, C Terra | **Partial:** 11 on-box deployment attempts plus one refused preflight; three wrappers exited 1 on readiness backlog; final recheck passed. Backend samples, not pane acceptance. | Release |
| W13 voucher → prefill | 35–70m; R Sol xhigh | R Sol xhigh with others | **Partial:** synthetic text-PDF facts reached draft, then one R0 Create Save/readback; CMS off was dropped then corrected. Scan failed and images misread surnames in observed checks; later priced Create used manual fields. | Voucher |
| W14 frontdoor / remaining asks | 15–35m; A + R + C | R Sol xhigh, A and C Terra xhigh | **Partial:** triage/attached voucher retention fixes landed. Explicit authored-agent exception covers TBO/Travelit; broad provider and general multi-ask completion remain unproved. | Voucher |

## Coverage: original user/product outcomes, not just tasks

| Contract | Expected | Best bounded current assessment |
|---|---|---|
| C1 source/workflow selection | Current email and per-stay action correct | Partial: selected-source guards and triage fixes landed; full staff interaction unproved. |
| C2 editable Create/Quote with missing/failed extraction | Open usable form without fabricated facts | Create failed-read manual admission exercised; full pane and manual Quote / all failure cases unproved. |
| C3 voucher/email source facts and staff precedence | Text/scan/PNG/JPEG grounded to attachment; preserve edits | Partial: PDF facts and guarded staff edits observed; CMS-off lost before correction; image surname wrong and scan failed in sample. |
| C4 guest/booker/agency/org | Distinct roles; selected live native IDs | Partial: existing guest profile selected for Labtest; no agency/company selected in that proof. One actual source agency unresolved and earlier role misclassification corrected manually. |
| C5 rate code, meaning, price | Typed/searchable selected native code and accurate price | Partial: one positive-price backend sample; coverage/meaning and UI across contexts not established. |
| C6 Create supported business fields | Staff edit room, ages, roles, source, Track, guarantee, Booker, CMS etc. | Partial: sampled fields read back; full UX/recomposition and every field not proven. |
| C7 Quote | Chosen native offer, cover, PDF, Excel, no sending | PDF/Excel and chosen offer sampled; actual draft insertion / pane use unproved. |
| C8 1–8 rooms | Sequential, receipts preserve partial/unknown and do not recreate | Fresh multi-room proof absent; unverified. |
| C9 Filing | Selected PDF and target, native Prepare then Go/readback | Sample original PDF metadata verified; native stored bytes and image upload not proved; image filing intentionally outside scope. |
| C10 Amend | Current/proposed, retained edits, repricing | One paid Labtest reprice and fresh readback passed; staff-pane and all fields unproved. |
| C11 Cancel / penalty | Show actual status; reconcile warning/charges | Stay Cancelled, warning R4,560 unapproved; fee posting unknown, staff handoff retained. |
| C12 history and late responses | Undo/reset/redo preserve current staff work | Concrete deployed-reducer diagnostic shows visible Undo failure; does not establish every late-response path fails. |
| C13 source/revision/one dispatch/partial recovery | Bind identity, never blindly repeat uncertain Save | Guarding and held uncertain attempt observed; exhaustive race/recovery proof absent. |
| C14 remaining asks | Completing one ask preserves another | Selected booking-voucher retention fixes shipped; general multi-ask completion unproved. |

## Earlier plan scope changed or missing from W1–W14

The [Nov 4 plan](/home/ubuntu/projects/zero/docs/plans/2026-11-04-002-feat-nava-pane-prefill-rate-parity-plan.md:117) used P01–P58 and explicitly called the full plan broader than the first core release. The Nov 5 plan is the actual overnight execution scope; do not silently equate every earlier patch with a W packet.

| Earlier requirement | Overnight treatment / remaining evidence |
|---|---|
| P25–P26 / R5–R8: frequency and bound-party rate recommendations | Earlier plan requested recommendations without making them the first Amend gate. W5 budgets selected native rate/meaning/price; no separate recommendation packet is explicit. [Recommendation logic](/home/ubuntu/projects/zero/.worktrees/core-question-list-final-deploy-20261105/apps/server-pilot/src/ai/rate-options.ts:171) and [UI rendering](/home/ubuntu/projects/zero/.worktrees/core-question-list-final-deploy-20261105/apps/mail/components/quote-workflow/contextual-rate-check.tsx:247) exist in deployed code, but this UI's [check returns when no code is selected](/home/ubuntu/projects/zero/.worktrees/core-question-list-final-deploy-20261105/apps/mail/components/quote-workflow/contextual-rate-check.tsx:123), so that path cannot recommend a first code. Actual runtime memory and other routes remain unverified. |
| R9 / P28: preserve **Quote** numeric amount/reason override | Separate from an HMS nightly rate override. W7 requires chosen offer/cover/PDF/Excel but does not explicitly price this earlier requirement. [Override control](/home/ubuntu/projects/zero/.worktrees/core-question-list-final-deploy-20261105/apps/mail/components/quote-workflow/rate-controls.tsx:496) exists in deployed code; preservation and export behavior require evidence. Do not label it deferred merely because native overrides were deferred. |
| P40–P45 / U7: native saved-nightly amount override | Conditional, separate native capability in earlier full plan; later C10 explicitly hands off numeric native overrides. **Deferred by revised execution scope**, not evidence a W packet failed. |
| P46–P52 / U8: create a new guest profile | Earlier full plan included a separate conditional profile flow; later C4 deliberately requires an existing native profile and HMS handoff if missing. **Deferred by revised execution scope**, not completed by existing-profile Create. |
| P53–P54: automatic recovery/retry after held operations | Explicitly later/conditional even in earlier plan; later C13 retains unknown/held outcomes and forbids blind retry. Reconciliation safety is in scope; automatic renewed Go is not shown delivered. |
| R14–R16: snapshot read-only behavior; shared webmail/Classic Outlook | Later plan requires both panes and visible use; published assets do not prove actual staff interaction. Snapshot-specific read-only acceptance is **unverified** here. |
| P15–P19: effective primary action, folder/count consistency, per-request completion | W14 retains independent asks and C13 source/request binding; broad cross-folder, count, multiple-stay and completion behavior remains **unverified**, even though selected voucher-retention fixes landed. |

### Earlier patch map: P01–P58

This maps all earlier plan IDs to the retrospective area; it is **not** an assertion each patch was independently implemented or verified. The changed Nov 5 contract and 07:48 owner downscope control the overnight delivery judgment.

| Earlier patch IDs | Task | Review / status |
|---|---|---|
| P01–P02 | Selected email and Amend pane entry | UI + saved workflows; selected-source wiring changed, broad pane acceptance unverified. |
| P03–P06 | Amend extraction, edits, state and hydration | UI + saved workflows; targeted edit behavior tested, all fields and paths unverified. |
| P07–P08 | Amend native rate picker and full form | Rates + UI + saved workflows; one priced backend sample, full staff form unverified. |
| P09–P12 | Native Amend continuation, price/dispatch guards and proof | Saved workflows + release; sampled paid readback, no claim of every edge case. |
| P13–P19 | Remaining source facts, fields and per-request handling | Voucher + Create + UI; selected paths changed, general per-stay/folder completeness unverified. |
| P20–P24 | Native contextual availability, pricing and guarded route | Rates; inspect exact context/coverage, no inference that a priced sample proves all options. |
| P25–P28 | Frequency/party recommendations and shared picker | Rates; recommendation code exists; runtime memory and end-to-end coverage require evidence. |
| P29–P30 | Quote inputs, offers, overrides and outputs | Rates/Quote; chosen PDF/Excel sampled; every override/export and draft path unverified. |
| P31–P33 | Create mapping, form, CMS and rooms | Create; sampled existing-profile one-room booking, party binding and batch still require separate proof. |
| P34–P36 | Selected PDF, binding, native Filing | Saved workflows + voucher; sampled Documents metadata, stored bytes unverified. |
| P37–P38 | Cancel and fee boundary | Saved workflows; final status confirmed, fee settlement unknown. |
| P39 | Coherent pane, history and recorded outcomes | UI; visible Undo failed reducer diagnostic and full redesign not achieved. |
| P40–P45 | Native saved-nightly override | Later plan explicitly deferred; not delivered by Quote amount override. |
| P46–P52 | New guest-profile creation | Later plan explicitly deferred; existing-profile Create does not satisfy it. |
| P53–P54 | Automatic held-operation recovery | Conditional/later; no evidence it was delivered, and blind retry was explicitly prohibited. |
| P55–P58 | Integrate, review, deploy and prove | Release; partial with exact check/deploy/proof caveats; flag promotion and cleanup are not independently exhaustively audited. |

## Cost and time accounting

- **Elapsed:** prior run began approximately Nov 4 **22:12:09 UTC**, paused around **00:35**; overnight plan write was **01:47:08**, final checkpoint **08:06:53**. Start→checkpoint ≈**9h54m44s**; plan write→checkpoint ≈**6h19m45s**. The plan forecast **4–8h remaining**, so the checkpoint fell inside that broad envelope, but unfinished/downsized outcomes mean this is **not** a completed-plan duration or proof that estimates were calibrated. Pauses and parallel lanes are elapsed, not active labor.
- **Execution chat and recorded children, 01:12:38–08:06:53 UTC:** **~$84.97** public-rate model-token estimate. Includes pre-run planning and all overnight lanes, not UI only; execution 01:43 onward is ~**$82.99** included in that figure. Actual Azure invoice unavailable. Source, rates, exclusions and per-lane usage in [UI cost section](/home/ubuntu/projects/zero/docs/research/2026-11-05-arch-fork-retro-ui-combined.md:50).
- **Wider, still incomplete proxy:** six independently identified earlier chats Nov 4 22:12 → Nov 5 00:35:30 add **~$46.31** for 3,362 deduplicated responses (Terra ~$39.45; Sol ~$6.87). Together with the above distinct overnight window, **~$131.28** in selected model-token proxy. It excludes other earlier workers, the gap/replanning not in these windows, and non-model costs. This is not the actual bill or a complete project total. Exact thread IDs and filters are reproducible in the [calculator](/home/ubuntu/projects/zero/docs/research/2026-11-05-arch-fork-usage-audit.py); do not add the original-UI or Create-integration subtotals below again.
- **This retrospective**, root plus recorded children, 11:51:25 → **13:59:37 UTC snapshot:** **~$9.11** model-token proxy (Terra ~$7.82, Luna ~$1.17, Sol ~$0.12; 1,115 responses). It covers the earlier UI retro and this expansion; it will rise after the snapshot. Actual billed amount, infrastructure and human time are unknown.
- Original UI worker ~**$10.74**, earlier Create integration ~**$5.27**, and replanning parent threads ~**$5.95**; scopes are distinct but replanning overlaps full-chat estimate, so **do not add $84.97 to $5.95**. Whole-project cost and precise per-feature cost remain unknown.
- Every 5–20-minute row's cost is a proxy for its explicitly listed lane(s); rows overlap across reports and often include other tasks. Never sum them to price a workflow. Token output includes reasoning; cached/write categories are within input. No numerical ROI without actual charge, staff benefit and counterfactual.
- The actual deliverable is a source-linked qualitative assessment: beneficial/partial/mixed/unknown vs resource and evidence gaps, rather than fabricated $ savings, exclusive labor or model-causation claims.

## Cross-unit synthesis and next-run controls

1. **State/source intent:** architectural statements survived in plan but did not fully reach small execution packets or user-visible checks. Make one workflow owner accountable for an observable staff journey, including edit → Undo → displayed value.
2. **Extraction is a dependency, not decoration:** failed read cached as complete could leave no WorkItem; retry alone failed again. Manual Create fallback was needed. Preserve source/roles and make failed reads actionable without fabricating AI results.
3. **Native price and financial status:** do not equate zero with a valid price; do not equate Cancelled status with fee settlement. Capture unknowns and avoid blind repeat after uncertain writes.
4. **Review and tests:** independent fallback and late Apex caught real defects; reproduce P0/P1 on final head. Preserve command failure status through `tail` and do not substitute subset reruns for the full failed check.
5. **Release and proof:** installed, healthy, READY, verified native write and staff-usable are separate states. Three readiness failures and an incorrect variable showed why gate outputs and timestamps matter.
6. **Timing and ROI:** record plan budget vs comparable actual candidate, merge, proof, rework boundaries; models/lanes, response-token proxy, reason for waiting and evidence per window. Shared efforts are not additive and evidence does not establish unavoidable/wasted minutes.
7. **Proof tooling side effect:** an earlier Amend proof imported an ingest entry point and unintentionally started a real-mail poll. Worker reported one inbound processed and no outbound change or associated HMS run. Use a side-effect-free helper and check startup behavior before a proof import; see release report for bounded evidence.

**Completion/coverage ledger:** W1–W14 and C1–C14 mapped above; P01–P58 mapped in groups. Deep reports cover each workflow and the prioritized release/proof work, with evidence and limits. Initial direct worker task payloads, actual Azure billing, complete deployed UI acceptance and broad multi-room proof remain unavailable/unverified.
