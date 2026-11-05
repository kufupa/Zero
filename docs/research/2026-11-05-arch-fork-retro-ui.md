# Arch fork retrospective: UI, first manual audit

**Verdict: the owner requested a UI overhaul; the agent promised a redesign, but the extent it understood is uncertain and the overhaul was not demonstrated. Substantial connections and controls shipped. Old overlapping draft structures survived, Undo/Redo remained visibly broken, and backend proof was stronger than proof of staff interaction.**

**Deeper causal analysis and 5–20-minute timing:** [UI failure and timing investigation](/home/ubuntu/projects/zero/docs/research/2026-11-05-arch-fork-retro-ui-deep-timing.md). Important attribution: the reducer defect was already present at the starting commit; the overnight work left it unresolved rather than introducing it.

Audit date: 5 November 2026. Owner requested UI first, then discussion before extending this audit to every work unit. No product edits, merges, deployments or native writes were performed for this audit. One independent reader checked PR/code evidence; the instruction, plan and Undo analysis were traced manually by the primary agent.

### Reviewer TL;DR

- **Scope:** UI only; other overnight outcomes await their own retros.
- **Intent:** owner requested an overhaul across workflows around native tools, with human edits and visible Undo/Redo. The owner later clarified in this retro that they expected the entire UI to be overhauled and rewritten. The original wording included both “wipe” and reuse/“not … from scratch,” leaving how much UI code/layout to replace open to interpretation. The agent promised redesign, but repeating architectural ideas does not prove it understood the required extent.
- **Failure:** packets narrowed Undo to cursor handling and Create to selected field fixes. Changes shipped, but complete recomposition was not demonstrated. A pre-existing reducer retains displayed edited values on history restore; a deployed-code reducer diagnostic shows expected 2→1→2 displayed as 3→3→3. Owner separately reported broken Undo. Full browser/server reproduction remains unverified.
- **Verification:** existing tests and reviews ran; Undo test checked mutation + refetch, not displayed restoration. Backend native proof did not prove staff-pane usability. The overall definition of done *did* require staff-pane use; the defect is also failure to enforce/report that gate, not just absent plan wording. No new-tests rule did not prohibit existing checks.
- **Time:** original UI task→handoff 88m29s; overnight candidate 22m33s; connected PR merge 35m01s; first release/proof window 1h03m15s including three deploys and mixed work. Complete UI acceptance time unknown. Plan budgets described active lane work; observed boundaries are elapsed and overlapping.
- **Next run:** map each critical staff outcome to an owner and observable acceptance before splitting implementation; e.g. edit 1→2→3, then Undo→Undo→Redo displays 2→1→2. Enforce existing acceptance gates or label unverified. Use existing checks or an owner-authorized focused check where permitted. Native proof and UI interaction prove different things.
- **Planning metrics:** record task/acceptance boundary, initial estimate, candidate/merge/verified timestamps, actual lane/model, dependencies/rework and evidence. Capture token usage separately by model/worker where available; actual $ requires billing/rate context and shared work cannot always be attributed. LOC, test count, PR count and arbitrary five-minute slices do not measure usefulness.
- **Depth:** split each observed interval over 20 minutes into approximately 5–20-minute windows, including intervals shorter than one hour. Describe recorded activity, not just clock slices; mark gaps and overlap. Keep ambiguous evidence unknown. No basis to attribute this failure to model choice or to a particular number of wasted minutes.

## 1. What was asked, and where the meaning narrowed

| Time, UTC | Exact instruction or interpretation | Assessment |
|---|---|---|
| Nov 4, original design | “Existing component placement, native-tab layout and the old price grid do not define the new interface.” Native tools define supported decisions; staff tasks define order. | Explicitly permits full redesign and directs staff-oriented composition; “may be redesigned entirely” does not itself require replacing every UI component. |
| Nov 4, 22:16:58 | Sole UI worker: “Make an elegant, implementable 320–420px staff UI directly … redesign freely, grounded in actual Infor deterministic tool field coverage and staff order.” Maintain Undo/Redo, saved CMS recipients and staff edits. | Implementation brief retained the intent. It also directed a small connected Amend increment first. |
| Nov 5, 00:45:30 | Owner questioned the quoted 92.8-minute UI estimate: tools exist; connect schemas and human editing. | An estimate challenge, not cancellation of redesign. |
| 00:49:36 | Agent reduced remaining field/control work to 10–25 minutes and said no fresh 90-minute frontend build was needed. | It initially interpreted the estimate challenge too narrowly. |
| **00:50:43** | Owner: “We're not just wiring, though, right?” “take the current pieces, wipe them and wipe the old connections … keep the general design”; best solution for all workflows; “pretty stupid to build it from scratch.” | **Owner rejected a wiring-only interpretation.** How extensively to rewrite existing UI code/layout versus reuse pieces was not explicitly resolved; the owner now says the whole UI rewrite was intended. |
| 00:53:57–00:55:32 | Agent identified split editable intent across QuoteSession, per-form state and WorkItem. It recommended rebuilding form composition, retaining cards, controls and pickers. | Agent articulated an architectural risk and promised redesign. Its proposed component reuse may have been narrower than the owner's intended overhaul; agreement on that extent is not demonstrated. |
| 01:13:04 | Agent promised 3–5.5 hours “including UI redesign, deployment and native proof.” | Redesign remained in the advertised scope. This estimate later changed. |
| **01:47:08 execution plan** | Architecture: “Recompose explicit workflow forms around WorkItem effective projection … QuoteSession remains presentation/output compatibility, not a competing execution draft.” | Strong requirement survived in the architecture section. |
| Same plan, W2/W6 | W2 priced adopting the mutation's own cursor. W6 priced partial-form admission, valid per-room inputs, supported fields and live identity selections. | **The work packets reduced broad interaction correctness to narrower repairs.** They did not explicitly require removing duplicate editing authority or verifying displayed values after Undo. |
| 06:42:29 / 07:50:10 | Progress reports described Undo/reset fixes as deployed and the shared state as fixed. | Wider success claim than the checks supported. |
| 11:41:41–11:43:32 | Agent acknowledged incomplete recomposition and overstated UI readiness after the owner's complaint. | Consistent with this audit's independent code trace. An admission is corroboration, not the sole evidence. |

**Failure location:** scope was narrowed during interpretation and again between architecture and executable packets, then checks did not support progress claims. The owner did ask for an overhaul; the transcript does not resolve whether all participants shared the same meaning of “wipe,” “reuse,” or a whole-UI rewrite. A plausible reading narrowed the work too much; it is not proof of the worker's internal understanding.

Sources: [original design](/home/ubuntu/projects/zero/design_draft.md:172), [original plan](/home/ubuntu/projects/zero/docs/plans/2026-11-04-002-feat-nava-pane-prefill-rate-parity-plan.md:33), [original UI implementation brief](/home/orca/.codex/sessions/2026/11/04/rollout-2026-11-04T22-12-42-01a1a89f-1ea0-7223-bb28-92aa9e7429d7.jsonl:22), [owner correction](/home/orca/.codex/sessions/2026/11/04/rollout-2026-11-04T23-29-11-01a1a8e5-2227-7832-bb3a-7d9f79094087.jsonl:867), [acknowledgment](/home/orca/.codex/sessions/2026/11/04/rollout-2026-11-04T23-29-11-01a1a8e5-2227-7832-bb3a-7d9f79094087.jsonl:993), [execution plan](/home/ubuntu/projects/zero/docs/plans/2026-11-05-001-feat-centurion-core-completion-plan.md:100), [morning acknowledgment](/home/orca/.codex/sessions/2026/11/05/rollout-2026-11-05T11-34-56-01a1a943-d9d0-7e11-b9c7-2659e9af7287_01a1ab7d-95fd-7d52-846c-3a0f313b910c.jsonl:165).

## 2. Expected UI versus delivered UI

| Requirement | Expected outcome | Actual evidence / limit |
|---|---|---|
| Workflow composition | One coherent form per staff task, ordered around supported native decisions; required/missing/requested fields prominent. | Existing Quote steps, stay cards and later booking cards remain. Fields and contextual checks were added; complete consolidation was not demonstrated. |
| Draft authority | WorkItem's effective projection supplies current editable intent; local state holds unsaved text and outputs without defeating authoritative restoration. | Structural edits still update QuoteSession, record WorkItem events and write a remembered-edit cache. Create fields also have a separate request queue and local choices. Multiple representations alone are not a bug; their conflicting restoration behavior is. |
| Undo/Redo | Two edits → Undo restores the displayed prior value → another Undo restores the original → Redo restores the next value. Approval and price freshness follow that restored draft. | **Actual deployed reducer keeps the last edited value across all three restorations.** Detailed reproduction below. |
| Children and ages | A child count has an understandable relationship to required per-room ages. For multiple rooms, staff can allocate children explicitly. | “Children total” changes a stay total. The later Create card's separate “Children” control creates age inputs. The first control does not create them. Staff face overlapping occupancy concepts. |
| Supported Create fields | Guest profile, dates, each room/occupancy/ages, agency/company, native rate/price, source/Track/guarantee/note, Booker and CMS usable before Prepare. | Many controls and native bindings shipped. Partial successful reads gained form access; genuinely failed reads required another authority implementation much later. Source/room date integration still failed at first proof. |
| Native rates | Typed/searchable code and meaning, explicit choice, native price/status, stale-result handling. | Substantial control and reader work shipped. That is counterevidence against “nothing changed.” It does not establish complete cross-workflow recomposition or every staff interaction. |
| Review/Go/result | One visible workflow, reviewed values match native inputs, uncertainty and partial rooms retained. | Backend Prepare/Save/readback and receipt work was substantial. The agent explicitly reported it had not opened the pane to visually check the Booked state. |
| Both surfaces | Same feature in shared webmail and classic Outlook pane; actual loaded interaction checked separately from asset publication. | Both routes use NavaPane. The morning coordinator reported the same published release after checking the owner's URL. This audit did not independently inspect the owner's running WebView or browser. |

Code pinned to **`20e17dd0137e8791e76c06bd5fb16fdbd9cfbd20`**, the overnight closing runtime. The root checkout is behind that code and contains unrelated edits; it was used for untracked canonical plans, not as deployed-code evidence. The morning “arch fork” chat is now doing new work, which is excluded from overnight attribution.

Decisive files: [pane edit path](/home/ubuntu/projects/zero/.worktrees/core-question-list-final-deploy-20261105/apps/mail/components/nava-pane/nava-pane.tsx:897), [stay-total control](/home/ubuntu/projects/zero/.worktrees/core-question-list-final-deploy-20261105/apps/mail/components/quote-workflow/requirement-card.tsx:292), [Create children/ages](/home/ubuntu/projects/zero/.worktrees/core-question-list-final-deploy-20261105/apps/mail/components/quote-workflow/booking-card.tsx:2536), [effective per-room fields](/home/ubuntu/projects/zero/.worktrees/core-question-list-final-deploy-20261105/apps/server-pilot/src/ai/work-item-effective.ts:162).

### Children: what this proves about the native tool

The native Create tool does validate supplied child count against supplied ages and rejects invalid ages. However, the pane mapper derives `childCount` from the submitted ages array. That validates the native request's internal consistency; it does not automatically reconcile a separate stay-wide UI total. This audit does **not** establish that a wrong-child reservation was saved.

For one room, count and age requirements should be connected directly. For multiple rooms, a stay-wide count cannot silently guess room allocation; it needs an explicit allocation/correction path. The defect is the disconnected staff interaction, not the absence of every age check.

Sources: [native validation](/home/ubuntu/projects/zero/.worktrees/core-question-list-final-deploy-20261105/apps/server-pilot/tooling/hms-cloud/create-reservation.mjs:66), [mapper](/home/ubuntu/projects/zero/.worktrees/core-question-list-final-deploy-20261105/apps/server-pilot/src/ai/pane-create-cloud-input.ts:138).

## 3. Undo/Redo: complete causal trace

1. Staff stay edits call `editStayRows`: update QuoteSession → record the before/after groups to WorkItem → remember groups in the pane cache.
2. Undo flushes edits, calls the guarded server mutation and adopts its returned cursor. This was the overnight repair's main focus.
3. `refetchStored` retrieves the restored server projection and increments `historyEpoch`.
4. The pane clears remembered edits/contact corrections, but keeps the current QuoteSession.
5. It feeds the restored projection into the ordinary `analysis_started` / `analysis_ready` path.
6. That reducer intentionally preserves staff-edited groups during rereads. It does not distinguish acknowledged history restoration from a late extraction result.
7. Result: **server history can restore the correct value while the pane continues showing its old value.**

Executed the actual reducer from pinned deployed code using an existing throwaway diagnostic. No DB, HMS call or repository change:

| Operation after quantity edits 1 → 2 → 3 | Restored input quantity | Pane quantity |
|---|---:|---:|
| First Undo | 2 | **3** |
| Second Undo | 1 | **3** |
| Redo | 2 | **3** |
| Fresh initial session with original input | 1 | **1** |

Command: `env -u DATABASE_URL -u VITEST_ALLOW_PILOT_RDS -u TEST_DATABASE_URL /home/ubuntu/projects/zero/node_modules/.bin/tsx --tsconfig /home/ubuntu/projects/zero/.worktrees/core-question-list-final-deploy-20261105/apps/mail/tsconfig.json /tmp/zero-undo-readonly.ts`.

**Scope of reproduction:** real reducer behavior with supplied restored values. It is not a fresh end-to-end server/browser test. The user's observation and the morning investigator's separate reproduction match it. Ordinary restored rows were not shown to be automatically written back; that stronger failure is not claimed.

An additional path uses an override gate without history in its key, so history reconciliation may not run while TreatAs/staff-note overrides are active. That is a separate source-level concern, not needed to explain the reproduced reducer failure.

What should have been implemented: an explicit authoritative history-restoration transition which adopts restored business fields and invalidates downstream approval/output, while retaining protections against late extraction. This is a focused state transition; rewriting the entire reducer was not necessary.

Sources: [edit path](/home/ubuntu/projects/zero/.worktrees/core-question-list-final-deploy-20261105/apps/mail/components/nava-pane/nava-pane.tsx:898), [Undo mutation/refetch](/home/ubuntu/projects/zero/.worktrees/core-question-list-final-deploy-20261105/apps/mail/lib/quote-workflow/use-work-item.ts:1177), [refetch](/home/ubuntu/projects/zero/.worktrees/core-question-list-final-deploy-20261105/apps/mail/lib/quote-workflow/use-work-item.ts:1016), [history cache clearing](/home/ubuntu/projects/zero/.worktrees/core-question-list-final-deploy-20261105/apps/mail/components/nava-pane/nava-pane.tsx:756), [analysis apply](/home/ubuntu/projects/zero/.worktrees/core-question-list-final-deploy-20261105/apps/mail/components/nava-pane/nava-pane.tsx:910), [retaining edited groups](/home/ubuntu/projects/zero/.worktrees/core-question-list-final-deploy-20261105/apps/mail/lib/quote-workflow/session.ts:1754), [morning diagnostic](/home/orca/.codex/sessions/2026/11/05/rollout-2026-11-05T11-38-30-01a1ab80-d70a-7722-aae0-72192e320344.jsonl:202).

## 4. Testing happened; its assertions missed the outcome

**“No new tests” did not mean “run no tests.”** The final plan explicitly required existing focused checks. The agent ran them, remote typechecks and reviews. It also changed existing test fixtures/cases. A full audit of every revised assertion remains outside this first UI pass.

| Evidence | What it established | What it did not establish |
|---|---|---|
| Existing Undo UI case | Clicking Undo calls `undoRevision` with expected sequence, then refetches. Other cases hold editors during refresh and handle refresh failure. | **Displayed values after Undo, repeated Undo and Redo.** |
| Existing stay-total UI case | Totals issue a stay-scoped action; zero differs from unknown; no per-row patch is called. | Child-total-to-age interaction. In fact, this test encodes the separate-total behavior. |
| Expanded existing WorkItem hook case in #1020 | Own mutation cursor, stale external edits, reload and source-change protections. | Complete mounted pane + QuoteSession restoration. |
| Create worker, 02:01 / 02:10 | Focused pane/booking/party/freshness checks reported passing. | Staff accepted the redesigned workflow. |
| Reset, 02:29 | Both remote app typechecks reported passing; DB-backed reset test explicitly skipped. | Full backend reset history against a DB or actual visible Undo. |
| Create follow-up, 02:42 | 152 focused booking cases reported passing; a cross-app fixture initially could not start. | All connected staff paths were covered. |
| Filing retention, 04:22 | 76 mail and 44 server checks reported passing. | UI recomposition across all workflows. |
| Manual failed-read Create, 06:11 | 28 server and 81 mail checks reported passing. | Fresh manual Create proof was still pending. |
| Fixture repair #1041 | 65 existing preview/commit checks passed after mocks were repaired. Product code unchanged. | New independent evidence for the missing Undo assertion. |
| Backend native proof | Reviewed submitted fields matched HMS Prepare/Save/readback for the exercised paths. | The staff could enter those values, undo them and reach Go through the pane. |

Counts above are **individual reported runs**, with overlapping suites. Do not sum them as unique tests. This audit independently verified source assertions and the reducer failure; it did not rerun the whole historical check inventory.

At 03:52:45 the Create worker explicitly said: “The returned confirmation maps to the UI’s Booked state in code; I have not opened the pane for a visual check.” The closing report also left actual staff-pane acceptance pending. Those disclosures limit the claim; they do not support calling Undo or recomposition complete.

Sources: [Undo assertions](/home/ubuntu/projects/zero/.worktrees/core-question-list-final-deploy-20261105/apps/mail/tests/nava-pane-work-item-controls.test.tsx:432), [stay-total assertions](/home/ubuntu/projects/zero/.worktrees/core-question-list-final-deploy-20261105/apps/mail/tests/requirement-card.test.tsx:79), [expanded hook case](https://github.com/kufupa/Zero/commit/3a66a9167cf46e63442d3de1e74ec6c0b078d51f), [worker check/visual disclosures](/home/orca/.codex/sessions/2026/11/05/rollout-2026-11-05T01-47-58-01a1a964-30ee-7e90-852d-9b8bf28177e2.jsonl:6689), [closing limits](/home/ubuntu/projects/zero/docs/plans/2026-11-05-001-feat-centurion-core-completion-plan.md:239).

## 5. Time: separate candidate, integration, proof and unfinished UI

All timestamps UTC. Intervals are elapsed wall time, including tools/checks/waits. They are not CPU time or exclusive coding effort.

| Work boundary | Start → end | Elapsed | Meaning |
|---|---|---:|---|
| Original sole UI task → handoff | Nov 4 22:16:58.567 → 23:45:27.074 | **88m29s** | 22 commits; source, forms, rates, edits and guards. |
| Same chat creation → handoff | 22:12:42 → 23:45:27 | **~92m45s** | Source of the quoted “92.8m.” Includes ~4m16s before the actual task arrived. |
| First UI task → first commit | 22:16:58.567 → 22:21:33 | **4m34s** | First source/Amend candidate. Not full UI completion. |
| Create integration assignment → first draft PR status | 23:42:37.523 → 23:56:30.138 | **13m53s** | #1014 still had checks incomplete. |
| Integration assignment → owner pause | 23:42:37.523 → Nov 5 00:35:16.936 | **52m39s** | Repeated stale-cursor review fixes and merge conflict; candidate remained unmerged. |
| New plan discussion → execution-plan rewrite | 00:04:47.729 → 01:47:08.824 | **1h42m21s** | Research, user discussion, scope changes and review. Cannot label entire interval wasted or active coding. |
| Overnight Create worker start → candidate report | 01:47:58.177 → 02:10:31.531 | **22m33s** | Committed candidate and focused checks; much inherited UI retained. Corrected from 22m34s. |
| Worker start → #1020 merge | 01:47:58 → 02:22:59 | **35m01s** | Connected code landed; redesigned staff experience still unproved. |
| Reset/freshness follow-up window | 02:24:35.539 → #1027 merge 03:00:02 | **35m26s** | Cursor/reset/rate conflicts repaired; overlaps other work. |
| Assigned failed-read manual Create implementation → merge | 06:05:06.209 → 06:27:26 | **22m20s** | New staff-owned authority path; discovered need much earlier around 04:00. The intervening period included other engineering, not proven idle time. |
| Assigned room-date guard fix → merge | 06:43:27.104 → 06:48:23 | **4m56s** | Guard was reading stay dates while staff fields were persisted per room. |
| Overnight return/checkpoint instruction → closing report | 01:43:11.271 → 08:06:53.769 | **6h23m42s** | Closing engineering checkpoint; **UI overhaul still incomplete**. |
| Promised 06:30 checkpoint → closing report | 06:30 → 08:06:53.769 | **1h36m54s later** | A significant checkpoint, not full supported/UI completion. |

The final forecast was **~4–8 hours remaining**, with W6 40–70m, W2 10–20m and 35–90m rework reserve. The ~6h24 closing interval is inside that broad envelope; it is **not evidence the advertised scope finished within the estimate**. W6's complete interaction/recomposition acceptance was never demonstrated, so its actual completion time is unknown.

The later positive-price Create proof finished at **07:17:02**, about **5h34m after the checkpoint instruction**. Earlier Create proof at ~03:51 exercised a zero-price stay; positive-price requirements were repaired later. Neither backend proof establishes complete UI editing.

Original UI handoff explicitly said Create/Cancel still depended on backend contracts. “Candidate ready” was valid narrower progress. Treating that as already-paid complete redesign when estimating the next run was not established.

Sources: [original task](/home/orca/.codex/sessions/2026/11/04/rollout-2026-11-04T22-12-42-01a1a89f-1ea0-7223-bb28-92aa9e7429d7.jsonl:22), [handoff](/home/orca/.codex/sessions/2026/11/04/rollout-2026-11-04T22-12-42-01a1a89f-1ea0-7223-bb28-92aa9e7429d7.jsonl:6774), [integration/pause transcript](/home/orca/.codex/sessions/2026/11/04/rollout-2026-11-04T23-41-17-01a1a8f0-3758-79d2-96cc-a7f7981e22fd.jsonl:12), [overnight worker](/home/orca/.codex/sessions/2026/11/05/rollout-2026-11-05T01-47-58-01a1a964-30ee-7e90-852d-9b8bf28177e2.jsonl:9866), [positive-price readback](/home/orca/.codex/sessions/2026/11/05/rollout-2026-11-05T01-12-38-01a1a943-d9d0-7e11-b9c7-2659e9af7287.jsonl:7838).

## 6. Code and PR effort: substantial, with inherited work distinguished

| Scope | Files | Additions / deletions | Attribution |
|---|---:|---:|---|
| Original UI candidate, `9d388ab751` → `5cdbcbc19` | 30 | **+2,932 / −427** | 22 UI commits. Includes tests. |
| Its mail product files | 23 | +2,389 / −351 | Controls, source wiring, forms, hooks and guards. |
| Its existing test files | 7 | +543 / −76 | Existing suites changed; not all newly authored tests. |
| Overnight net mail product, `2e408c37` → `20e17dd` | 34 | **+2,211 / −426** | Includes inherited candidate code landing and follow-ups. Not fresh overnight LOC. |
| Overnight net test-related files, both apps | 20 | +297 / −101 | Suite/fixture edits; overlapping with earlier inherited work. |

Do **not** add candidate totals to overnight totals: inherited patches appear in both. The overnight Git range also contains a separate documentation cleanup with large deletions; those are not UI engineering effort.

| PR | Merge UTC | Concrete work | Whole PR + / − | Mail product + / − |
|---|---|---|---:|---:|
| [#1011](https://github.com/kufupa/Zero/pull/1011) | Nov 4 23:01:45 | Selected-message/Amend fields, source and execution | 1,442 / 153 | 614 / 102 |
| [#1012](https://github.com/kufupa/Zero/pull/1012) | 23:39:26 | Contextual Amend rate options | 1,344 / 46 | 294 / 5 |
| [#1013](https://github.com/kufupa/Zero/pull/1013) | Nov 5 00:18:19 | Selected voucher and reviewed Filing target | 886 / 156 | 238 / 66 |
| [#1016](https://github.com/kufupa/Zero/pull/1016) | 00:24:36 | Selected-request Cancel | 863 / 116 | 393 / 43 |
| [#1014](https://github.com/kufupa/Zero/pull/1014) | **Not merged** | Earlier Create/rate integration candidate; reused later | 2,646 / 401 | 1,565 / 266 |
| [#1020](https://github.com/kufupa/Zero/pull/1020) | 02:22:59 | Partial Create drafts, voucher prefill/party binding, selected rates, cursor fixes | **2,862 / 544** | **1,704 / 332** |
| [#1023](https://github.com/kufupa/Zero/pull/1023) | 02:29:29 | Source-backed Create request fields on Reset | 61 / 7 | 9 / 4 |
| [#1024](https://github.com/kufupa/Zero/pull/1024) | 02:32:18 | Preserve Amend edits/native details | 140 / 37 | 96 / 29 |
| [#1025](https://github.com/kufupa/Zero/pull/1025) | 02:52:01 | Shared Create preview/reset cursor handling | 159 / 97 | 116 / 68 |
| [#1027](https://github.com/kufupa/Zero/pull/1027) | 03:00:02 | Unchanged rate replies avoid false cursor conflict | 4 / 1 | 4 / 1 |
| [#1029](https://github.com/kufupa/Zero/pull/1029) | 03:25:50 | Preserve voucher CMS choices and review copy | 22 / 6 | 1 / 1 |
| [#1030](https://github.com/kufupa/Zero/pull/1030) | 03:32:33 | Stay-bound voucher confirmation choices | 45 / 12 | 0 / 0 |
| [#1031](https://github.com/kufupa/Zero/pull/1031) | 04:24:45 | Keep voucher review after booking reply | 295 / 27 | 87 / 1 |
| [#1039](https://github.com/kufupa/Zero/pull/1039) | 06:27:26 | Manual booking after failed extraction | 305 / 46 | 105 / 15 |
| [#1040](https://github.com/kufupa/Zero/pull/1040) | 06:48:23 | Guard selected room's saved dates | 10 / 2 | 0 / 0 |
| [#1041](https://github.com/kufupa/Zero/pull/1041) | 07:10:13 | Existing source-loader fixture repair | 8 / 8 | 0 / 0 |

PR file statistics are GitHub's final PR diffs, including server/tests in “whole PR.” They measure changed lines, not effort or originality. The table is the selected UI/HITL evidence set, not every overnight PR.

In #1020, `booking-card.tsx` alone changed **+688/−157**, `use-work-item.ts` **+304/−54**, and `contextual-rate-check.tsx` was added at **268 lines**. This was substantial implementation, rather than an agent simply declining to work on UI. The question is whether those changes met the full intent.

Review also happened. #1020's final Greptile check finished at **02:26:14**, **3m15s after merge**, and reported shared multi-room sequencing and an Amend rate-check caller issue. Independent review had preceded merge; follow-ups repaired cursor/rate paths. A successful check status did not mean “no findings.” This UI audit has not reconciled every review thread or established every finding's final disposition.

## 7. Why it failed: evidence versus hypotheses

| Explanation | Status | Supporting evidence / counterevidence |
|---|---|---|
| Owner wording omitted overhaul | **Rejected as to the goal; extent ambiguous** | Explicit 00:50 correction requests overhaul across workflows; “wipe” plus “not … from scratch”/reuse leaves exact code and layout replacement open. Owner now clarifies the expected whole-UI rewrite. |
| Agent fully understood the intended extent | **Unresolved** | It identified competing drafts and promised recomposition at 00:53–00:55, but proposed retaining cards/controls, then assigned narrow repair packets. A paraphrase alone does not prove shared understanding. |
| Work packets did not fully carry the architecture | **Supported** | W2 narrowed Undo to cursor adoption; W6 emphasized admission/fields. No displayed-restoration acceptance criterion. |
| Previous candidate was treated as sufficient redesign credit | **Supported concern** | Earlier candidate's 92.8m repeatedly cited as already-spent UI work. Candidate had backend dependencies; conflicting state behavior remained. |
| Correct local safety rule applied to the wrong event | **Confirmed** | “Preserve staff edits on reread” also applies to authoritative history restoration, reproducing wrong visible values. |
| Tests focused on calls/guards instead of staff outcome | **Confirmed for Undo** | Existing UI case checks mutation/refetch, not the restored display; reducer reproduction fails. |
| Native proof substituted for complete interaction proof | **Supported** | Code-to-Booked mapping and backend Save/readback claimed, with no pane visual check. Staff acceptance explicitly remained pending. |
| Checks/reviews consumed all time without useful results | **Rejected** | They found actual cursor, rate, source and date defects. Exact useful/wasted time split is unavailable. |
| Compaction erased the instruction | **Unresolved; not established** | Planning parent compacted twice; overnight coordinator eight times, seven before closeout; Create worker eleven times. The redesign was acknowledged immediately after a parent compaction. Counts alone do not prove lost intent. |
| Model selection caused the failure | **Unresolved** | Create worker used Terra xhigh; coordinator used Sol xhigh during overnight execution. No controlled comparison ties these models to the missing acceptance. |
| Web/Outlook served different designs | **Not the leading explanation** | Shared component code and reported same published release; exact live-client state not independently inspected here. The reproduced code defect does not require a deployment mismatch. |

**Strongest alternative interpretation:** “not … from scratch,” retain general design, reuse current pieces and the later checkpoint could be read as permission to preserve substantial existing UI. Those words do not establish that preserving existing layouts or skipping a full workflow rewrite met the owner's intent. The retro has not performed a full before/after visual comparison or proven exactly what every worker understood. The plan disclosed staff-PC/UI acceptance limits; those limits do not justify claiming visible Undo was fixed.

**What should have been expected:** a workflow recomposition with a clear edited-field authority and observable interaction acceptance. Minimum proof for the UI requirement would include an actual displayed edit → Undo → Undo → Redo sequence, one-room child count/age correction, and the full existing-profile Create path through the same pane components. Native proof remains separate. This is an acceptance gap, not a proposal for a new test framework or another broad research phase.

**Clearer future assignment, incorporating owner's clarification:** overhaul and rewrite the UI across every supported workflow; existing screens and connections are not the starting constraint. Reuse the general design language, generic primitives and backend where useful, but explicitly assess/rebuild each workflow's layout, controls and connections. For each workflow record what was replaced, retained and why, then verify visible staff actions and name any unverified result. This is a proposed interpretation for future work, not proof of what the old worker understood.

## 8. Full plan decomposed; broader audit remains pending

The UI is several connected pieces, not one generic “generator” task. Its data producers, human editing, native pricing, action authority and output consumers can fail independently.

The original November 4 programme had **58 patches across eight capability units**, plus delivery/recovery work. Its high-level units were U1 selected-email identity; U2 complete prefill/effective actions/durable edits; U3 contextual rates/history/recommendations; U4 full supported Amend; U5 Quote/Create; U6 Filing/Cancel; U7 saved nightly amount override; U8 native New Profile. P39 explicitly required common field hierarchy, actions, results, Undo/Redo and recipients across forms. P53–54 covered conditional held-operation recovery; P55–58 covered integration, checks, deployment, proof and cleanup. The November 5 replan below superseded that programme for this overnight execution; U7/U8 and unproved recovery were not silently treated as required core delivery.

| High-level piece | Nov 5 units | What the next retro must trace | Current audit state |
|---|---|---|---|
| UI composition and human editing | W1, W2, W3, W6, W10; UI portion of W9 | Form admission/order, source projection, edits/restoration, identities, late results | **First manual pass complete; partial delivery and Undo failure established** |
| Extraction and voucher prefill | W13; extraction part of W14 | Actual admitted text/pages → model proposals → sanitizer roles/provenance → effective fields | Source leads recovered; full delivery/accuracy/timing audit pending |
| Triage and remaining asks | W14 | Human/automated distinction, pre-stay rules, action/folder alignment, per-request completion | Pending |
| Native rate selection and pricing | W5; rate parts of W3/W6/W9 | Context/party IDs, chosen code/meaning, native price, freshness, failures and review fixes | UI connection sampled; complete native audit pending |
| Create, Quote and multi-room outputs | W6–W8, W10 | One-room Save, original source, positive price, batch receipts/recovery, PDF/Excel/cover and actual insertion | Proof receipts recovered; full audit pending |
| Amend, Cancel and Filing | W4, W9 | Complete business inputs, Prepare/Save/readback, penalty decisions, selected original PDF and completion | UI sampled; full workflow audit pending |
| Review, merge, deploy and readiness | W11, W12 | Final-head evidence, fallback reviews, merge/deploy time, loaded pane, effective flags, premature completion claims | Selected PRs/time sampled; full gate audit pending |

Deferred native profiles, numeric overrides, cashiering/refunds, groups/imports and image filing must be assessed against the **latest scope**, not incorrectly counted as missed overnight requirements. General manual Quote/missing-read coverage and fresh multi-room proof were disclosed incomplete at closeout; they still need intent-versus-delivery analysis.

## 9. Source inventory and evidence limits

### Transcripts

- [Earlier planning parent](/home/orca/.codex/sessions/2026/11/04/rollout-2026-11-04T23-29-11-01a1a8e5-2227-7832-bb3a-7d9f79094087.jsonl): owner scope correction and plan decisions.
- [Overnight execution](/home/orca/.codex/sessions/2026/11/05/rollout-2026-11-05T01-12-38-01a1a943-d9d0-7e11-b9c7-2659e9af7287.jsonl): 01:12 fork, final plan rewrite, overnight execution and morning closeout.
- [Current morning continuation](/home/orca/.codex/sessions/2026/11/05/rollout-2026-11-05T11-34-56-01a1a943-d9d0-7e11-b9c7-2659e9af7287_01a1ab7d-95fd-7d52-846c-3a0f313b910c.jsonl): owner's UI complaint and agent acknowledgment.
- [Original sole UI implementation](/home/orca/.codex/sessions/2026/11/04/rollout-2026-11-04T22-12-42-01a1a89f-1ea0-7223-bb28-92aa9e7429d7.jsonl): original brief, 22 commits and candidate handoff.
- [Earlier Create integration](/home/orca/.codex/sessions/2026/11/04/rollout-2026-11-04T23-41-17-01a1a8f0-3758-79d2-96cc-a7f7981e22fd.jsonl): #1014, checks, review repairs, conflict and pause.
- [Overnight Create/Quote worker](/home/orca/.codex/sessions/2026/11/05/rollout-2026-11-05T01-47-58-01a1a964-30ee-7e90-852d-9b8bf28177e2.jsonl): implementation/checks/native proof and later manual-source fixes.
- [Original design/prototype worker](/home/orca/.codex/sessions/2026/11/04/rollout-2026-11-04T15-27-45-01a1a72c-5f94-78c1-b529-9747686a0fef.jsonl): explicit redesign, retained controls, field/tool mapping.

The exact initial overnight collaboration-task payload is encrypted in the local rollout, so this pass does not quote it. The earlier sole-UI brief, owner instructions, execution-plan rewrite and worker actions are directly readable. No causal claim about precisely what wording the overnight worker received is made without that payload.

### Canonical Markdown and directly associated sources

| Artifact | Role / read status |
|---|---|
| [Nov 5 executed plan](/home/ubuntu/projects/zero/docs/plans/2026-11-05-001-feat-centurion-core-completion-plan.md) | Read architecture, units, verification, ETA and later checkpoint. Initial 01:47 rewrite recovered separately to distinguish intent from 08:04 status edits. |
| [Nov 4 parity plan](/home/ubuntu/projects/zero/docs/plans/2026-11-04-002-feat-nava-pane-prefill-rate-parity-plan.md) | Read full patch map and UI/delivery criteria. |
| [Design and S1–S12 agreement](/home/ubuntu/projects/zero/design_draft.md) | Read decisive UI, draft authority, fields, ownership and history requirements. |
| [Sole-UI research](/home/orca/orca/workspaces/zero/plan-ui-system-20261104/RESEARCH.md) | Read design/field/control inventory. Historical research is context, not later implementation authority. |
| [Prefill/rates research](/home/ubuntu/projects/zero/docs/research/2026-11-04-nava-pane-prefill-rates-research.md) | Read scope/evidence and design/ROI sections. |
| [Readiness review](/home/ubuntu/projects/zero/docs/research/2026-11-04-nava-plan-readiness-review.md) | Read decisions, test-policy history and measured comparators. |
| [Earlier four-hour retro](/home/ubuntu/projects/zero/docs/research/2026-11-04-big-fat-4-hour-chat-retro.md) | Read timing, PR and proof limits as context; earlier run is not this run. |
| [Core-workflow handoff](/home/ubuntu/projects/zero/docs/research/2026-11-04-why-core-workflows-still-unfinished-handoff.md) | Recovered/snapshotted; larger month/overnight audit to revisit in next pass. |
| [Nov 3 125–200m retro](/home/ubuntu/projects/zero/docs/research/2026-11-03-evening-plan-retro-125-to-200min.md), [task ledger](/home/ubuntu/projects/zero/docs/research/2026-11-03-option-a-deep-retro/TASK-LEDGER.md), [Halloween build retro](/home/ubuntu/projects/zero/docs/research/halloween/2026-10-31-hms-cloud-build-retro.md) | Direct estimate sources identified. Their underlying runs are not independently re-audited here. |
| [Native field audit](/home/ubuntu/projects/zero/docs/research/halloween/2026-11-01-hms-field-scope-audit.md), [source/tool research](/home/ubuntu/projects/zero/docs/research/halloween/memory-experiments/2026-10-30-source-cohort-and-cloud-tool-design.md), [corpus report](/home/ubuntu/projects/zero/docs/research/halloween/corpus-analysis/2026-11-02-centurion-corpus-run.md) | Associated requirement/frequency sources identified for broader passes. Historical frequency is not measured saved staff effort. |
| [U7 nightly research](/home/orca/orca/workspaces/zero/u7-native-nightly-20261104/RESEARCH.md), [U8 profile research](/home/orca/orca/workspaces/zero/u8-native-profile-20261104/RESEARCH.md) | Linked optional native tranches; outside this UI audit and latest core scope. |
| [PRODUCT.md](/home/ubuntu/projects/zero/PRODUCT.md), [AGENTS.md](/home/ubuntu/projects/zero/AGENTS.md) | Read current owner/product/verification guidance; transcript carries historical versions where policy changed. |

Canonical plan/design files are untracked in the root checkout; their captured modification times precede this audit. Source copies, hashes, PR metadata and the initial execution-plan write were preserved outside the repository at `/tmp/arch-fork-retro-20261105/`. Plans were not silently treated as immutable Git artifacts.

**95 evidence threshold:** met for explicit UI intent, partial implementation, the reproduced Undo reducer failure and the identified test gap. Exact coding-versus-waiting minutes, full native/UI coverage, live owner-client release state and compaction's causal role remain unresolved. Route: local transcripts/code/Git, GitHub read-only metadata and one independent PR reader. Audit model cost in dollars is unavailable; no price or billed-cost estimate is fabricated.
