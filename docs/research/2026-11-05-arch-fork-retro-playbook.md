# Arch fork: UI retro + playbook for remaining work

**Status:** UI investigated manually with owner. Owner subsequently authorized retro of every plan unit; see the [complete retro index](/home/ubuntu/projects/zero/docs/research/2026-11-05-arch-fork-retro-all.md). No product changes, deploys or writes to HMS in this retro.

## 1. Owner's instructions

- Find the running `arch fork` transcript, overnight execution plan, related plans/design/MDs. Recover the original instruction and what was actually delegated.
- Start with UI, manually and together. Owner expected an overhaul/rewrite of the entire UI across workflows, retaining the general design and useful machinery. Do **not** claim complete shared understanding from an agent paraphrase.
- Reconstruct plan units and original estimates. For each, investigate intent → actual work → result → failure/causes → better next-time approach. Include useful work as well as shortcomings.
- Record actual elapsed time, lane, model/reasoning, meaningful LOC, tests, reviews, commits and PRs; compare estimates only where scope and measurement boundaries match. Investigate $/token cost where evidence permits.
- Break **every observed interval over 20 minutes**, including 20–60-minute intervals, into roughly 5–20-minute evidence-backed windows. For **every window** assess the useful return, bad/unmet outcome, cost/effort evidence and ROI limitations, even when financial ROI is unknown. Events shorter than five minutes may be grouped without losing duration; unknown activity stays unknown.
- Be concise for humans but detailed, sourced and durable for future LLMs. UI first; wait for owner sign-off on the playbook before repeating across the rest.

## 2. What we did and learned from UI

### Sources

- [Original UI task](/home/orca/.codex/sessions/2026/11/04/rollout-2026-11-04T22-12-42-01a1a89f-1ea0-7223-bb28-92aa9e7429d7.jsonl:22); [owner scope correction](/home/orca/.codex/sessions/2026/11/04/rollout-2026-11-04T23-29-11-01a1a8e5-2227-7832-bb3a-7d9f79094087.jsonl:867); [overnight coordinator transcript](/home/orca/.codex/sessions/2026/11/05/rollout-2026-11-05T01-12-38-01a1a943-d9d0-7e11-b9c7-2659e9af7287.jsonl:1); [original plan](/home/ubuntu/projects/zero/docs/plans/2026-11-04-002-feat-nava-pane-prefill-rate-parity-plan.md); [overnight plan W1–W14](/home/ubuntu/projects/zero/docs/plans/2026-11-05-001-feat-centurion-core-completion-plan.md:171); [design](/home/ubuntu/projects/zero/design_draft.md:172).
- Preserved initial execution-plan write: `/tmp/arch-fork-retro-20261105/initial-plan-write.txt` (temporary; current plan has later checkpoint edits). [UI report](/home/ubuntu/projects/zero/docs/research/2026-11-05-arch-fork-retro-ui.md) links other associated MDs; no claim every linked historical document has been independently audited.
- Compared prompts, architecture, W packets, worker transcripts, commits, PRs, checks and pinned deployed code `20e17dd0137e8791e76c06bd5fb16fdbd9cfbd20`. One independent reader checked PR/code evidence; primary agent manually traced intent, plan and Undo. Current root checkout is older/dirty and is not deployed-code evidence.

### Findings

1. **Scope/intent:** owner requested overhaul, later clarified entire UI rewrite. Original “wipe” + “not from scratch”/reuse left exact extent open to interpretation. Agent promised redesign, but true shared understanding is unresolved. High-level architecture mentioned recomposition; W2 narrowed Undo to cursor adoption and W6 emphasized field/partial-draft changes.
2. **Actual output:** substantial form, state, rate and native integrations shipped; full workflow recomposition and visible staff acceptance were not demonstrated. Original UI candidate: 22 commits, 30 files, +2,932/−427 including tests. Overnight #1020 inherited candidate work; do not add overlapping LOC as independent output.
3. **Undo:** pre-existing reducer preserves edited rows on a history restore. Diagnostic with pinned deployed reducer: restored 2→1→2, displayed 3→3→3. This reproduces reducer behavior; it is not a full browser/server test. Owner separately reported broken Undo. Overnight work left the defect, did not demonstrably introduce it.
4. **Verification:** tests and reviews ran; six history-control cases passed, but the Undo case asserted mutation/refetch, not visible restored value. No-new-tests direction did not mean no existing checks. Backend native Save/readback is useful evidence but does not prove pane usability. The plan did require staff-pane acceptance; it was not demonstrated.
5. **Time:** original UI task→handoff 88m29s; early integration→pause 52m39s; overnight candidate 22m33s and #1020 merge 35m01s; first release/proof window 1h03m15s, including three deploys and other work. Full overhaul completion time unknown. Lane A/Create Terra xhigh; B/rates Sol high; C/saved workflows Terra xhigh; coordinator Sol xhigh during the main run. Planned model and actual model may differ.
6. **Important correction:** prior “1h02m Create readback” was a misleading progress-to-report interval. Two specific readback/verification commands each took ~34s; first flagged rate-code/display mismatch, second passed after comparing the mapped display. Record reports, command execution and readback status separately.
7. **Limits:** no proof of exact avoidable minutes, a model causing the failure, all UI paths failing, actual pane acceptance, or complete USD cost. The original overnight worker's initial delegation payload is encrypted in local logs. Model choice, compaction and ambiguous wording remain hypotheses where evidence is insufficient.

**Combined example:** [one UI retro with intent, results, source evidence, timing, lane/model and ROI](/home/ubuntu/projects/zero/docs/research/2026-11-05-arch-fork-retro-ui-combined.md). Earlier [UI retro](/home/ubuntu/projects/zero/docs/research/2026-11-05-arch-fork-retro-ui.md) and [deep timing](/home/ubuntu/projects/zero/docs/research/2026-11-05-arch-fork-retro-ui-deep-timing.md) remain as source artifacts. A 92-row window audit found no timed table interval outside 5–20 minutes; this is not proof that every minute of every worker was independently audited.

### What the UI investigation adds to the repeat method

| Practice | Why it matters | UI example |
|---|---|---|
| Trace request → packet → output → acceptance | Detect scope lost before coding as well as execution failure. | Whole-UI intent vs W2 cursor and W6 field repairs. |
| Check what passed tests actually asserted | A green result can verify the wrong outcome. | Six history cases passed; no visible Undo value assertion. |
| Inspect test output, shell semantics and rerun scope | Shell success can mask failed tests. | One four-file run logged 5 failures despite exit 0 because of `; tail`; later green rerun covered three files. |
| Pin deployed code and establish pre-existing baseline | Distinguish introduced defect from unresolved existing defect. | Reducer failure predated run; overnight changes left it. |
| Compare plan model/owner with recorded lane/model | Show actual routing and attribution, not assumptions. | W2 planned Terra medium; A actually Terra xhigh. W5 planned Terra xhigh; B actually Sol high. Shared work prevents exact unit-level allocation. |
| Use actual command boundaries, not report labels | Prevent inflated or false task timings. | “1h02m readback” included releases and other work; two command intervals ~34s. |
| Trace reused code, PR boundaries and later fixes | Measure concrete contributions without counting the same work twice. | #1014 unmerged but candidate reused; #1020 includes inherited work. |
| Judge both good and bad using evidence | Useful safety fixes and failed user outcome can coexist. | CMS correction and native readback were useful; full pane acceptance was missing. |
| Challenge initial conclusion and record corrections | User feedback and counterevidence improve the retro itself. | Rechecked wording clarity, 5m21 claim and vague timeline rows. |

**Weaknesses to fix next time:** first pass omitted actual model granularity, mislabelled a mixed hour and then a report gap, and some time windows initially lacked actual work details. Initial claim that wording was clear overstated evidence. The retro now has a recorded-usage cost estimate, but no actual bill or independent before/after visual audit. Do not confuse 5–20m formatting with a complete activity inventory.

## 3. Coverage map after sign-off

Use the original plan and owner instructions as well as the execution plan. Map all requirements to W units; add separate rows for any requirements dropped from W1–W14. Existing UI work is a starting point, not proof of W4/W5/W7–W9 or any entire non-UI workflow.

| Unit | Plan scope | Planned active-lane budget |
|---|---|---:|
| W1 | Candidate integration | 20–35m |
| W2 | Undo/reset | 10–20m |
| W3 | Quote freshness | 10–25m |
| W4 | Filing acceptance | 0–20m audit; 25–45m conditional |
| W5 | Selected native rates | 25–55m |
| W6 | Editable Create | 40–70m |
| W7 | Quote output | 15–30m |
| W8 | Batch continuation | 10–25m |
| W9 | Amend/Cancel | 25–50m |
| W10 | Native party binding | 15–30m |
| W11 | Final checks/review | 15–30m |
| W12 | Release/native proof | 55–105m |
| W13 | Voucher/prefill | 35–70m |
| W14 | Frontdoor/remaining asks | 15–35m |

Budgets exclude/add shared gates as stated by the plan; these are not elapsed completion times. W units overlap and contain subtasks; split them further where required to explain distinct user outcomes. Distinguish conditional/deferred work, checkpoint work, original requirement, replan and later owner changes.

## 4. Repeatable investigation for each unit and meaningful subtask

1. **Instruction and intent:** quote/link owner direction, original requirement, plan packet and actual worker prompt when readable; preserve time/version and subsequent changes. Identify ambiguities, expected user/business result, acceptance criteria and omitted requirements. Do not infer comprehension merely because an agent repeated words.
2. **Plan:** owner, planned lane/model, estimate, dependencies, intended checks, change budget, source state and scope. Note whether it was already built or merely a candidate.
3. **Actual execution:** locate real worker(s), model/reasoning, timestamps, task switches, progress, commits, review, checks, PR, merge, deploy, proof and follow-ups. Split each observed interval over 20m into ~5–20m windows with timestamped events; distinguish actual command start/end from delayed messages. Mark concurrent/unknown work; do not equate wall time with active effort or add overlapping lanes.
4. **Output and usefulness:** compare before/after at relevant SHAs; enumerate shipped behavior, genuinely useful repairs, partial or unmerged work, missing requirements, user-facing result and limitations. Separate inherited/reused changes, mechanical/generated code, product code and tests. Give PRs and additions/deletions by explicit diff boundary; avoid double counting.
5. **Verification:** identify actual test/check commands, results, skips, failures, review findings and reruns, plus what assertions/proofs establish. Inspect relevant tests/code where failure matters. Distinguish local candidate, merged/deployed SHA, backend readback and actual staff interaction. Classify outcomes: verified / partial / failed / unverified / deferred, with precise evidence.
   Inspect the test runner's output and shell/pipeline status separately; do not treat `tail`, `tee`, `|| true` or a subset rerun as proof the original suite passed.
6. **Failure analysis:** trace the concrete chain from wording → interpretation → packet → implementation → verification → reporting. Compare plausible alternatives and counterevidence. Separate demonstrated mechanism, supported hypothesis and unknown; do not assume model, compaction, user wording, idleness or a baseline defect caused a failure without evidence.
7. **Time/cost:** identify start/end for candidate, integration, review, release, proof and rework separately. Compare plan's active-lane budget against elapsed only with caveat; do not manufacture exclusive coding minutes or imply incomplete work finished. Capture recorded per-response token usage, model, cached/non-cached categories, and timestamp/worker boundaries when feasible; deduplicate records and disclose overlap/shared effort. Calculate estimated $ only with verified applicable rates/billing context; otherwise state unavailable. Reasoning tokens may be included in output, so avoid double counting.
8. **Improvement:** provide concrete instruction/acceptance and the cheapest appropriate evidence that would detect the failure, respecting owner rules on tests and native proof. Identify what to retain, what should change, and what cannot yet be concluded. Do not substitute speed, LOC or test count for usefulness.

### Required record: specific asks, together

For every W unit and meaningful subtask, create one connected record containing:

| Question | Required output |
|---|---|
| What was asked? | Exact source-linked owner prompt, original/revised plan, actual worker prompt if available; intended user outcome, acceptance and ambiguity; explicitly surface requirements omitted from packets. |
| What was planned? | Estimate and measurement type, planned owner/model/effort, dependencies, intended LOC/checks; conditional work and known inherited candidate. |
| What really happened? | Ordered ~5–20m timeline, real UTC start/end, lane + actual model/reasoning, concurrent work and recorded activity; each row links evidence. Group sub-5m events; mark gaps. |
| What was produced? | Exact PR/commit/merge/deploy SHA; behavior before/after, product vs test LOC by explicit diff boundary, inherited versus new, dependent or unmerged work. |
| Did it work? | Actual commands and assertions, pass/fail/skip/review results, proof level and limits; separate candidate, merged, deployed, native verified and user-visible acceptance. |
| Was it good? | Useful behavior and why; defects, omission and why; staff/business outcome and whether it met requested intent. Avoid treating unverified as failed or passed. |
| Why? | Mechanism, competing explanations, evidence for/against, pre-existing vs introduced, impact of handoffs, dependencies, changed instructions and reporting. Mark unknowns. |
| Time/model/cost? | Planned vs actual lanes/models, candidate/merge/proof boundaries, rework/deploy/checks, inclusive vs exclusive and overlaps; response-level usage, cached/input/output, actual billing if available. Never infer model caused outcome. |
| ROI? | Observable benefit and proof, resources/cost, limitations, reasonable counterfactual and whether return can actually be calculated. Include both useful and ineffective work. |
| What next time? | Specific instruction, task decomposition, acceptance scenario, proof/check and routing/process change that would address the evidence-backed failure. |

**Timeline/ROI row schema:** `UTC start–end | elapsed | lane/model/effort | intended subtask | actual activity + output | check/PR | useful return | failure/gap | recorded or estimated cost | verdict + evidence`. Assess every row, not only broad task categories. Not every row requires a code diff or test; specify when nothing relevant is recorded. Intervals >20m must be broken down even if less than one hour. A timestamp span identifies observation, not exclusive labor; overlapping row costs are not additive.

### ROI method: specific and honest

For both **overnight execution** and **the retro itself**, assess separately:

1. **Benefit:** outcome completed, staff problem removed, defect found or risk reduced; link proof and note whether users actually received/used it.
2. **Cost:** comparable wall-clock phases; attributable worker/model tokens or actual billing, review/rework and human time when recorded. Identify overlapping/shared time and reused code.
3. **Quality:** expected vs actual user outcome, verification level, defects and downstream rework. Partial benefit is possible even when the overarching task failed.
4. **Counterfactual:** what credible alternative could have reached the same verified outcome at lower cost? Label proposed alternatives as hypotheses unless data exists. State when a high-value result required unavoidable dependencies.
5. **Verdict:** `positive evidenced contribution`, `partial contribution`, `no evidenced benefit`, `failed outcome`, or `unknown`; give reason and evidence, not a fabricated numeric ROI. Numeric ROI `(benefit − cost)/cost` only if comparable monetary benefit, cost, period, attribution and counterfactual are supported; otherwise say which inputs are missing. Do not call an unmerged candidate wasted if later reused or count the same value twice.

UI calibration: the deployed UI overhaul is not established, but #1020 shipped useful connected work; earlier #1014 was unmerged yet reused; 6 history tests checked calls but missed displayed Undo; source/CMS fixes and backend readback had value without proving UI. The three deploy commands consumed ~17m06s combined elapsed inside the 1h03m15s mixed proof window; no evidence establishes how much was avoidable. Overall dollar ROI is unknown. Retro produced actionable scope, reducer and verification findings, but its billed cost is not established; the combined UI retro records a timestamped model-rate estimate; ROI is not numerically calculable.

**Measured usage example:** direct UI worker, Terra xhigh, 88m29s: 919 unique logged responses, 138,067,000 input tokens including 136,528,257 cached; 399,422 output including 137,627 reasoning. Overnight Create worker candidate, Terra xhigh, 22m33s: 210 responses, 26,808,962 input including 26,276,828 cached; 79,570 output including 19,658 reasoning. [Boundaries and caveats](/home/ubuntu/projects/zero/docs/research/2026-11-05-arch-fork-retro-ui-combined.md). These are worker response totals, not complete multi-agent or itemized task bills; recorded dollars remain unknown.

## 5. Required deliverables and guardrails

- **One canonical combined Markdown report** with a concise human index and complete per-unit LLM-readable sections: intent, planned/actual, 5–20m timeline, lane/model, tests/PRs/LOC, outcomes, ROI, failure evidence and prevention together. Link supporting raw evidence/source artifacts; do not scatter timing and models into separate required reports. If size forces supplementary files, retain the complete index and direct section links in the canonical report.
- Include full coverage/status, original estimates vs comparable actual boundaries, costs and next-run decisions. Include exact source paths/timestamps and a completion/coverage ledger so no requirement vanishes during compaction.
- Cross-unit synthesis: repeat failures, critical path/dependencies, calibration opportunities, useful work vs unresolved outcomes; distinguish shared work from per-unit work. No claims of precise wasted time or USD without evidence.
- Preserve active sessions, branches and worktrees. Read-only code/log/PR investigation; no product modifications, external messages, deploys, DB writes or actual HMS writes as part of this retro. Obtain any separate authorization required for different work.
- The owner has now authorized the broader audit; the original UI-first sign-off gate has been satisfied.
