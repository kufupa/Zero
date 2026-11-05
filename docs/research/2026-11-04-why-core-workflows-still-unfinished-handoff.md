# Nava: why autonomous runs still fail to finish core workflows

**Self-contained engineering handoff. Historical audit: Nov 4, 23:48 UTC. Overnight update: Nov 5, approximately 08:00 UTC, sections 12–15. Caveman ultra. Evidence and limits embedded; other files are audit identifiers, not required reading.**

**TL;DR: repeated component delivery; incomplete product delivery. Native Create has saved repeatedly. Agents keep rebuilding/generalizing its surrounding contracts, finding integration defects late, then treating merged/flagged/backend-proved work as near-complete. Reviews catch much self-created rework. Tests contribute some waste; evidence does not support “tests consumed most of month.” Cloud rewrite improved tools; did not fix delivery behavior around them.**

## 1. Owner outcome; scope correction

- Nava = reservationist assistant inside Classic Outlook/WebView2 and shared webmail pane. Centurion/HRCEN first. Infor HMS = record authority.
- Required: selected email → correct action/booking → complete supported prefill → editable fields → native price/facts → staff Go → Save → fresh business-field readback → usable result.
- Core: Triage, Quote, Create, Amend, Cancel, selected-PDF Filing. UI quality/Infor field parity top priority. Missing facts require usable staff input; not dead controls.
- Ordinary reservation Create **was repeatedly in scope**. Automatic **new guest-profile creation** was deferred from initial pilot. Different operations. Missing profile explains some unsupported guests, not failure to finish existing-profile Create.
- Owner: finish entire core features quickly. No new general framework, pricing/accounting eligibility engine, process platform, broad test corpus or another tool rewrite as default cure.
- Current safety: staff approves real writes; agents may stage real requests unsaved and Save Proof Labtest 2027+ stays with CMS off. Nava saves unsent replies; HMS CMS confirmation may send when staff approves its checkbox. UNKNOWN → reconcile; no blind retry.
- This handoff alone authorizes analysis only. Owner separately authorized the Nov 5 autonomous implementation described below. A receiving LLM needs its own execution authority. Preserve other sessions/worktrees; no blanket cleanup.

## 2. Evidence strength and version boundary

Inventoried 865 MDs; full-text searched 483 relevant MDs /58,879 lines: Oct 4–Nov 4 + Halloween tree. Inspected decisive retros/plans/field audits/current source. Search coverage ≠ reading every line. Month evidence thinner than rewrite week.

History = **recorded outcomes** from earlier transcript/PR/runtime audits; no fresh runtime tests. Reports share sources; agreement ≠ independent replication.

Current static source pinned to locally available `origin/main` **811dd0bc86297003849700bfa509a41292ce9041**, PR #1012, Nov 4 23:39:26 UTC. Root checkout **6bb282ae7f40359d07e4f4fef14068dae78f1a17**, behind main and dirty; preserved. Current run state sampled separately. No production browser, DB, deploy, flags or app tests touched. Current live completeness **unverified**.

Locators identify provenance. Evidence embedded; no other docs needed.

## 3. Month timeline: working Create repeatedly fails to become finished Create

| ID | Date/run | Recorded evidence | Engineering implication / limit |
|---|---|---|---|
| E1 | Oct 8–9 overnight v8, ~7h23m | 36 PRs merged; 9 unplanned live-discovered fixes. Labtest Create saved with agency/org/commission at runner level; **not pane route**. Contract-rate cause misattributed twice; ~1h lost. | Native Create already possible. Wrong diagnosis + missing pane integration existed early. Different older adapter/property context; not proof new Cloud release works. |
| E2 | Oct 20 overnight | Quote/queue deployed. Create guarantee selector timed out twice before Save; same interaction retried without DOM diagnosis. Webmail draft proof not completed. | Repeat-before-diagnose; scope competing for one live lane. Safe stop correct; unchanged retry low value. |
| E3 | Oct 23 g1023 | 28 PRs merged. Labtest Create/Cancel both hotels; HRCEN Create proof **12m**. Da Vinci pilot quotes all failed: **19 runs refused in 1–3ms**, missing quote installation/config; flag enabled without one property-specific quote. Amend **414m**, ≥8 rounds, parked. | Simple cases can finish fast. “Flag on” mistaken for feature; unbounded native diagnosis can swallow night. 12m = proof stage, not entire product implementation estimate. |
| E4 | Oct 25 mh1024, **18h35m** | 26 PRs merged; mixed proof results. U5 review/fix window **2h37m**; U6b lane **377m**, split after oversized draft reviewed. ~94m deploy intervals across 11 deploys. | Oversized/serial changes + late splitting + repeated deployment. Time windows overlap; cannot sum as waste. Full scope broader than quoted first milestone. |
| E5 | Oct 26 or2 morning | Actual critical chain **11 links**, ~50m/link. Waits after dependencies merged: **139m, 91m, 79m** from ownership/barriers. Remote gates ~149m = **16% of Luna lane time**; duplicate same-SHA reruns ~**6m total**. Baseline-red stalls ~**60m critical path**. | Dependency design and stops exceed duplicate checking. Earlier log-string counts overstated actual test runs. |
| E6 | Oct 26 afternoon, **282m** | 17 PRs. **32 P1 findings; 27 judged real; 11 adjacent**—fix next field/path, discover next defect. Three units drew 24 findings. ~297 blocked coordinator **lane-minutes**. Sample review runtime ~3.3m. | Rework, cross-field correctness and centralized unblocks dominate. Lane-min ≠ elapsed wall time. Reviews often exposed real problems. |
| E7 | Oct 29 “47” run, ~8h32m to snapshot | 24 related PRs opened, none merged; no live end-to-end workflow or deploy. Native SaaS access blocked early. Synthetic fallback grew into source/stale-price/recovery/guest/draft dependency stack. 497 inter-agent messages; 34 coordinator compactions. | External blocker real; fallback expanded without delivering. Activity counts cannot quantify wasted time. |
| E8 | Oct 30–Nov 1 Cloud rewrite | Oct 30: 26 feature/fix PRs ~3h52m, live unsaved composition. Oct 31: **three fake Create → note Amend → Cancel lifecycles**, fresh reads; one via agent sessions. Later broad run: **38 PRs**, no deployment at Nov 1 retro, connected mail→approval→Create still absent **16h34m after replan**. | Rewrite produced real capabilities. Standalone-tool success repeatedly stops before staff product. Narrow lifecycles ≠ broad party/field parity. |
| E9 | Nov 2–3 K chain | Go 19:42:15; missing Create bridge discovered **19:46:08**. Planned branch assumed bridge already present. By 01:20 no app-prepared fake Create Save/readback; **36 main-target PR merges**. Pause before final 01:32 forecast, but early milestones missed badly. | Incorrect starting-state assumption + helper-first throughput. Do not falsely claim final deadline passed before owner pause. |
| E10 | Nov 3 follow-on Plan001, **550m** | Standalone native Create succeeded at 08:20; selected-email→Go proof absent at cutoff. Create/Filing/Multi-room merged; write workers off; Amend held. | Outside-in wording alone failed: contracts/driver/release still incomplete. Not equivalent to zero useful work. |
| E11 | Nov 3 evening M1, **200m cutoff** | Scope already narrowed to Quote/existing-profile Create/Filing/prefill. At 125m code deployed; no passing Create/Filing proof. Closed request selection cost **15m54s** until replacement preview. Then Save rejected “Rate is not available”; preview already had blank Average Rate/totals. Filing lacked staff target-entry controls despite “needs staff input” report. | **Core failure survived descoping.** Missing native step + poor fixture choice + absent fallback, not ambitious optional features alone. |
| E12 | Nov 4 morning **4h30m** | 10 PRs; first merge **2h36m**, main four merged **2h54m**. Four Labtest readbacks/flags on. Create/Filing Saves on **671a3b2d**; Cancel/Amend on **9d388ab751**. Create/Cancel real previews used Amend-email details; real Amend already applied; staff-PC use unobserved. | Significant delivery improvement. Evidence narrower than “full staff journeys complete.” Valid backend progress; no proof all advertised fields/forms/requests work. |

## 4. Actual root causes, ranked

| Rank | Finding | Evidence | Consequence | Cheapest corrective move |
|---|---|---|---|---|
| 1 / critical | **No stable ownership of complete user transaction** | E1 runner-only; E8 standalone lifecycles; E9 missing bridge; E10 standalone Save; E12 incomplete actual request paths. | Tools, UI, mapper, approval, worker, readback individually advance; assembled feature remains unfinished. | One owner accountable for **whole Create** across existing boundaries; complete native sequence and field propagation in one connected increment. Other owners contribute bounded changes. |
| 2 / critical | **Successful business behavior not preserved through integration/rewrite** | E8 saved lifecycles. E11 later Create lacked usable pricing; E12 live Prepare again exposed Check Availability selector/duplicated guard. | Already-known staff steps get omitted or reimplemented badly; “recovery” becomes fresh development. | Carry proven business step sequence forward. Compare actual running caller, not helper existence. Existing focused checks + one real-request unsaved stage should catch omissions early. |
| 3 / high | **Native serialization mistaken for staff contract** | Historical Save schema pinned **985 keys**. Pricing candidate pinned **112 fields** against actual **1,112 pairs**; **809 empty**, 303 nonempty; two legitimate case variants. 55 passing existing cases missed new matcher. | Harmless HMS drift blocks supported staff work; matcher engineering replaces reservation logic. | Verify guest/property/stay/approved fields, expected action, active session, one dispatch and readback. Preserve vendor extras; no global key-count/body schema as business gate. |
| 4 / high | **Integration defects discovered piecemeal after “candidate ready”** | E6 11 adjacent P1s; E12 optional fields, mixed room IDs, UUID/source/CMS issues. | Fix→review→next defect→fix loops; short task ETA repeatedly resets. | Trace one request through every consumer before declaring ready. Check null/false/zero, native IDs vs labels, room identity, staff edits vs late reads, review invalidation together. No generic contract platform. |
| 5 / high | **Parallel production funnels through serial dependencies/coordinator** | E5 post-dependency waits; E6 coordinator lane waits; E9 branch stacks; E12 **29m recorded coordinator gap** while workers sent 87 messages. | More agents create more candidates, not faster completed transactions. | Persistent area owners; whole UI one writer; overlap independent backend work; release owner integrates continuously. Don’t wait for every helper merge before continuing compatible coding. |
| 6 / high | **Proof inputs/environment prepared late or incorrectly** | E3 missing installation; E9 wrong starting branch; E11 closed request/blank rate; E12 real Create/Cancel request unavailable. | “Final verification” opens new engineering/debugging phase. | At start, identify active source, known profile, supported room/rate and actual deployed caller/config. Stage unsaved while coding. Missing actual Create request ≠ permission to mislabel another request. |
| 7 / high | **Done/status proxies conceal missing feature behavior** | E3 flag≠installation; E11 “staff input” with no input control; E12 goal complete despite stronger journey gaps. | Owner launches another run to discover previously hidden work. | Status names exact completed workflow and unresolved business step. “Merged,” “Prepared,” “Saved/read back,” “staff usable” remain distinct. No new tracking platform. |
| 8 / medium | **Process fixes sometimes become another product** | E7 synthetic fallback stack; E11 **371-line cutover wrapper** despite explicit “No new wrapper”; Halloween oversized tests; repeated retros recommending scripts/frameworks before features. | Delivery problem solved by adding more delivery machinery, creating more dependencies/review. | Use existing commands/queues/events/tools. Add infrastructure only for reproduced core blocker with actual consumer and smallest fix. |
| 9 / medium | **Competing plans/old instructions + uncalibrated ETA** | E4 milestone ETA reused for wider run; E5 240m estimate despite longer own DAG; E9 multiplier included partial/superseded runs. Old context foregrounded legacy/HRDAV paths after rewrite. | Restart spends time rediscovering authority/current code; optimistic forecasts survive scope changes. | Owner’s latest request + current source + one short state. Forecast exact remaining chain; no LOC-speed math or completion probabilities from incomplete comparators. |

**Causal chain:** disconnected slices → late integration defects → adjacent fixes/reviews → changed heads/checks → coordinator/release queue → partial proof → optimistic closeout → fresh plan/re-run repeats same seams.

## 5. Create: why “type into Record View” became slow

Human sequence is small. Ordinary supported Create should remain small:

1. New Guest Stay; select existing guest; select applicable agency/company.
2. Enter dates, room, occupancy/ages, rate, source/Track/guarantee/note/booker/CMS supported by tool.
3. Run **Check Availability after relevant selections**; read native price/availability.
4. Show effective fields/price; staff approves.
5. Save once; fresh confirmation/business-field readback; show result.

Real complications: dependent native POSTs; selections reset prices; CMS may send; Save may succeed before timeout. Need small guards/readback, **not weeks of whole-request matching**.

Observed avoidable failures:

- Childless pane omitted `childAges`; mapper required array. Ordinary adults-only request refused. Fix representation `[]` across actual caller.
- Rate code selected before later guest/Track changes; blank native Average Rate ignored; Save rejected. Correct native sequence, not pricing engine.
- Optional Check Availability helper phase existed, but production caller didn’t use it. Existing helper test ≠ working Create.
- “Complete prefill” broader than durable form state. Some profile/party/rate/CMS choices local; false/null omitted; late responses overwrite edits.
- Prepare and Go use **fresh sessions**. Go restages approved intent. New native price must match approved observation; persistent unsaved browser draft not required by current design.
- Historical CMS-off Labtest assumptions leaked into generic/real-guest contract. Current source has addressed some; old refusals not universal current blockers.

**Current-source counterevidence at 811dd0bc8:** `create-reservation.mjs` lines 573–576 carries availability, 629–631 checks Average Rate, 686 invokes protected Save, 752–775 reads back/classifies saved. Mapper lines 54–60 permits approved real-guest CMS send, refuses Labtest send. Native Create not absent today. Latest run still integrating durable UI fields/source cursor/per-room rate context. Main source existence ≠ deployed staff completeness.

**“Create never existed” false. “Full supported staff Create still unestablished” supported.** Repeated success without durable completion = main failure.

## 6. Where time wasted; what not to blame

| Category | Strongest measured examples | Judgment |
|---|---|---|
| Repeated incorrect diagnosis/native interaction | E1 ~1h wrong rate diagnosis; E2 unchanged selector retry; E11 closed-request detour + ignored blank price. | Avoidable investigation/rework. Exact total month waste unknown. |
| Integration/review cascades | E4 157m review/fix window + 377m lane; E6 11 adjacent P1s. | Main repeat pattern. Reviewer often right; initial change incomplete. |
| Scheduling/ownership waits | E5 139/91/79m waits; E6 ~297 lane-min; E12 29m gap. | Concrete stalls; overlapping, no valid sum. Gap root cause unclassified. |
| Stale baseline/fixture work | E5 ~60m critical stalls; E11 fixture repair ~10m, comment-only PR ~6m. | Real overhead. Known failure cannot be called passing; don’t repair unrelated baseline inside every workflow. |
| Duplicate checks | E5 ~6m same-SHA reruns; E11 repeated typecheck 42s after fixture-only edit. | Waste exists, smaller than rhetoric for sampled runs. Current rules already allow reuse/avoid duplicates. |
| Oversized synthetic tests | Halloween cancellation slice ~497 test lines; occupancy safeguards **1,131 test lines**. | Evidence of disproportionate scope. Line counts not measured runtime/time waste; safety behavior may be useful. |
| Boilerplate/process expansion | E11 371-line wrapper; broad compatibility/result/evidence changes without sampled consumer. | Wrapper explicitly contradicted plan. Other abstractions need caller-specific challenge, not blanket deletion. |
| Native persistence/readback | E11 exposed actual rejected Save; E12 prevented duplicate Filing/Amend writes. | Essential, useful verification. Remove repeated blind probes, not readback. |
| Review duration itself | E6 sample ~3.3m; Nov 3 sampled final reviews 1m57s–3m26s; many valid P1s. | “Every review costs 15m” unsupported. Rework+queue differs from reviewer runtime. |

**No defensible “X% month wasted on tests/ceremony.”** No comparable time partition across month. PR counts, LOC, wait sums, messages and compactions cannot supply one. Reported Nov 4 extra ~90m after main merges included **additional code/fixes/deploy/proof**, not pure ceremonial tax.

## 7. What Cloud rewrite solved; what persisted

- Solved/improved: native surface discovery, deterministic readers/setters, party/profile lookups, availability, reusable sessions, narrow saved-write proof.
- Did not automatically solve: selected-email identity, durable editable forms, native IDs across adapters, approvals vs changed drafts, actual caller wiring, release/config, partial/UNKNOWN outcomes.
- Historical app had optional pane agent, background extraction/drafts, installed quote provider, Cloud JSONL sessions and separate write routes. Same feature nouns obscured different executing paths. Some quote paths still used older adapter while new Cloud quote existed separately.
- Multiple implementations ≠ all duplication; shared commits/different PRs ≠ duplicate work. Prior audit found **zero identical full patch IDs** among 45 open PRs. “76% dormant code” claim not reproduced; reject percentage.
- Both extremes failed: oversized general contracts cause review loops; tiny helper PR chains serialize delivery. Aim **one connected workflow increment**, appropriate size, not rigid per-function PRs.

## 8. Finish features faster: engineering correction, not another process project

1. **Finish complete supported Create first; preserve whole core scope.** Single successful easy fixture = checkpoint, not permission to drop supported fields, multi-room results, CMS, edits or recovery states. Other workflows continue independently.
2. **Inspect current caller chain and incomplete business step.** No broad inventory/rewrite before touching exact blocker. Use existing tools and proven native sequence.
3. **Own field propagation end to end.** Every supported editable field reaches native input/review/readback; missing field has working staff entry; edits survive reload/late reads. One explicit field mapping sufficient, not new form framework.
4. **Observe native stage early.** Real request details → unsaved Prepare while implementation proceeds. Final deployed Labtest Save/readback after applicable checks. No numbered probe campaign/admin clicking.
5. **Constrain guard to real hazard.** Wrong guest/property/source, changed approved price/fields, duplicate dispatch, CMS side effect. Replace whole-body/key-count matching with actual identity/action/business checks + existing once-only fence/readback. Unresolved hazard remains blocker.
6. **Keep ready-to-ship head stable.** Existing focused checks, approved remote typecheck per touched app, final-head Apex/fallback; fix valid P0/P1. Current-main merge gate; clean bundle; correlate loaded mail UI and backend. No bypass; no repeated checks without changed relevant head/failure.
7. **Measure remaining feature work, not artifacts.** Report “Create missing durable party selection” rather than “95% code complete/final proof.” Keep only short outside-repo live checkpoint. Reconcile passed field coverage with final shipped head; don’t reopen proved unrelated work gratuitously.

Critical path: current supported inputs/native sequence → effective UI/mapper/source approval consistency → final relevant checks/review → clean deploy → native proof/usable result. Exact missing seam determines estimate. Independent Quote/Filing/Cancel/Amend may overlap; shared UI/release/write slots constrain concurrency.

**ETA verdict:** core delivery currently partial; no calibrated completion percentile. Prior 2.5–4.5h core / 3.5–7h entire programme are conditional hypotheses, not verified deadlines. Native proof can be minutes after implementation works (E3); entire workflow still depends on unpriced wiring/rework. Do not promise “one hour” from 12m proof or 20m candidate spans.

## 9. Historical Nov 4 run checkpoint; superseded by section 12

Run began **Nov 4 22:12:09 UTC**. Latest inspected state entry **23:39:26 UTC**:

- Amend #1011 **29d03eb3** deployed; one Labtest Go plus worker readback; separate native session confirmed dates/room/rate/total/CMS off at 23:33:29. Real-email unsaved stage passed, request already applied.
- Contextual Amend rates #1012 merged **811dd0bc8**; deploy started 23:41 per state. Not independently verified by reviewer. Candidates may be estimates/unchecked eligibility; Prepare remains final authority.
- Create source cursor guard, durable UI persistence and per-room rate-context changes assembling in isolated release tree. Complete Create UI release/proof not recorded in sampled state.
- Filing assembling; POP3 selected PDF supported, Outlook sealed attachment adapter pending. Cancel backend/UI assembling. New-profile/native-nightly tails separate.
- Deploy readiness reports old HRDAV quote backlog while HRCEN health passed. Deliberately disabled HRDAV service; no authority inferred to change it. This is deployment coupling to investigate, not proven sole blocker or permission to bypass.
- Fixture ingestion accidentally ran live worker loop; state initially suspected a real POP3 message processed, later attribution unproven. No extra helper alive/HMS run identified in audit; fixture ingest held pending identity handling. Demonstrates proof setup can add operational side effects; avoid expanding harness.

Snapshot changes; preserve running work. No claim latest candidate broken or earlier Create absent.

## 10. What receiving LLM should answer

> Diagnose why supported existing-profile Create still isn't complete, using embedded evidence and current candidate source if available. First distinguish: absent capability, missing caller/UI wiring, native sequence defect, brittle guard, release/config blockage, and proof-only gap. Identify exact remaining business steps for full Create; which previous successful behavior must be preserved; smallest fixes; unnecessary prerequisites. Then apply same analysis to other core workflows. Rank blockers; give critical chain and conditional ETA from comparable completed scope. Challenge prior reviews and this handoff. No new framework, broad tests, wholesale rewrite, automatic extra approval gates or unsupported completion percentage. Read-only unless owner separately authorizes execution. Return actionable feature completion, not another retrospective process.

Unknowns: current deployed bundle/loaded UI; latest Create candidate SHA; complete supported field coverage; actual staff-PC use; exact month time allocation; current charged-Cancel/New-Profile/nightly-range outcomes. These unknowns do not justify another whole-platform build.

## 11. Provenance register; evidence already embedded

Paths/line locators below = audit identifiers, **not required reading/links**. All within repository `/home/ubuntu/projects/zero` unless noted. Historical claims retain their dated evidence limits.

- E1: `docs/plans/handoff-reports/2026-10-09-overnight-v8-retro.md`, lines 7–10, 18–25, 52–55, 71–89.
- E2: `docs/research/2026-10-20-overnight-quote-retro.md`, lines 25–30, 64–68.
- E3: `docs/context/ledger/2026-10-23-g1023-retro.md`, lines 3, 9–34, 49–57, 73–75.
- E4: `docs/context/ledger/2026-10-25-mh1024-retro.md`, lines 2, 22–55.
- E5: `docs/context/ledger/2026-10-26-or2-retro.md`, lines 23–49, 55–73, 86–93.
- E6: `docs/context/ledger/2026-10-26-or2-retro-pm.md`, lines 3, 22–29, 49–54.
- E7: `docs/research/2026-10-29-47-overnight-retrospective.md`, lines 36–45, 64, 72–78.
- E8: `docs/research/halloween/2026-10-31-hms-cloud-build-retro.md`, lines 7–20; `2026-10-31-hms-write-and-memory-results.md`, lines 7–25; `2026-11-01-hms-17h-retro.md`, lines 7–20, 31–38, 76–85.
- E9: `docs/research/halloween/2026-11-02-llm-retro/2026-11-03-k-chain-independent-retrospective.md`, lines 13–17, 32–35, 96–117.
- E10: `docs/research/2026-11-03-plan001-adversarial-systems-review.md`, lines 11–16, 30–44, 48–78.
- E11: `docs/research/2026-11-03-evening-plan-retro-125min.md`, lines 5–17, 53–83; `2026-11-03-evening-plan-retro-125-to-200min.md`, lines 29–35, 52–84.
- E12: `docs/research/2026-11-04-big-fat-4-hour-chat-retro.md`, lines 3–8, 30–45, 64–76, 158–166, 203–208.
- Native field-count evidence: `docs/research/2026-11-04-evening-plan-paused-retro-and-recovery.md`, lines 115–131. Native Create caller audit: `docs/research/2026-11-04-adversarial-review/lane-create.md`, lines 10–47, 63–99. Historical findings; some subsequently fixed.
- Cross-run corpus/source audit: `docs/research/halloween/2026-11-02-llm-retro/README.md`, lines 119–139, 159–199. 213 PRs created /166 merged; median open→merge 13m14s; 45 open PRs/40 worktrees at dated snapshot. Not product-value counts.
- Current plan: `docs/plans/2026-11-04-002-feat-nava-pane-prefill-rate-parity-plan.md`, lines 19–43, 98–113, 129–183, 341–371, 405–414. `design_draft.md`, lines 24–50, 395–435. Current `PRODUCT.md`/`AGENTS.md` govern safety/scope.
- Current static source at **811dd0bc8**: `apps/server-pilot/tooling/hms-cloud/create-reservation.mjs`, lines 573–576, 629–631, 686, 752–775; `apps/server-pilot/src/ai/pane-create-cloud-input.ts`, lines 45–105. Current checkpoint: `/tmp/nava-pane-run-20261104.state`, entries through 23:39:26 UTC.

Historical audit route: local Markdown/Git/source/state only; no external research/subagents for that audit. Subsequent implementation used parallel builders and independent reviews, described below. Dollar cost unavailable. No defensible month-wide causal waste percentage.

## 12. Nov 5 checkpoint: what actually shipped/proved

**Current main/runtime: `20e17dd0137e8791e76c06bd5fb16fdbd9cfbd20`. Supported core checkpoint; no universal pilot/10-of-10 claim. Three write workflows proved. Quote artifacts proved. Cancellation changed native status but left a financial review hold.**

Owner authorized overnight code/review/merge/deploy and Labtest writes. Later explicitly allowed economical downscope. No new profiles, cashiering, refunds or general framework built. Existing UI/components/state reused; connections and missing fields repaired. No new tests added.

| Workflow | Actual result | Evidence and limit |
|---|---|---|
| Create | One Save created `2096664849-1`, native reservation stay `40505`, guest `46924` **Proof Labtest**, HRCEN. Reserved Jan 4–5, 2027; STWN/BAR, two adults, zero children, NGI, no parties, source Walkin, Track Best Available, Booker/contact/note correct, CMS off. Average/total/grand total R2,280. Fresh independent native read and durable booked receipt matched. | Deployed `7b4360cb`; run `4d65661a-5513-4ea9-a6fd-2f2168530755`; readback artifact SHA `7f6ab457d2cac55a8c99e3dee44f2660f23384b414dc3876bf8871d948e512ab`. Business mismatches `[]`. This was a newly created Labtest reservation in live HMS, not a real guest cancellation target. |
| Same-source Filing | Original booking PDF uploaded to that same stay. Independent Documents listing found unique `NAVANR6BGCST7RC2HAWEJVXTVY7HZU`, filename `synthetic-labtest-booking-voucher.pdf`. Exact voucher handled marker true; Create receipt preserved. | Run `4bbfc8bc-40f3-40ee-836a-9154ed08ce27`; readback SHA `07f227b62b96c173e07a97a8a945a04e3bbb536dd92bcd8d6c3c033da031e83d`. Original attachment `f8d1dfeb-a524-43b1-80fd-24040de7c00a`, 1,503 bytes, SHA `dc999e3a28e9c544aaf64b305ce8a8c3b75a6dfcc355638a682fc5c4f42b7f42`. Native listing/metadata verified; native stored bytes **unverified**. |
| Amend | One Save changed departure to Jan 6. Independent read: Reserved Jan 4–6; STWN/BAR/NGI, average R2,280, total/grand R4,560, balance R0; Booker/note preserved, CMS off. | Deployed `7b4360cb`; run `b3014d27-47e6-4fc1-be0f-e1a603cf592a`; fresh-read summary SHA `f98d088ef8bb2909e0722deeab9418f7ecbf416ded9e9bd20cd36a95af3f30df`. |
| Cancel | One Go on `20e17dd` changed that Labtest stay to **Cancelled**. Fresh independent read confirmed dates, reason Test Reservations, empty cancellation note, preserved reservation note/Booker and CMS off. **HMS presented a positive R4,560 post-Save penalty warning.** No fee approval/button action or charge request dispatched by this flow. | Run `0c1c0f42-ecb5-4f69-a664-ca730cffa360`, terminal `dead_letter`, `cancel_penalty_pending`, `UNKNOWN/needsCheck`. Challenge expired/pending; target hold retained. Fresh-read derived summary SHA `5672fb4936f9f332093f3d76e44d23848c3f7e7353157db8b374e6c7e5bf3aff`. Balance R0 and blank deposit fields do **not** prove charge posting. **Not free-Cancel PASS; no canary-pass claim.** |
| Quote | One chosen native Jan 4–5/STWN/BAR offer at R2,280 fed actual PDF, Excel and unsent cover. Artifact dates, quantities, board and totals checked; no company in cover. | PDF SHA `73603b7d33809c2c5318b88296f2ee9beacd395f15e91cc697db7705a2b874ef`; Excel SHA `9d439abaa35ef08a7267fa54bbb0abb980e6c6357eaa442235e79e7634aad993`. Actual Outlook/webmail draft insertion and staff-PC acceptance **unproved**. |

Create/Filing/Amend proofs were on `7b4360cb`. Subsequent main changes: two existing test mocks and one extraction-schema question-list normalization. Native write/approval/date-guard code unchanged. Do not relabel earlier canaries as fresh `20e17dd` writes.

Shared improvements deployed: complete supported field wiring; current selection/source binding; own-revision undo/reset; stale Quote/rate response rejection; existing guest/agency/company pickers; typed/searchable selected-rate code plus native price; attachment text/visual provenance; Travelit/TBO routing fixes; voucher/POP work retained after booking. General multi-ask completion and staff-PC usability remain narrower than the full product contract.

Runtime verification: all four actual PM2 process environments showed `20e17dd` and required write flags on. Both published entries served matching immutable release/index with TLS; VPN/hotel probe passed. Initial deployment installed/health passed but readiness failed on four fresh background read jobs. Same-original-window recheck at **07:44:54** passed, zero nonterminal/recent dead letters, no waiver; window **07:37:36.903** unchanged. Last-good metadata resumed only after actual gates passed, using conservative **07:32:36** boundary. This readiness observation **preceded the later Cancel financial-handoff dead letter**; do not claim a post-Cancel global readiness check passed or erase that event.

All native/model sessions closed. No real guest Save/cancellation; no CMS messages; no penalty approval; no blind Save retries; no review-hold clearing. Cancel reconciliation summaries are derived transcripts of actual fresh reads, not hashes of original raw HMS responses.

## 13. New direct evidence: where this run lost time

### E13 — AI bookkeeping blocked human work

Original synthetic PDF source: message `313f0bcb-128e-468c-87a0-a59ae79a58f1`, extraction `638b71c9-ce83-4fe7-a81f-e3dfef6fb00f`, version `extract-928b835c558b`. Two genuine worker attempts failed `invalid_output`; the outer queue run could be `succeeded` while its extraction outcome was FAILED. No editable WorkItem existed. Thus the native tool could work while the human could not start the form.

Fix #1039: explicit **Start booking manually** from the real failed source under authenticated source/read/revision locks. Stable blank WorkItem `366e05b8-76cb-4d8e-b51e-356d6109981d`; all unknown business facts null; 23 ordinary staff edits. Original `638` stays **FAILED**, failure history and original PDF retained. Saved booking facts labelled staff-manual, not AI-prefilled. No invented extraction UUID/success. Manual-start authority survives extractor-version updates because it binds the actual failed row and source/marker, not the current prompt version.

Remaining boundary: this manual path covers genuine failed-read **Create**. Missing/pending reads without a durable read ID and manual Quote/saved-workflow drafts do not gain blanket completion from this patch.

### E14 — Correct form values; wrong approval consumer

First manually completed Prepare refused `cloud_create_scope_changed` **before Native Save**. Locked-source diagnostic: active identity true; date match false. Stay-header dates null, but room dates correctly Jan 4–5. Guard read the old stay-header location while form persisted per-room dates.

Fix #1040, two files/10 added lines: `pane-create-scope.ts` reads exact selected source/request/row/room dates, preserving own-property null and old-header fallback; `pane-cloud-preview.ts` passes source identity. No actor/source/UUID/sequence/room/price/once fence removed. Reused the same 23 staff edits; no re-entry. Fresh native Prepare then Save/readback passed. This is **unpriced consumer mismatch**, not 90 minutes of necessary UI styling.

Two existing preview/commit mocks still imported old generic source-loader exports and omitted `effectivePayload`. #1041 changed only those mocks/error strings: **65/65 existing checks passed**, assertions intact, product diff zero. Old fixture failures were not called passing or repaired with production compatibility shims.

### E15 — A question list rejected a usable amendment

Genuine Amend read `e08db838-a14b-45d3-9159-a739d452232e` failed with bounded Zod `invalid_type` at top-level **missing**. No WorkItem, therefore no source-bound Amend Prepare. One authenticated real retry succeeded on that same source/read, retaining initial failure history; native Amend then passed.

Fix #1042 is one schema line:

```ts
missing: z.array(questionSchema).nullish().transform(q => q ?? [])
```

Accept absent/null question bookkeeping; reject malformed non-null questions. No dates/guest/count/age defaults added. Null ages and explicit child-total mismatches stay blocked. **62 existing checks + final remote typecheck passed; independent reviews clear.** Generated schema changes extractor version naturally. Old failed rows do not become successes without a genuine read. Current Cancel's first genuine read succeeded. Pre-existing model claims such as empty child ages without clear zero-child evidence remain an accuracy limitation; no claim all extraction became correct.

### E16 — “No policy” did not establish free cancellation

Prepare: policy applies No, override No, penalty text null. After Save: **“Cancellation Penalty of 4560.00 may be added to account. OK.”** Native status already Cancelled. Guard stopped before fee approval; financial review remains. Thus neither native status alone nor initial policy flags prove free cancellation. Prior claimed **95% free** was unsupported. Do not bypass this guard, infer waived fees from balance R0 or implement cashiering solely to turn this canary green.

### Other concrete rework and uncertainty

- Earlier Nov 2028 fake Create accepted R0/HTTP200 as readiness; actual Save showed **Rate is not available**, no confirmation, UNKNOWN. Positive-only automated Create guard added. Complimentary/zero/unpriceable cases use explicit HMS handoff; not a claim every zero rate is invalid. Original unknown hold retained.
- Real-email unsaved receipt genuinely existed (`cbe879`, 03:12:35–03:13:46, SHA `9b60035c5335859d9cf36f209a441f4c00ea83861709014d62ec8af41d5d2e89`). Native guest/company/room/guarantee checked; source/PDF current; no Save. **Partial only:** agency unmatched/omitted, BAR example R1,940/night versus voucher DBB/R1,700; approval false. Actual source has no verified rate code. GTDCMP was a **guarantee**, briefly misread by coordinator as rate during review; incorrect proposed probe withdrawn **before any execution**. No ID/code guessed to claim green.
- Late timeout, extraction-version CAS, mailbox/thread lock order and source/revision fixes caused repeated review/deploy cycles. Opaque old validation failures were unrecoverable because issue paths had not been retained; bounded fixed-schema code/path diagnostics now exist.
- Native price check, financial guard and fresh readback caught actual defects. Evidence still does not support blaming most time on tests. Waste: reaching those checks late with incomplete caller contracts, optimistic closeout and repeated serial release work.

## 14. Original ETA versus actual closure

Conditional forecast **225–495 minutes (~4–8 hours)**, including **35–90 minutes repair reserve**, overlapped lanes and additional checks/release tail. Not calibrated percentiles. No clean per-unit start/finish ledger; do not invent actual coding minutes. Earlier paused run's 143–145 minutes remain history, not erased by a resume estimate.

| Packet | Planned active-lane budget | Current acceptance |
|---|---:|---|
| W1 integration |20–35m|Merged/deployed inherited pieces.|
| W2 own-cursor undo/reset |10–20m|Deployed; focused checks.|
| W3 Quote freshness |10–25m|Deployed; chosen-offer result checked.|
| W4 Filing delta |0–20m audit;25–45m if needed|Native Prepare delta reused; original-source upload/readback proved.|
| W5 selected rates |25–55m|Deployed; authoritative selected-rate prices proved, not all catalogue totals.|
| W6 editable Create |40–70m|Partial-read form wired; failed-read manual authority added later; single-room Save/readback proved.|
| W7 Quote outputs |15–30m|PDF/Excel/unsent cover proved; actual client insertion unproved.|
| W8 batch continuation |10–25m|Existing 1–8-room receipt/recovery machinery reused; fresh multi-room native proof unproved.|
| W9 Amend/Cancel |25–50m|Amend proved; Cancel native status confirmed but financial review unresolved.|
| W10 party binding |15–30m|Native picker/ID path deployed; unmatched real agency still requires staff resolution.|
| W11 final checks/review |15–30m plus valid fixes|Focused/remote checks passed on changed heads; late consumer and fixture defects added cycles.|
| W12 release/proofs |55–105m|Several deployments/proofs; latest three writes proved, fourth financially partial.|
| W13 voucher prefill |35–70m|Provenance/reading pipeline deployed; wrong/failed model reads remain; manual Create works.|
| W14 frontdoor/remaining asks |15–35m|Routing and voucher/POP retention deployed; general multi-ask automation deferred.|

Largest missed scope: failed-read human admission was deeper than “mount empty form”; then the room-date consumer mismatch. Both lay on Create's critical chain. Later extraction metadata and positive cancellation warning prevented universal closeout. The 06:30 return was a checkpoint; first fresh manually entered Create Save occurred **07:11:22**. No time-reset or “90% done” claim.

## 15. Stop expanding; next product decisions

**Keep this checkpoint. Do not restart the entire plan.** Next: one representative staff case in actual pane. Select real email; confirm source fields/roles; choose existing guest/party and real rate; correct missing values; Prepare; staff-authorized Go; verify visible result. This is acceptance work, not another extraction research programme. Source missing a native rate/agency requires a working staff selection, not a guessed value.

Remaining product issues, distinct from completed native paths:

1. **Actual staff UI acceptance + Outlook draft insertion.** Published assets and render/reducer tests do not prove these.
2. **Cancel financial handoff.** Show known Cancelled status alongside explicit fee review; preserve target hold. Resolve Labtest ledger manually before declaring finance complete. No automatic charged-cancellation/refund promise. Current status/charge distinction is concrete, not hypothetical.
3. **Extraction accuracy/role errors.** Guest/Booker email duplication observed on text that identified only Booker. Missing-list normalization is not a general accuracy repair. Staff corrections remain necessary; no measured 80%+ case coverage claimed.
4. **Manual forms beyond failed-read Create.** Quote/saved actions with failed or missing reads, source IDs absent/pending: not universally solved. Price a separate narrow authority change if real staff cases demand it.
5. **Multi-room/partial-room acceptance.** Existing recovery code reused; only one room freshly proved. Do not recreate confirmed/uncertain rooms.
6. **Deliberately deferred:** new guest profiles (create in HMS then resume), numeric rate overrides/Retain, cashiering/refunds, native groups/XLSX imports, quote pooling, new OCR, native PNG/JPEG filing. Images can be reading evidence; native PDF filing is the proved path.

Receiving LLM: challenge this checkpoint without confusing “code exists,” “native action proved,” “financial outcome complete” and “staff can use it.” Fix the next observed staff blocker as one connected workflow increment. Do not clear pending holds, add broad test/agent machinery, silently waive fees, invent rate/agency IDs or turn a Labtest transcript into real-mail readiness evidence. Cheapest delivery comes from one authority per field, editable unknowns, source-faithful native staging and usable partial/handoff states.

Implementation provenance: `pane-create-scope.ts`, `pane-cloud-preview.ts`, `manual-create-source.ts`, `pane-create-source-loader.ts`, `extraction/schema.ts`, current WorkItem/pane components, native HMS tools. These names locate audited seams; conclusions/evidence above suffice without opening another Markdown file. Orchestration: Terra xhigh builders, Sol high native/rate escalation, Luna xhigh reading/review where assigned; runtime extraction remained its configured Luna adapter. No claimed token/dollar cost or statistical productivity multiplier.
