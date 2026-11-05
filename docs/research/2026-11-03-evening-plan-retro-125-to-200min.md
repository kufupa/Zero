# Evening plan retro: minutes 125–200

**Frozen window:** 2026-11-03 22:39:25–23:54:25 UTC. Kickoff was 20:34:25 UTC. This is a historical snapshot of a still-running session, not a live status report. All transcript events and artifacts used below were recorded by the cutoff.

**Verdict:** There was real progress: a second main revision was deployed, Labtest controls were enabled, and direct real-email Quote and prefill results were obtained. The agreed staff-ready M1 was still incomplete. Create had no successful fake Save, and Filing had no upload/readback. The largest avoidable Create delay was choosing a closed work item. A separate Filing limitation was discovered but not addressed within the window.

The previous snapshot is [the first 125 minutes](/home/ubuntu/projects/zero/docs/research/2026-11-03-evening-plan-retro-125min.md). The promised scope was Quote, existing-profile Create, supported PDF Filing, and selected-email prefill/staff overrides; Amend, Cancel and automatic New Profile creation were deferred. The [submitted goal](/home/orca/.codex/attachments/bd84607d-f3fe-4dc1-9546-b61ad0629092/pasted-text-1.txt) asked for roughly 100–125 minutes and explicitly permitted independently ready workflows to ship.

## State at 3 hours 20 minutes

| Capability | What the record establishes by 23:54:25 UTC |
|---|---|
| Deployment and flags | Main `b6a3e5b2c40bbb770eaf5dd76eb20e4d499a3dfc` was deployed and healthy. The stage-one render set Create and Filing to **Labtest** mode, with their required dispatch/worker controls; it did not fully enable real-guest Create/Filing. All four processes were healthy on the fresh check. |
| Quote and prefill | Direct selected-email results matched the source and returned usable HMS prices: R5,800 for the checked four-night request. Direct analysis/prefill returned the expected details. The completed Quote job also retained a `TRANSIENT_NETWORK` marker. This proves useful route output, not the actual Outlook-host interaction or that selecting an email automatically triggers every step. |
| Create | The existing fake profile was selected and a native preview prepared. One Save was attempted. HMS rejected it as rate unavailable; no successful new stay/readback was recorded. A small pricing fix was in PR #999, not yet demonstrated on a native Save. |
| Filing | The selected PDF was obtained and read for voucher extraction, but no upload or Documents readback was recorded. Its extracted surname and arrival were absent, exposing a staff-target-selection limitation described below. |
| Checks on the Create fix | The existing Create suite passed 44/44; the remote server typecheck completed successfully at 23:52:41. Independent review had started but was not recorded as completed by the cutoff. No merge or deployment of #999 was established by the cutoff. |

The user's later quotation says the fix was reviewed and merging. That may describe progress after this snapshot; this report does not inspect or contradict later events. [Stage-one flags](/home/orca/.codex/m1-20261103-203425/stage1-apply-b6a3e5b2.log) · [final-revision Quote result](/home/orca/.codex/m1-20261103-203425/quote-result-b6a3e5b2.json) · [prefill receipt](/home/orca/.codex/m1-20261103-203425/prefill-b6a3e5b2.json) · [server typecheck](/home/orca/.codex/m1-20261103-203425/typecheck-server-pilot-b84639a7.log).

## Where the 75 minutes went

The rows are consecutive wall-clock periods; tasks in the final column often overlapped. They are not estimates of exclusive person/agent time.

| UTC | Duration | Main path | Work happening alongside it |
|---|---:|---|---|
| 22:39:25–22:54:15 | 14m50s | Built, reviewed and merged #998, which lets the environment writer update M1 controls without rewriting unrelated overlay values. | Checked the real-email Quote, prefill, source identity and populated booking draft. |
| 22:54:15–23:03:16 | 9m01s | Deployed `b6a3e5b2`, applied Labtest controls, restarted services and checked health. The wrapper's immediate health check failed during startup; a fresh check passed. | Filing source and UI inspection continued. |
| 23:03:16–23:07:44 | 4m28s | Re-ran Quote on the deployed revision, checked its result and started Create preparation. | Reviewed the chosen voucher and its normal Filing path. |
| 23:07:44–23:09:43 | 1m59s | Started Create verification; its source binding was refused before Save. | Filing analysis continued. |
| 23:09:43–23:25:37 | 15m54s | Diagnosed the refusal as a **closed work item**, selected an active request and started its preview. Cause identified at 23:20:26; the active request was selected by 23:21:39. | Filing worker traced target selection and checked the selected PDF. |
| 23:25:37–23:31:34 | 5m57s | An initial preview was unavailable; an unsaved diagnostic and a retry succeeded without a code change. Reviewed the prepared form and submitted one Labtest Save. | Filing confirmed no extracted surname or arrival at 23:27. |
| 23:31:34–23:38:21 | 6m47s | The Save returned unconfirmed. Checked the original writer, a native census and the post-Save image. HMS had rejected Save: **“Rate is not available.”** The hold was retained; no blind retry. | Source inspection of recovery and pricing continued. |
| 23:38:21–23:50:39 | 12m18s | Diagnosed the pricing-preparation gap and opened PR #999. The fix moved rate selection after guest/pricing staging and blocks binding or Save when the final average rate is blank. | A separate read-only Quote found an available January rate for the next canary. |
| 23:50:39–23:54:25 | 3m46s | Existing Create tests had passed; independent review and final-head checks ran. The server typecheck passed. No recorded merge or redeploy yet. | Filing worker began reviewing the rate fix. |

Timeline sources: [flag fix and deploy](/home/orca/.codex/sessions/2026/11/03/rollout-2026-11-03T20-28-50-01a1a319-a8cb-7e80-8700-4aceefa98931.jsonl:3836) · [Create refusal and closed request](/home/orca/.codex/sessions/2026/11/03/rollout-2026-11-03T20-28-50-01a1a319-a8cb-7e80-8700-4aceefa98931.jsonl:4205) · [one Save and diagnosis](/home/orca/.codex/sessions/2026/11/03/rollout-2026-11-03T20-28-50-01a1a319-a8cb-7e80-8700-4aceefa98931.jsonl:4826) · [fix PR](/home/orca/.codex/sessions/2026/11/03/rollout-2026-11-03T20-35-06-01a1a31f-6859-7480-b786-4a22474b645f.jsonl:7620).

## How long was Create stuck?

These intervals overlap; do not add them together.

| Starting point | Elapsed at cutoff | Meaning |
|---|---:|---|
| 23:07:44, Create verification began | 46m41s | Entire Create effort, including the wrong work item and preview retry. |
| 23:09:43, closed-item refusal reported | 44m42s | Since the first Create blocker, which was unrelated to rate availability. |
| 23:32:50, Save returned unconfirmed | 21m35s | Includes safe recovery/diagnosis before knowing the rejection reason. |
| 23:38:21, rate rejection identified | 16m04s | Time actually spent since identifying the rate problem. |
| 23:42:04, preparation gap identified | 12m21s | Fix development, review and checks, much of it parallel with finding another available rate. |
| 23:50:39, PR #999 opened | 3m46s | Review and typecheck were in progress; typecheck completed by cutoff. |

## Avoidable delay: closed request

The coordinator selected an email whose work item was already `done`. Create correctly refuses to bind a closed request. It took **10m43s** from the reported refusal to identify that cause, and **15m54s** until the replacement preview was running. Selecting or checking an active work-item status up front could plausibly have avoided most of this detour; the exact saving is not proven.

A subtle detail: an earlier source result's `status=ready` was **route readiness**, not the work item's status. The later projection showed `workItemStatus=done`; the replacement explicitly showed `workItemStatus=needs_you`. The guard was doing useful work; the choice and diagnosis were the problems. [Closed-item projection](/home/orca/.codex/m1-20261103-203425/create-binding-projection-b6a3e5b2.json) · [active selection](/home/orca/.codex/m1-20261103-203425/create-active-selection-b6a3e5b2.json) · [coordinator diagnosis](/home/orca/.codex/sessions/2026/11/03/rollout-2026-11-03T20-28-50-01a1a319-a8cb-7e80-8700-4aceefa98931.jsonl:4407).

## Rate issue: a real bug, plus an avoidable failed canary

The [pre-Save image](/home/orca/.codex/m1-20261103-203425/create-preview-filled.png) already showed the rate code but a **blank Average Rate and totals**. The coordinator inspected it and said the listed identity, dates, room and code matched, but did not flag the missing price. It later acknowledged that rate availability should have been checked before Go. A blank amount was a useful warning, although that image alone does not establish which native action caused it or prove every blank state must fail.

The subsequent [post-Save image](/home/orca/.codex/m1-20261103-203425/create-save-unknown.png) showed “Rate is not available.” The [Save receipt](/home/orca/.codex/m1-20261103-203425/create-native-save-b6a3e5b2.json) was `pane_save_unconfirmed`, not success; a [fresh census](/home/orca/.codex/m1-20261103-203425/create-unknown-census-b6a3e5b2.json) found no same-arrival stay. Checking the uncertain write before retrying was justified.

There was also a concrete product gap: the old Create handler could select a rate code before staging the guest and track, then consider the form ready without confirming a current price. It is not established whether the first rate was unavailable from the outset, or which subsequent form change affected it. A known-available Quote chosen before the first Save might have avoided this canary failure; it is **not proven** that the quoted price would survive all subsequent Create form changes. [Source diagnosis](/home/orca/.codex/sessions/2026/11/03/rollout-2026-11-03T20-35-06-01a1a31f-6859-7480-b786-4a22474b645f.jsonl:7092) · [available second Quote](/home/orca/.codex/m1-20261103-203425/create-canary2-quote-prices-b6a3e5b2.json).

The fix is proportionate to the observed failure: one handler and one existing fixture, **21 insertions / 11 deletions**. It delays rate selection and requires a nonblank final average rate. Existing tests were run twice, with small source edits between runs; the second run took about seven seconds. No new test cases were written, as requested. The 44 passing cases do not by themselves prove the new blank-rate branch or an actual successful HMS Save. [PR #999](https://github.com/kufupa/Zero/pull/999) · [first run](/home/orca/.codex/sessions/2026/11/03/rollout-2026-11-03T20-35-06-01a1a31f-6859-7480-b786-4a22474b645f.jsonl:7435) · [second run](/home/orca/.codex/sessions/2026/11/03/rollout-2026-11-03T20-35-06-01a1a31f-6859-7480-b786-4a22474b645f.jsonl:7539).

## Filing gap hidden by “PDF selected and read”

The selected PDF was identified and the voucher query returned it, but it extracted **no surname and no arrival**. Separately, the normal Filing card on deployed `b6a3e5b2` only starts its guest search from an extracted surname **and** arrival. Its upload preparation requires exactly one matching search result. It provides no staff field to enter the missing details or choose a target confirmation. The email-analysis result had a confirmation, but the voucher card did not consume it.

Consequently, the selected email could not reach the normal in-pane Filing action through this card as observed, even though the backend's target-bound APIs can take explicit booking details. A script calling those APIs could prove a backend path; it would not prove that staff can select the target in the pane. Other vouchers with extracted details and one matching booking may take the existing path, but no actual upload or Documents readback was demonstrated here. This matters because the agreed M1 included filing a supported PDF to the selected stay and staff overrides.

The Filing worker reported the UI limitation at **23:22** and the selected PDF's missing fields at **23:27**. The coordinator told the user at 23:29 that the fields “need staff input”, without establishing a way to supply that input in this Filing card. The worker received no further task from **23:27:11 to 23:52:11**, when it began the rate-fix review. A reasonable alternative was to investigate or implement a small staff target-selection path in parallel with Create; it is not proven that doing so would have saved the full 25 minutes or that a suitable existing fake stay was available for an independent upload proof.

Evidence: [Filing worker's UI trace](/home/orca/.codex/sessions/2026/11/03/rollout-2026-11-03T20-34-58-01a1a31f-488f-7f91-9db3-cce0ec5b0768.jsonl:4890) · [selected PDF result](/home/orca/.codex/sessions/2026/11/03/rollout-2026-11-03T20-34-58-01a1a31f-488f-7f91-9db3-cce0ec5b0768.jsonl:5121) · [shipped search and single-match logic at b6](https://github.com/kufupa/Zero/blob/b6a3e5b2c40bbb770eaf5dd76eb20e4d499a3dfc/apps/mail/components/quote-workflow/voucher-find-card.tsx#L200) · [shipped attach gate at b6](https://github.com/kufupa/Zero/blob/b6a3e5b2c40bbb770eaf5dd76eb20e4d499a3dfc/apps/mail/components/quote-workflow/voucher-find-card.tsx#L450) · [coordinator's staff-input update](/home/orca/.codex/sessions/2026/11/03/rollout-2026-11-03T20-28-50-01a1a319-a8cb-7e80-8700-4aceefa98931.jsonl:4729).

## Overengineering, testing and process judgment

1. **Flag work fixed a real blocker, but arrived late.** The old renderer would have changed unrelated settings, contrary to the user's instructions. Preserving them mattered. The #998 change added 160 lines to a deploy script to update four controls and five dependencies; that is substantial release plumbing for this pilot and a candidate for later simplification. The record does not establish a shorter authorized approach that preserved the existing writer and canary protections. Earlier preflight would have exposed the conflict while feature work was in flight. [#998 diff](https://github.com/kufupa/Zero/commit/b6a3e5b2c40bbb770eaf5dd76eb20e4d499a3dfc).
2. **One fake Create and one fake Filing proof are meaningful.** The first Save caught a real rate failure. The follow-up screenshot and readback explained an uncertain write. There is no evidence in this window of a broad rate-matrix campaign or unrelated manual Nava admin clicking. The screenshots were retrieved from the normal native output; the error was missing a visible blank rate on the first one.
3. **Checks were not the main 75-minute culprit.** No new test cases were added. Existing tests and a typecheck were run on a changed handler; the second focused run was short and followed minor edits. They did not prove end-to-end success. The final-revision Quote repeat occupied about 4½ minutes after the flag restart; validating the changed runtime had value, but active Create selection/setup could potentially have overlapped. A real browser/session lock, if encountered, could limit that overlap; the record does not quantify a saving.
4. **Parallelism still underperformed.** Filing's real target-selection limitation was known while Create was being diagnosed, but its worker had no recorded next task for 25 minutes. The plan allowed independent release and the owner wanted usable staff workflows, so an explicit parallel decision on this gap was warranted.
5. **Status was too optimistic if read as end-to-end readiness.** “Most code work done; final live checks remain” omits the selected Filing email's missing target-selection path and the fact that the Create fix was not yet proven by a native Save. The statement that the PDF was selected and read was true; it was not evidence that staff could file it.

## Remaining work as of the cutoff

- Complete review, merge and deploy the rate fix, then run one authorized fake Create on an active request with a known-available rate and fresh native readback. Check the deployed controls on the resulting release.
- Resolve the staff Filing target-selection limitation for the intended supported cases, or explicitly narrow the launch to vouchers whose extracted surname/arrival produce one correct booking and give staff a usable manual fallback. Then prove one authorized fake upload and fresh Documents readback. A suitable existing authorized Labtest stay could make that proof independent of the new Create, if one is actually available and the normal source/target rules are satisfied.
- Treat Quote and prefill as useful deployed/directly demonstrated progress. Verify automatic selection and staff-edit wiring through existing pane output where possible, and report that Outlook/webmail host interactions were not exercised. Do not open the UI just to collect evidence. Independently ready capabilities need not wait for Amend.

There is no reliable remaining-time estimate from this frozen record: it does not establish the outcome of the pending review, deploy, native Create retry, Filing UI work or final filing proof. Those steps may have progressed after the cutoff.

## Evidence and limits

Primary sources are the timestamp-filtered [coordinator transcript](/home/orca/.codex/sessions/2026/11/03/rollout-2026-11-03T20-28-50-01a1a319-a8cb-7e80-8700-4aceefa98931.jsonl), [pane transcript](/home/orca/.codex/sessions/2026/11/03/rollout-2026-11-03T20-35-06-01a1a31f-6859-7480-b786-4a22474b645f.jsonl), [Filing transcript](/home/orca/.codex/sessions/2026/11/03/rollout-2026-11-03T20-34-58-01a1a31f-488f-7f91-9db3-cce0ec5b0768.jsonl), [release transcript](/home/orca/.codex/sessions/2026/11/03/rollout-2026-11-03T20-35-16-01a1a31f-8d4d-7172-ab08-5604ce3b40be.jsonl), immutable commit content, and pre-cutoff receipts under `/home/orca/.codex/m1-20261103-203425/`. Some agent-message bodies are encrypted; task start/end times and reported results do not establish every internal reason for an interval. No post-cutoff monitoring, live HMS call, deployment, code modification or test was performed for this retro.
