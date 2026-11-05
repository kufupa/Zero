# Evening plan: paused retro and recovery recommendation

**Snapshot:** owner paused the executing goal at **2026-11-04 00:25:26 UTC**, after **3h51m01s** from the 20:34:25 kickoff. This extends the [125–200-minute retro](2026-11-03-evening-plan-retro-125-to-200min.md) by **31m01s**. Read-only review; no implementation, HMS action, deployment, flag change or interruption performed.

**Verdict:** useful Quote/prefill and backend fixes are deployed. The promised real-guest Create/Filing pilot is still incomplete. The latest deployment improved Create's refusal conditions but did not make Create work. The principal new discovery is a missing mandatory HMS pricing step, rather than an edge-case coverage problem. The earlier 100–125-minute recommendation relied too heavily on inherited Create readiness. A target described as “not guaranteed” still needed better evidence.

## 1. What staff can use

| Capability | Evidence at pause | Staff delivery position |
|---|---|---|
| Quote | Installed real-email route returned HMS R5,800 for the checked request. Shared pane has automatic Quote wiring. | Strongest candidate for a restricted staff pilot immediately. Actual Outlook selection/connection was not exercised in this run; route evidence does not establish every attachment, rate or host case. |
| Selected-email prefill and edits | Real selected-email analysis returned relevant fields; shared pane binds analysis and staff edits and invalidates stale approvals. | Deployed useful capability alongside Quote; host interaction remains unexercised. |
| Existing-profile Create | One earlier fake Save was rejected. After the latest deploy, preparation still refuses before a new Save; final average price remains blank. | Real-guest writes remain disabled. Two connected native preparation corrections remain: startup completion and draft pricing. |
| Supported PDF Filing | Extraction read the selected PDF; target-bound backend/uploader changes are deployed. No upload or Documents readback demonstrated this run. | Real-guest uploads remain disabled. The selected sample also exposes a missing staff target-input path; a direct operator script does not supply that pane capability. |
| Amend, Cancel, automatic New Profile | Explicitly outside this M1. | Keep out of the recovery queue. Missing profiles are created manually in HMS. |

Latest deployed main: **`1e2b2f7a0fa968acc2ad593d6ebb7fcc4c12f746`**, PR [#999](https://github.com/kufupa/Zero/pull/999). Four PM2 processes were online on that SHA at 00:05:52. Their effective process environments contain `PANE_WRITE_CREATE=lab`, `PANE_WRITE_ATTACH=lab`, Create dispatch on and attachment worker on. `remote-http` has these effective initial-process settings even though its PM2 metadata does not show every key. [Runtime receipt](/home/orca/.codex/m1-20261103-203425/runtime-deployed-1e2b2f7a.json).

One further real-product limit is confirmed in deployed code: **HMS confirmation sending is disabled for Cloud Create**, including the UI checkbox, and the mapper refuses `confirmationSendMail=true`. This is broader than keeping fake tests' sending off. If Create is released without changing it, tell staff that HMS confirmation sending needs a manual step; do not promise it works because the recipient selector exists. [UI restriction](https://github.com/kufupa/Zero/blob/1e2b2f7a0fa968acc2ad593d6ebb7fcc4c12f746/apps/mail/components/quote-workflow/booking-card.tsx#L1752) · [mapper refusal](https://github.com/kufupa/Zero/blob/1e2b2f7a0fa968acc2ad593d6ebb7fcc4c12f746/apps/server-pilot/src/ai/pane-create-cloud-input.ts#L56).

The Create reviewer also questioned native linking for multi-room based on a legacy comment. Root checked the call site: `parentStayId` is used only when `!cloudPreview`. That allegation does **not** establish a Cloud multi-room conflict. Sequential batch code exists; live 2–8-room success remains unproven. Do not start a batch matrix or expand the recovery scope based on that rejected claim. [Actual branch condition](https://github.com/kufupa/Zero/blob/1e2b2f7a0fa968acc2ad593d6ebb7fcc4c12f746/apps/mail/components/quote-workflow/booking-card.tsx#L1679).

## 2. “Labtest mode” and testing mean exactly this

The code runs against the live HMS property. **Labtest is the write-admission restriction to the approved fake guest**, not a separate development deployment. Quote and permitted reads can use real emails/guests while the write flags remain restricted.

The [submitted goal](../context/PROMPT-2026-11-03-m1-ship.md:59) explicitly required one fake native Create and one fake upload/readback. The owner also authorized enabling the M1 flags. Enablement was not awaiting another owner approval: the run never reached successful proofs.

**Fake Save/readback, fake upload/readback, preview experiments and existing test-suite execution all count as testing.** “Zero new tests” does not mean zero testing; the plan/prompt preserved existing checks and live proofs. Earlier reporting should have made that workload explicit.

Two separate gates exist:

- The checked-in environment writer requires genuine HRCEN canary evidence for each write flag it promotes from `lab` to `on`. [Promotion guard at the deployed revision](https://github.com/kufupa/Zero/blob/1e2b2f7a0fa968acc2ad593d6ebb7fcc4c12f746/apps/server-pilot/deploy/write-ec2-remote-env.sh#L466).
- The run's private cutover helper requires **both** Create and attachment canaries and promotes both together. That joint dependency is stronger than the checked-in writer's per-workflow requirement and undermines the plan's independent-release intent. [Private helper](/home/orca/.codex/m1-20261103-203425/release/m1-cutover.sh:97).
- The private Filing proof script separately requires a fresh successful Create before constructing its target input. This is an operator-script dependency, not a requirement to create a new stay for every native document upload. Its explicit fake override uses the selected real PDF with `lastName: 'Labtest'`. An existing fake target still needs to be established as eligible and correctly bound before changing that proof setup. [Filing proof precondition](/home/orca/.codex/m1-20261103-203425/filing-fake-preview-bind.sh:15).

Recommendation: keep one demonstrative fake operation for each write workflow because the first attempted Save exposed a basic failure. Cut additional matrices, fixture campaigns, repeated unaffected workflow checks and joint release dependencies. Native readback during normal product execution remains necessary to tell staff what happened. Removing a prelaunch proof gate would change release policy; it would not supply Create's missing pricing operation.

## 3. Where the latest 31 minutes went

These are consecutive wall-clock periods, not additive agent-hours.

| UTC | Elapsed | Outcome | ROI / criticism |
|---|---:|---|---|
| 23:54:25–23:59:55 | 5m30s | Independent review completed, #999 merged, deployment started. | Proportionate release tail. The patch still lacked an observed working native priced draft. |
| 23:59:55–00:05:52 | 5m57s | Bundle deployed and actual process SHA/env audited. | Genuine deployment; it did not add a working staff Create/Filing action. |
| 00:05:52–00:10:05 | 4m13s | Installed Create preview refused; native diagnostic identified the blocked Vault request during date staging. | Found a real startup race. |
| 00:10:05–00:14:34 | 4m29s | Code inspection and startup timing experiment; waiting allowed dates to stage. | Useful causal evidence. A simple “Ajax currently idle” predicate proved insufficient later. |
| 00:14:34–00:17:50 | 3m16s | Stage snapshots showed discounted BLRB changes the category; BAR input tried instead. | Avoidable operator input mismatch. Do not weaken the category guard to accommodate bad test input. |
| 00:17:50–00:22:28 | 4m38s | Correct BAR still had a blank price. Legacy code revealed missing Check Availability. Exact request captured with dispatch aborted. | Highest-value new discovery. It should have been checked before #999 was treated as the rate fix. |
| 00:22:28–00:25:26 | 2m58s | Draft-bound request metadata, guard-composition recommendation and network-idle experiment obtained; connected fix assigned. | Useful design input; no new implementation of that fix was present at pause. |

Coordinator sources: [review](/home/orca/.codex/sessions/2026/11/03/rollout-2026-11-03T20-28-50-01a1a319-a8cb-7e80-8700-4aceefa98931.jsonl:5431), [deploy](/home/orca/.codex/sessions/2026/11/03/rollout-2026-11-03T20-28-50-01a1a319-a8cb-7e80-8700-4aceefa98931.jsonl:5580), [startup issue](/home/orca/.codex/sessions/2026/11/03/rollout-2026-11-03T20-28-50-01a1a319-a8cb-7e80-8700-4aceefa98931.jsonl:5709), [missing pricing step](/home/orca/.codex/sessions/2026/11/03/rollout-2026-11-03T20-28-50-01a1a319-a8cb-7e80-8700-4aceefa98931.jsonl:5895), [pause](/home/orca/.codex/sessions/2026/11/03/rollout-2026-11-03T20-28-50-01a1a319-a8cb-7e80-8700-4aceefa98931.jsonl:6046).

Ten post-deploy Create SSM operations have recorded execution durations totalling **313.278 seconds (5m13s)**: eight browser/installed-path observations and two receipt-only reads. From preview launch at 00:06:54 to pause was **18m32s**. The remainder includes reasoning, code inspection, script preparation, dispatch, polling and coordination; it cannot all be assigned to model thinking. Successful SSM execution only means the diagnostic command completed: its product result may still be refused.

## 4. What went wrong

1. **Inherited tool readiness was overstated.** The first release estimate treated Create as a working tool requiring wiring. The new installed handler omits the pricing step already present in legacy Create. The first fake Save did not happen until approximately T+177, and the missing operation was identified at approximately T+224.
2. **A hypothesis was shipped before its native effect was demonstrated.** #999 selects the rate after final guest/party context and refuses a blank price. That is a useful guard. It does not calculate the price. Forty-four existing tests and independent review did not establish live Create readiness.
3. **Known staff gaps did not own an implementation queue.** Filing's missing target inputs were reported while Create was being diagnosed. Instead of addressing that product gap independently, the release sequence waited for Create's new fake stay and later reused Filing capacity for Create review.
4. **The release implementation reintroduced all-or-nothing delivery.** The canonical plan permits independent release; the private stage-two helper insists on both write proofs. Quote/prefill progress was reported without a clear restricted staff-pilot handoff.
5. **Test setup errors consumed product time.** Earlier closed-work-item selection cost about 16 minutes; the latest BLRB/category mismatch created another detour. Both are ordinary operator preparation mistakes, not evidence that staff need a complex eligibility engine.
6. **Guard layering adds real integration cost.** General read-only guards, per-tool request fences and the Save route chain all interact. The existing guard correctly denies Check Availability because it can re-rate/temporarily hold a rate. A narrow approved Create request must compose through these guards. Making the generic reader permissive would not be an acceptable shortcut.
7. **Status described merged code more clearly than usable staff actions.** “Most code done; final live checks remain” omitted missing pricing and the selected Filing sample's missing staff path. Report deployed, enabled, native-successful and staff-usable separately.

The Filing reviewer checked the deployed card independently: extracted surname plus arrival are required for automatic search, and exactly one matching row is needed to proceed. “Find booking” retries those extracted inputs; multiple rows offer open/copy actions rather than target selection. The card has no surname/date/confirmation editor. Other PDFs with complete extraction and one correct match can follow the conditional path; the failing selected sample does not prove every PDF fails. [Search gate](https://github.com/kufupa/Zero/blob/1e2b2f7a0fa968acc2ad593d6ebb7fcc4c12f746/apps/mail/components/quote-workflow/voucher-find-card.tsx#L201) · [approval gate](https://github.com/kufupa/Zero/blob/1e2b2f7a0fa968acc2ad593d6ebb7fcc4c12f746/apps/mail/components/quote-workflow/voucher-find-card.tsx#L452) · [staff controls](https://github.com/kufupa/Zero/blob/1e2b2f7a0fa968acc2ad593d6ebb7fcc4c12f746/apps/mail/components/quote-workflow/voucher-find-card.tsx#L516).

The strongest alternative explanation is that these diagnostics were all discovering genuine integration defects. That is partly true: startup and pricing failures are real. It does not justify the late first vertical proof, incomplete first rate fix, idle Filing queue or joint promotion requirement. There is no evidence of an unrelated Nava admin-clicking campaign during this latest window.

### Why existing tools and parallel lanes did not establish readiness

The plan's evidence table classified Create as merged identity/date/multi-room work with a release delta, and its dependency diagram had Filing, pane and release-prerequisite branches but no Create implementation branch. Create's native proof was budgeted as U1.5 after deployment. This failed to expose a fundamental inherited integration uncertainty before allocating the launch budget. [Planning assumption](../plans/2026-11-03-003-feat-pilot-independent-release-plan.md:65) · [dependency graph](../plans/2026-11-03-003-feat-pilot-independent-release-plan.md:100) · [15-minute verification unit](../plans/2026-11-03-003-feat-pilot-independent-release-plan.md:190).

The actual deployed call chain is shared pane → `pane-cloud-preview` → `tooling/hms-cloud/create-reservation.mjs` → `withBookingLookupSession` → individual native operations. Many operations exist, but their complete composition is not proven: the Cloud handler selects a rate and reads the form, while the older complete Create runner additionally runs Check Availability. That pricing action was inline in the older runner, not exposed as a lookup `runTool` operation. The Cloud Save route has an optional exact-request availability seam, but current Create wiring supplies none. Native field setters are therefore substantial reusable assets, not proof that the installed staff Create path is complete.

Diff `dc26b386..1e2b2f7a` changes 27 app files: eight Mail files, seven server-source files, two deployment files, three server tests and seven `hms-cloud` files (including two tests). **Zero files under `tooling/playwright-quote` changed during the evening run.** Cloud imports its exported track helper and shared browser/guard helpers; these imports already existed at kickoff. The old full Create CLI has a direct-invocation guard and is not run merely by importing its track helper. This is an incomplete Cloud composition over shared older helpers, not evidence that the executor switched to the old complete Create workflow. [Cloud loader](https://github.com/kufupa/Zero/blob/1e2b2f7a0fa968acc2ad593d6ebb7fcc4c12f746/apps/server-pilot/src/ai/pane-cloud-preview.ts#L67) · [inherited imports](https://github.com/kufupa/Zero/blob/dc26b38636cd37b6af90fd6cfbacdb5c7c2d545b/apps/server-pilot/tooling/hms-cloud/create-reservation.mjs#L11) · [legacy CLI guard](https://github.com/kufupa/Zero/blob/1e2b2f7a0fa968acc2ad593d6ebb7fcc4c12f746/apps/server-pilot/tooling/playwright-quote/create-lab-stay.mjs#L1453).

Parallelism can accelerate independent Filing, pane, deployment and review work. It cannot make dependent guest/date/rate/price/Save steps on one native draft simultaneous. The recovery needs one owner of the complete Create sequence, independently useful parallel work and early evidence of the actual critical native path; another swarm or another ungrounded ten-minute task list does not repair the readiness assumption.

## 5. Shortest recovery sequence

This is a recovery recommendation, not authorization to resume the paused goal. Preserve paused work and use existing owned descendants when the owner resumes implementation.

| Order / concurrency | Proposed owner | Concrete task | Completion evidence / stop condition |
|---|---|---|---|
| Start together | Coordinator | Inventory current deployed Quote/prefill admission and shared-pane selection wiring from existing outputs. Prepare restricted staff capability note: Quote/prefill in Nava; Create/Filing in HMS. | A clear usable first pilot, with unexercised Outlook connection disclosed. No full-suite or admin navigation campaign. |
| Start together | Create worker | Add bounded startup completion to existing new-stay session handling; revalidate the draft before the first date operation. Reuse observed network-idle evidence. | Date preparation survives the observed late startup request; keep Vault mutation denied. |
| Start together | Filing worker | Make exact stay identification available in the existing voucher card when extraction is missing or ambiguous. Prefer the existing name/date lookup; add confirmation lookup only if the existing API supports it. | Staff can supply missing details and explicitly select one target; edits invalidate approval. Source/hash and target binding retained. |
| After startup seam is understood | Create worker | Add the existing HMS Check Availability action to Create after final guest/track/party/rate staging. Authorize only the validated draft's exact one-shot request through existing session/fence seams. | HMS calculates a nonblank price and final draft identity/fields remain correct. No general reader exception; no fake-only production path. |
| After pricing action | Create worker | Return the actual prepared price and permit existing approval/Save only when the native draft is valid. Preserve source, duplicate, preimage and uncertain-write behavior. | Installed Prepare yields a truthful usable draft. Real existing-profile unsaved preparation must work through the approved production path; fake success alone does not prove this. |
| Concurrent with product work | Coordinator / reviewer | Arrange one independent review and applicable affected-head checks; reuse unchanged evidence. Make promotion workflow-specific using the existing supported writer. | No unresolved valid P0/P1; no new deploy framework or automatic repeat of every unaffected workflow. |
| When each slice is ready | Coordinator | Bundle deploy, perform exactly one fake installed operation/readback for the ready write, enable that workflow, verify effective process env. | Create and Filing release independently. Their proofs need not share a newly created stay if an eligible existing Proof Labtest 2027+ stay is actually available and source/target rules are satisfied. |

Normal installed real-profile Create preparation is itself denied while the dedicated flag is `lab`; `on` admits real guests. Following legitimate promotion, use a real-email **unsaved Prepare**, not a real-guest verification Save, to ensure the new pricing authorization works for the production flow. Count that as a live check; do not hide it under “no new tests.” [Current admission](https://github.com/kufupa/Zero/blob/1e2b2f7a0fa968acc2ad593d6ebb7fcc4c12f746/apps/server-pilot/src/ai/pane-cloud-preview.ts#L116).

Use **10-minute focus checkpoints** for the implementation tasks. A checkpoint must produce a patch, an observed result or one exact unresolved fact; it is not a 10-minute completion estimate. If the pricing/action seam remains unresolved at the checkpoint, report that fact and ship the independent useful capability instead of consuming another implicit launch deadline.

**Critical paths:** Create startup → draft pricing → approval binding → review/check → deploy → one fake Save/readback → Create promotion. Filing staff target path → review/check → deploy → one fake upload/readback → Filing promotion. Same-guest writes remain serialized; UI/code work and independent reads can overlap.

**ETA:** Quote/prefill have no identified remaining product-code blocker, but the host interaction is unexercised. A complete real-guest Create/Filing ETA is **unknown** until the missing pricing action yields a usable draft and the Filing staff path is resolved. Measured release tails provide a useful floor/comparable: #999 review/merge/deploy/audit occupied roughly **11½ minutes**, and the deploy/audit alone about **6 minutes**. This excludes writing the unresolved fix, native operation/readback, flag activation and new failures. Those historical durations are not a promise that the remaining product work fits another 100–125 minutes.

Do not silently descope Create/Filing and call M1 complete. Launch a clearly labelled restricted Quote/prefill pilot first, then release the write workflows when ready. This sacrifices immediate automation for those writes while delivering staff value and ending the all-or-nothing wait.

An intermediate Filing release can also explicitly admit only PDFs whose existing extraction yields one correct target, after its installed upload proof succeeds. Incomplete/ambiguous PDFs would use HMS manually while target corrections are added. That is a narrower partial delivery, not evidence that the selected sample or every advertised staff override works. Choosing another test PDF alone must not conceal the known sample limitation.

## 6. Sol versus Terra, confidence and cost

The executing log identifies **GPT-6.1 Sol, ultra effort**. No matched Terra execution exists in these sources. [Official OpenAI documentation](https://developers.openai.com/api/docs/guides/latest-model) describes Terra as fast and efficient, but gives no matched timing result for this run. Terra might reduce generation time; these records cannot quantify it or show that a model swap would solve the missing native step, operator mistakes or release dependencies.

Local evidence threshold is met for deployed SHA, write flags, failed Create preparation, missing pricing action and the explicit proof gates. Full completion time and broad staff/host readiness remain unresolved. Two bounded Luna reviewers inspected Create and Filing independently; actual dollar cost by model is not exposed by the available billing evidence and is not fabricated.

## 7. Recovery-plan challenge: 112 versus 1,112 fields

**The large request is native HMS serialization, not 1,112 required Nava inputs. The pending pricing patch has a real field-count bug.** I initially repeated the count without explaining its composition or connecting the earlier field-scope evidence. That was an avoidable review failure. It must not become a thousand-field implementation or exploration task.

After the coordinator pause, the existing Create worker produced [PR #1000](https://github.com/kufupa/Zero/pull/1000), head `ea70d728381f32228e617c510e264eb7768ee3a8`, based on deployed `1e2b2f7a`. Its five-file diff has 260 additions and 13 deletions, including a shared read-only-guard seam. It remains a candidate, not an installed working Create. Its `CHECK_AVAILABILITY_FIELD_COUNT = 112` and global case-folded uniqueness check contradict the actual saved request. Its reported 55 existing passing tests do not exercise that new internal pricing-authority path. [Candidate matcher](https://github.com/kufupa/Zero/blob/ea70d728381f32228e617c510e264eb7768ee3a8/apps/server-pilot/tooling/hms-cloud/guest-stay-rate-plan.mjs#L260).

Read-only file metadata on EC2, with no browser interaction or HMS request, established:

| Observation | Actual value | Implication |
|---|---:|---|
| URL-encoded request pairs / exact unique keys | 1,112 / 1,112 | No duplicate concatenation established. |
| Empty / nonempty values | 809 / 303 | Submitted field count is not a required staff-input count. |
| Case-folded unique keys | 1,110 | Two native case variants exist; blanket case folding rejects the real request. |
| Record state | `status=New`, HRCEN, blank confirmation/record/reservation/stay/share IDs | Consistent with the existing blank Guest Stay draft, not an existing stay being amended. |
| Request action | POST `/web/base/OSRESV.HDR.getcheckavailability`, `ONLY_DATA_REQUIRED=true` | This is Check Availability, not the Save request. |

Field names include arrival/departure, room and rate, guest preferences (`guestoptin1`–`guestoptin20`), native custom fields, child labels, display variants, lease/group/accounting fields, and toolbar controls such as `printmenu`, `emailicon`, `duplicatereservation`, `organizationsearch`, `checkavailability`. These are names in HMS's own request, not proposed Nava editors. Counts by overlapping prefixes include guest 85, rate 24, room 24, profile 25, and 181 numbered names; these categories do not sum to the full payload.

The case variants are `ishoteldatewithingroupdates` / `isHotelDateWithinGroupDates` with different values, and `confirmautoruleupdate` / `confirmAutoRuleUpdate` with equal values. Preserve exact vendor field names; do not collapse different values. Keep uniqueness checks for critical identity/action fields.

The diagnostic captures `request.postData()` from one actual native control action and then aborts dispatch. It does not fabricate 1,112 keys. Its saved schema summary commands are SSM `5be46f4f-5c57-4e67-a7c4-bd37d1f3c7f7`, `e949a20b-3e4c-44ad-894b-c2e97df20848`, and `4767f8b3-40ea-4b44-a0d1-122137e3b007`; all returned Success/0. The private file is `create-canary2-check-request-private.json` in the run's shared directory.

This was not a wholly new unknown: [guest-stay-save.md](../../apps/server-pilot/tooling/hms-cloud/guest-stay-save.md#L89) already explains 985 `record.getData()` keys versus 1,109 raw `record.data` keys, including 123 extra metadata fields and `extId`. Historical Save captures have 988 keys, including three Save controls. **Do not change the Save schema from 985/988 to 1,112:** these are different native representations and different actions. The arithmetic similarity of 1,109 plus three controls does not prove the exact current Check Availability/model field-set correspondence.

The current Create tool opens **Front Desk → Guest Stay → New Record**, as documented in earlier research and implemented in `lookup.mjs`. Earlier successful fake Creates used that route. This supports keeping the existing route; field count alone gives no reason to switch to an unexplored New Reservation screen. [Earlier route evidence](halloween/memory-experiments/2026-10-30-live-lookup-memory-prompt.md#L19) · [historical successful Create and known full-body fragility](halloween/2026-11-01-hms-17h-retro.md#L76).

**Smallest recovery:** repair the pending action guard against the current native draft, keep exact property/profile/stay/rate/action binding and one-request authority, let HMS calculate its own price, then run one installed priced Prepare and one authorized fake Save/readback. Address a specific observed mismatch if it occurs. No whole-form field classification, new pricing engine, or new approval protocol is a prerequisite. The owner approved rate-plan approval with HMS price/final result, not exact-price locking. Preserve existing source/approval/duplicate/preimage/uncertain-write checks.
