# Retro: the “big fat 4-hour chat”

**Verdict:** The team shipped and enabled four HRCEN workflows, with substantial safety checks and four Labtest readbacks. The last recorded runtime check took **4h 28m**; the closing answer took **4h 30m**. The run missed its 3h 30m checkpoint by **58 minutes**, and its completion claim was broader than the evidence for actual Create and Cancel requests.

- **Scope:** The autonomous run beginning 4 November 2026 at 03:17 UTC, plus its setup and the relevant later follow-up. This is a historical assessment, not a claim about today's runtime.
- **What shipped:** Ten merged PRs; final deployed SHA [9d388ab751](https://github.com/kufupa/Zero/commit/9d388ab7510eb86d613d316b42fb42479cdc85b9); all four workflow flags reported on across four healthy processes.
- **Biggest missed detail:** The real Create and Cancel preparations used details from an **amendment email**, not actual pending Create and Cancel requests. The final real Amend example was **already applied**. Those are useful backend checks, but narrower than a demonstrated fresh request through the full staff workflow.
- **Biggest execution discovery:** The coordinator had a roughly **29-minute recorded decision gap** while three workers continued and sent it 87 messages. They appeared in a burst when it resumed. The cause is not established.
- **Research:** Main transcript, all 17 linked child-session records, original brief and deeper plan, state/proof logs, Git history and PR/review records. Guest names, email contents and secrets are omitted here.

---

## 1. What the plan actually asked for

The owner asked the coordinator to deepen the recovery plan, then work autonomously through implementation, review, merge, deployment, real-email unsaved preparation, Labtest Save/readback and workflow flags. The 210-minute point was a **checkpoint, not a stop**. The intended path was selected email or PDF → staff review and edits → native HMS Prepare and price/facts → staff Go → protected Save → fresh readback. [Goal][goal-start] · [launch brief][brief] · [deeper plan][plan]

| Workstream | Required result |
|---|---|
| **Create** | Existing HMS profile; staff-editable stay, room, rate, parties, guarantee, note and confirmation settings; Check Availability and HMS price before Go; sequential multi-room handling. Missing profiles stay manual. |
| **Filing** | File the selected voucher or proof-of-payment PDF on the correct stay; editable surname/arrival search and explicit choice when ambiguous; preserve exact source and target. |
| **Cancel** | Correct booking and reason; show HMS facts; a separate staff Go for a native penalty or charge; retain holds and uncertainty if outcome is unclear. |
| **Amend** | Supported dates, room, occupancy and child ages, rate, guest details and confirmation settings; HMS repricing before Go and fresh requested-field readback. |
| **Shared** | Keep Quote and triage working; source/target/approval binding; one-shot dispatch; no agent saves on real guests; Proof Labtest writes use 2027+ dates and CMS off. |
| **Release** | Final-head focused checks and review, current-main merge gate, clean-main deployment, per-workflow canary, real-source unsaved preparation, and effective flags in all four processes. |

The plan's implementation units were: **U1** shared guards and baseline; **U2** Create; **U3** Filing; **U4** real sources and proof setup; **U5** review/merge/deploy; **U6** Labtest persistence and flags; **U7** Cancel; **U8** Amend. All had material work completed. U4's real-request evidence remained incomplete for Create and Cancel; staff-PC use and the charged-cancel branch were not observed. [Plan units][plan-units] · [definition of done][plan-done]

## 2. Outcome: four enabled, with important proof limits

| Workflow | Code and deployed proof | What that did **not** establish |
|---|---|---|
| **Create** | Priced real-guest-detail preparation without Save; one Labtest Save and fresh matching readback on deployed **671a3b2d**; Create enabled. | The real fixture came from an **Amend** email, not an actual new-Create request. The passing Labtest write used the native backend canary; an actual selected new-Create email → staff pane → Go was not observed. |
| **Filing** | Real selected voucher reached an unsaved preview. One Labtest upload on **671a3b2d** was reconciled to the exact target/source/document metadata; Attach enabled. Later read-only checks ran on newer builds. | The native Documents listing and reconciliation proved matching **metadata**, not an independent byte-for-byte read of the stored PDF. |
| **Cancel** | A real Reserved stay was prepared without a write; one Labtest cancellation and fresh status/reason/note readback passed on final **9d388ab751**; Cancel enabled. | The real preview used an **Amend** email as a fixture; the actual cancellation email found was already cancelled. The penalty prompt was left unaccepted; no separate charge was dispatched, but the account-ledger outcome was not verified. |
| **Amend** | A source-bound real-email Prepare passed with CMS on; a representative Labtest date/room/rate/occupancy change and fresh readback passed on **9d388ab751**; Amend enabled. | The real email's date change was **already applied**. The original Labtest canary journal stayed UNKNOWN after an extra inspector failed; a separate fresh read matched, without a second Save. The inspector's exact failure remained unclassified. |

Evidence: [final state][state-final] · [Create proof log][create-proof] · [Amend worker's final report][agent-amend-final] · [release log][release-log].

**The SHA distinction matters:** Create and Filing were saved on the first deployed bundle, **671a3b2d**. Cancel and Amend were saved on final **9d388ab751**. Filing was read again on later builds; there was no second upload. This does not invalidate the first-bundle canaries, but “all four saves were proven on the final SHA” would be inaccurate.

**The completion distinction matters:** The coordinator explicitly marked the goal complete at 07:46 while its own final answer disclosed that actual Create and Cancel source-bound requests were unverified. The workspace rule required the real tool to prepare real email **details** before Save; the fixtures did exercise that narrower check. The stronger original selected-email workflow was not demonstrated for those two request types. This is an evidence gap, not proof those workflows are broken. [Goal completion call][goal-complete] · [closing answer][closing]

The short closing answer disclosed the source, penalty and Filing-metadata limits, but did not mention the initial Filing UNKNOWN or the Amend inspector's UNKNOWN journal. Those details were retained in the longer proof records and matter when reconstructing what actually happened. [Release log][release-log] · [Amend proof][amend-unknown]

**Outlook was not exercised on a staff PC.** The later investigation found the release was wired into the pane, but actual installation, pairing, staff interaction and first live use were not observed. Nava saves its own replies as unsent drafts; HMS may send a confirmation when staff leave the CMS control on. Those are separate behaviors. [Product contract at deployed SHA](https://github.com/kufupa/Zero/blob/9d388ab7510eb86d613d316b42fb42479cdc85b9/PRODUCT.md) · [later Outlook investigation][agent-outlook]

## 3. Where the 4h 30m went

Times below are UTC. The rows partition wall time by the dominant **critical-path milestone**; other agents worked concurrently. They are not measurements of coding time, CPU time or exclusive effort.

| Window | Elapsed | Main work and result |
|---|---:|---|
| **03:17–03:46** | ~29m | Goal restarted; four Terra coding lanes and a Luna researcher launched. Shared record guard was committed; Create, Filing and Cancel candidates and Amend native checks were progressing. |
| **03:46–04:57** | ~71m | Create PR opened; reviews and live unsaved preparation found zero-price, optional-field, guest-selection, mixed-room identity, UUID, name and source-binding problems. Real-email/profile search continued. The +60-minute landing target was missed. |
| **04:57–05:27** | ~30m | Coordinator stopped recording decisions while workers continued. Its own later state called out approximately 30 minutes of coordinator release latency. No merge or deployment yet. |
| **05:27–06:04** | ~37m | Release ownership delegated. A real HMS preview exposed the Check Availability selector and duplicated guard; those were fixed and repriced before Save. Create and Filing merged; first bundle deployed. |
| **06:04–06:36** | ~32m | Create Labtest Save/readback passed and was enabled. Filing upload ended UNKNOWN, then was reconciled without a duplicate upload; Attach enabled. Cancel and Amend PRs merged in parallel. |
| **06:36–06:56** | ~20m | Filing and Amend follow-ups merged; second bundle deployed. The 210-minute checkpoint arrived with Create/Filing on and Cancel/Amend canaries still incomplete. The first Cancel attempt stopped before Save. |
| **06:56–07:18** | ~22m | Diagnosed Cancel dialog versus parent-form fields and Amend's stale CMS model. Fixed late UI run-state/date defects; merged three further PRs; deployed final build. |
| **07:18–07:47** | ~29m | Cancel Save/readback passed; Amend Save needed separate reconciliation after an inspector failure; final flags and health were verified; source-bound Amend preparation and closeout followed. |

Key clock readings:

| Milestone | Time | Since 03:17:06 |
|---|---:|---:|
| Four coding lanes plus researcher live | 03:19 | ~2m |
| Create PR opened | 03:46:45 | ~30m |
| First merge, Create | 05:52:51 | **2h 36m** |
| First bundle deployed | ~06:04 | **2h 47m** |
| Four main workflow PRs merged | 06:11:07 | **2h 54m** |
| 210-minute checkpoint | 06:47:06 | **3h 30m** |
| Last code PR merged | 07:12:46 | **3h 56m** |
| Final build healthy | 07:18:35 | **4h 01m** |
| Four workflow flags verified on | 07:41:19 | **4h 24m** |
| Last recorded source-bound Amend check | 07:44:57 | **4h 28m** |
| Closing answer | 07:47:36 | **4h 30m 30s** |

The first execution child started at 03:18:16; the last finished at 07:46:32: **4h 28m 16s**. That is a second legitimate 4h 28m clock, distinct from the coordinator's complete turn.

The preceding adversarial estimate was **75–105 minutes for Create + Filing** and **2h 15m–3h 15m for all four**. Using 07:44:57 as the final recorded runtime milestone, the run was about **73 minutes beyond the earlier 3h 15m upper estimate** and **58 minutes beyond the 3h 30m checkpoint**. The estimate and checkpoint were not promises or hard stops. [Prior estimate][initial-ask] · [checkpoint state][state-checkpoint] · [last check][last-check]

## 4. Every shipped PR and what it changed

The comparison from baseline **70f42e7c8** to final **9d388ab751** contains **131 distinct changed files, 9,422 additions and 1,257 deletions**. It includes product code, existing tests and copied or adapted prior work; it is not a count of newly invented production lines. Forty-one test-related files were modified, with no new test files in that net diff.

**No-new-tests nuance:** The launch brief prohibited new tests, but allowed existing focused checks. The run changed existing test cases, sometimes substantially. In `*.test.*` and `*.spec.*` diffs, 20 added test descriptions were paired with 20 removed descriptions in the same diff hunks: they were renamed or revised cases, not 20 new case declarations. For example, #1006 expanded an existing Amend case to cover a submitted run surviving edits. This inventory does not audit the meaning of every changed assertion. [Brief][brief] · [example at final SHA](https://github.com/kufupa/Zero/blob/9d388ab7510eb86d613d316b42fb42479cdc85b9/apps/mail/tests/amend-find-panel.test.tsx#L2211) · [PR #1006](https://github.com/kufupa/Zero/pull/1006).

| PR | Merged UTC | Change | Add / delete | Greptile finish vs merge |
|---|---:|---|---:|---:|
| [#1001](https://github.com/kufupa/Zero/pull/1001) | 05:52 | Real-guest Create, native availability/price, CMS, room identity and shared record fixes. | +1,156 / −518 | −34s |
| [#1002](https://github.com/kufupa/Zero/pull/1002) | 05:57 | Selected-email Filing, source binding, editable target finding, CMS preservation and recovery. | +1,267 / −329 | +33s |
| [#1003](https://github.com/kufupa/Zero/pull/1003) | 06:04 | Connected staff-approved Cloud Cancel, target hold and separate charge decision. | +2,873 / −204 | +2m 19s |
| [#1004](https://github.com/kufupa/Zero/pull/1004) | 06:11 | Connected reviewed Cloud Amend, supported fields, native options and readback. | +3,915 / −206 | +3m 51s |
| [#1005](https://github.com/kufupa/Zero/pull/1005) | 06:19 | Allow a separately approved fee shown before the cancellation Save. | +16 / −6 | +35s |
| [#1007](https://github.com/kufupa/Zero/pull/1007) | 06:38 | Allow Filing on verified real stays across HMS statuses and tolerate unrelated form drift. | +90 / −43 | +1m 40s |
| [#1006](https://github.com/kufupa/Zero/pull/1006) | 06:41 | Keep submitted Amend runs visible after edits; align date/night changes. | +120 / −34 | +1m 18s |
| [#1008](https://github.com/kufupa/Zero/pull/1008) | 07:01 | Preserve newer Amend retry history and chosen dates. | +28 / −7 | +2m 06s |
| [#1009](https://github.com/kufupa/Zero/pull/1009) | 07:08 | Accept reason/note in HMS's cancellation dialog before parent-form sync. | +2 / −3 | +25s |
| [#1010](https://github.com/kufupa/Zero/pull/1010) | 07:12 | Check the live CMS control when the model is stale; reset review state for a new run. | +58 / −10 | +52s |

**Review timing:** A positive time means GitHub's final-head `Greptile Review` check finished after merge. That happened for **nine of ten PRs**, although all ten later reported success; a successful check does not mean it found no issues. The run allowed an independent fallback when Greptile stalled, and some fallback reviews were recorded; this audit did not establish the pre-merge fallback for every PR. The [merge gate at the deployed SHA](https://github.com/kufupa/Zero/blob/9d388ab7510eb86d613d316b42fb42479cdc85b9/scripts/orch/merge-gate.sh#L21) blocked known unresolved P0/P1 threads and matched the head, but did not wait for an in-flight review. Two later P1s are discussed in section 8. Do not infer that the other PRs had no review.

Create's PR was open about **126 minutes** before merge. The other nine were opened less than five minutes before merge, but much of their coding and independent review occurred in worktrees before PR creation. PR-open duration is therefore **not** total task or review time.

### The work inside those PRs

| Task | What the code changed |
|---|---|
| **Create** | Passed empty child ages for adults-only bookings; allowed real-guest unsaved preparation while writes remained gated; restored the native Check Availability step and HMS price; carried editable confirmation settings and guest/party/guarantee data; fixed mixed-room identifiers and existing receipt compatibility. |
| **Filing and source selection** | Connected the selected email/PDF to a verified stay, added editable search and ambiguous-row selection, handled duplicate message headers using exact source identity, preserved CMS state and uncertainty holds, and allowed verified real stays with non-Reserved statuses. |
| **Cancel** | Connected the staff approval route to the native browser, bound reason and target, removed overly restrictive payment/guarantee vetoes, retained durable holds and added a separate native charge decision. Later fixed a fee prompt and dialog fields that had not yet propagated to the parent form. |
| **Amend** | Connected supported date, room, occupancy, rate, guest and confirmation edits to native repricing and readback. Later changes kept submitted/retried runs visible, kept dates and nights aligned, reset review state between runs and handled an unsynchronized CMS model. |
| **Shared release plumbing** | Replaced brittle whole-record/form assumptions with relevant identity and business-field checks; extended the flag writer to the required workflows; preserved source/target binding, staff approval and once-only dispatch. |

The product brief explicitly deferred automatic new-profile creation, typed numeric rate overrides, billing/refunds, native groups and XLSX imports, and new OCR. Create without an existing profile remained a manual HMS step. These were **out of scope**, not silently missed tasks. [Product contract at deployed SHA](https://github.com/kufupa/Zero/blob/9d388ab7510eb86d613d316b42fb42479cdc85b9/PRODUCT.md).

## 5. How the team parallelized

The execution window used **14 child agents: seven Terra max and seven Luna max**, plus the Sol ultra coordinator. Two additional Luna workers helped prepare the launch brief before the clock; one later Luna worker investigated Outlook after closeout. The recorded spawn tree has no grandchildren. [Spawn list][first-spawn] · [later spawn][later-spawn]

| Outside the execution clock | Time, UTC | Work |
|---|---|---|
| [Scope audit / Luna][agent-scope] | 03:03–03:05 | Checked stale main, dirty/shared worktrees, candidate branches and recovery-plan evidence before the brief was written. |
| [Proof entrypoints / Luna][agent-entrypoints] | 03:03–03:05 | Mapped installed worktree tools and the existing unsaved Create and Labtest proof entrypoints. |
| [Outlook pilot entry / Luna][agent-outlook] | 09:22–09:27 | Checked staff installation, sign-in, pairing and classic Outlook entry; could not prove a staff PC had used this release. |

| Agent / model | First–last recorded turn, UTC | Work and handoff |
|---|---|---|
| [Create / Terra][agent-create] | 03:18–04:54 | Create implementation and repeated follow-ups for guest/guarantee, room IDs, UUIDs and optional source; several separate turns. |
| [Filing / Terra][agent-filing] | 03:18–03:38 | Initial Filing UI/tool commits and focused checks; integration and live proof handed off. |
| [Cancel / Terra][agent-cancel] | 03:18–07:44 | Cancel implementation, reviews, release, dialog diagnosis, canary and flag verification. |
| [Amend / Terra][agent-amend] | 03:18–07:44 | Amend implementation, native repricing, UI follow-ups, canary, reconciliation and real-source Prepare. |
| [Runtime proof / Luna][agent-runtime] | 03:19–03:26 | Read-only runtime, flag and proof-entry audit; found the flag writer lacked needed Amend/Cancel coverage. |
| [Shared server / Terra][agent-shared] | 03:27–07:45 | Shared routes and integration; later owned Create/Filing landing, deployment and promotion. |
| [Real Create proof / Luna][agent-real-create] | 03:38–04:23 | Searched bounded real requests and profiles; found no safe exact matching profile for a genuine Create example. |
| [Release proof commands / Luna][agent-commands] | 03:51–04:00 | Mapped existing authenticated route and canary entrypoints. |
| [Exact-source research / Luna][agent-source-research] | 04:17–04:23 | Traced duplicate Message-ID handling and Web/Outlook source identifiers. |
| [Source selection / Terra][agent-source-ui] | 04:30–04:44 | Implemented source binding, linked-thread selection and Filing lookup changes for integration. |
| [Known-profile search / Luna][agent-known] | 04:53–05:05 | Located a real amendment-email fixture with a known profile; found deployed runtime did not yet contain candidate Create code. |
| [Create Labtest setup / Luna][agent-setup] | 04:56–05:06 | Bounded source/target search; found no eligible open Labtest Create email and reported the limitation. |
| [Create release proof / Terra][agent-proof] | 05:29–07:45 | Fixed availability proof path, ran Create canary, helped reconcile Filing, diagnosed Amend CMS and independently verified release. |
| [Checkpoint log / Luna][agent-checkpoint] | 05:32–07:46 | Recorded milestone snapshots, late-checkpoint retro and final state. |

These are **first-to-last session bounds**, not continuous coding durations. Some workers had multiple turns; others spent time waiting for deployment, browsers, checks or other agents.

From paired child turn-start/complete events, clipped to the execution window:

- **Peak:** five child turns open at once, plus the coordinator; first reached at 03:19:07.
- **Five child turns open:** about **189 of 270 minutes** (70%).
- **Sum of child open-turn durations:** about **20.3 hours**: 16.6 Terra and 3.7 Luna. This includes waiting and overlapping time; it is **not** compute time, billed hours or time saved.
- The coordinator issued **182 internal send-message calls**, 14 spawns and 10 follow-up requests during the run. One request to restart the Create agent failed because the thread limit was reached; it did not immediately start a new turn. These counts exclude messages sent by children. [Capacity error][capacity-error]
- Explicit wait calls across the agents cover **1h 50m of wall time** with at least one agent waiting; summed per-agent waits total **2h 56m** because waits overlap. Other agents could work during those periods. Hidden waits inside other tools are excluded, so neither figure is idle time.

Parallel coding worked. The critical path later converged on shared source binding, sequential main merges, deployment, real HMS behavior, proof and flag restarts. More agents could not remove those dependencies by themselves.

## 6. The hidden 29-minute coordinator gap

| Evidence | Observation |
|---|---|
| [Coordinator transcript][stall-start] | Last coordinator tool output before the gap: **04:57:35**. The next recorded coordinator token activity appeared at **05:26:36**; its next tool call was at **05:26:57**. |
| [Shared worker transcript][stall-shared] | The shared worker continued making tool calls throughout that period. Cancel and Amend workers also continued. |
| Child send-message events | Cancel, Amend and shared-server agents made **87 calls addressed to the coordinator** from 04:58 to 05:26. |
| [Coordinator message burst][stall-burst] | **89 agent messages** were recorded in roughly 0.4 seconds at 05:26:50, consistent with queued delivery. |
| [State retro][state-delay] | The coordinator's own retrospective attributed roughly 30 minutes of late Create landing to coordinator latency and then delegated release ownership. |

This is a genuine observability and coordination failure. The logs do **not** identify whether the cause was model service latency, client scheduling, buffering or another mechanism. They also do not prove that the entire interval could have been removed: the live availability selector and guard defects discovered after 05:27 still needed fixes.

The launch brief requested user-facing updates at least every 60 seconds and state updates about every ten minutes. The transcript has **58 gaps over 60 seconds among 60 consecutive execution messages**; the longest was **30m 04s**, from 04:57:03 to 05:27:07. The state log also jumped from the +98-minute snapshot to the +133-minute snapshot. This is not evidence that the whole team was idle. [Progress gap start][progress-gap-start] · [progress gap end][progress-gap-end] · [state snapshots][state-delay]

## 7. What went well

| Practice | Concrete result |
|---|---|
| **Isolation and reuse** | Dirty shared checkout and pre-existing worktrees were preserved; each writer had an assigned worktree and file ownership. Existing native flows and prior work were reused. |
| **Live Prepare before Save** | Real HMS exposed missing availability controls, duplicated request guards, stale CMS model values and Cancel's dialog/parent mismatch before an irreversible write. |
| **Uncertainty handled safely** | Filing's UNKNOWN upload and Amend's failed independent inspector led to fresh reconciliation, not blind duplicate writes. The first Cancel attempt was proved unchanged before retrying after a fix. |
| **Independent release** | Create and Filing were enabled while later Cancel and Amend work continued. The 210-minute checkpoint did not stop the run. |
| **Review caught real problems** | Review identified optional source, Booker model sync and a stale review card. The latter was fixed in a subsequent PR. Stalled reviewers had independent fallbacks rather than blocking indefinitely. |
| **Runtime verification** | The team checked the deployed SHA, four processes, workflow flags and health; it reported DB-backed suites as skipped and did not claim an Outlook-PC test. |

## 8. What went wrong, including things easy to miss

| Finding | Evidence and practical implication |
|---|---|
| **The plan's estimate omitted integration reality.** | The original audit identified eight traps, but the run found more in mixed room IDs, missing profiles, duplicate headers, real HMS control selection, native dialog state and late UI history. Green candidate checks did not imply the first release was ready. |
| **Source preparation was on the critical path.** | A genuine new-Create email with an exact existing profile was not found during bounded searches. The Cancel request found was already cancelled. A different-kind real email was useful as a fixture but could not establish the intended request flow. |
| **Release ownership was initially centralized.** | The coordinator's own +133-minute retro said it had held Create landing for about 30 minutes; release delegation followed. The 29-minute recorded coordinator gap supports a bottleneck, while the later live blocker means the exact avoidable delay is unknown. |
| **A cancelled Labtest preimage cost another preparation.** | The first selected Create date already had a cancelled Proof Labtest stay. It stopped before Save; a distinct date was prepared and used for the single passing Save. [Create proof][create-proof] |
| **Filing's recovery command aborted after committing.** | The first upload ended UNKNOWN. A supported recovery command then exited with SIGABRT after its durable state change. A fresh read and targeted operational inspection established the resolved result. No second upload occurred. [Release log][release-log] |
| **Cancel and Amend each exposed a different HMS state model.** | Cancel reason/note lived in a dialog while parent values lagged. Amend's live checkbox was checked while its model value was stale. Fixes retained identity and approved business-field checks rather than requiring whole native bodies to match. |
| **The charged Cancel path is still a distinct risk.** | A cancellation did persist with a penalty prompt, but the separate approval was not accepted and the account ledger was not checked. No conclusion about a charge or refund should be inferred from “Cancelled.” |
| **The Cloud Cancel flag name is misleading.** | HRCEN Cloud Cancel uses the legacy **CANCEL_UNPAID** mode for all payment states, including bookings with deposits or fees; the separate charge Go still applies. Turning off only the PAID flag is therefore not established as a way to disable charged Cloud cancellations. Both flags were enabled in the run. [PR #1003](https://github.com/kufupa/Zero/pull/1003) · [Cloud Cancel mode at final SHA](https://github.com/kufupa/Zero/blob/9d388ab7510eb86d613d316b42fb42479cdc85b9/apps/server-pilot/src/ai/pane-cloud-cancel.ts#L193) |
| **The Amend canary's original UNKNOWN was not rewritten.** | Fresh independent readback matched and a separate receipt was written, but the original canary journal and the reason for its extra inspector failure remained unresolved. This is different from a clean first-pass canary. [Proof log][amend-unknown] |
| **Not every attempted existing check passed.** | Filing's PR recorded one broader Quote-workflow DOCX text assertion failure, also reproduced on its unchanged base. That evidence points away from a new Filing regression; it does not make the attempted check a pass. [PR #1002](https://github.com/kufupa/Zero/pull/1002) |
| **A later user question was not answered normally.** | At 09:22 the owner asked whether staff could pilot in Outlook. After useful investigation, the displayed final answer was an automated-filter refusal; a later question about the draft/staff workflow has no substantive answer in the supplied transcript. This is separate from the 4h 30m execution. [Follow-up][follow-up] · [filter response][filter-response] · [later question][later-question] |

### Review findings worth knowing about

Several GitHub Greptile comments arrived **after merge**. Independent pre-merge fallback review was allowed by the run's rules; late comments still needed triage.

| Finding | Status at the run's final SHA |
|---|---|
| **Amend price may change after staff reviewed it.** [PR #1004 review](https://github.com/kufupa/Zero/pull/1004#discussion_r4464280457) | The final code validates the approved price's shape, observes a fresh HMS price during availability, but the shown native path does not compare that new amount with the earlier approved amount before Save. The PR notes say a price freeze was declined under the owner's observational-pricing direction. This is a **product tradeoff and a possible price-change risk**, not an observed incident; the inspected transcript does not establish a new owner decision on this exact scenario. [Native code at final SHA](https://github.com/kufupa/Zero/blob/9d388ab7510eb86d613d316b42fb42479cdc85b9/apps/server-pilot/tooling/hms-cloud/pane-amend-session.mjs#L398) · [PR #1006 rationale](https://github.com/kufupa/Zero/pull/1006). |
| **A new Amend run could inherit an old review result.** [PR #1008 review](https://github.com/kufupa/Zero/pull/1008#discussion_r4464632681) | This P1 arrived after #1008 merged and was addressed in **#1010**. Good example of responding to a late reviewer finding. |
| **Cancel screenshots and review controls can be hidden.** [PR #1003 review](https://github.com/kufupa/Zero/pull/1003#discussion_r4464214933) | At final SHA, Cloud Cancel's queued result has an empty screenshots list; the restored run carries it into a card that needs a screenshot name. Backend evidence is separately recorded. On an email with an amendment classification, the other approval card is filtered to Filing, so it also hides the Cancel Review OK/Flag controls. These are static code findings for those surfaces; no staff-PC interaction was observed, and another surface may expose evidence. [Queue result](https://github.com/kufupa/Zero/blob/9d388ab7510eb86d613d316b42fb42479cdc85b9/apps/server-pilot/src/ai/pane-cloud-cancel.ts#L193) · [Cancel card](https://github.com/kufupa/Zero/blob/9d388ab7510eb86d613d316b42fb42479cdc85b9/apps/mail/components/quote-workflow/amend-lookup-panel.tsx#L1630) · [approval filter](https://github.com/kufupa/Zero/blob/9d388ab7510eb86d613d316b42fb42479cdc85b9/apps/mail/components/nava-pane/blocks/booking-voucher-card.tsx#L114). |
| **Slow Cancel pre-reads may outlive the lease heartbeat.** [PR #1003 review](https://github.com/kufupa/Zero/pull/1003#discussion_r4464214951) | Final code performs a native read before the target lock and another after it, before starting the local heartbeat; the default stale-run timeout is 15 minutes. A long read or lock wait could lead to a lease-lost hold. The ordering is visible in code; an actual timeout was not demonstrated in this run. [First read](https://github.com/kufupa/Zero/blob/9d388ab7510eb86d613d316b42fb42479cdc85b9/apps/server-pilot/src/ai/pane-hms-write.ts#L1613) · [second read](https://github.com/kufupa/Zero/blob/9d388ab7510eb86d613d316b42fb42479cdc85b9/apps/server-pilot/src/ai/pane-cloud-cancel.ts#L377) · [heartbeat](https://github.com/kufupa/Zero/blob/9d388ab7510eb86d613d316b42fb42479cdc85b9/apps/server-pilot/src/ai/pane-cloud-cancel.ts#L547) · [default timeout](https://github.com/kufupa/Zero/blob/9d388ab7510eb86d613d316b42fb42479cdc85b9/apps/server-pilot/src/env.ts#L463). |
| **Filing can prepare in lab mode while real-guest Go stays disabled.** [PR #1002 review](https://github.com/kufupa/Zero/pull/1002#discussion_r4464156036) | The final code allows real-guest unsaved preparation in `lab` but requires `on` for approval. The PR explicitly describes that as intentional: the real write stays gated. The practical concern is whether the pane explains that the prepared upload cannot yet be approved. The final run used `on`; this is not evidence of an `on`-mode failure. [PR rationale](https://github.com/kufupa/Zero/pull/1002) · [approval mode check](https://github.com/kufupa/Zero/blob/9d388ab7510eb86d613d316b42fb42479cdc85b9/apps/server-pilot/src/ai/hms-approval.ts#L190). |
| **Direct selection and CMS matcher regression coverage was questioned.** [Filing review](https://github.com/kufupa/Zero/pull/1002#discussion_r4464156044) · [CMS review](https://github.com/kufupa/Zero/pull/1010#discussion_r4464712416) | Reviewers did not find direct cases for Filing's editable booking selection, retargeting and mismatched detail, or the stale-model/mismatched-request CMS matchers. A source search found no tests naming those CMS functions; indirect coverage was not established. Live preparation and readback provide useful but narrower evidence. The owner had prohibited new tests for this run. |

## 9. Twenty-nine concrete lessons for the next run

| # | Next-run action | Why this run supports it |
|---:|---|---|
| 1 | **Define completion as a per-workflow evidence matrix before starting.** | Four flags and four Labtest readbacks did not by themselves prove actual Create/Cancel request paths. |
| 2 | **Label fixtures by request type and whether the requested change is new.** | An Amend email supplied Create/Cancel details; the real Amend date change was already applied. |
| 3 | **Keep the goal open when a required proof is missing, or explicitly agree a narrower goal.** | The coordinator marked complete while its final report still named source-bound gaps. |
| 4 | **Start a separate release owner immediately, with authority to proceed on explicit conditions.** | The coordinator became a release bottleneck and was unresponsive for roughly 29 minutes. |
| 5 | **Add a coordinator heartbeat and escalate missed heartbeats to a worker.** | Workers kept progressing, but 87 messages accumulated before the coordinator recorded another decision. |
| 6 | **Record one clear owner, handoff and next action for each shared file and release gate.** | Initial file ownership worked; release ownership became clearer only after the miss. |
| 7 | **Resolve representative real sources, exact profiles and distinct Labtest targets early.** | Bounded source searches and an already-cancelled Labtest preimage delayed proof. |
| 8 | **Run the real unsaved native flow as soon as a candidate exists.** | It found the availability selector, guard conflict, parent/dialog distinction and stale CMS model before Save. |
| 9 | **Compare staff business fields, identity and authorization; tolerate unrelated HMS drift.** | Whole-form/key assumptions and model-only checks refused valid work. Keep exact source, target, action and one-shot protections. |
| 10 | **Treat form controls, dialog state and backing model as separate observations.** | Both late Cancel and Amend blockers came from assuming they had already synchronized. |
| 11 | **Reconcile an uncertain write before retrying; preserve the original result.** | Filing and Amend were recovered without duplicate writes; the raw Amend UNKNOWN still tells an important story. |
| 12 | **Track each canary's exact deployed SHA and what its readback proves.** | Create/Filing ran on the first bundle; Cancel/Amend ran on the final bundle; Filing proved metadata, not stored bytes. |
| 13 | **Record the pre-merge fallback and monitor reviewer results that finish after merge.** | Greptile finished after nine merges; #1008's late P1 required #1010, and other late findings remained. |
| 14 | **Separate “approved HMS price shown” from “price cannot change before Save.”** | A post-merge reviewer raised that distinction; the run treated a price freeze as outside scope. Make the product decision explicit. |
| 15 | **Exercise the charge decision and ledger only under the owner's authorized scope.** | A cancelled status and an unaccepted fee prompt do not establish the ledger result. |
| 16 | **Make durable evidence and review actions visible to staff, not merely stored in the backend.** | The final Cancel card's screenshot list appears empty, and an amendment-classified email filters the other card to Filing. |
| 17 | **Start the run heartbeat before potentially slow native reads, if the lease contract permits.** | The final Cancel code starts its local heartbeat after two reads and a lock wait; the reviewer identified a possible false lease loss. |
| 18 | **Use separate browser sessions and target locks; measure any additional serialization.** | Distinct Cancel, Filing and Amend targets were sometimes sequenced through two browser slots. The record does not establish whether that was a hard capacity limit or conservative scheduling. |
| 19 | **Publish short milestone and exception updates even during long waits.** | The brief requested 60-second updates, but the longest recorded gap was 30 minutes; state logging also slipped. |
| 20 | **Report actual costs and verification limits with the release, not just test counts.** | DB suites and Outlook interaction were skipped; model billing was not available. Test counts alone could not convey real-source, price, fee or PDF-byte limitations. |
| 21 | **Queue and visibly retry agent work rejected by the thread cap.** | A Create follow-up failed with “agent thread limit reached”; a failed dispatch is not an active worker. |
| 22 | **Carry exact source identity across Outlook, webmail, the route and the write.** | Duplicate message headers broke acquisition; Outlook's native entry ID and a local database message ID were different kinds of identifier. [Source investigation][state-source] |
| 23 | **Audit the flag writer's actual variable coverage before planning promotion.** | The existing M1 writer supported its narrow mode but initially lacked the required Amend/Cancel switches. The runtime researcher found this before promotion. |
| 24 | **Pin current main, deployed SHA and the clean base before interpreting failures.** | The shared root was dirty and 44 commits behind; a broader DOCX assertion also failed on an unchanged base. Both facts changed how evidence should be read. |
| 25 | **Prepare a plain staff handoff alongside the technical closeout.** | The later Outlook answer was filtered. Staff still needed a clear account of installation and pairing, the Go workflow, HMS confirmation sending and Nava's unsent reply draft. |
| 26 | **Document what flags actually gate, especially legacy names.** | HRCEN Cloud Cancel uses the switch named UNPAID for paid and unpaid stays; operational controls should be verified against the consumer, not inferred from the label. |
| 27 | **Make preview-only mode unmistakable when Go is intentionally gated.** | Real-guest Filing can prepare in `lab` while approval remains disabled until `on`; staff need to know why. |
| 28 | **When tests are authorized, focus them on target changes and control/model disagreement.** | Late reviews identified gaps around Filing retargeting and CMS mismatch cases; neither gap proves a runtime bug. |
| 29 | **Forecast implementation, landing, deployment and live proof separately.** | All four primary PRs were merged by 2h 54m, but final proofs and flags still took roughly another 90 minutes. Source availability and live-HMS fixes need explicit contingency. |

## 10. Verification, costs and remaining uncertainty

| Claim | Assessment | Counterevidence / limit |
|---|---|---|
| Ten PRs merged and final SHA deployed during the run | **Supported** by Git history, PR metadata, state and runtime checks. | This does not prove the same SHA or flags are live now. |
| Four Labtest operations had matching fresh readbacks | **Supported by the recorded proof and reconciliation logs.** | Create/Filing used an earlier deployed SHA; Filing verified metadata; Amend's original journal remained UNKNOWN. |
| Four actual staff request paths were demonstrated end to end | **Not established.** | Create/Cancel used an Amend-email fixture; the real Amend example was already applied; no staff PC was exercised. |
| The coordinator's stall caused exactly 30 minutes of avoidable delay | **Not established.** | The gap and buffered messages are visible, but its root cause and counterfactual overlap with later code defects are unknown. |
| All reviewer concerns were fixed | **Not established.** | Late price, screenshot, heartbeat and direct-coverage concerns are described above; some are intentional scope decisions or untested risks. |

The **95 evidence threshold is met for the reconstructed sequence and recorded outcomes**, with the caveats above. It is **not met for claiming full staff-pilot readiness or for attributing the coordinator gap to a specific technical cause**. No live HMS, staff-PC, production-database test or deployment was performed for this retrospective.

**Cost:** Actual metered dollars are unavailable in the inspected records. Original run: Sol ultra coordinator **$unknown**, Terra max workers **$unknown**, Luna max workers **$unknown**. This retrospective: Luna max workers and coordinator **$unknown**. Token counters are not invoices, and overlapping open-turn time is not billing.

**Route used:** local transcript/child-session and Git inspection, independent Luna subagents, and read-only GitHub PR/review metadata. No external web research was needed.

## Sources and method

- [Original chat transcript][transcript] and the child transcripts linked in section 5. The transcript contains later follow-up turns; the execution clock here starts with the restarted goal at 03:17:06 and ends with the 07:47:36 answer.
- [Autonomous launch brief][brief] · [isolated deeper plan][plan] · [state and final retro][state-final] · [release log][release-log] · [Create/proof log][create-proof].
- [Baseline commit](https://github.com/kufupa/Zero/commit/70f42e7c8c563f92ed99ad13b4d15e8634730853) · [final deployed commit](https://github.com/kufupa/Zero/commit/9d388ab7510eb86d613d316b42fb42479cdc85b9) · PRs #1001–#1010 in section 4.
- Child relationships were read from the local Codex session database and checked against each child transcript. Open-turn durations use task-start and task-complete timestamps, clipped to the execution window; waiting is included.
- Git totals are the net diff between the two named commits. PR additions/deletions are per-PR GitHub metadata, so overlapping edits need not sum to the net diff.

[transcript]: /home/orca/.codex/sessions/2026/11/04/rollout-2026-11-04T02-58-41-01a1a47e-95ac-7a82-8938-042f58e1fd92.jsonl
[initial-ask]: /home/orca/.codex/sessions/2026/11/04/rollout-2026-11-04T02-58-41-01a1a47e-95ac-7a82-8938-042f58e1fd92.jsonl:12
[goal-start]: /home/orca/.codex/sessions/2026/11/04/rollout-2026-11-04T02-58-41-01a1a47e-95ac-7a82-8938-042f58e1fd92.jsonl:243
[first-spawn]: /home/orca/.codex/sessions/2026/11/04/rollout-2026-11-04T02-58-41-01a1a47e-95ac-7a82-8938-042f58e1fd92.jsonl:288
[capacity-error]: /home/orca/.codex/sessions/2026/11/04/rollout-2026-11-04T02-58-41-01a1a47e-95ac-7a82-8938-042f58e1fd92.jsonl:2265
[later-spawn]: /home/orca/.codex/sessions/2026/11/04/rollout-2026-11-04T02-58-41-01a1a47e-95ac-7a82-8938-042f58e1fd92.jsonl:6534
[progress-gap-start]: /home/orca/.codex/sessions/2026/11/04/rollout-2026-11-04T02-58-41-01a1a47e-95ac-7a82-8938-042f58e1fd92.jsonl:3222
[stall-start]: /home/orca/.codex/sessions/2026/11/04/rollout-2026-11-04T02-58-41-01a1a47e-95ac-7a82-8938-042f58e1fd92.jsonl:3242
[stall-burst]: /home/orca/.codex/sessions/2026/11/04/rollout-2026-11-04T02-58-41-01a1a47e-95ac-7a82-8938-042f58e1fd92.jsonl:3252
[progress-gap-end]: /home/orca/.codex/sessions/2026/11/04/rollout-2026-11-04T02-58-41-01a1a47e-95ac-7a82-8938-042f58e1fd92.jsonl:3442
[last-check]: /home/orca/.codex/sessions/2026/11/04/rollout-2026-11-04T02-58-41-01a1a47e-95ac-7a82-8938-042f58e1fd92.jsonl:6445
[goal-complete]: /home/orca/.codex/sessions/2026/11/04/rollout-2026-11-04T02-58-41-01a1a47e-95ac-7a82-8938-042f58e1fd92.jsonl:6498
[closing]: /home/orca/.codex/sessions/2026/11/04/rollout-2026-11-04T02-58-41-01a1a47e-95ac-7a82-8938-042f58e1fd92.jsonl:6505
[follow-up]: /home/orca/.codex/sessions/2026/11/04/rollout-2026-11-04T02-58-41-01a1a47e-95ac-7a82-8938-042f58e1fd92.jsonl:6512
[filter-response]: /home/orca/.codex/sessions/2026/11/04/rollout-2026-11-04T02-58-41-01a1a47e-95ac-7a82-8938-042f58e1fd92.jsonl:6662
[later-question]: /home/orca/.codex/sessions/2026/11/04/rollout-2026-11-04T02-58-41-01a1a47e-95ac-7a82-8938-042f58e1fd92.jsonl:6669
[brief]: /home/orca/zero-recovery-2026-11-04-0303/GOAL.md
[plan]: /home/orca/.codex/worktrees/b984/zero/docs/plans/2026-11-04-001-feat-m1-recovery-plan.md
[plan-units]: /home/orca/.codex/worktrees/b984/zero/docs/plans/2026-11-04-001-feat-m1-recovery-plan.md:80
[plan-done]: /home/orca/.codex/worktrees/b984/zero/docs/plans/2026-11-04-001-feat-m1-recovery-plan.md:146
[state-final]: /home/orca/zero-recovery-2026-11-04-0303/STATE.md:105
[state-checkpoint]: /home/orca/zero-recovery-2026-11-04-0303/STATE.md:81
[state-delay]: /home/orca/zero-recovery-2026-11-04-0303/STATE.md:47
[state-source]: /home/orca/zero-recovery-2026-11-04-0303/STATE.md:34
[release-log]: /home/orca/zero-recovery-2026-11-04-0303/release-state.md
[create-proof]: /home/orca/zero-recovery-2026-11-04-0303/create-proof-state.md:4
[amend-unknown]: /home/orca/zero-recovery-2026-11-04-0303/create-proof-state.md:20
[agent-scope]: /home/orca/.codex/sessions/2026/11/04/rollout-2026-11-04T03-03-10-01a1a482-b081-7d72-89be-abbb74de610a.jsonl
[agent-entrypoints]: /home/orca/.codex/sessions/2026/11/04/rollout-2026-11-04T03-03-18-01a1a482-cd23-7b12-b6ef-357f2721dc8a.jsonl
[agent-create]: /home/orca/.codex/sessions/2026/11/04/rollout-2026-11-04T03-18-15-01a1a490-8092-7210-a90b-c633f647283a.jsonl
[agent-filing]: /home/orca/.codex/sessions/2026/11/04/rollout-2026-11-04T03-18-28-01a1a490-b17c-7883-a7ca-cd0da0220635.jsonl
[agent-cancel]: /home/orca/.codex/sessions/2026/11/04/rollout-2026-11-04T03-18-41-01a1a490-e307-7563-a337-52b85534a1a8.jsonl
[agent-amend]: /home/orca/.codex/sessions/2026/11/04/rollout-2026-11-04T03-18-51-01a1a491-0d3e-73e0-96a1-31d6527bad7f.jsonl
[agent-amend-final]: /home/orca/.codex/sessions/2026/11/04/rollout-2026-11-04T03-18-51-01a1a491-0d3e-73e0-96a1-31d6527bad7f.jsonl:16159
[agent-runtime]: /home/orca/.codex/sessions/2026/11/04/rollout-2026-11-04T03-19-07-01a1a491-49d8-7750-96ff-616f8e8ded8f.jsonl
[agent-shared]: /home/orca/.codex/sessions/2026/11/04/rollout-2026-11-04T03-27-24-01a1a498-df42-72c2-81fa-0cc08538fe83.jsonl
[stall-shared]: /home/orca/.codex/sessions/2026/11/04/rollout-2026-11-04T03-27-24-01a1a498-df42-72c2-81fa-0cc08538fe83.jsonl:6745
[agent-real-create]: /home/orca/.codex/sessions/2026/11/04/rollout-2026-11-04T03-38-59-01a1a4a3-7b21-7bd0-a59b-117063843a70.jsonl
[agent-commands]: /home/orca/.codex/sessions/2026/11/04/rollout-2026-11-04T03-51-41-01a1a4af-1b44-70f3-82fd-ba483107adbf.jsonl
[agent-source-research]: /home/orca/.codex/sessions/2026/11/04/rollout-2026-11-04T04-17-56-01a1a4c7-2209-7e32-bda7-f4dcba4769ff.jsonl
[agent-source-ui]: /home/orca/.codex/sessions/2026/11/04/rollout-2026-11-04T04-30-42-01a1a4d2-d1c7-7910-b1d6-be2e40bcf2b5.jsonl
[agent-known]: /home/orca/.codex/sessions/2026/11/04/rollout-2026-11-04T04-53-06-01a1a4e7-5353-7e51-a57e-142fe14bb31c.jsonl
[agent-setup]: /home/orca/.codex/sessions/2026/11/04/rollout-2026-11-04T04-56-48-01a1a4ea-b9dd-7b53-a1f0-1b2771e7fac7.jsonl
[agent-proof]: /home/orca/.codex/sessions/2026/11/04/rollout-2026-11-04T05-29-23-01a1a508-8ebb-78b0-ba15-26fd5992d81d.jsonl
[agent-checkpoint]: /home/orca/.codex/sessions/2026/11/04/rollout-2026-11-04T05-32-25-01a1a50b-545e-7690-900e-c774589fe0c3.jsonl
[agent-outlook]: /home/orca/.codex/sessions/2026/11/04/rollout-2026-11-04T09-22-52-01a1a5de-50d2-7610-88e6-3a91cf816cae.jsonl:223
