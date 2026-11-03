# Option A deep retro — evidence cutoff 2026-11-03 19:14 UTC

**Verdict: run failed to turn substantial product work into shipped staff value. Main causes: uncertain native work treated as small wiring, releases coupled to slowest lane, stale-task compaction, and verification work allowed to become separate projects.**

Owner's success criterion: working HMS tools → real-email prefill → staff edits/Go → production workflow. Minimal ceremony. Latest owner correction governs this review: **use existing pane output/direct methods; do not click through admin UI for proof.** My earlier commentary incorrectly conflated output verification with GUI navigation.

**Subsequent owner steer:** no new tests; current instructions supersede stale PRODUCT.md requirements; Cancel may be deferred if it delays the other workflows. Historical eligibility recommendations below describe the audited run's contract, not a new requirement to build an automated staff-decision system. The follow-on [independent-release finish plan](../../plans/2026-11-03-003-feat-pilot-independent-release-plan.md) separates remaining features from release blockers.

**Latest scope cut:** automatic New Profile creation is deferred. Launch Create uses an existing HMS guest profile; staff can create a missing profile in HMS before resuming Nava. Historical findings about absent profile Save remain valid, but that absence no longer blocks this launch or contributes to its ETA.

**Latest delivery decision:** owner agrees Quote + existing-profile Create + Filing + prefill is milestone M1, with a requested 100–125-minute delivery budget. The follow-on plan uses a 120-minute operating target and moves Amend work until after M1 is deployed/verified. Historical Amend requirements remain follow-on scope, not first-launch dependencies. This budget is not a measured whole-milestone ETA.

**Startup cleanup, owner-requested:** local [PRODUCT.md](../../../PRODUCT.md) and [AGENTS.md](../../../AGENTS.md) now contain the product scope and execution rules. Duplicate AGENT.md, START-HERE and current RUN-CONTRACT were deleted; CLAUDE imports and the [new M1 prompt](../../context/PROMPT-2026-11-03-m1-ship.md) were updated. Stale mandatory reporting, hard size/.ok gates and duplicate full checks were removed from current guidance. This documentation cleanup does not fix the unexercised runtime flag/canary bootstrap path.

Scope: Option A execution from 14:42 to 19:14 UTC, not every historical run. Earlier retro stops 19:05. At cutoff 274 wall minutes had elapsed versus 120–165m target. Latest saved production observation remains `0da451e`; no subsequent deployment appears in captured execution. Read-only origin inspection confirms merged main `dc26b3863`. This is a dated audit, not a fresh production-health claim.

Evidence: 23 sessions (coordinator +22 workers), 4,137 outer tool calls, 5,477 distinct recorded shell-command events, Git history/PR metadata, native probe reports, source, deployment draft. Three bounded Luna Max audit workers. No implementation, deployment, flag changes, live browser or DB tests performed for this retro.

## 1. Claims that survive adversarial checks

| Claim | Verdict | Evidence / counterevidence |
|---|---|---|
| Nothing from this run had deployed by cutoff | Supported | Coordinator repeatedly reports old prod SHA; no deploy invocation found. U0/Create/release prep did merge. Useful code exists. |
| Every task was waste | False | Alias-safe target holds, general identities/dates, exact prices, stale Cancel/Go binding and durable flags repair genuine production failures. |
| Finished Create was held behind Amend | Supported | 16:51:51 coordinator says Create focused checks/review pass and Amend remains release blocker. Create merged 18:20:31. Final release checks/proof were still missing; “ready to deploy” overstates readiness. |
| Admin clicking was required | Rejected under owner constraint | Output verification does not require GUI navigation. Browser lanes repaired selectors/overlays/request guards on old deployment and produced no actionable write canary. |
| Tests account for hours of overrun | Unsupported | 133 detected test invocations sum ~20.1 host-observed command-min across parallel lanes; coordinator ~2.28m. Writing tests/review/fix time is separate, unmeasured exactly. |
| Successful `amended` proves date workflow | False | [product58b:15](/tmp/nava-u3-rate-probe-HLLwep/product58b.mjs:15) changes adults only and directly calls native functions. Earlier [product56](/tmp/nava-u3-rate-probe-HLLwep/product56.mjs:15) changes dates/adults but returned UNKNOWN. |
| Multi-night retain was a ~15-line task | False | ~15-line second-Save defect was one subtask. Native sequence, per-night evidence, real identities, server/UI approval propagation and product-module integration remained. |
| Varying nightly rates were invented scope | Too strong | Per-night retain correctness is explicitly in accepted scope. Synthetic fixture construction and extended-date discovery need bounded treatment; first release need not wait for every case. |
| NGI-only means safely unpaid | Unsupported by label alone | Zero deposit/NGI does not independently prove no payments or secondary folio charges. Keep actual unpaid evidence/refusal, even if widening stops. |
| 75–90m P50 / 2.5–3h P90 is measured forecast | Unsupported | Few heterogeneous PRs, no completed comparable release, estimated implementation/deploy tails; no percentile basis. |
| More parallel agents should have solved it | False as stated | 22 workers, ~703.7 overlapping worker-turn minutes. Delivery remained governed by serial coordinator/native/merge/release dependencies. |

## 2. Critical path was mispriced before implementation

Plan arithmetic: `20 + max(65,45,65) + 35 =120m`; 165m adds 45m contingency. Arithmetic is valid. Inputs were not calibrated to remaining work.

| Unit | Target | Observed milestones | Judgment |
|---|---:|---|---|
| U0 policy/dispatch | 20m | Start 14:42; merged 15:16:20 (~34m) | Necessary shared contract; estimate omitted alias/completion defects and review fixes. |
| U1 Create | 65m | Worker started 14:59:50 (prep before U0 merge); focused/review-ready 16:51:51; merged 18:20:31 | Generalization plus stopped-batch repair delivered. ~89m between reported ready and merge was avoidable release queueing, not additional Create build. |
| U2 Filing/Cancel | 45m | First implementation 15:18–15:47; repair/review through ~17:27; still unmerged at cutoff; finance probes 18:45 onward | “45m” mixed identity wiring with a missing Cancel executor, UI state, native scope/payment semantics. Initial coding was fast; launch convergence failed. |
| U3 Amend | 65m | Research from 14:46; Sol escalation 15:27; two-Save native retain proof ~17:35; native product modules return `amended` for adults only ~18:35 (reported18:37) | Unknown native behavior dominated. Not priced as research. Further fixture/extension work continued instead of freezing release envelope. |
| U4 release | 35m | Prep throughout; #990 merged 18:21:56; cutover draft not applied; no final remote typecheck/deploy in captured execution | Not “no work.” Release engineering happened, but no completed release. Final tail still unmeasured. |
| U5 profile / U6 re-shop | 75–90 /90–120m | U5 recon began before U4; neither workflow delivered | Real feature gaps. Recon was premature scheduling, not substitute for delivery. U6 was deferred in plan, not accidentally completed. |

**Key distinction:** no-scope-cut means preserve final goal. It does not require withholding an independent completed workflow until every other workflow is done. Plan's U4 dependency on U0–U3 made that withholding the default.

## 3. What was overengineering or avoidable churn

Amend native facts: 77 `.mjs` artifacts, not 77 confirmed writes. Necessary core sequence proof came after a wrong availability/reprice assumption. Synthetic varying-rate fixture creation then consumed another late phase; extension/date changes are core, so deferral needs explicit supported/refused envelope. See [full U3 chronology](amend-findings.md).

| Work | Why done | Critique | Better action |
|---|---|---|---|
| Rewriting execution prompt after compaction | Stale latest user instruction survived fork | Pure waste. Seven regenerations ~14.12 coordinator minutes; prompt checker another 2.16 worker-turn minutes. | Resume concrete active outcome; authority file is supporting source, not goal's entire meaning. |
| Excess coordinator context / repeated compaction | Large source/tool/probe/agent history | Eight compactions ~24.57m. Workers continued, so not additive deploy delay; controller repeatedly lost task and release focus. | Short durable scoreboard, bounded worker returns, concise evidence pointers. |
| Admin navigation / source hunting | Attempt to obtain selected-email/pane canary | Violated owner speed constraint. Needed output evidence became navigation, overlays, selectors, unread-mail hunting and probe repair. | Direct exact-source route/pane output; representative email plus staff overrides; one bounded output check. |
| Probe request fence blocking normal reads | Avoid accidental writes | Boundary matters; overly restrictive temporary harness made itself the failure under investigation. Repeatedly repairing its allowlist inflated work. | Reuse established session/read methods; identify actual Save boundary. Broad POST prohibition is not meaningful in HMS, where reads also use POST. |
| Copying numbered probe/save scripts | Iterate native hypotheses | A fixture/protocol test evolved into many near-duplicates, copied bugs and diagnostic failures. | One parameterized probe, one named hypothesis, one observable decision per run; keep known-good helper. |
| Varying-rate fixture construction before first release | Prove every-night retain rather than averages | Correct question; unbounded fixture creation is poor release sequencing. | Bound research. Unsupported inputs get explicit refusal/hold while proven independent workflows ship; retain requirement stays in remaining scope. |
| Broader Cancel financial discovery before launch | NGI-only/zero-deposit gap | Payment ambiguity is real. Broadening all guarantee/folio shapes need not block Create/Filing or an already proven supported Cancel class. | Freeze actual supported unpaid contract; hold unsupported/unknown cases. Do not treat NGI label as proof. |
| U5 reconnaissance before Tranche1 release | Use spare capacity / prepare next tranche | Some useful native facts, but coordinator kept taking new work while release remained unopened. One worker was repurposed across profile, cutover, canary and finance. | Free coordinator for release; bounded recon only if disjoint and no launch dependency. |
| 413-line private cutover wrapper | Preserve existing settings and verify four processes | Preserving settings is necessary. New staged copy/rollback/fsync/process-environment framework increases review surface; only syntax checked. | Small merge-preserving change in existing writer and existing verification path. Do not turn flag activation into another framework. |
| Repeated reviews/tests as source changed | Validate evolving contracts | Real findings valuable. Repetition reflects unstable integration contracts and late scope discovery. | Freeze connected slice, run affected checks and one independent review; reopen only for actual defects. |

These verdicts do not establish exact “minutes wasted” for every cluster. Parallel intervals overlap; native waits, reasoning and code/test writing share turns. Assigning all elapsed probe time to waste would be fabricated precision.

[Every worker task, active/span timings, rationale and verdict](TASK-LEDGER.md). [Every native probe artifact and phase judgment](PROBE-LEDGER.md) preserve individual filenames/times; grouping does not silently omit retries.

## 4. Compaction failure is directly visible

After initial goal activation, seven later replacement histories end with ordinary user request: **“Cool. Give me the full /goal-style prompt that I can copy-paste into this chat.”** The goal-activation message is absent from those replacement user histories. Goal continuations still provide a file-pointer objective, but coordinator repeatedly follows stale prompt request.

This is stronger evidence than “smart model overthinks.” It identifies concrete context failure plus agent failure to re-anchor. No new owner requests for those seven prompts appear in execution window.

[Exact replacement-history locators and timings](compaction-analysis.md). Prompt generation ~14.12m; compaction ~24.57m. Workers kept running; those totals cannot be added to native delays or called exact time-to-deploy savings.

## 5. Actual product code exists; generic tools had lab assumptions throughout

| Landed change | Product +/− | Tests +/− | Meaning |
|---|---:|---:|---|
| U0 #988 | +529/−92 | +452/−40 | Target identity/history, aliases, completion, shared readers. Also docs/ops outside these totals. |
| Create #989 | +1052/−326 | +1051/−50 |19 product files; identity/date/profile/guarantee propagation plus batch recovery/UI. |
| Release prep #990 | +58/−8 | +275/−5 |113/−7 ops lines additional: env/parser/remote forwarding and browser-hold scope. |
| Net merged baseline→main | +1639/−426 | +1778/−95 | Not all dormant scaffolding; also not a trivial flag flip. |

Previous retro's `+2103/−376` for Create is total PR diff, not product-only lines. Half additions are tests. LOC does not measure effort or justify every abstraction.

Underlying architecture mistake predates this run: fixture identity/date assumptions embedded inside generic readers, profile proofs, Save matchers, recovery schemas and dispatch. Generalizing one caller cannot fix downstream literal checks. U1 was repairing that coupling across actual installed path, not building production functionality from zero.

Keep general identity/policy boundary. Do not spend pilot time cosmetically renaming every `labtest` filename. Judge runtime admission and call path, not names.

## 6. Significant pilot gaps still remain

| Staff requirement | Evidence at cutoff | Gap / consequence |
|---|---|---|
| Real-email prefill on open | Background mechanisms exist; runtime flags differ between processes; no actionable final-SHA output proof | Enablement and actual source→result→pane behavior unverified. Caps/flags alone cannot establish readiness. |
| Quote + staff input | Installed native Quote deliberately retained | Correct to avoid migration. Current scope includes agency/company rates; complete deployed behavior not re-proven by this run. |
| Existing-profile single/multi Create | Landed general code; release tail missing | Most useful available shipping candidate. Multi partial/uncertain state must stay truthful. |
| First-time guest Create | No-match cannot yet create required profile | Common booking path incomplete. U5 is meaningful feature, not decorative edge case. |
| Filing | General Cloud path implemented; shared identity/approval fixes; unmerged, final deployed proof missing | Not delivered staff workflow yet. Byte re-download project unnecessary; exact source/hash/upload-target/listing evidence sufficient for scoped claim. |
| Retained date/adult Amend | Adult-only native-module proof for fake three-night stay; earlier date+adult returned UNKNOWN; no deployed route proof | Useful core mechanism. Earlier 4→3-night shortening persisted with positive fresh readback but returned uncertain; after fix only adult-only result was re-proven. Added/shifted dates and nonuniform mapping unresolved. |
| Room/rate-plan Amend / re-shop | U6 unimplemented/unverified | Significant explicit feature gap. Flags cannot create saved-stay Room/Rate Shop path. |
| Unpaid Cancel | New executor/UI/state fixes exist; guarantee/payment scope unresolved; final effect proof missing | Not flags-only. Paid/penalty/uncertain cases require hold; actual supported class needs proof. |
| Human overrides / selected-source stability | Several actual review fixes in mounted components | Binding is essential: Go must describe and save fresh selected target, not cached guest or prior email's action. Output-based verification can cover this without admin clicking. |

Manual typed amend amounts were explicitly dropped in current PRODUCT scope; native rate-plan/re-shop change remains required. Do not invent a fresh custom-rate requirement from historical speech.

## 7. “Ship now” steer also has unpriced work

Previous steer correctly prioritizes release and bounds unfinished research. It overstates **“main deployable now”**, proposes coverage narrowing as if already accepted, and prints unsupported percentile ETA.

Known release issues:

1. Final release-head affected-app remote typechecks not run in captured execution.
2. Proposed same-night-count shift envelope is not established. Imported native projection requires every target date already exist in saved schedule; ordinary shifted dates add new dates and refuse. It also refuses nonzero tax/fees; production prevalence is unmeasured. [Native projection](/home/orca/.codex/worktrees/22ad/zero/apps/server-pilot/tooling/hms-cloud/labtest-amend-retain-proof.mjs:112). The actual demonstrated date effect is shortening 4 nights→3, not arbitrary same-length shift.
3. Current cutover draft flips several workflows together; Create-only release requires concrete narrowing, not simply running same draft.
4. Remote writer requires matching HRCEN canary token with exact 40-character final SHA before relevant off→on transitions. Notes identify no in-repo producer and acknowledge possible circularity if required proof itself needs those flags. Existing guard cannot be bypassed or receipt fabricated.
5. Candidate route: establish actual final-SHA fake/native component proof through authorized guarded path, record honest evidence, then cut over and verify actual selected-source output. Whether that satisfies current pre-flip contract must be resolved explicitly; no evidence in captured run establishes completed solution.
6. Latest main policy allows any clean worktree at origin/main. Dirty designated deploy tree was resolved early; it should not remain a release excuse.

**Possible circular gate is an unresolved release-design gap, not proven reason for past hours:** no completed cutover attempt reached it. Fix finite release path before saying the pilot is ready.

## 8. Faster operating contract, without pretending scope is finished

- Release owner starts independent workflow's release tail when its connected candidate is ready. Merge/check/cutover is a task, not end-of-run ceremony.
- Keep final goal's coverage; ship honest supported cases progressively. Any product narrowing is explicit, not silent.
- Native unknowns: named hypothesis, bounded attempts, supported/refused outcome. Repeating same mechanism triggers strategy change; new case does not automatically become current release gate.
- Honor direct-output/no-click verification. Preserve exact source, staff overrides, trusted mode, target, final SHA and native result. State which UI interactions remain unverified.
- Keep small checks for wrong guest/source, duplicate/uncertain effects, exact approved prices/body, penalty abort and genuine worker/env admission. Cut speculative harnesses, repeated equivalent fixtures and broad manual navigation.
- Keep actual independent defect review. Remove duplicated process gates whose evidence does not change launch decision; do not remove native write correctness.
- Estimate build, unknown-native research, integration and release separately. Use completed comparable units for ranges; label unknown tails. No invented P50/P90 or “15 lines means65m.”
- Fresh execution context: concrete outcome in active goal; authority/spec file secondary; compact scoreboard records deployed SHA, ready slices, current unknown, next release action.

Your prompt was not the main failure. It supplied broad finish scope and a serial release DAG that encouraged waiting. AI authored/accepted estimates without proving native assumptions, lost execution task repeatedly, and failed to protect shipping from new investigations. “All units eventually” should not have become “nothing deploys until all first-tranche uncertainties disappear.”

## 9. Sources, exhaustive inventories and limits

Independent bounded tracks: [Amend forensics](amend-findings.md), [Filing/Cancel/release forensics](filing-release-findings.md), [plan/Create code review](plan-code-findings.md). Parent cross-checked decisive results against actual scripts, receipts and imported source; agreement alone is not evidence.

- [All recorded outer operations](operations.csv):4,137 rows, UTC/agent/tool/category/raw-line locator. Categories heuristic; not percentages of waste.
- [All distinct recorded shell commands](commands.csv):5,477 rows, UTC/agent/status/host-observed duration/raw-line locator. Raw command text omitted to avoid duplicating credentials; source remains accessible.
- [Worker session inventory](sessions.csv), [turn events](turns.csv), [mechanical metrics](METRICS.md).
- [Visible coordinator evidence](coordinator-evidence.md), [visible worker evidence](worker-evidence.md), [compaction analysis](compaction-analysis.md).
- [Prior retro](/home/orca/.gemini/antigravity-cli/brain/cd12dfc8-785f-461d-8001-fa996eac521a/sol-ultra-retro-2026-11-03.md); [ship-now handoff](../../context/HANDOFF-2026-11-03-option-a-ship-now-steer.md); [accepted plan](../../plans/2026-11-03-002-feat-general-cloud-real-pilot-plan.md); [original execution authority](/home/orca/.codex/attachments/7560d57f-7ce9-4d29-ae01-3a151fc122fc/pasted-text-1.txt).
- PR primary metadata: [#988](https://github.com/kufupa/Zero/pull/988), [#989](https://github.com/kufupa/Zero/pull/989), [#990](https://github.com/kufupa/Zero/pull/990).
- [Cutover notes](/tmp/zero-option-a-u4-cutover-notes.md), [413-line unexecuted draft](/tmp/zero-option-a-u4-cutover-draft.sh).

**95 threshold:** met for release coupling, stale-prompt failure, invalid forecast basis, real integration gaps and no-click waste. Not met for exact causal waste minutes, current live state, universal retain semantics, payment completeness or whole-pilot ETA. Route: local history/code/artifacts + bounded subagents.

Encrypted worker messages/reasoning unavailable in portions of saved history. Every recorded operation is catalogued; every internal intention cannot be recovered. Timing tables distinguish span/turn/runtime and avoid adding concurrent work. Dollar costs unavailable; usage counters in METRICS are not billed spend. Original historical no-click message locator not recovered; current owner confirmation is explicit and accepted.

**Complete: source-linked retro, every-worker task ledger, command inventories, native-probe artifact ledger. Execution session and production untouched.**
