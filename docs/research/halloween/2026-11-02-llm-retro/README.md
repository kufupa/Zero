# LLM coding + product retro — 2026-11-02

**Status: complete (bounded source/chat review; runtime flags unverified).** Main question: why has a customer-support/reservationist agent taken this long to build, what architecture exists now, and is the AI-coding loop helping or hurting?

**Follow-up, 2026-11-02:** the 45 open PRs counted below were created during the retro window. An all-time query found **47** open PRs, including older #488 and #651. After review, #658 was closed as documentation already on main, and #802 as a paired Booker update superseded by merged #807; **45** open PRs remained at 19:36 UTC. Three clean, inactive merged-PR worktrees were removed with their commits and branch names preserved, leaving **37** Git worktrees locally. Main later advanced to `5297ac7787`: plan 005 now explicitly labels the Outlook-shaped replay as a fake bridge, with real Outlook left to the client the next day. The owner’s Claude session also refreshed product/startup context. See the [PR and worktree reconciliation](2026-11-02-pr-worktree-audit.md), [all-PR inventory](pr-inventory.md) and [worktree inventory](worktree-inventory.md).

This file is both the retro and its activity log. Scope: Wednesday 2026-10-28 through Monday 2026-11-02 inclusive. Separate verified facts, owner intent, inference, and recommendation. No raw private transcript text, guest data, secrets, or credential-bearing tool output belongs here.

Unless explicitly updated above, the findings and counts below describe the original retro snapshot, not a fresh runtime or backlog query.

## TL;DR

Product is Nava for Infor HMS (Centurion now; Da Vinci/HRDAV next). Elapsed time includes a scope jump: Oct 30 explicitly deferred app integration; Nov 2 targets six connected workflows across webmail/Outlook. Chats confirm late-window shift from building tools to status/ETA/scope corrections and concern about agent coordination. Current source still does not wire the pane LLM to the Cloud JSONL tools; effective production flags are unknown. 213 PRs, 45 open/40 worktrees; broad file overlap, no identical full patch duplicates. Main fix: connect one security-reviewed vertical and use K3 as an early stop/replan gate; then parallelize behind frozen contracts. Full evidence and caveats below.

## Scope and method

- Analyze non-meta user-role text and assistant final prose from Codex + Claude Code sessions in date window; user-role text may include injected context and cannot all be attributed to the owner. Use tool output only where needed to verify an outcome. Ignore large irrelevant tool payloads.
- Trace current architecture and product scope from latest plans, handoffs, code, and existing retros. Dated plans are evidence, not fresh authorization.
- Measure PRs, commits/changed LOC, worktrees, duplicate heads, and verification evidence where data permits. State denominators and gaps.
- Research public loop-engineering claims separately; cite first-party sources and distinguish fact from opinion.
- No product-code edits, tests, typechecks, database calls, deployment, process stopping, worktree cleanup, or Git operations that mutate state.
- `sudo` used only after explicit owner authorization, for read-only discovery/reading of the additional Codex archive; no privileged writes or broad raw dumps.

## Baseline captured before this report

| Item | Evidence |
|---|---|
| Checkout | `main`, HEAD `18017a981ce5235c3ce76264a2e09e66f06155c6`; `origin/main` is 1 commit ahead, 0 commits behind local (`git rev-list --left-right --count origin/main...HEAD` → `1 0`). |
| Existing worktree changes | 11 tracked modified paths + 37 untracked status entries before creating this retro. No pre-existing path was edited by this task. |
| Product identity | [`PRODUCT.md`](../../../../PRODUCT.md) calls product Nava and describes deterministic Infor HMS tools. “Insurance” → “Infor” is plausible transcription repair, not established fact. |
| Chat archive access | `/home/orca/.claude/projects` and `/home/orca/.codex/sessions` readable as current `orca` process. After explicit authorization, narrow `sudo` discovery found `/home/ubuntu/.codex/sessions`; it had no in-window sessions (only Aug 26–31 history). No standard `/home/ubuntu/.claude/projects` archive/session JSONL was found. No files modified. |
| Work performed | Read-only discovery only so far; no tests or live customer/HMS interactions. |

## Work log

| Date | Action | Result |
|---|---|---|
| 2026-11-02 | Read shared host + Zero task guidance; read `PRODUCT.md`, `docs/context/START-HERE.md`, and `AGENT.md`. | Product/safety boundary: Nava reservationist for Centurion; no test/deploy needed for this analysis. |
| 2026-11-02 | Captured `git status`, branch relation, and `git worktree list --porcelain`. | Dirty checkout preserved; broad multi-worktree activity visible. Aggregates are in the metrics section below. |
| 2026-11-02 | Located session archives and checked process names. | `/home/orca` was the first readable history root; archive discovery later expanded after explicit owner authorization. |
| 2026-11-02 | After explicit follow-up authorization, used noninteractive sudo only for read-only archive-path discovery under `/home/ubuntu`. | Found a second Codex session archive; transcript scan expanded to cover it. No elevated writes, broad dumps, or secret exposure. |
| 2026-11-02 | Completed local Claude and Codex text-only parent-session scans for Oct 28–Nov 2; no raw guest/secret text retained. | Claude: 79 active IDs / 898 user-role text events / 634 finals. Codex: 79 in-window IDs / 1,030 user-role events / 379 finals. Counts include possible injected context; see transcript findings/limits. |
| 2026-11-02 | Manually sampled five Codex assistant finals around scope/run status; compared each to its parent ask. | Most separate merged/reviewed/live states well. One 10.9k-character report was accurate/caveated but too long and widened scope beyond the immediate retro ask. Sample is not corpus-representative. |
| 2026-11-02 | Manually sampled eight Claude prompt/final pairs around completion/plan claims. | Four finals reported specific results/artifacts, two lacked a concrete result, two had scope-drift risk; no generic/overlong pattern in this sample. Claims were not independently verified. |
| 2026-11-02 | Read-only PM2 availability check for runtime flags. | `pm2` not in this shell; target-process env was not queried. Effective deployed flags/build remain unverified. |
| 2026-11-02 | Started bounded research agents; later added tool-architecture, Claude-transcript, and Codex-transcript tracks. | Six Luna Max subagents total; see ledger. Only external-source agent writes one separate note. |
| 2026-11-02 | Queried CodeGraph and traced pane entrypoint, Mastra tool registry, Cloud JSONL dispatcher, guest-profile request guards, and result projection; cross-checked 1A/1B/1C naming in dated research. | 1A/1B/1C are documented HMS read surfaces/method, not the guest-profile helper names. New Cloud tools still are not registered on the pane-agent path; candidate selection is a tightly guarded unsaved native request, and candidate data contains raw rows/contact fields. |
| 2026-11-02 | Read earlier Oct 30 / Nov 1 run retros and aggregated ETA-ledger rows. | Prior work already records delivery/coordination failure modes; avoid duplicate event-by-event retelling. |
| 2026-11-02 | Compared changed paths, branch/head IDs, stacks and patch IDs across 45 open PRs; matched these against 40 worktrees. | 100 shared exact paths; 38/45 PRs one overlap component; no identical full patch IDs; zero current worktree↔open-PR head matches. No uncommitted-hunk comparison or cleanup. |
| 2026-11-02 | Verified Anthropic long-run/security/API docs with Exa fetch. | Supports durable bounded loops, not token-maxing; sandbox covers fewer paths than all agent tools. |
| 2026-11-02 | Created this retro folder/file. | This is the only new root-authored artifact so far. |

## Agent ledger

| Agent | Model / effort | Narrow assignment | State |
|---|---|---|---|
| `product_intent` | `gpt-6-luna` / max | Current plans/owner decisions: target architecture, scope, safety, missing features. | Complete; docs-only intent evidence, not chat-confirmed. |
| `engineering_metrics` | `gpt-6-luna` / max | Date-bounded PR, commit/LOC, worktree, duplicate-head, verification, and PR-path-overlap audit. | Complete; path/branch counts verified, not uncommitted hunk overlap or off-GitHub test evidence. |
| `loop_research` | `gpt-6-luna` / max | Public evidence on Boris Cherny, bounded agent loops, security/checkpoints/evals. Writes only [`loop-engineering-research.md`](loop-engineering-research.md). | Complete; source note read + checked against official Anthropic docs. |
| `tool_architecture` | `gpt-6-luna` / max | Wiring between 1A/1B/1C read surfaces, Cloud session tools, agent registry, and app path. | Complete; static-code claim only, not live runtime. |
| `claude_transcripts` | `gpt-6-luna` / max | Broad local scan of Zero Claude parent sessions Oct 28–Nov 2; user-role text + assistant final prose; no tool payloads. | Complete; 79 active IDs, 898 user-role events, 634 finals; nested subagents excluded; 8-pair output sample. |
| `codex_transcripts` | `gpt-6-luna` / max | Bounded local scan of Zero Codex parent sessions Oct 28–Nov 2; user-role text + final prose; no tool payloads. | Complete; 79 IDs, 1,030 user-role events, 379 finals; count includes injected context. |

Six Luna Max subagents used across independent tracks; peak concurrency 4 including coordinator. Agents asked for Caveman Ultra, bounded scope, citations where applicable, no raw private text, and no unrelated writes. Cost is not exposed by this runtime; report as unavailable unless a source provides it.

## Executive findings

- “Five days to build an agent” is misleading: Oct 30 deliverable was standalone Cloud tooling with pane/app integration explicitly deferred; the Nov 2 deliverable is a six-workflow, webmail+Outlook connected pilot. Scope expanded materially.
- The strongest technical gap is composition: pane LLM, staff-reply draft worker, HMS shadow-read path, and Cloud JSONL tools are separate. The new Cloud session is not currently registered in the pane LLM tool set; live runtime flags/build are unknown.
- Coding speed/PR throughput is not the constraint visible in this evidence: 213 PRs opened, median open→merge 13m14s; 45 open PRs, 40 worktrees, 26 dirty. Shared-file/stack integration is a bigger risk. There are no identical full-patch duplicates, but zero open PR heads match a current worktree.
- The 1A/1B/1C method is a genuine success: inspect real UI, make shallow readers, prove one case, broaden by evidence. Its readers generated large field evidence but are not a customer workflow or an agent API.
- Prompts show a shift from tool creation toward status/ETA/scope corrections and babysitting by Oct 31–Nov 2, but do not prove hours. Repeated prompts exist; they are not the whole cause. Actual integrated proof lagged merged-code volume.
- Security is mixed: code and plan have useful guards and HITL, but plan 005’s “PIA/NDA/ZDR, therefore no redaction” is not a substitute for model-route/data-minimization review. Current guest candidate output includes raw HMS row data.
- Keep the ETA ledger; add feature proof state, not another ETA log. Trim stale always-loaded product/process memory; preserve safety. Treat plan 005 as a proposed run, not execution evidence or current runtime truth.

## Chat evidence: intent, corrections, and babysitting

Window: Oct 28 00:00 through Nov 2 23:59 London time; timestamps were UTC in the scanned files (London was UTC for this window). These are **user-role text records**, not guaranteed human-authored prompts: Codex includes injected workspace/skill context, and Claude cannot distinguish context embedded in non-meta user messages. Do not sum Claude + Codex counts as unique prompts.

| Corpus | In-window parent sessions | User-role text records | Assistant final prose | Limits |
|---|---:|---:|---:|---|
| Claude Code, Zero roots/worktrees | 79 active IDs among 190 top-level logs / 65 roots; five also had older history | 898 non-meta | 634 (630 `end_turn`, 4 `stop_sequence`) | Nested `subagents/` logs excluded; one active log had no in-window owner turn; two had no final. Stream-parsed; 0 malformed; 9 logs >25 MiB (largest 181 MiB). |
| Codex CLI | 79 deduped IDs (77 with chat text); 86 files including rollouts | 1,030 | 379 | `thread_history_1.sqlite` and `/home/ubuntu/.codex/sessions` had no in-window activity. User count includes injected context. |

**What repeated / changed:**

- Normalized Claude user-role text had 754 unique forms and 144 repeat occurrences across 33 duplicate groups. No single request dominates. This is not evidence that “bad prompts” alone caused the slowdown.
- Keyword markers found pushback/follow-up in 191 turns across 20 sessions; undo/revert/restore language in 53 turns across 12. Coordination terms appeared in 262 owner turns across 33 sessions; short status/progress follow-ups in 80 turns across 9 sessions. These are proxies for correction/babysitting, not verified model errors or hours.
- In Codex, the pattern shifts from autonomous tool-building to asking about ambiguity payloads, tenant-scoped behavior, 17-hour under-delivery, then whether more agents helped. Examples to inspect: Oct 30 `01a189f9` 00:52–53; Nov 1 `01a191e6` 11:05; Nov 2 `01a19d5b` 18:12. Oct 31 assistant prose reported real modular readers/price availability/fake create-amend-cancel work (`01a188df` 10:25), so babysitting ≠ zero progress.
- Early “owner asleep” (Oct 28 `01a1801f` 01:28) meant autonomous implementation. Later autonomy skepticism was about delivery/coordination. It never means unattended real-guest writes or sends.
- Owner asked for group-email messages to be flagged/tracked but excluded from group-booking scope (`01a19829`, Nov 2 00:09). Current `mail-triage.ts` already has a `groups-events` category, so classification exists in source; plan 005 lacks an explicit tracking metric/acceptance bar. Verify that triage persists/measures the marker. Do not turn it into group booking.
- A Codex response initially implied staff adoption, then corrected to hypothetical “helpability” (`01a19829`, Nov 1 18:24). Track helpability/completion evidence—not adoption—unless staff usage is directly measured.

**Output quality / AI-slop signal:** 364/634 Claude finals use completion language; 325 pair it with evidence/check vocabulary; 214 include caveats. A lexical screen leaves 39 completion-word finals without evidence/check terms; this warrants a small manual sample, not a claim that 39 were false. Evidence/check vocabulary appears in 502/634 finals. 43/79 sessions had one user-role text record + one final, so babysitting is concentrated, not universal. The sampled scan gives no basis to compare models or attribute corrections to the AI rather than changing scope / runtime uncertainty. Tool payloads and nested agent transcripts were not included.

**Manual output samples (13 purpose-selected prompt/final pairs; not representative):** Oct 31 Codex `01a188df` (12:15) was brief/status-like but asserted “main/current” without visible SHA/check evidence. `01a191e6` (13:45, ~10.9k characters) carefully caveated what was not run, but expanded a 17-hour-run retro into next-week research/cancellation planning—too long and scope-widening. Nov 1 Codex `01a19829` (18:24) correctly distinguished hypothetical helpability from adoption. Nov 2 Codex `01a1996d` (00:02, 00:09) usefully separated merged/code-review slices from live workflows still unproved, and estimates from measured time. Claude’s 8-pair sample (Nov 1–2) rated four finals as reporting specific results/artifacts, two as plausible but unverified, and two as scope-drift risks; no generic/overlong case was found. Claude-reported artifacts were not independently verified. Read: not wholesale hallucinated slop; there are caveated/evidence-aware outputs, plus concrete verbosity/scope-expansion risks and a tendency to state currentness without an SHA. Fix with a short handoff contract: `implemented@SHA / checked@SHA / live@property / not-tested / next decision`.

One early Claude diagnostic projection accidentally emitted a local tool-result payload; the scanner stopped, did not retain/reuse/reproduce it, and reports no external transfer or worktree changes. All archived raw content stays out of this retro.

## What owner has been trying to build

The repo docs align on a product goal, even though the implementation/docs still disagree about the architecture:

- Nava should be a connected reservation-support tool inside staff email (webmail and Outlook), not a tool demo. Existing product notes say staff were not using it because it was incomplete.
- Current pilot target is Legacy Hotels Centurion/HRCEN. PRODUCT.md explicitly lists Da Vinci/HRDAV as “next”; plan 005 remains HRCEN-only. “Insurance” is likely a voice transcription of Infor, not a different insurance product.
- Shift business operations toward reusable Centurion HMS Cloud tools. Treat legacy Playwright tools as reference/compatibility, not the new product baseline. `PRODUCT.md` still describes Playwright as the tool mechanism, so that source-of-truth conflict itself needs repair.
- The staff-facing agent should clarify/prepare work; a human approves irreversible actions. For proof, use fake Labtest identities; do not infer approval for real guest changes, outbound sends, property changes, or deployment.
- Six requested workflows in plan 005: triage, quote, single booking, voucher/payment-proof filing, saved-stay amend, multi-room booking. Multi-room is real scope, but native room association is an unresolved constraint—not permission to invent it.
- “Fresh UI” means webmail/Outlook control and contract parity, not a visual redesign. OCR/POP and other parked research should not silently expand the pilot.
- Prior 90/120-minute targets are ambitions, not measured delivery promises. Plan 005’s ~5h40 estimate is still a forecast, not a validated build time.
- “Complete” should mean the agreed six-workflow pilot and its explicit proof bar—not every HMS surface/tool marked 100% complete. Also keep the owner-requested group-email marker/tracking separate from group booking: verify triage includes it before deciding whether to add it.

These are facts recorded in repo owner-decision docs/plans. Chat scans support the major scope shift and latest intent, but user-role data cannot be perfectly attributed to the owner and does not validate every plan detail.

### Scope changed mid-window

The Oct 30 build plan explicitly said: standalone Cloud tools + composed real-HMS script for that run; app/pane integration, production DB design, and the staff-facing product were deferred, and that run must not be called “product done.” The later Nov 2 goal is an integrated webmail/Outlook pilot with six staff workflows and deployed proof. That is a substantial scope expansion. It explains some calendar elapsed time without proving the implementation process was efficient. Key source: [Oct 30 tools plan](../pre-autonomous-build-new-tools-md-30-oct.md) and [Nov 2 plan 005](../../../plans/2026-11-02-005-feat-connected-pilot-final-plan.md).

## Architecture actually in force

Several distinct code paths exist; there is not one obvious assembled customer-support agent in current source. The current pane agent does not call the new Cloud JSONL tool session. The repo uses “1A/1B/1C” for three HMS read surfaces / a build method, not for the guest-profile helper names. See the source map below; effective environment flags and live runtime wiring remain unverified.

### Source-code architecture observed (static; environment state not checked)

| Path | What the source says | What is not established |
|---|---|---|
| Staff mail pane → reasoning | When `PANE_BRAIN=agent` and pane analysis is enabled, `pane-brain.ts` calls a Mastra `Agent` via `createAzureLunaModel()` and requests a structured `ReservationistDecision`. Without injected runners it passes `{}` tools. With runners, pane adapter exposes only `quote_stay` and `party_lookup`. | Effective flags, model endpoint, which server/worker invokes it in the current pilot, and live behavior were not checked. |
| Reservationist tool defaults | Agent registry contains quote, party lookup, quote PDF, and create dry-run/validation; default quote/party runners call existing `tooling/playwright-quote` scripts. No create-save/amend/cancel tool is registered on this agent. | Static absence from this registry does not mean no separate backend can write. |
| Background draft worker | `worker.ts` processes queued `candidate_draft` runs. Source defaults `HMS_DRAFT_ENRICHMENT_MODE` to `off`: normal path prepares/persists a staff reply draft without HMS enrichment. The `shadow` HMS lane runs a claim-safe plan/read path and persists counters only; source says the default lane cannot enter it. | Effective `ai-worker` lane/mode and current process build were not inspected. This is not proof of what is deployed today. |
| Cloud guest-profile helpers | `guest-profile.mjs` provides search, inspect, select, close helpers. `booking-lookup-session.mjs` imports and registers them in its own JSONL dispatcher, and booking/create helpers use that session. | They are not registered as tools on the pane Mastra agent. A compatibility re-export from an older party-session exists, but does not prove pane wiring. These are distinct from 1A/1B/1C read surfaces. |
| Cloud session authority | Guest selection validates one exact HRCEN data-only request, blank booking/reservation IDs and save flags, then reports `selected_unsaved` after native readback. | This is not a pure HTTP read: it performs a guarded native POST to select an unsaved profile. Treat it as a stateful UI operation with its own authorization/safety contract. |
| Model-visible data | Guest candidate output currently includes contact fields plus raw `responseData` and `gridData` rows. | Do not pass that whole object to an LLM without a minimal projection and privacy review. |
| Other service/worker seams | Repo also has versioned `hms_*` read-tool/worker plumbing and installed-provider adapters. | Static graph/reference existence does not establish these are the current user-facing path. |

Evidence: [`pane-brain.ts`](../../../../apps/server-pilot/src/ai/pane-brain.ts), [`agent-pane-adapter.ts`](../../../../apps/server-pilot/src/ai/agent-pane-adapter.ts), [`reservationist-agent.ts`](../../../../apps/server-pilot/src/ai/reservationist-agent.ts), [`worker.ts`](../../../../apps/server-pilot/src/ai/worker.ts), [`env.ts`](../../../../apps/server-pilot/src/env.ts), [`booking-lookup-session.mjs`](../../../../apps/server-pilot/tooling/hms-cloud/booking-lookup-session.mjs), [`guest-profile.mjs`](../../../../apps/server-pilot/tooling/hms-cloud/guest-profile.mjs). Source-only trace; no effective PM2 flags, live requests, or session state were queried. `pm2` is absent from this shell; runtime truth remains unknown.

**Architecture read:** a staff-reply draft worker exists; an optional, separately gated reservationist pane LLM exists; a claim-safe HMS read shadow exists; and new Cloud tools run in a CLI/session boundary. They are not one connected autonomous customer-support agent. Keep reasoning as intent extraction/planning over typed, minimized outputs and keep deterministic Cloud operations behind an explicit adapter/session boundary. Before a broad rebuild, choose one canonical path and prove mail selection → prepared action → staff approval → guarded tool → fresh readback → unsent response. Do not expose the whole HMS session registry to the model.

**Terminology correction:** existing research calls 1A = Stay 360 shallow cards, 1B = Record View, and 1C = Guest Details; these are data surfaces/readers. The Oct 30 “1A/1B/1C method” means inspect actual Cloud UI, build quickly, prove one real case, widen to representative cases/batches, then iterate. The guest-profile helpers are a different tool family. Preserve the user’s successful method without conflating it with a shipped agent API.

### Plan `2026-11-02-005` at the original retro snapshot (plan, not proof)

**Later update:** plan 005 was finalized in main commit `14e958b6f`, then clarified in `5297ac7787`; v2 is marked `ready-for-go`, has eight coding lanes plus coordinator, and forecasts ~5h50m. The peer review covered an earlier plan SHA, and the forecast is conditional. The clarified replay uses a fake Outlook bridge; real Outlook is a next-day client check. The [existing-work addendum](plan-005-existing-work-addendum.md) maps the later plan against open PRs and dirty worktrees. The bullets below describe the earlier snapshot, not the later v2 plan.

- Frontmatter: `ready-for-go (pending peer adversarial review)`; supersedes plans 003/004 and supplements plan 001. Plan 002 explicitly says it was superseded by 005.
- Goal: six connected staff workflows from selected mail—triage, quote, single create, voucher/payment-proof filing, saved-stay date/occupancy/rate-retain amend, and multi-room booking. Writes: Prepare → staff Go → native guard → screenshot → fresh readback.
- Architecture: 7 AI lanes + integrator; four frozen interface stubs; strict Zod inputs; `ToolResult<v1>` with `ok/refused/needs_input/uncertain`; `uncertain` always requires reread before retry. Aim ~340 calibrated wall minutes / 355 raw (~5h40), ~1,700 summed agent-minutes; human time budgeted zero; Outlook client test next day.
- Important distinction: “7 lanes” is a proposed implementation/team decomposition, not seven agents in the shipped product. It assumes separate Orca worktrees, shared contracts, and serial merge/deploy tail. Zero owner minutes is an estimate assumption; it does not erase live-write/deploy approval gates.
- The user’s requested group-email flag/metric is not explicit in plan 005’s six workflow description; the broader plan 001 mentions a group marker but not clearly a tracking acceptance criterion. Verify whether current triage covers it; do not silently expand to group-booking.
- `needs_input`/ambiguity should return candidate choices plus an actionable next step, not just an error code. Plan’s typed envelope can carry this data, but §4 does not make it an acceptance requirement.
- Verification: contract replay of ~3 real threads per workflow through webmail + fake Outlook bridge, backend prepare/preview (no commit); one representative Labtest save per write path + final deployed booking; DB suites explicitly skipped and reported.
- Plan 005 explicitly cuts the earlier golden-set evaluation work; the ~3-thread replay is for integration breakage, not a demonstrated quality/accuracy bar. DB persistence suites are also an explicit skip. Keep checks lean, but run a small independent-truth acceptance sample before claiming pilot quality.
- Treat this as the *latest plan’s proposed architecture and bar*, not evidence these six workflows are implemented, merged, deployed, or live-proven. A separate metrics snapshot found the prior `three-connected-workflows` Claude lock still live at 18:18Z after ~10h29; the plan itself says begin after that run finishes, except at a safe checkpoint. Need current session confirmation before saying the next plan started.

## Why delivery is taking so long

Strongest evidence points to scope transition plus integration/acceptance conversion, not slow PR mechanics: the target moved from standalone real-HMS tools to a full two-surface product; many changes merge quickly, while new Cloud tools are not on the pane path and earlier retros show no full connected workflow at their snapshots. Chat scans support a late shift toward ETA/status/scope corrections and coordination, but cannot isolate owner coding time, wait/babysitting hours, or a single root cause.

### Quantitative evidence (2026-10-28 00:00Z → 2026-11-03 00:00Z)

| Measure | Observed | Interpretation limit |
|---|---:|---|
| GitHub PRs created | 213: 166 merged, 45 open, 2 closed | All repo PRs in UTC date search; not all are product features. |
| Merge latency | Median 13m14s; p90 55m08s; max 13h42m | Open→merge only; excludes pre-PR coding, review work before open, and open PRs. Git merge is not the bottleneck. |
| Merged diff sums | +52,846 / −4,341 lines; 840 changed-file entries | Per-PR totals can repeat paths/changes; not unique delivered LOC. |
| Branch commit diff sums | All refs: +205,019 / −35,988; origin/main: +62,160 / −4,568 | Repeated branch work included; not net new product value. |
| Worktrees, snapshot Nov 2 18:18Z | 40 total; 39 linked; 26 dirty; 14 clean; 1 detached; 1 locked | `278` porcelain status entries, not files. 38/39 linked born Oct 29–Nov 2; 18 on Nov 2. |
| Repeated HEADs | 29 unique heads; duplicate groups 8, 3, 3 | Multiple concurrent branches share bases; can be planned fan-out, not automatically waste. |
| Open PR stacks | 45 open PRs, 45 distinct branches/heads; 20 base on `main`, 23 on another open PR, deepest stack 8; 2 base on external branches | Stacking may be intentional, but makes merge order/dependencies a critical-path concern. |
| Exact path overlap | 511 PR-file entries, 224 unique paths, 100 exact paths shared; 38/45 PRs form one overlap component | Same-file overlap does not establish hunk conflicts. Top shared paths: `nava-pane.tsx` (11 PRs), `reservationist-execution.ts` and `drafts.ts` (10 each). |
| Duplicate implementation | 0 identical full patch IDs among 45 open PRs; 11 commit SHAs recur across PR-specific ranges | Shared commits show shared history, not duplicate features. |
| PR ↔ worktree traceability | Zero open PR head SHA or branch-name matches among 40 current worktrees | Could be unpushed local work or completed local branches; dirty file-level mapping not done. Do not prune on this alone. |
| GitHub check names on 213 PRs | 0 named test, 0 named typecheck, 0 named Greptile Apex; Greptile Review on 166 merged | Checks may run outside GitHub. Cannot conclude absent; same-head required evidence is not demonstrated by these rollups. |
| Vercel statuses | 14 failures visible | No check-run detail in queried rollup; preview failure ≠ product failure. |

**Read:** merge mechanics are fast; outstanding work and integration dominate risk. 45 open PRs + 40 worktrees (26 dirty) show considerable unintegrated surface. 100 exact changed paths are shared across open PRs and 38/45 fall in one overlap graph; that is coordination risk, not proof of duplicate code. Yet all 45 full PR patch IDs differ, so exact-duplicate PRs are not the explanation. Zero current worktrees map directly to those open PR heads; build a read-only branch/worktree/PR manifest before any cleanup. The Nov 1 retro records ~19.5h from build start to retro and ~14.7h until first Labtest create proof: 38 merges, no deployment, no full inbound workflow at that snapshot. Better owner outcome metric: one supported email→decision→tool→review path, on one final SHA, with explicit verified/untested states. This still does not tell us exact human coding hours, model cost, or whether every PR is useful.

Size signal: 38/166 merged PRs exceed 500 gross additions, 9 exceed 1,000; this is a triage signal only. Repo gate is ~500 **product** lines, pure moves excepted. Largest cited PR #827 adds 1,571/−75 over 32 files; do not call it a gate violation without product-line classification.

## What is going well / badly

### Going well

- User-led 1A/1B/1C approach was strong: inspect actual HMS surfaces, build shallow readers/tools, prove one real case, then expand by evidence. The 1A/1B/1C *surfaces* are small deterministic readers; separate guest-profile helpers add explicit schema/query checks, session-bound selection, a narrowly fenced request, and native readback.
- This work produced real breadth: the Nov 1 field audit describes 892 successful 1A/1B/1C captures out of 894 attempts, covering 16 Stay 360 card headings, 118 Record View fields, and 88 Guest Details descriptors. Strong read discovery; it does not establish saved-record editability or a connected staff workflow.
- Cloud tool development used live interface discovery and Labtest proof as a feedback loop; existing Oct 30 and Nov 1 retros document real progress, not just generated scaffolding.
- Compound engineering is happening in practice: the repo has useful dated retros, a live coverage ledger, and a field-by-field evidence audit. The failure is that startup pointers/memory still foreground stale HRDAV/Pomerado/legacy workflow context, so accumulated learning is not reliably becoming the next run’s current truth.
- The code has meaningful safety structure: writes off by default in the pane, explicit staff-approval paths elsewhere, narrow native guards, and distinct `uncertain`/reread ideas in the latest plan.
- The owner is actively correcting outdated workflow rules and asking for evidence-backed parallelism, not dogmatically insisting on legacy sequencing.

### Going badly / open risks

- The new Cloud tool family is not connected to the current pane LLM tool registry. Similar nouns (`party_lookup`, guest-profile, installed provider, JSONL tools) mask separate paths.
- Candidate results currently carry raw HMS row data/contact fields. A future LLM adapter must project only necessary fields and use opaque IDs; do not hand the candidate object through unchanged.
- PR/worktree fan-out and high merge throughput produced a large unintegrated surface. Existing retro snapshots report 38 merges without a complete customer workflow; Nov 2 showed 45 open PRs and 26 dirty worktrees.
- Open-PR overlap is concentrated in a few central files, while no open PR head maps exactly to a worktree. That weakens ownership/traceability; a small manifest is more valuable than more agent fan-out. No proof of hunk conflict or duplicate implementation, and no worktree should be deleted from these counts alone.
- Several parallel plans and dated startup memories compete for authority. This makes “what is current?” harder precisely when context compacts.
- Documentation is plentiful but navigation/precedence is weak. Don’t add another giant skill or retro index; repair the one startup pointer and point to a short current-state handoff, while keeping source evidence searchable.
- Tests are not simply “too many” or “too few.” The gap is representative, production-shaped connected workflow proof plus same-head applicable checks. Current GitHub rollups do not prove off-GitHub checks were absent.

These are repository/process observations. Transcript evidence below shows a broad prompt mix and concentrated correction/babysitting, but keyword markers do not measure model fault or owner hours.

## Prior analysis already in repo

Do not repeat per-run reconstruction; synthesize these existing retros:

- [30 Oct Cloud build retro](../2026-10-31-hms-cloud-build-retro.md): 26 in-scope PRs (not 26 tools) in ~3h52; core 20 landed by ~2h53, six follow-ons added ~59m. Useful live-first slices; no completed staff workflow. Calls for a stop/re-scope checkpoint.
- [1 Nov 17h retro](../2026-11-01-hms-17h-retro.md): 38 PRs merged since replan, no deployment, no complete connected email→approval→Labtest→readback flow at snapshot. 4,766 added product/config lines + 5,265 test lines; coordinator ~8,085 exec calls + ~935 inter-agent messages; actual active coding, true idle time, and model spend unavailable. Names prerequisite stacking, review churn, repeated polling, broad fixtures, and weak critical-path ownership as contributors—not test runtime alone.
- [29 Oct overnight retro](../../2026-10-29-47-overnight-retrospective.md): prior pre-Cloud run reached useful foundations but no live end-to-end Centurion workflow; synthetic integration and safety PR stack grew while the SaaS path stayed blocked. Historical context, not current stack truth.
- Existing evaluations include [HMS coverage run](../2026-10-31-hms-coverage-run.md) (long event ledger), [write/memory results](../2026-10-31-hms-write-and-memory-results.md), and [field-scope audit](../2026-11-01-hms-field-scope-audit.md). Reuse only relevant evidence; dates, SHA, property, and current Cloud behavior matter.

**Synthesis:** the problem is not “AI cannot code fast.” Existing evidence shows rapid PR production and real tool proofs, but much weaker conversion to a coherent, verified staff workflow. The Nov 2 source/plan review still finds separate tool planes and no evidence the proposed six-workflow pilot is complete. Best-supported explanation is a scope jump plus integration/acceptance gaps—not proven wasted coding or a single AI failure. Available evidence cannot quantify owner hours, idle time, or model cost.

## External loop-engineering evidence

Full citations and study limits: [`loop-engineering-research.md`](loop-engineering-research.md).

- “Boris Shamir” appears to be a transcription of Boris Cherny; I searched Cherny’s public first-party posts. They describe personal use of parallel sessions, plan-first work, background verifiers, hooks, `/loop` and `/batch`; not controlled proof that high fan-out or token use improves outcomes.
- Anthropic’s long-running-agent write-up says compaction alone is insufficient; durable setup/progress artifacts + one incremental feature/session + executable checks + clean handoff/commit improved continuity in its experiment.
- Anthropic API `max_tokens` is an output ceiling, not a quality setting. “Max tokens = faster/better” has no cited support.
- Claude Code docs say broad permission bypass is for isolated containers/VMs. Bash sandbox does not sandbox file tools, MCP servers or hooks; security must cover every path, not only shell. Keep human approval for real-guest writes/sends.
- No controlled local comparison of Terra 6.1 Max vs Luna 6 Max vs Opus 5.5 was found; retain the owner’s current routing as a hypothesis, log route/review evidence, and compare on the same versioned tasks instead of inferring performance from anecdotes.

## ETA / delivery telemetry already exists

- “ETL” likely means **ETA** (the file/global instruction use ETA); no second time-estimate ledger is needed. `/home/orca/.claude/eta-ledger.jsonl` is ~600 KB with 1,648 event rows; shared Claude instructions say to append estimates and closures.
- Read-only aggregation by task ID and close date found 69 task closures from Oct 28–Nov 2: 54 superseded, 8 partial, 5 pass, 2 fail. `superseded` means plan/task replaced, not necessarily failed.
- Of 12 pass/partial/fail closures with a ratio, median `actual/estimate` = 0.88; only 5 passing rows, median 0.428. Heterogeneous tasks + small N make this weak calibration evidence, not a basis for shrinking every ETA.
- Schema check: rows can track project/task/estimate/actual/outcome/rework/stuck time and some other run telemetry, but no row has `plan`, `sha`, or `evidence` fields; only 1 has `pr`. Thus it tracks time/rework better than delivered product proof.
- Recommendation: keep ETA forecast calibration in place. Add outcome linkage only as a small extension or companion table—not a new sprawling event stream—with one row per customer workflow and: accepted behavior, owner/status, plan version, final PR+SHA, applicable checks at that SHA, Labtest proof reference, webmail/Outlook status, unresolved security/pilot holds, and explicit `not-tested` states. Store proof refs, not guest data. Update this only at meaningful state transitions.

## Memory/source-of-truth conflict found

- Root [`CLAUDE.md`](../../../../CLAUDE.md) auto-imports `PRODUCT.md`, `AGENTS.md`, and `docs/context/START-HERE.md`; shared `/home/orca/.claude/CLAUDE.md` adds global rules, including the ETA-ledger directive.
- Repo Claude memory index at `/home/orca/.claude/projects/-home-ubuntu-projects-zero/memory/MEMORY.md` is 80 lines of dated feedback/project pointers. Its 11-02 entry `feedback-product-md-order-stale.md` explicitly says current PRODUCT/ACTIVE/AGENTS workflow ordering and “Done” gate predate Cloud rewrite; keep safety rules, re-question non-safety product constraints.
- Current docs conflict: `PRODUCT.md` still presents Playwright as the deterministic HMS tool baseline, while current owner-decision docs say new work targets reusable HMS Cloud tools and old Playwright implementations are reference/compatibility only. `PRODUCT.md` also retains old workflow/Done guidance the dated Claude memory calls stale. A two-line user edit already replaces blanket one-workflow sequencing with evidence-backed granular parallelism.
- **Trim from auto-loaded memory:** old run-specific task ordering, frozen ETA targets, workflow counts, stale completion gates, old model assignments, and detailed retros. Do not load the whole history each session; retain links and explicit `supersedes` labels.
- **Keep always available:** product purpose and source-of-truth pointer; hard safety/privacy/authorization boundaries; current customer-visible architecture; current accepted workflow and exact proof/hold; how to resume; current model/agent routing only if it is truly durable.
- **Add/maintain one concise dated current-state handoff:** distinguish owner-confirmed facts, source facts, plan proposals, and unverified runtime state; name canonical Cloud path and parked/legacy code; exact SHA/environment/property for evidence; expiry/recheck date. Point `START-HERE.md` there instead of copying volatile context into several memories.
- Preserve the existing project `AGENTS.md` safety rules and `PRODUCT.md` safety boundaries. Reconcile or archive stale *non-safety* rules only after item-by-item review; do not wholesale ignore product memory or replace safety docs with this retro.

## Product gaps and next build slice

Confirmed or likely gaps (static source and plans; not a live readiness assessment):

1. **One canonical connected path.** The pane path does not currently invoke the Cloud JSONL/session tool family. Define the adapter boundary and join the actual user journey before adding more tools.
2. **Minimal data contract.** Keep the full HMS response/evidence privately for audit, but strip raw response/grid rows from model-facing results; use opaque session/search/candidate refs and property-bound schemas. This matches the Oct 30 tool plan’s “full useful response privately, smaller agent view” rule and addresses current `responseData`/`gridData` leakage risk.
3. **One representative vertical slice.** Mail/thread → extraction → deterministic prepare/preview → staff Go → exact native action → screenshot/evidence → fresh HMS readback → truthful staff result. Include refused/needs-input/uncertain recovery paths; uncertain must not auto-retry.
4. **Safe writes and trust boundaries.** Keep separate read/write capabilities; server-enforce property and staff authorization, approval binding to the exact prepared digest, stale-source detection, idempotency/uncertain reconciliation, and independent readback. Real guest writes/sends remain human-authorized; Labtest is the proof environment.
5. **Current integration proof.** A PR count, tool unit test, or successful isolated Labtest tool call is not pilot readiness. State exact SHA, property, environment, proof path, sample, and remaining holds.
6. **Property-port contract for Da Vinci later.** Reuse domain/workflow logic, but keep property, credentials, read/write capabilities, field mappings, source authority, and proof isolated. Do not “map” by replacing `HRCEN` strings or by allowing fallback to another tenant.

The six-workflow plan (quote, create, filing, amend, multi-room, triage) is a product target, not necessarily the next safe batch. Recommended: keep plan 005’s frozen interfaces, focused boundary tests, and per-write Labtest proof; make K3 (first app-prepared fake booking + fresh readback at ~95 raw minutes) a hard stop/replan gate. If it misses, do not let all seven lanes run on to the 5h40 forecast without identifying the blocker. Then parallelize only work behind proven contracts and a single integration owner.

### Security pushback before any autonomous run

Plan 005 does include focused grant/digest/fence/uncertain/refusal tests and fake-Labtest writes. But its §6 claim that PIA/NDA/ZDR cover the model path and therefore “no redaction work” is a governance assumption, not technical security proof. Verify the exact model route, egress, retention/logging, and the fields actually exposed. Preserve raw evidence privately; minimize model context anyway. Also, the plan’s ~3-thread-per-workflow replay is integration smoke, not an accuracy/production bar; its DB-suite skip must be reported and cannot prove persistence correctness. These are go/no-go facts to resolve in the peer adversarial review, not reasons to abandon the safe write path.

## Existing delivery failure modes (evidence; not root cause proof)

- Cloud work produced lots of small/fast merges and real HRCEN tool proofs; Oct 30’s first 20-PR spine landed in under 3h. This is real progress.
- By the Nov 1 17h snapshot, 38 PRs had merged but no complete email→approval→Labtest save→readback workflow existed. 4,766 product/config additions and 5,265 test additions did not equal an integrated user result.
- PR-count rose faster than the number of completed connected workflows; metrics cannot tell how many added lines became durable production capability.
- GitHub rollup cannot prove required remote test/typecheck/Apex checks ran—or did not run. Treat their presence as an evidence gap; never label checks “skipped” solely from absent contexts.
- 26 dirty worktrees and a live 10h29 lock show high coordination load; lock PID was alive, so it was not stale. Do not clean up/prune based on age.
- 38/45 open PRs share one exact-path-overlap component, but full patch IDs are unique; risk is serialized/shared-file coordination rather than obvious duplicate patches.

## Memory to trim / retain / add

**Trim:** stale non-safety Playwright baseline, blanket workflow ordering, outdated “Done”/golden-set gate, fixed test counts, run-specific model choices, expired ETA targets, and long historical run notes from startup context. Keep them archived/searchable with supersession markers.

**Retain:** product purpose; safety/authorization/privacy/deploy invariants; current canonical Cloud-vs-legacy architecture; one current plan/state pointer; evidence and resume instructions. Do not delete safety rules to make context smaller.

**Add/track:** one dated current-state handoff and outcome ledger keyed by workflow/PR/final SHA, with test/Labtest/webmail/Outlook evidence and explicit gaps/holds. Keep existing ETA event stream for estimate/actual/rework calibration; do not replace it or duplicate its time fields.

## Proposed operating loop

1. Keep a single short “current truth” page: architecture route + accepted workflows + exact status/proofs/holds. Date every volatile fact; state what supersedes what. Keep long event histories searchable, not auto-loaded.
2. Choose one outcome and define observable success, refusal states, and human-approval boundary before agent fan-out.
3. Start with one vertical integration path. Freeze typed interfaces and ownership. Parallelize independent lanes only after the integration owner proves contracts; avoid seven agents simultaneously inventing the product boundary.
   - Reuse plan 005’s K3 first fake booking as an early stop/replan checkpoint. Its 5h40 K7 remains a forecast; log actual owner/coordinator minutes, agent busy vs wait, integration/review/rework, and first user-visible proof.
4. Give each lane an output contract, bounded timebox, relevant files, dependency, verification command, and handoff. One integration coordinator; no polling loops without a progress signal or stop time.
5. Verify the final SHA with a small high-value set: representative mail contract replay, focused trust-boundary checks, read-only probe, one Labtest write/readback per write class, and required review. Report DB/external suites skipped with reason.
6. Keep a real person at irreversible boundaries: HMS writes, outgoing email, production deploy, flags, and permission changes. A model loop can retry reversible local code/checks; it cannot infer owner approval.
7. Track forecast separately from outcome: keep the existing ETA ledger; link estimate/closure to task, plan version, PR, SHA, evidence, blocked time, and rework/supersession reason. Add a compact feature-proof state only if no current source already owns it.

Do not build a general-purpose autonomous coding skill or loop yet. First prove this one bounded loop; then codify only stable behavior (intent snapshot, bounded task, stop gate, evidence state, safe handoff) as a short skill/runbook. The existing 1A/1B/1C method already has more proven value than a speculative agent-swarm recipe.

Anthropic’s published long-run experiment supports durable progress artifacts, incremental feature slices, executable checks, and clean handoff over relying on compaction alone. Boris Cherny’s posts are practitioner examples, not comparative evidence that maximum agent count/token use is better. Full sources and caveats: [`loop-engineering-research.md`](loop-engineering-research.md).

## Evidence ledger

| Claim | Status | Support | Counterevidence / gap |
|---|---|---|---|
| Product is Infor HMS / Centurion now, with Da Vinci next. | Supported by PRODUCT.md and the current plan; “insurance” is likely transcription. | Current scope explicitly HRCEN; HRDAV is the named later property. | No Da Vinci runtime readiness/proof checked. |
| Current runtime architecture. | Multiple distinct paths exist in source; no proof they are composed in production. | Pane agent, draft worker, HMS shadow reads, Cloud JSONL session, and proposed plan 005 have different roles. | Effective flags/deployed SHA not inspected; `pm2` absent from this shell. |
| Development was inefficient. | Scope changed materially; integration is the visible bottleneck. | Oct 30 explicitly deferred app integration; Nov 1 retro took ~19.5h to snapshot/first proof; Nov 2 has 45 open PRs and 40 worktrees. | We lack owner-authored event count, accurate hours, hunk conflicts, and causal attribution. |
| 1A/1B/1C method works. | Strong, user-led discovery pattern; real read evidence. | 892/894 captured read surfaces; shallow readers + one-real-case-first method in Oct 30 plan. | Not evidence of editability, LLM wiring, or a customer-ready workflow. |
| Prompt repetition caused delay. | Not supported as primary cause. | 754 normalized user-role texts, 144 repeat occurrences across 33 groups; broad range of asks. | No reliable owner-only prompt count; normalized duplicates do not measure semantic repetition. |
| Autonomous coding should stop. | No. Use bounded autonomy with integration gates; no unattended irreversible actions. | Plan 005 has frozen interfaces/K1–K7 and safe Labtest path; owner later questioned fan-out after under-delivery. | Seven lanes / zero human time / ~5h40 are forecast assumptions; only run when current scope/approval is explicit. |
| Group-email triage tracking. | Classification exists; metric/acceptance may be missing. | `mail-triage.ts` has `groups-events`; owner separately requested flag + tracking; plan 005 does not name the metric. | Verify state persistence and metric; keep group booking outside the pilot. |

## Gaps and exclusions

- Counts are known for in-window user-role records and assistant finals; reliable owner-authored prompt counts are not. No cross-client deduplication or nested-subagent transcript audit.
- “All chats” means all relevant Zero sessions in the stated date window where logs are available; unrelated projects, tool payloads, and sensitive content are excluded.
- Manual output-quality samples cover five Codex and eight Claude finals only; Claude completion/evidence keyword counts remain heuristic, not a corpus-wide truth audit.
- Current staff adoption, property readiness, live environment flags, and production behavior are out of scope and were not rechecked.
- Actual wall time vs owner/coordinator time, agent busy/idle time, model token/cost, and live runtime flags cannot be reported from current evidence.

## Source index

- [`PRODUCT.md`](../../../../PRODUCT.md)
- [`docs/context/START-HERE.md`](../../../../docs/context/START-HERE.md)
- [`AGENT.md`](../../../../AGENT.md)
- [Oct 30 tools plan](../pre-autonomous-build-new-tools-md-30-oct.md)
- [Nov 2 connected-pilot plan 005](../../../plans/2026-11-02-005-feat-connected-pilot-final-plan.md)
- Claude archive root: `/home/orca/.claude/projects/-home-ubuntu-projects-zero`
- Codex archives: `/home/orca/.codex/sessions/2026` and `/home/ubuntu/.codex/sessions` (no in-window turns in second root)
- Latest plans, dated handoffs, and in-repo retros are linked in sections above; raw chat IDs/timestamps are in “Chat evidence.”
