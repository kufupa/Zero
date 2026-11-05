# Evening plan retro: first 125 minutes

**Frozen window:** 2026-11-03 20:34:25–22:39:25 UTC. This is a historical snapshot, not the current state of the still-running implementation session. No later events are included.

**Verdict:** The run deployed code, but did not deliver the agreed staff-ready M1 within 125 minutes. The strongest avoidable problems were poor use of available workers, a long unexplained worker-message delay, a new cutover wrapper, and discovering an environment conflict late. Reviews and typechecking also found real defects, so not all elapsed time was ceremony.

The requested M1 was Quote, existing-profile Create, supported PDF Filing, and selected-email prefill/staff edits. Amend, Cancel and automatic New Profile creation were excluded. The operating target was 120 minutes within a requested 100–125-minute budget; it was not a measured guarantee.

## State at the cutoff

| Area | Evidence by 22:39:25 UTC |
|---|---|
| Deploy | Main SHA `593d054174c4085fcbd1f4d553a3908e2b65ce57` was deployed; health and readiness passed. |
| Quote | One direct real-email job finished with `resultStatus=ready`, four options and a positive total. A `TRANSIENT_NETWORK` marker persisted; its significance was not established. This was not proof of an Outlook interaction. |
| Create | Labtest-only; required dispatch was not yet enabled. No completed fake Create proof was recorded for this release. |
| Filing | Off; no completed fake Filing upload/readback was recorded for this release. |
| Prefill | A targeted pre-deploy pane preview showed selected-email fields. Final Outlook/webmail interactions were not demonstrated. |

Sources: [deployment log](/home/orca/.codex/m1-20261103-203425/deploy-593d0541.log), [deployed runtime audit](/home/orca/.codex/m1-20261103-203425/runtime-audit-deployed-593d0541.json), [direct Quote result at 22:39:13](/home/orca/.codex/sessions/2026/11/03/rollout-2026-11-03T19-14-00-01a1a2d1-3444-7143-bdf7-b059f1a6c262_01a1a2d5-254f-7730-b0f6-e73fe29ffd50.jsonl:2725).

## Where the 125 minutes went

These are consecutive wall-clock periods, not exclusive activities. Tasks and workers within each period overlapped.

| UTC | Duration | Main activities and result |
|---|---:|---|
| 20:34:25–20:53:55 | 19m30s | Established ownership, isolated three workers, inspected production configuration, and extracted the connected Filing candidate. Filing was reported ready at 20:53:55. |
| 20:53:55–21:30:45 | 36m50s | Pane candidate appeared at 20:58. Reviews identified gaps; release support diagnosed the Labtest bootstrap deadlock and built a cutover helper. Selected-email/PDF preparation ran alongside. Filing's transcript had a nearly 16-minute gap. Bootstrap PR #993 landed around 21:30. |
| 21:30:45–22:01:17 | 30m32s | Pane and Filing went through further fix/review cycles. A comment-only marker fix #994 landed around 21:42, pane #992 around 21:55, and Filing #991 around 22:01. All three workers were between tasks for almost nine minutes in this period. |
| 22:01:17–22:11:05 | 9m48s | Integrated typechecks found two compiler errors. PR #995 fixed them; #996 preserved uncertain Filing evidence and corrected test isolation. |
| 22:11:05–22:25:40 | 14m35s | Final checks found an existing stale Filing fixture. PR #997 corrected it, and the affected check was rerun. The fixture commit is timestamped 22:22:23; its merge-gate fast-forward was recorded at 22:23:11. |
| 22:25:40–22:31:10 | 5m30s | Approved bundle deploy completed. During deployment, stage-one flag preflight failed on an unrelated environment mismatch and changed no flags. |
| 22:31:10–22:39:25 | 8m15s | Runtime SHA/health were checked; the environment mismatch was investigated; one direct real-email Quote job returned a result. Create/Filing enablement and native proofs remained outstanding. |

The plan budgeted a shipping head at **T+65** and deployment at **T+65–90**. The last product fix was around **T+97**; the final test-only commit was around **T+108**; deploy started at **T+111**. The deployment itself was not the long part.

## What each lane actually did

| Lane | Work completed or attempted | Assessment |
|---|---|---|
| Coordinator | Set up release ownership, inspected diffs, launched reviews, selected a Quote email and PDF, ran checks, merged and deployed. | Necessary coordination, but it concentrated review work on one agent and left available workers unassigned. |
| Pane/prefill | Fixed invalidation when staff change a request, paused stale asynchronous Quote/booking work during rereads, and made missing-profile guidance reachable. Initial candidate ~20:57; #992 landed ~21:55. | Real product and write-safety gaps. Several successive reviews found additional paths, so the first candidate was not release-ready. |
| Filing | Extracted approval → target-bound upload → Documents readback, then fixed real-guest read admission, stay-specific session forwarding, writer recovery and an initial-only name lookup. Initial candidate ~20:53; #991 landed ~22:01; follow-up #996 ~22:11. | The exact-target and recovery work mattered. The narrow name-initial case was a plausible deferral if a safe manual fallback and the selected pilot case permitted it. |
| Release support | Checked deployed SHA and flags, found the Labtest proof/flag chicken-and-egg, corrected it in #993, reviewed Filing and prepared a 371-line private cutover helper. | The bootstrap fix was needed. The new wrapper was against the plan and its real preflight came too late. |
| Checks and deploy | Ran existing focused checks and remote typechecks, corrected one old fixture and one comment-marker failure, deployed and ran a flag preflight. | Typechecks found real build errors. The fixture and marker work were process overhead, although the fixture could not simply be reported as passing. |

The source diff from initial main `dc26b386` to deployed `593d054`, limited to the apps, contained approximately **367 added / 131 removed non-test lines** and **49 added / 25 removed lines in existing test files**. These counts do not measure effort or quality. No new test cases were identified.

## Specific avoidable work and delays

### 1. Workers went unassigned while reviews remained

The release worker finished a review at **21:37:59** and did not receive another task until **21:55:01**. The pane worker was between tasks from **21:43:00–21:55:12**; Filing was between tasks from **21:46:02–21:54:57**. Thus all three were between tasks for approximately **8m55s**.

The coordinator received Filing's revised candidate at 21:46, continued recorded reasoning, then spent **3m20s compacting** before dispatching the next reviews around 21:55. A bot review was running for part of this period. This is a clear missed opportunity to overlap work, not proof that the whole nine minutes would have been saved.

Evidence: [coordinator receives Filing result](/home/orca/.codex/sessions/2026/11/03/rollout-2026-11-03T20-28-50-01a1a319-a8cb-7e80-8700-4aceefa98931.jsonl:2031), [compaction](/home/orca/.codex/sessions/2026/11/03/rollout-2026-11-03T20-28-50-01a1a319-a8cb-7e80-8700-4aceefa98931.jsonl:2089), [next assignments](/home/orca/.codex/sessions/2026/11/03/rollout-2026-11-03T20-28-50-01a1a319-a8cb-7e80-8700-4aceefa98931.jsonl:2101).

### 2. Filing worker: nearly 16 minutes without recorded events

The Filing transcript has no events between **21:08:04 and 21:23:51**. Coordinator messages sent at **21:09** and **21:12** were recorded by that worker only at 21:23. Filing review results existed around 21:10, but the worker began addressing its own fixes around 21:25 after a requested cross-review.

The message bodies are encrypted, and the log does not establish whether the gap was scheduling, model execution, recording, or another cause. Do not call all 16 minutes idle or add them directly to the release delay: pane and release work continued concurrently. [Filing gap](/home/orca/.codex/sessions/2026/11/03/rollout-2026-11-03T20-34-58-01a1a31f-488f-7f91-9db3-cce0ec5b0768.jsonl:1402)

### 3. A new one-off cutover wrapper

Release support began a private cutover helper at **21:17** and reported it ready at **21:31**. It was **371 lines** by 21:43 and included staging, writer invocation, comparisons and restart handling. The canonical plan explicitly said **“No new wrapper.”** It continued to use the existing writers and deploy path, so it was not a replacement deployment system, but it was still a new wrapper contrary to that instruction.

Protecting unrelated environment settings was necessary; there is no evidence that this amount of custom code was necessary. Its construction overlapped other work, so its 14 minutes cannot be treated as 14 minutes added to the deadline. The coordinator later reviewed the helper while workers were unassigned. [Plan](/home/ubuntu/projects/zero/docs/plans/2026-11-03-003-feat-pilot-independent-release-plan.md:182) · [helper preparation](/home/orca/.codex/sessions/2026/11/03/rollout-2026-11-03T20-35-16-01a1a31f-8d4d-7172-ab08-5604ce3b40be.jsonl:1979) · [371-line count](/home/orca/.codex/sessions/2026/11/03/rollout-2026-11-03T20-28-50-01a1a319-a8cb-7e80-8700-4aceefa98931.jsonl:2003)

### 4. The environment conflict was visible early

At **20:47**, the runtime audit recorded `PARTY_MATCH_V2=true` in the durable environment but absent from the remote overlay. The existing writer would add that flag when rendering the overlay, and its guard required a canary for the resulting on-flip. The **22:29** stage-one preflight encountered exactly that conflict and refused without changing live flags.

The final-SHA canary itself could not be supplied before the final deployment. But the mismatch and the writer's proposed unrelated change could have been identified earlier through a bounded comparison. This was a missed preflight, not a reason to fabricate a canary or switch on an unrelated feature. [20:47 audit](/home/orca/.codex/m1-20261103-203425/runtime-audit-before.json) · [22:29 refusal](/home/orca/.codex/m1-20261103-203425/stage1-check-593d0541.log)

### 5. Existing tests and review generated avoidable work

- **Fixture:** At 22:15, the server suite reported 130 passed and one existing fixture failed. The fixture omitted saved-stay identity; the guard correctly treated it as unresolved. Diagnosis, fixture-only PR #997 and rerun reached green around 22:25: roughly **10 minutes**. Some preparation overlapped. A transparently dispositioned known fixture failure might have allowed an earlier deploy if the release policy permitted it; do not call a skipped failure a pass.
- **Comment marker:** PR #994 restored a shell comment that an existing test searched for. It had no runtime behavior change. It took roughly 21:36–21:42 to prepare/review/merge, overlapping product work. Keeping the original comment in #993 would have avoided the separate fix.
- **Repeated typecheck:** Server typecheck passed on `61f6e68c`, then ran again for 42 seconds on `593d054` after only a test fixture changed. The server `tsconfig.json` excludes tests; relevant source and configuration were unchanged. The checks overlapped other work, so 42 seconds of additional wall time is not established. [Earlier check](/home/orca/.codex/m1-20261103-203425/typecheck-server-pilot-61f6e68c.log) · [repeat](/home/orca/.codex/m1-20261103-203425/typecheck-server-pilot-593d0541.log)
- The run wrote **no new test cases** but did modify existing fixtures/assertions. The submitted goal said “zero new tests” and required applicable existing checks. That is the distinction the run followed, and it was introduced by the plan/prompt author.
- There were at least 13 non-empty Apex review-result artifacts by cutoff across changed heads and follow-up PRs. Some reviews found material defects. Their count alone does not prove each was redundant or quantify the wall time they cost.

### 6. Compiler problems were discovered late

The first integrated typechecks started around **22:01** and found two compiler errors. The failing lines trace to the earlier Create work merged before kickoff; one affected server file was unchanged by this run before the fix. No early baseline typecheck was run, so the record does not prove both errors would have failed on that earlier head. A background baseline check was a credible way to find problems sooner while the lanes continued. [Compiler errors](/home/orca/.codex/m1-20261103-203425/typecheck-mail-cf0d74be.log)

The plan discouraged an intermediate-main check to avoid duplicate work. That saved potential repeated checking but traded away early diagnosis. Keep the final relevant check; consider an early diagnostic when inherited main has not been shown to compile.

### 7. Narrow lookup and selected-email work

- **“J Smith” lookup:** A Filing lookup rejected an initial-only first name. Review labelled it P1, and a small fix was added near the end of the Filing cycle. This appears to affect a narrow set of names, rather than causing a wrong write. Deferring it was worth considering if the pilot case did not need it and staff had a clear, safe manual path. A separate recovery-safety fix was in progress at the same time, so the name fix cannot be assigned the whole delay.
- **Pane browser preview:** The pane worker loaded one direct selected-thread preview from **20:58–21:09**, including a Chromium configuration fix. It showed prefilled fields; seven writes were blocked. The runner exited 2 because of its stale unclassified-read list. This was not an admin-clicking campaign, but loading the pane was at odds with the owner's speed preference for direct output. It ran in parallel; a release delay is unproven. [Pane preview](/home/orca/.codex/sessions/2026/11/03/rollout-2026-11-03T20-35-06-01a1a31f-6859-7480-b786-4a22474b645f.jsonl:2097)
- **PDF selection:** At 21:08 the coordinator asked the owner for a technical thread/message identifier. The owner did not understand the question at 21:22; the coordinator selected a PDF from the existing queue by 21:25. It should have made that bounded choice itself. Other work continued, so the elapsed question time is not established as release delay.
- **Model false alarm:** Around 20:47 release support flagged a possible dormant Nova Lite setting; by 20:56 it confirmed the active M1 route used Luna. This was parallel investigation, with no demonstrated impact on the critical path.

### 8. Instruction refresh and communications

The documentation cleanup requested in the other chat caused updated workspace guidance to reach the executing session at about **20:43**. The coordinator reported that the workers were interrupted and resumed around **20:47**. The later documentation commit was not a product change. The record does not establish how much the interruption affected the final deadline. [Coordinator update](/home/orca/.codex/sessions/2026/11/03/rollout-2026-11-03T20-28-50-01a1a319-a8cb-7e80-8700-4aceefa98931.jsonl:513)

The coordinator made 57 `send_message` calls and 35 `followup_task` calls by the cutoff. Their encrypted bodies do not establish that they were repetitive prompts, and counts alone do not prove delay. The observed late delivery and unassigned-worker windows are stronger evidence.

## What was necessary

- Staff-request changes needed to invalidate prior results and approvals; otherwise staff could approve stale details.
- Filing needed exact selected source and native guest/stay binding, and recovery needed to avoid treating an uncertain or still-running write as safely complete.
- The two compiler errors needed correction for a buildable release.
- Preserving unrelated flags mattered. The preflight refusal prevented the overlay writer from enabling another feature without its required evidence.
- One bounded fake Create and one bounded fake Filing upload with fresh native readback are meaningful checks of the installed write paths. An extended fixture campaign, admin navigation or repeated equivalent probes were not demonstrated as necessary.

The first candidates were produced quickly, but they were not ready to ship: reviews found real defects including real-guest Documents reads still blocked and stale pane preparation. Conversely, a failing stale fixture and a comment marker had no direct staff value. Both facts matter when assessing the elapsed time.

## Responsibility and changes for next time

The previous plan/prompt author accepted a 100–125-minute target with no comparable completed end-to-end milestone. The plan retained per-PR reviews, existing focused checks and a preference for one baseline bundle without enough allowance for review feedback, environment drift or compaction. It allowed earlier independent releases, but the run waited for the combined baseline. The evidence does not establish that Create could safely have shipped earlier.

For a future run:

1. Compare the real durable environment, remote overlay and writer's proposed changes immediately; start a baseline build diagnostic in parallel when inherited main is unproven.
2. Keep lane owners on their critical product fixes. When an agent has completed a task, promptly assign ready review or integration work; investigate missing heartbeats without retrying an uncertain native Save.
3. Use the existing deploy/environment paths and a small bounded comparison; do not construct a new one-off framework when the plan says no wrapper.
4. Reuse valid evidence for test-only changes, avoid comment-marker follow-up PRs, and explicitly disposition proven stale fixtures rather than silently calling them passed. Triage narrow availability defects by actual pilot impact.
5. Ship independently ready capabilities when their own release and safety prerequisites are proven, rather than waiting by default for the slowest lane.

At the cutoff, remaining M1 work included resolving the flag-render conflict, enabling the Labtest controls, proving one fake Create and one fake Filing on the final release, widening the proven staff capabilities, and checking staff-visible behavior. The time required was not established by this snapshot.

## Evidence and limits

Primary evidence: the [submitted M1 goal](/home/orca/.codex/attachments/bd84607d-f3fe-4dc1-9546-b61ad0629092/pasted-text-1.txt), [coordinator transcript](/home/orca/.codex/sessions/2026/11/03/rollout-2026-11-03T20-28-50-01a1a319-a8cb-7e80-8700-4aceefa98931.jsonl), [Filing transcript](/home/orca/.codex/sessions/2026/11/03/rollout-2026-11-03T20-34-58-01a1a31f-488f-7f91-9db3-cce0ec5b0768.jsonl), [pane transcript](/home/orca/.codex/sessions/2026/11/03/rollout-2026-11-03T20-35-06-01a1a31f-6859-7480-b786-4a22474b645f.jsonl), [release transcript](/home/orca/.codex/sessions/2026/11/03/rollout-2026-11-03T20-35-16-01a1a31f-8d4d-7172-ab08-5604ce3b40be.jsonl), and pre-cutoff receipts in `/home/orca/.codex/m1-20261103-203425/`.

Transcript events were bounded at 22:39:25 UTC; the Git comparison was fixed to `dc26b386` → `593d054`. Timestamps and observed outcomes are strongly supported. The cause of the Filing silence, the contents of encrypted messages, hypothetical earlier release times, and any outcome after the cutoff are not established.
