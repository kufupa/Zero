# Arch fork: deeper UI failure analysis and timing

**Finding:** the owner requested a UI overhaul with working history and later clarified they expected the entire UI to be rewritten. The agent promised redesign, but how fully it understood that extent is unresolved. It translated Undo into a cursor-revision repair; the record does not show a check of the displayed restored value. An older reducer rule then preserved the current edited value when history supplied the prior one. Other UI changes were substantial, but the redesigned end-to-end interaction was not demonstrated.

**LLM handoff:** extends [first UI retro](/home/ubuntu/projects/zero/docs/research/2026-11-05-arch-fork-retro-ui.md). UI-only audit; all other work units remain pending. Chronology = wall time, not active minutes; parallel lanes overlap. Deployed snapshot: `20e17dd0137e8791e76c06bd5fb16fdbd9cfbd20`. Dirty root checkout is older; do not use it as deployed-code evidence.

## 1. Where the intent was lost

| Stage | What was requested or decided | What followed | Why it matters |
|---|---|---|---|
| Owner instruction | Keep the general visual design, overhaul workflows around Cloud tools, wipe old connections and keep human edits and history working. | Owner explicitly corrected the agent's “just wiring” reading at 00:50 UTC; also said “wipe” existing pieces and “not … from scratch.” | Overhaul was requested, but extent of UI code/layout rewrite vs reuse was ambiguous; owner now clarifies they expected the entire UI rewritten. [Owner's correction](/home/orca/.codex/sessions/2026/11/04/rollout-2026-11-04T23-29-11-01a1a8e5-2227-7832-bb3a-7d9f79094087.jsonl:867). |
| Architecture | Agent identified editable intent split across QuoteSession, form state and WorkItem; the execution plan said WorkItem should supply the effective draft and QuoteSession should not compete with it. | W2 instead specified own-cursor adoption and freshness; W6 specified mounting incomplete drafts, field coverage and party selection. | Broad integration intent survived in prose but was not carried into a specific displayed-history acceptance step. [Architecture](/home/ubuntu/projects/zero/docs/plans/2026-11-05-001-feat-centurion-core-completion-plan.md:102), [work packets](/home/ubuntu/projects/zero/docs/plans/2026-11-05-001-feat-centurion-core-completion-plan.md:177). |
| Implementation | #1020 changed cursor handling, source binding, form controls and much more. | The existing edited-row preservation rule remained in place. Restored history was routed through the same reducer path as a late reread. | A legitimate concurrency fix did not resolve the complete user interaction. [#1020](https://github.com/kufupa/Zero/commit/3a66a9167cf46e63442d3de1e74ec6c0b078d51f), [reducer](/home/ubuntu/projects/zero/.worktrees/core-question-list-final-deploy-20261105/apps/mail/lib/quote-workflow/session.ts:1754). |
| Verification | Existing focused tests, remote typechecks, reviews and backend native proof were run. | The existing Undo pane case asserted the mutation and refetch; it did not assert the visible value after Undo and Redo. | Passing the checks did not establish the promised staff outcome. [Existing Undo case](/home/ubuntu/projects/zero/.worktrees/core-question-list-final-deploy-20261105/apps/mail/tests/nava-pane-work-item-controls.test.tsx:432). |
| Reporting | Coordinator reported Undo/reset fixes deployed and later described shared state as fixed. | The actual staff-pane interaction and visual acceptance were not established. | The claim was broader than its supporting evidence; the worker also disclosed the lack of a visual check. [Progress claim](/home/orca/.codex/sessions/2026/11/05/rollout-2026-11-05T01-12-38-01a1a943-d9d0-7e11-b9c7-2659e9af7287.jsonl:7133), [visual gap](/home/orca/.codex/sessions/2026/11/05/rollout-2026-11-05T01-47-58-01a1a964-30ee-7e90-852d-9b8bf28177e2.jsonl:6689). |

**Important correction on ownership:** the faulty reducer branch and the limited Undo test were already present at the original UI starting commit `9d388ab751`; both files are unchanged between that commit and the overnight deployed SHA `20e17dd013`. This establishes that the overnight work **did not repair a pre-existing defect**. It does not establish who introduced it, whether the overnight agent knew the exact defect, or that every Undo field fails.

### Why this fails technically

1. Staff edits stay rows, changing QuoteSession and recording edits in WorkItem.
2. Undo flushes pending edits, applies the server history mutation, accepts the returned revision cursor and refetches the restored projection.
3. The pane feeds that projection into `analysis_ready`, the ordinary handler also used for rereads.
4. The reducer intentionally protects previously edited stays from late rereads. It has no distinction for an authoritative history restoration, so it keeps the currently displayed edited rows.
5. A reducer-level diagnostic against deployed code supplied restored quantities **2 → 1 → 2**; the pane stayed at **3 → 3 → 3**. It reproduced actual reducer behavior, not a live database or browser journey. The owner's reported observation is separate corroboration.

**The causal error is event semantics:** late extraction must not erase a staff edit, but an explicit Undo must restore the chosen prior version. The old rule treats those events alike. A correct change would explicitly reconcile history into the visible editable draft while retaining the late-result protection, then check displayed Edit → Undo → Undo → Redo values. No entire reducer rewrite is implied.

This does not establish that a restored row was automatically written back to the server. It also does not establish the cause of every possible history failure.

### The missed check was actually run

At **02:44**, the worker ran the existing history-controls suite: all **6 cases passed**, alongside 43 WorkItem hook cases. One passing case was literally named “clicking Undo calls undoRevision with the expected revision then refetches.” Its assertion stops at mutation and refetch; it does not check the restored quantity in the rendered pane. This is direct evidence of how the team could get a green result while the displayed result remained wrong. [Recorded run](/home/orca/.codex/sessions/2026/11/05/rollout-2026-11-05T01-47-58-01a1a964-30ee-7e90-852d-9b8bf28177e2.jsonl:3508), [test assertions](/home/ubuntu/projects/zero/.worktrees/core-question-list-final-deploy-20261105/apps/mail/tests/nava-pane-work-item-controls.test.tsx:432).

At 02:45–02:46 the worker also noticed a **different** “restores a finished staff rate” case failed on the unchanged baseline and disclosed it in #1025. The record does not show that this rate-restore failure is the Undo defect. It shows that a baseline failure could be correctly classified as not newly introduced while still leaving the broader product issue for separate investigation. [Comparison](/home/orca/.codex/sessions/2026/11/05/rollout-2026-11-05T01-47-58-01a1a964-30ee-7e90-852d-9b8bf28177e2.jsonl:3618).

### Why did the rest of the UI look insufficiently overhauled?

The agent did build substantial new controls and connections. But it retained existing Quote steps, stay cards, booking cards and multiple draft representations; it did not demonstrate the planned recomposition into a coherent staff workflow. The “Children total” control illustrates the gap: it updates a stay-wide total, while per-room child counts in another card create the age inputs. The stay-total component file was unchanged from the original UI starting commit to the deployed SHA; the booking card changed substantially. The native tool validates the ages actually supplied, but that does not reconcile the separate UI total. For multiple rooms, the user must explicitly allocate children; the correct allocation cannot be inferred automatically. This evidence does not prove that an incorrect booking was saved.

The 92.8-minute previous UI candidate was repeatedly used as evidence that much UI work had already been paid for. That candidate had real changes and an explicit handoff with remaining backend dependencies. Treating its prior time as evidence of completed interaction design is unsupported. We cannot prove that this estimate shortcut alone caused the remaining failure.

**What is known versus uncertain:** the pre-existing reducer defect, missing visible-value assertion and narrowed W2 packet are directly evidenced. The extent to which compaction, model choice, forecast pressure, parallel ownership or the no-new-tests rule caused the omission is unknown. The last rule did not prohibit running existing tests; many were run. The record does not justify blaming the owner for the missing acceptance check.

## 2. Plan units → observed UI work

Yes: the [execution plan](/home/ubuntu/projects/zero/docs/plans/2026-11-05-001-feat-centurion-core-completion-plan.md:171) defined W1–W14, owners, estimates and line budgets. Initial 01:47 plan write is preserved at `/tmp/arch-fork-retro-20261105/initial-plan-write.txt`; current plan also contains later checkpoint edits. UI-related units below. Budgets are estimates; observed intervals overlap and often include multiple units. No invented unit completion times.

**Recorded lanes, not just plan:** A `create_quote_builder` = `gpt-6.1-terra` xhigh; B `rates_builder` = `gpt-6.1-sol` high; C `saved_workflows_builder` = `gpt-6.1-terra` xhigh; R coordinator = `gpt-6.1-sol` xhigh through 07:50, then high. [Spawn/model records](/home/orca/.codex/sessions/2026/11/05/rollout-2026-11-05T01-12-38-01a1a943-d9d0-7e11-b9c7-2659e9af7287.jsonl:443), [coordinator setting](/home/orca/.codex/sessions/2026/11/05/rollout-2026-11-05T01-12-38-01a1a943-d9d0-7e11-b9c7-2659e9af7287.jsonl:2). Original UI worker and earlier #1014 integration worker were each Terra xhigh. [Original](/home/orca/.codex/sessions/2026/11/04/rollout-2026-11-04T22-12-42-01a1a89f-1ea0-7223-bb28-92aa9e7429d7.jsonl:10) · [integration](/home/orca/.codex/sessions/2026/11/04/rollout-2026-11-04T23-41-17-01a1a8f0-3758-79d2-96cc-a7f7981e22fd.jsonl:10).

| Unit | Planned time; lane/model | Recorded lane/model | Actual observed elapsed; output; limit |
|---|---|---|---|
| W1 integration | 20–35m; A Terra xhigh | A Terra xhigh | **14m08s** first commit; **22m33s** handoff; **35m01s** [#1020](https://github.com/kufupa/Zero/pull/1020) merge. Includes W2/W6/W10, checks, inherited code. PR +2,862/−544; mail product +1,704/−332. |
| W2 Undo/reset | 10–20m; A Terra **medium** | A Terra **xhigh** | **2m54s** shared cursor/partial-form window; Reset follow-up **13m27s** to [#1023](https://github.com/kufupa/Zero/pull/1023) merge; later mixed Reset/Quote fix **13m38s** to #1025. Visible Undo still broken; exclusive time unknown. |
| W3 Quote freshness | 10–25m; A Terra xhigh | A Terra xhigh; B Sol high review | Review finding → [#1025](https://github.com/kufupa/Zero/pull/1025) merge **13m38s**, mixed with Reset/multi-room fixes; [#1027](https://github.com/kufupa/Zero/pull/1027) rate-reply follow-up **3m21s**. |
| W4 Filing acceptance | 0–20m audit; 25–45m conditional; C Sol high if native gap | C Terra xhigh; B Sol high review | Observed fix start → [#1017](https://github.com/kufupa/Zero/pull/1017) merge **17m15s**; first commit **3m48s**. Compatibility follow-up → [#1021](https://github.com/kufupa/Zero/pull/1021) merge **12m49s**. Mixed with Amend/Cancel; full audit pending. |
| W5 selected native rates | 25–55m; B Terra **xhigh** | B Sol **high** | Dedicated worker 01:48:17 → candidate commit 01:58:28 **10m10s**; handoff 01:59:08 **10m51s**; #1020 merge 02:22:59 **34m41s**. Two commits +370/−8 and +8/−5. Native proof/displayed UX separate. |
| W6 editable Create | 40–70m; A Terra xhigh | A Terra xhigh | First connected candidate **13m21s**, #1020 merge **34m13s**. Manual failed-read entry separately **22m20s** to [#1039](https://github.com/kufupa/Zero/pull/1039) merge; room-date fix **4m56s** to #1040. Full recomposition/interactive acceptance unproved. |
| W7 Quote output | 15–30m; A Terra xhigh | A Terra xhigh | Quote proof **12m06s**: native price, PDF and Excel; staff corrections, cover unsent. Proof elapsed, not original implementation time; UI interaction unproved. |
| W8 batch continuation | 10–25m; A Terra xhigh | A Terra xhigh | Existing batch path inspected **4m22s**, overlapping W10 edits. Reported confirmed-room receipts and stop on uncertainty; fresh multi-room proof and unit completion time unestablished. |
| W9 Amend/Cancel | 25–50m; C Terra xhigh, Sol high native | C Terra xhigh; B Sol high review | Cancel investigation → [#1022](https://github.com/kufupa/Zero/pull/1022) merge **35m57s**, first commit **6m**. Amend reported work → [#1024](https://github.com/kufupa/Zero/pull/1024) merge **35m41s**; early candidate **9m24s**. Overlaps W4/proof; acceptance pending. |
| W10 party binding | 15–30m; A Terra xhigh | A Terra xhigh | Finishing guest picker → report **2m20s**; earlier work may predate report. Voucher agency/company code edit → candidate commit **5m55s**, overlapping W1/W8. #1020 merged 02:22:59. Exclusive total unknown. |
| W11 checks/review | 15–30m; R + spare Luna xhigh → Sol high | R Sol xhigh; B Sol high reviewed Create; Apex model unverified | #1020 PR open → merge **9m05s**; #1025 **5m30s**. Apex finished **3m15s after #1020 merge**; existing history test did not assert displayed value. |
| W12 deploy/proof | 55–105m; R + workflow owner | R Sol xhigh; A Terra xhigh, B Sol high and C Terra xhigh contributed | First deploy command start 02:52:13 → coordinator's zero-price Create proof report 03:55:28 = **1h03m15s**, including three deploys and other work. First readback command **34s**, flagged code/display mismatch; second verification command **34s**, passed. 02:53:15 was a status message, not deploy start. Positive-price readback 07:17 after manual-entry/date fixes. UI interaction unproved. |

**Interpretation:** intervals are observed start/report/commit/merge/proof boundaries, not measured exclusive coding time. Reviews, workers and W-units overlap. Candidate and partial proof are not full planned acceptance. Do not add the numbers or infer success from speed. Original candidate 22m33.354s rounded to 22m33s; prior report's 22m34s was a one-second error.

Direct timelines: [Create/Undo/party/batch](/home/orca/.codex/sessions/2026/11/05/rollout-2026-11-05T01-47-58-01a1a964-30ee-7e90-852d-9b8bf28177e2.jsonl:105), [rates worker](/home/orca/.codex/sessions/2026/11/05/rollout-2026-11-05T01-48-14-01a1a964-71c3-73b2-940a-00c578d0ae37.jsonl:17), [Amend/Cancel/Filing worker](/home/orca/.codex/sessions/2026/11/05/rollout-2026-11-05T01-48-30-01a1a964-b172-7181-8374-0069d89c96e3.jsonl:17), [release coordinator](/home/orca/.codex/sessions/2026/11/05/rollout-2026-11-05T01-12-38-01a1a943-d9d0-7e11-b9c7-2659e9af7287.jsonl:2057).

**Review nuance:** B (Sol high) [reviewed](/home/orca/.codex/sessions/2026/11/05/rollout-2026-11-05T01-48-14-01a1a964-71c3-73b2-940a-00c578d0ae37.jsonl:781) Create `bfea5ea` against its base at 02:10:58, including history guards, and reported no new P0/P1. That was a comparative review, not proof of visible Undo; the defect already existed on the base. No causal claim about model choice follows from model differences.

### W12: the hour was not a one-hour readback

Correction: previously called 02:53:15–03:55:28 “bundle → readback, 1h02m13s.” 02:53:15 was a progress message; the first deploy command began **02:52:13.259**. Full observed start → final coordinator report = **1h03m15s**; three deployment commands ran. My interim claim that the readback itself took 5m21s was also wrong: that was the gap between B's Save-return message and final success message. The first readback command took **34.31s** and flagged a mismatch; final verification took **33.97s** and passed. R = coordinator/Sol xhigh; A = Create/Terra xhigh; B = rates/proof/Sol high. References: [R rollout](/home/orca/.codex/sessions/2026/11/05/rollout-2026-11-05T01-12-38-01a1a943-d9d0-7e11-b9c7-2659e9af7287.jsonl:2323), [A rollout](/home/orca/.codex/sessions/2026/11/05/rollout-2026-11-05T01-47-58-01a1a964-30ee-7e90-852d-9b8bf28177e2.jsonl:4977), [B rollout](/home/orca/.codex/sessions/2026/11/05/rollout-2026-11-05T01-48-14-01a1a964-71c3-73b2-940a-00c578d0ae37.jsonl:2146). Source IDs below are one-based line numbers.

| UTC interval | Elapsed | Observed work and boundaries; not exclusive effort |
|---|---:|---|
| 02:52:13–03:00:01 | 7m48s | **R** first deployment runs 02:52:13–02:58:02 (**5m49s**, success). In parallel, A fixes a rate-reply race; #1027 merges at 03:00:02, one second after this window. Core runtime reported active 03:00:01. R:L2323/L2408; A:L4097/L4203. |
| 03:00:01–03:10:10 | 10m10s | **R** deploys later release 03:04:30–03:10:08 (**5m38s**, includes fetch/checkout). In parallel team fixes quoted-text triage, checks voucher extraction; first PDF check misses fields, later raw check includes them. **B** waits for exact-release readiness. R:L2506/L2563/L2662; B:L2073. |
| 03:10:10–03:18:12 | 8m02s | **B** begins native read 03:10:49, reports pass 03:12:40, admits voucher 03:14:23, then gets approval for unsaved Prepare. **A/R** find queued voucher dropped explicit “CMS send: off”; correction starts. B:L2146/L2190/L2223/L2294; A:L4977/L5018; R:L2798. |
| 03:18:12–03:23:14 | 5m01s | **B** runs first unsaved native Prepare: 03:18:12 → 03:22:00 ≈ **3m47s**; reports R0. **A** commits CMS fix and starts checks/review concurrently. R reports Prepare 03:23:14; no Save yet. B:L2294/L2377; A:L5292; R:L2911. |
| 03:23:14–03:33:14 | 10m00s | **A** resolves CMS source conflict; #1029 merges 03:25:50. Review finds negated-label issue 03:26; #1030 merges 03:32:33. **B** checks stored Prepare/grant and reviews correction. Third deploy command starts 03:33:14. A:L5429/L5712/L6021; B:L2424/L2508; R:L3151. |
| 03:33:14–03:40:17 | 7m03s | **R** fetch/checkout + third deploy completes 03:38:52 (**5m38s**, success). Runtime readiness reported 03:40:17; **B** starts fresh source/native read/Prepare against corrected release. R:L3151; B:L2688. |
| 03:40:17–03:46:28 | 6m11s | **B** corrects stale runner checksum 03:41:16, reruns read and Prepare; reports Prepare success 03:45:04. **A/B/R** review saved source, revision, guest and grant. **B** begins authorized Labtest Go 03:46:28. B:L2724/L2819/L2855; A:L6467/L6583. |
| 03:46:28–03:55:28 | 9m00s | **B** executes Go 03:46:33–03:48:30 (**1m57s**). First readback 03:48:39–03:49:14 (**34s**) flags track expected `BAR`, displayed `Best Available`; worker inspects mapping and runs other post-Go checks. **A** reports fresh readback 03:51:07 before B's final verification. B's second fresh verification 03:52:39–03:53:13 (**34s**) passes with expected display from existing `normalizeCreateTrack`; B reports 03:54:34, R 03:55:28. B:L2896/L2926/L2936/L3041/L3064/L3086; R:L3370. |

**Mismatch nuance:** first readback returned a mismatch, not an SSM command failure. The final proof script normalized the reviewed `BAR` code using existing product mapping and compared its `Best Available` display against the saved record. It did not establish that the original readback comparison was fixed in product code. The first Save command finished 03:48:30; B's 03:49:12 announcement lagged it and overlapped the first readback. An earlier A report of successful field checks at 03:51 should not be substituted for B's later complete verification. Record-view proof has limited capture scope; no pane interaction was demonstrated. See [first readback result](/home/orca/.codex/sessions/2026/11/05/rollout-2026-11-05T01-48-14-01a1a964-71c3-73b2-940a-00c578d0ae37.jsonl:2936) and [final verification result](/home/orca/.codex/sessions/2026/11/05/rollout-2026-11-05T01-48-14-01a1a964-71c3-73b2-940a-00c578d0ae37.jsonl:3064).

First proof used an R0 Labtest stay. It validated the sampled backend Save/readback, not visible UI. Later positive-price Create readback occurred 07:17 after separate fixes. The interval includes useful source-safety corrections, two release waves before first Prepare, and a third deploy after CMS fixes. It does not establish how many minutes were avoidable or exclusively active work.

### Other UI intervals above 20 minutes, split

These are overlapping elapsed windows, not additive labor. Original sole UI **88m29s** and earlier integration **52m39s** are already split into 5–10m rows in §§4–5 below.

| Unit / lane | UTC interval | Elapsed | What happened |
|---|---|---:|---|
| W1 + initial W6 / A Terra xhigh | 01:47:58–01:54:54 | 6m57s | Candidate inspection, partial draft + cursor, guest lookup underway. W6's specific admission report begins 01:48:46. |
| W1 + W6 | 01:54:54–02:02:06 | 7m12s | Guest picker; fixture correction; focused checks; first candidate commit. |
| W1 + W6 | 02:02:06–02:10:31 | 8m25s | Batch-path inspection and voucher party binding; connected candidate handoff. |
| W1 + W6 | 02:10:31–02:22:59 | 12m27s | Correct type errors; draft PR; remote checks/review; #1020 merge. Other W-units continued. |
| W5 / B Sol high | 01:48:17–01:59:08 | 10m51s | Two rate commits and candidate handoff. |
| W5 integration | 01:59:08–02:13:54 | 14m46s | Candidate integrated into Create PR; B moved to review/proof work. This interval is not exclusive rate coding. |
| W5 integration | 02:13:54–02:22:59 | 9m05s | #1020 PR checks/review/merge. Overlaps W1/W6. |
| W6 manual / A | 06:05:06–06:16:09 | 11m03s | Staff-owned failed-read draft, guards, focused checks, candidate. |
| W6 manual / A | 06:16:09–06:27:26 | 11m17s | Review fixes, both typechecks, #1039 merge. |
| W9 Cancel / C Terra xhigh | 01:48:41–01:54:41 | 6m00s | Warning/status correction first commit. |
| W9 Cancel / C | 01:54:41–02:09:53 | 15m12s | Interleaved Amend, Filing and native work; not 15m of exclusive Cancel coding. |
| W9 Cancel / C | 02:09:53–02:16:33 | 6m40s | Read-only proof/source checks, then isolate Cancel correction. |
| W9 Cancel / C | 02:16:33–02:24:38 | 8m05s | Focused checks, review finding/fix, #1022 merge. |
| W9 Amend / C | 01:56:37–02:06:01 | 9m24s | Selected rate, native contact/ages and edit preservation; last early candidate commit. |
| W9 Amend / C | 02:06:01–02:16:33 | 10m32s | Filing compatibility + read-only native work; Amend dependency not landed. |
| W9 Amend / C | 02:16:33–02:24:26 | 7m53s | Cancel work/proof preparations while awaiting Create; start Amend branch after Create lands. |
| W9 Amend / C | 02:24:26–02:32:18 | 7m52s | Amend PR, tests, type-error fix, remote checks/review, #1024 merge. |
| W6 manual → paid proof / A/R/B | 06:05:06–06:16:09 | 11m03s | Manual candidate and focused checks. |
| W6 manual → paid proof | 06:16:09–06:27:26 | 11m17s | Review/typechecks; #1039 merge. |
| W6 manual → paid proof | 06:27:26–06:39:54 | 12m28s | Deploy; failed-read voucher gains staff-owned draft. |
| W6 manual → paid proof | 06:39:54–06:48:23 | 8m29s | Room-date guard mismatch found; #1040 fix merged. |
| W6 manual → paid proof | 06:48:23–06:58:18 | 9m55s | Corrected release deployed/readiness checked; fresh Prepare begins. |
| W6 manual → paid proof | 06:58:18–07:09:09 | 10m51s | Native R2,280 check; Prepare passed 07:06; fields reviewed; Go authorized. |
| W6 manual → paid proof | 07:09:09–07:17:02 | 7m53s | One Save and fresh positive-price readback. |

Sources: the per-worker transcript links immediately above; [positive-price proof chronology](/home/orca/.codex/sessions/2026/11/05/rollout-2026-11-05T01-12-38-01a1a943-d9d0-7e11-b9c7-2659e9af7287.jsonl:7098). Durations rounded to seconds; partial windows under five minutes are included only as events within larger rows.

**Granularity audit:** all **92 timestamped table windows** in this document are 5–20 minutes, including intervals originally between 20 and 60 minutes. The long summary figures above point to constituent windows; they are not standalone breakdowns. Two original-worker windows were enriched with transcript-level edits and test results after the first audit. A time window can still contain overlapping tasks or uncertain activity; some unit start/end times remain unknown. This is not an event-by-event audit of every minute of every overnight lane.

W13 prefill and W14 front-door/remaining asks are separate later retros; only their effects on the UI are noted here. W4/W5/W7/W8/W9 require deeper separate workflow audits before claiming overall success or failure.

## 3. How to read the timing

- All times below are UTC. Exact boundaries come from timestamped transcript messages, tool output or Git; the displayed seconds are rounded where necessary.
- Each row is a **wall-clock window**, typically 5–20 minutes. Events may have started before that row, and gaps do not prove idleness, waiting, or active coding.
- Different lanes overlap. **Do not add worker elapsed times to obtain total elapsed time**, and do not add LOC for patches reused in later PRs.
- A commit or a merged PR marks a boundary, not proof that its whole feature or staff experience was finished. Review and backend evidence prove different things from a browser interaction.
- Neither active engineering minutes nor API billing in dollars can be reliably reconstructed from the available evidence.

## 4. Original sole-UI worker: November 4

The [UI brief](/home/orca/.codex/sessions/2026/11/04/rollout-2026-11-04T22-12-42-01a1a89f-1ea0-7223-bb28-92aa9e7429d7.jsonl:22) arrived at 22:16:58. It called for a 320–420px staff UI redesigned around actual tool coverage, while preserving history and staff edits. The [handoff](/home/orca/.codex/sessions/2026/11/04/rollout-2026-11-04T22-12-42-01a1a89f-1ea0-7223-bb28-92aa9e7429d7.jsonl:6774) at 23:45:27 left backend integration and remote typecheck outstanding. Git confirms 22 commits in this range; commits are completion markers, not precise start times of individual edits.

| UTC interval | Duration | Observed work / boundary |
|---|---:|---|
| 22:16:58–22:25:42 | 8m44s | Inspected selected-message and Amend paths; first Amend candidate committed 22:21:33; another commit preserved edits during booking reads. |
| 22:25:42–22:35:42 | 10m | **Amend rate search + durable edits:** modified rate-code control and fixture; focused run **116 passed**, broader run **145 passed**; committed rate search 22:27:36. Inspected WorkItem/history, then built Amend draft binding, save queue and history hooks. Amend tests **137 passed** at 22:32; a later combined run could not collect one suite because `@zero/tsconfig/base` was missing, so worker added a temporary Vitest config. A pane run at 22:35 had **8 failed, 23 passed, 132 skipped**. [Rate changes](/home/orca/.codex/sessions/2026/11/04/rollout-2026-11-04T22-12-42-01a1a89f-1ea0-7223-bb28-92aa9e7429d7.jsonl:744); [draft changes](/home/orca/.codex/sessions/2026/11/04/rollout-2026-11-04T22-12-42-01a1a89f-1ea0-7223-bb28-92aa9e7429d7.jsonl:979); [test failure](/home/orca/.codex/sessions/2026/11/04/rollout-2026-11-04T22-12-42-01a1a89f-1ea0-7223-bb28-92aa9e7429d7.jsonl:1387). |
| 22:35:42–22:43:29 | 7m47s | **Amend persistence/binding:** investigated pane failures, changed selected-email rebinding and saved-draft/history guards, adjusted pane fixtures, reran checks. One work-item suite **43 passed**; later focused multi-suite run **188 passed**; selected pane run **9 passed, 111 skipped**. Committed Amend persistence/binding at 22:43:29. These overlapping runs are not additive and do not prove complete UI acceptance. [Rebinding edits](/home/orca/.codex/sessions/2026/11/04/rollout-2026-11-04T22-12-42-01a1a89f-1ea0-7223-bb28-92aa9e7429d7.jsonl:1466); [188-case run](/home/orca/.codex/sessions/2026/11/04/rollout-2026-11-04T22-12-42-01a1a89f-1ea0-7223-bb28-92aa9e7429d7.jsonl:1944); [pane subset](/home/orca/.codex/sessions/2026/11/04/rollout-2026-11-04T22-12-42-01a1a89f-1ea0-7223-bb28-92aa9e7429d7.jsonl:1969). |
| 22:43:29–22:51:44 | 8m15s | Bound selected PDF for Filing, narrowed Amend lookup types and refreshed selected Amend before action. |
| 22:51:44–23:01:16 | 9m32s | Amend rate observations, read-only preview, retained-rate handling and pending-request binding. Worker says Cloud unsupported controls were being hidden. [Transcript](/home/orca/.codex/sessions/2026/11/04/rollout-2026-11-04T22-12-42-01a1a89f-1ea0-7223-bb28-92aa9e7429d7.jsonl:3386). |
| 23:01:16–23:09:44 | 8m28s | Matched Create controls to supported fields, verified explicit Filing selection, arranged Create fields and native rate search. |
| 23:09:44–23:18:40 | 8m56s | Connected saved edits to native rate context; added save barrier and party/source/revision guards for rate checks. [Transcript](/home/orca/.codex/sessions/2026/11/04/rollout-2026-11-04T22-12-42-01a1a89f-1ea0-7223-bb28-92aa9e7429d7.jsonl:4215). |
| 23:18:40–23:28:30 | 9m50s | Quote rate check bound to saved context; discovered extraction-change race, coordinated backend guard and built shared save queue. |
| 23:28:30–23:35:55 | 7m25s | Guarded draft edits against extraction changes, bound stay edits/history to displayed identity, persisted room choices, guarded selected-rate Create. |
| 23:35:55–23:45:27 | 9m32s | Cancellation reason/note and review, exact-number Filing lookup, Create approval freshness; final candidate commit and handoff. |

These windows explain what the previous UI time covered. They do not establish a completed UI redesign, and they do not prove that time between commit boundaries was spent only on the named change.

## 5. Create integration and replan

### Earlier Create integration worker, November 4–5

This worker overlapped the end of the sole-UI worker and later plan discussion. Sources are the [integration transcript](/home/orca/.codex/sessions/2026/11/04/rollout-2026-11-04T23-41-17-01a1a8f0-3758-79d2-96cc-a7f7981e22fd.jsonl:12) and [draft PR #1014](https://github.com/kufupa/Zero/pull/1014).

| UTC interval | Duration | What the record shows |
|---|---:|---|
| Nov 4 23:42:37–23:51:35 | 8m58s | Isolated Create/Quote files, assembled code, corrected a stay-edit guard, repaired dependencies and added-room projection; booking checks reported 246 passing. [Transcript](/home/orca/.codex/sessions/2026/11/04/rollout-2026-11-04T23-41-17-01a1a8f0-3758-79d2-96cc-a7f7981e22fd.jsonl:109). |
| 23:51:35–00:00:29 | 8m54s | Investigated 20 pane-suite failures; opened draft PR at 23:54. Matching base/PR run reported 98 passed, 20 failed, 2 skipped. DB suite was skipped. [Transcript](/home/orca/.codex/sessions/2026/11/04/rollout-2026-11-04T23-41-17-01a1a8f0-3758-79d2-96cc-a7f7981e22fd.jsonl:1187). |
| 00:00:29–00:09:29 | 9m | Investigated fixtures, queued remote checks, received Greptile findings, confirmed missing extraction ID, rate-input freeze and overwritten Booker issues; fixed verified issues. Both remote checks passed on the old head only. [Transcript](/home/orca/.codex/sessions/2026/11/04/rollout-2026-11-04T23-41-17-01a1a8f0-3758-79d2-96cc-a7f7981e22fd.jsonl:1897). |
| 00:09:29–00:17:41 | 8m12s | Added stale-date guard, ran focused checks, pushed new head and repeated both remote typechecks; cross-field revision reconciliation remained a P1 gap. [Transcript](/home/orca/.codex/sessions/2026/11/04/rollout-2026-11-04T23-41-17-01a1a8f0-3758-79d2-96cc-a7f7981e22fd.jsonl:2630). |
| 00:17:41–00:26:34 | 8m53s | Traced an older rate overriding a newer one, added revision guards and investigated stale caches/recovery. [Transcript](/home/orca/.codex/sessions/2026/11/04/rollout-2026-11-04T23-41-17-01a1a8f0-3758-79d2-96cc-a7f7981e22fd.jsonl:2698). |
| 00:26:34–00:35:17 | 8m43s | Focused checks and independent review, pushed another head, then encountered six current-main conflicts. Owner paused during the merge; PR stayed unmerged with conflict resolutions uncommitted. [Transcript](/home/orca/.codex/sessions/2026/11/04/rollout-2026-11-04T23-41-17-01a1a8f0-3758-79d2-96cc-a7f7981e22fd.jsonl:3784). |

### Replan and UI-scope correction, November 5

This is the planning/coordinator lane, not a second timer for the integration worker. It includes user discussion and requested architecture explanations. “No message” does not imply the agent was idle. [Planning transcript](/home/orca/.codex/sessions/2026/11/04/rollout-2026-11-04T23-29-11-01a1a8e5-2227-7832-bb3a-7d9f79094087.jsonl:333); [overnight fork](/home/orca/.codex/sessions/2026/11/05/rollout-2026-11-05T01-12-38-01a1a943-d9d0-7e11-b9c7-2659e9af7287.jsonl:6).

| UTC interval | Duration | What the record shows |
|---|---:|---|
| 00:04:48–00:11:02 | 6m14s | Owner requests evidence-based granular units; planner examines candidate and identifies conflicting shared state/source files. |
| 00:11:02–00:19:03 | 8m01s | Drafts nine-unit plan and identifies shared-file integration and native-profile dependency. |
| 00:19:03–00:33:00 | 13m57s | No further message in this planning chat until owner's next request; the integration worker was still active in parallel. |
| 00:33:00–00:41:33 | 8m33s | Inspects paused run and develops 12 smaller packets; forecasts 2.5–5h from resume. |
| 00:41:33–00:50:44 | 9m11s | Presents plan; owner challenges the 92.8m UI comparator; agent initially narrows remaining work to field wiring, then owner clarifies actual overhaul. |
| 00:50:44–00:59:44 | 9m | Agent traces split state, proposes recomposition around durable draft, and finds missing-field form-admission blocker. |
| 00:59:44–01:12:57 | 13m13s | Owner asks for reviewer rationale and a detailed architecture explanation; agent traces prefill, memory and deterministic tools. Includes separate user-requested explanation work. |
| 01:12:57–01:24:33 | 11m36s | Gives conditional 3–5.5h forecast; user asks about incomplete extraction and voucher formats; agent finds a voucher-provenance gap and proposes three builder lanes plus coordinator. |
| 01:24:33–01:35:54 | 11m21s | Gap between proposed lane split and user's next message. No inference about user or agent activity outside this chat. |
| 01:35:54–01:47:28 | 11m34s | User directs deep plan including voucher prefill and review; agent checks scope/ROI, receives ~06:30 checkpoint request, rewrites plan and starts execution. |

## 6. Overnight Create worker and connected verification: November 5

### Coordinator's connected-delivery timeline

These are fixed 10–15-minute observation windows, not estimates of how long each task took. The coordinator was directing several workers and proofs in parallel. Line numbers refer to the [overnight coordinator transcript](/home/orca/.codex/sessions/2026/11/05/rollout-2026-11-05T01-12-38-01a1a943-d9d0-7e11-b9c7-2659e9af7287.jsonl). Later native-proof windows explain elapsed delivery time; they are not all frontend work.

| UTC window | Duration | Observed event(s); source line |
|---|---:|---|
| 01:47–02:00 | 13m | Execution begins; partial Create form and history-cursor fix under checks; Filing and rate work in parallel. L435, L672. |
| 02:00–02:10 | 10m | Review finds PDF headers misclassified and voucher party names not reaching picker; fixes underway. L889. |
| 02:10–02:20 | 10m | Connected Create candidate pushed; final checks and proof planning. L1052, L1230. |
| 02:20–02:30 | 10m | Both remote typechecks and independent review reported; #1020 merged 02:22:59 while Apex remained running. Reset follow-up merged at 02:29:29. L1336–1444. |
| 02:30–02:40 | 10m | Source reset and Amend merged; late Create review reports self-invalidating Quote replies, competing room previews and shared-guest leakage. L1695, L1812. |
| 02:40–02:50 | 10m | Follow-up fixes pushed; fresh native reads recover. L2015. |
| 02:50–03:00 | 10m | Fixes pass reported checks/review, merge and deploy; a final rate-response race requires follow-up. L2057–2305. |
| 03:40–03:50 | 10m | Source/draft/native fields reviewed, one Labtest Create Save authorized and returned confirmation. L3261, L3288. |
| 03:50–04:00 | 10m | Fresh readback reports first Create verified; this was the zero-price proof, not later positive-price proof. L3370, L3398. |
| 04:00–04:10 | 10m | Failed extraction found to need its own persisted manual-draft path; Amend proof and voucher-retention issue underway. L3434–3682. |
| 06:05–06:15 | 10m | Manual-entry work delegated; real retry fails again, diagnostic calls differ from worker failures; manual path passes focused checks. L6062–6378. |
| 06:15–06:25 | 10m | Connected manual-entry candidate reviewed and typechecked; stale cached edits identified as another blocker. L6520–6721. |
| 06:25–06:35 | 10m | Manual entry lands at 06:27:26; owner checkpoint at 06:30 reports deployment and unfinished positive-price proof. L6790–6939. |
| 06:35–06:45 | 10m | Failed voucher gains a staff-owned draft; coordinator says Undo/reset fixes deployed; native approval guard rejects form's room-level dates because it reads stay-level dates. L7098–7177. |
| 06:45–06:55 | 10m | Date-guard fix #1040 merges at 06:48:23; deployment and fresh verification. L7214–7317. |
| 06:55–07:05 | 10m | Corrected release ready; fresh native rate R2,280 and 23 saved staff edits checked; Prepare in progress. L7374–7617. |
| 07:05–07:20 | 15m | Prepare passes; one Labtest Create Save; positive-price fresh readback completes at 07:17. L7637–7838. |

03:00–03:40, 04:10–06:05 and after 07:20 contain separate prefill/proof/other-work tasks; excluded from this UI retro. No inference of idle time.

### Create/Quote worker: observed task switches

These windows overlap the coordinator's table. Time outside the windows is not automatically idle: the worker was reassigned between tasks, and the coordinator table tracks the larger delivery. Source: [Create/Quote worker transcript](/home/orca/.codex/sessions/2026/11/05/rollout-2026-11-05T01-47-58-01a1a964-30ee-7e90-852d-9b8bf28177e2.jsonl). Line numbers below point into that file.

| UTC window | Duration | Observed work / check / handoff |
|---|---:|---|
| 01:47:58–02:00 | ~12m | **W1/W2/W6/W10:** candidate inspection, partial Create, history cursor, guest selection; adapts existing expectation. L105–878. |
| 02:00–02:10 | 10m | **W1/W6/W8/W10:** pane fixture, rate/extraction integration, room receipts, voucher party picker. L878–1455. |
| 02:10–02:20 | 10m | **W1/W2:** candidate handoff 02:10:31; type errors, draft PR, separate Create reset fix. L1596–2143. |
| 02:20–02:30 | 10m | **W1/W2:** Create merges; reset review/typechecks; DB-backed reset case skipped. Also reviews Cancel. L2323–2635. |
| 02:30–02:40 | 10m | **W2/W3:** Reset merged; late review finds rate/room preview/Reset issues; cursor repairs. Also reviews triage. L2745–3233. |
| 02:40–02:50 | 10m | **W2/W3/W11:** checks; **six history-control cases pass at 02:44**, including limited Undo assertion; separate rate-restore baseline comparison; #1025. L3391–3754. |
| 02:50–03:00 | 10m | **W3/W11:** #1025 checked/merged; rate-reply cursor follow-up #1027. Also handles triage. L3830–4264. |
| 03:40–03:53 | 13m | Reviews actual source, guest, cursor and grant bindings; observes Save/readback; clarifies that Booked state was inferred from code without opening pane. L6335–6751. |
| 03:53–04:00 | 7m | Worker reports handoff; no further worker message before manual-admission assignment at 04:00. Activity during the gap is not established. L6751–6764. |
| 04:00–04:11 | 11m | **W6:** failed/pending extraction needs separate manual-entry authority. Also reviews Filing receipt. L6764–7332. |
| 05:36–05:50 | 14m | **W6:** diagnoses failed-read manual start; estimates 90–180m for assessed scope. Also reviews retry. L9328–9814. |
| 05:50–06:05 | 15m | Reviews revised retry and source digest; final review reports no concrete P0/P1. Manual-start implementation assigned at 06:05. L9814–9866. |
| 06:05–06:16 | 11m | **W6/W11:** manual-start implementation; staff-owned source, Create guards, 28 server + 81 mail checks; candidate committed. L9866–10669. |
| 06:16–06:28 | 12m | **W6/W11:** review fixes, remote checks; #1039 merges 06:27:26; deployed proof pending. L11031–11390. |
| 06:28–06:34 | 6m | Reports merged change and pending deployed proof; automated review has not returned. L11390–11550. |
| 06:34–06:48 | 14m | Diagnoses guest/booker email role issue, then room-date approval guard; #1040 review/typecheck. It merges at 06:48:23, just after this window. Mounted-route fixture failures were compared against baseline. L11562–12051. |
| 06:48–07:00 | 12m | Date guard merged; at 06:54 worker starts existing source-loader mock repair; 65 preview/commit cases pass, with no product code change. L12051–12150. |

## 7. Timing conclusions

The original UI worker's task-to-handoff was **88m29s**; the often repeated **92.8m** starts at chat creation, 4m16s before its task arrived. The overnight Create candidate report took **22m33s**, and its first connected PR merged after **35m01s**; these are candidate/merge times, not complete UI-overhaul times. The final overnight report arrived about **6h24m** after the owner's checkpoint instruction, and left actual pane acceptance pending. Therefore the real completion time for the promised UI overhaul is **unknown**.

Failed-read manual Create: at 05:38 worker estimated **90–180m plus checks/review** for the assessed authority work. Implementation assignment → #1039 merge = **22m20s**; assignment → positive-price Create readback = **71m56s**, including deployment, date-guard fix and parallel proof. These boundaries differ from the estimate's scope; the contrast does not prove equivalent scope or exclusive effort. [Estimate](/home/orca/.codex/sessions/2026/11/05/rollout-2026-11-05T01-47-58-01a1a964-30ee-7e90-852d-9b8bf28177e2.jsonl:9504), [start](/home/orca/.codex/sessions/2026/11/05/rollout-2026-11-05T01-47-58-01a1a964-30ee-7e90-852d-9b8bf28177e2.jsonl:9866), [readback](/home/orca/.codex/sessions/2026/11/05/rollout-2026-11-05T01-12-38-01a1a943-d9d0-7e11-b9c7-2659e9af7287.jsonl:7838).

Original candidate and overnight code share patches. The first report gives bounded LOC and PR counts; those should not be summed as independent work. Multiple later native-proof and follow-up intervals overlap Create worker activity and cover more than UI; their elapsed time is informative about delivery dependencies, not exclusively UI coding.
