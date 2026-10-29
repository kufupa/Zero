# Claude Code simplification audit and plan
Created: 2026-10-28

## Verdict

Keep the safety and proof boundaries. Reduce unconditional historical context, correct conflicting guidance and unsupported workflows, and stop irrelevant cross-worktree hook output. Do not trade away review, production isolation or the owner's requested scope for shorter prompts.

**Authority:** Ask 361-meta requests research and a plan only. This document does not authorize edits to instructions, memory, hooks, permissions, skills, live sessions or production. The ask itself was recorded in `docs/context/OWNER-ASKS.md` and `PRODUCT.md`.

## Coverage and uncertainty

- Snapshot, 2026-10-28 00:00 to 01:13 UTC: 857 accessible JSONL files were structurally streamed for event timestamps. 32 had events today; 5 were this audit's own session or workers, leaving 27 prior/concurrent archives, including 5 main sessions and 22 subagent archives. All 110 assistant-visible and 41 human/coordinator/interruption text blocks in those main sessions were read. Tool results and subagent archives were sampled; six images were not inspected. Running files may have advanced after the snapshot.
- The retrospective worker fully inspected 31 distinct discoverable headline retros across 36 paths, with five identical copies. Supporting lane reports were sampled separately. A referenced temporary directory was absent, so any files that had been in it are unknown.
- Other-user Claude directories were inaccessible; sudo was not used. Two observed live process session IDs did not match an archive in the examined root. There may be additional sessions elsewhere. Therefore this is not a complete audit of all Claude Code chats or all retrospective evidence.
- Repo revision observed: `origin/main` `3a5b3f315`. Working tree was already dirty and other sessions may continue to edit it. Historical records are not current runtime or authority.
- Evidence strength varies. File contradictions and this session's hook output are directly observed. Statements about business impact or dollar savings require controlled before/after measurement.

## Evidence and assessment

| Claim | Evidence | Counterevidence or limit | Recommended response |
|---|---|---|---|
| Working evidence and safety gates help | `docs/context/ledger/2026-10-26-or2-retro.md:75` records no merges before same-head Greptile and real P0s caught by review. `docs/research/2026-10-27-next-run/amend-cancel.md:12` proves refusing a penalty dialog did not prevent the preceding cancellation. | One run's outcome does not establish causation. Some controls were assistant-added rather than owner-required. | Retain same-head review, property lock, write boundary, post-action readback and no penalty acceptance. Do not claim a cancelled booking was prevented merely because its fee dialog was untouched. |
| Historical context is unconditionally loaded | `CLAUDE.md:1` imports `PRODUCT.md`, `AGENTS.md`, `AGENT.md` and `docs/context/ACTIVE.md`; these measured roughly 111 KB at audit. `ACTIVE.md` alone measured roughly 68 KB and includes historical runs. | Bytes are not model tokens, latency or bill. Some history protects continuity and current holds. | Keep a short current state plus links; preserve all historical records and validate retrieval before removing any automatic import. |
| Test advice conflicts | User-global `~/.claude/CLAUDE.md:23` says local VPS tests/typecheck. `AGENTS.md:54` forbids test runners and typechecks on this VPS for Zero. `AGENT.md:97` says always run `pnpm check`; `AGENT.md:112` forbids that exact command. | Project-specific guidance wins for this repo; the global file may serve other projects. | Correct the contradictions by scope; retain remote Zero checks and targeted safe lint. Do not weaken hooks. |
| Required closeout mode is not implemented as named | `AGENTS.md:27` mandates `ce-compound mode:lane-close`. Installed `~/.claude/skills/ce-compound/SKILL.md:30` detects only `mode:headless` and otherwise uses interactive mode. The skill describes verified solutions as its intended material. | A genuine reusable solved problem can merit compounding. No behavior was verified fixed in this audit. | Replace blanket lane-close ritual with a brief existing handoff; invoke the supported headless mode only when documenting a verified reusable learning. |
| CodeGraph hook produces irrelevant and wrong-worktree output | In this audit its prompt hook warned that its index belonged to a different worktree and returned unrelated symbols. A second invocation followed an agent message, returning about 16 KB. `~/.claude/hooks/codegraph-prompt-hook.sh:19` filters task-notification payloads, not every agent message. | CodeGraph can be useful for real source navigation; prompt output does not by itself quantify latency or dollars. | Keep on-demand code navigation. Test a scoped, worktree-aware trigger and suppression of non-user notifications before changing the live hook. |
| Model and cost labels need care | `docs/research/2026-10-14-product-assessment.md` records a routed-model alias issue. Today's transcript archive contains usage fields, not provider invoices. | A model label can be accurate in some sessions; no current billing or actual served route was verified. | Verify served provider and pricing before dollar accounting. Do not promise savings from fewer bytes without a measured baseline. |
| More planning or review is not automatically faster | Today, a planning-only workflow started a lane before the owner stopped it; an eight-reviewer burst was later stopped as delaying a fix. `docs/context/ledger/2026-10-26-or2-retro-pm.md:19` records review rework and overlapping coordinator waits. | Two reviewers in the burst identified useful test gaps; the timeline does not prove a net delay against a serial control. | Distinguish plan authority from execution. Use parallel workers for independent material questions, not as an automatic gate; retain critical reviews. |
| Durable policy and history have become mixed | `docs/context/OWNER-ASKS.md:109` contains dated process suggestions, including an old context-reset practice; current `AGENTS.md` gives a later handoff rule. `docs/context/ACTIVE.md:292` repeats the conflicting local-check advice. | A dated ask can still be authoritative if the owner never superseded it. | Clearly label records as historical, preserve original owner wording, and promote only current rules into one authoritative scoped location. |
| Memory conflicts on writers and tests | The memory index mentions a three-writer limit and a local full-test wrapper. The linked memory also recommends targeted local tests. `AGENTS.md:38`, `AGENTS.md:57` and `AGENTS.md:61` instead allow isolated writers without a count cap and prohibit local test runners for Zero. | File ownership, browser locks and heavy-check limits still apply; this is project-specific guidance. | Correct both the index and linked memory after confirming latest owner direction. Preserve remote test execution and do not invent a new writer cap. |

### Today's concrete session examples

- In `~/.claude/projects/-home-ubuntu-projects-zero--worktrees-recover-parse-failure/4e05638f-20fd-47d6-94af-b409d33ac6bc.jsonl:26550`, the owner challenged fake-data and stop-gate overhead. The assistant acknowledged that synthetic tests tested its mechanism, not the requested real screen. Separately, a review found defects in the proposed stop gate. Neither proves the failed mint's root cause.
- In `~/.claude/projects/-home-ubuntu-projects-zero--worktrees-recover-parse-failure/83d64b3b-f14a-4163-9af8-1319b21f8174.jsonl:2290`, a worktree/lane was created before the owner's planning-only correction. A later briefing was denied. Do not claim the denied brief or batch ran.
- `docs/context/ledger/2026-10-26-or2-retro.md:49` corrects an inflated gate-run count caused by counting command echoes as executions. Do not equate log-string counts with tool executions.
- The Oct 26 retrospective's faster PR throughput compared different run scopes, while live quote proof remained open. Treat throughput as an operational metric, not proof of staff value.

## Proposed edits, not applied

Each line is an independent hunk. Check references, active changes and owner policy before applying.

1. In the global test guidance, replace the universal local-VPS instruction with: “Follow each repository's approved test and typecheck location. For Zero on this VPS, use its remote-check rules. Run only targeted lint where permitted.” Keep the separate installer-only Actions policy unchanged.
2. In `AGENT.md`, replace “Always run `pnpm check` before committing” with: “Use the targeted lint and approved tests specified in `AGENTS.md`; do not run repository-wide lint or format commands.” Keep the existing prohibition.
3. In `AGENTS.md`, replace the unconditional unsupported lane-close invocation with: “At lane close, record the outcome, remaining hold and evidence in the existing handoff. Use `ce-compound mode:headless` only for a verified, reusable solution that needs a durable entry.”
4. In `docs/context/ACTIVE.md`, keep current acceptance, authority, lock and production holds, plus pointers to dated evidence. Move historical material to existing archives or one verified archive. Preserve all content and update inbound links; never erase original requests.
5. In the memory index and the linked writer-limit memory, replace the stale count cap with the current isolated-file ownership rule after checking its provenance. Keep the ban on local heavy checks.
6. For the CodeGraph hook, specify expected behavior rather than editing immediately: no lookup for background-agent messages, no lookup from a mismatched worktree, useful on-demand lookup for code work. Preserve installer detection and existing timeout protections. Validate on synthetic event payloads and an isolated session before any global change.
7. For historical `OWNER-ASKS.md` and `MISTAKES.md`, preserve records as evidence. Make historical suggestions visibly dated and non-authoritative where necessary; do not delete owner decisions merely because they are old.

## Execution plan after separate owner approval

1. **Snapshot and ownership.** Capture exact versions of relevant repo and user-home files, identify live session owners and dirty changes, and confirm effective precedence and rollback. Do not stop, restart or reconfigure existing sessions. Freeze current safety invariants and owner-approved exceptions.
2. **Resolve factual contradictions.** Make the independent test-command and unsupported-mode corrections first. Validate that Zero's remote-test requirement and installer-only Actions remain intact. Update stale memory only after source and latest owner direction agree.
3. **Shrink startup without losing state.** Rewrite the current-state view from current verified holds, active owners and acceptance checks. Archive history without deleting original asks or breaking links. Keep unverified status labelled. Review concurrent edits before applying.
4. **Scope hooks and skills.** Measure the existing prompt hook with representative code, plain-language, agent-message and wrong-worktree fixtures. Prototype narrowly in isolated configuration. Keep the installed catalog unless an individual skill is demonstrably problematic; metadata discovery is not the same as fully loading a skill.
5. **Behavioral comparison.** Run the same consented, sanitized, non-production task set against old and candidate setups in fresh isolated sessions. Include plan-only versus execution, CodeGraph across worktrees, remote-check selection, production safety, simple coding, a complex debugging case and relevant historical recall. Check both correct task outcome and guardrail behavior.
6. **Roll out and observe.** Compare elapsed-to-useful-answer, unnecessary questions, wrong actions, tool invocations, hook duration, provider-attributed dollar cost when available and quality regressions. Keep the original for rollback. Change one high-risk surface at a time. Roll back on a missed safety hold, unauthorized action, lost request or broken workflow. Do not treat an arbitrary speed or size target as a pass bar.

For simple contradiction fixes, verify the edited text and a representative test-routing prompt. Reserve paired old-versus-candidate cases for hook and startup-context changes; use a short existing-session checklist, not a new evaluation platform.

**Not in scope:** deleting transcripts/retros, new memory infrastructure, replacing models, auto-executing production work, changing permissions, disabling security, GitHub Actions, or live HMS trials. Determine current owner authority separately before any such action.

**ETA:** No reliable completion estimate for the cleanup is available. The prior planning/research ledger medians are not a benchmark for this specific cross-session migration. First measure the baseline and estimate the actual longest chain before quoting time.

## Sources

- [Dated audit evidence and coverage](../research/2026-10-28-claude-code-audit.md).
- `CLAUDE.md`, `PRODUCT.md`, `AGENTS.md`, `AGENT.md`, `docs/context/ACTIVE.md`, `docs/context/OWNER-ASKS.md`, `docs/context/FACTS.md` and `docs/research/CATALOG.md`.
- `docs/context/ledger/2026-10-26-or2-retro.md`, `docs/context/ledger/2026-10-26-or2-retro-pm.md`, `docs/context/ledger/2026-10-27-pomerado-run2-retro.md` and `docs/context/ledger/2026-10-27-pomerado-login-first-retro.md`.
- Host configuration under `~/.claude/`, including the CodeGraph prompt-hook wrapper and installed `ce-compound` skill. These are host paths, not repo-owned files.
- Today's accessible session snapshots, including the two file/line anchors above. Raw chats are not copied into this document.

## How the pieces should fit

| Surface | Proposed job | Not its job |
|---|---|---|
| User-global Claude guidance | Stable cross-project preferences and truly cross-project safety. | Hardcode Zero's runtime or a transient model route for every project. |
| Repo instructions | Small, current Zero rules shared by Claude, Codex and Cursor. | Duplicate the full historical run ledger at every startup. |
| Product contract | Current staff workflows, hard boundaries and proof requirements. | Treat every old ask as a newly authorized action. |
| Active handoff | Current owners, holds, checkpoints and links. | Store the entire run history inline. |
| Owner ask ledger and retros | Preserve original wording, decision history and evidence, with dates. | Override later decisions simply because old advice remains visible. |
| Auto-memory | Owner preferences and non-obvious stable context, indexed for selective recall. | Duplicate repository facts or retain superseded limits. |
| Skills | Domain workflows loaded for relevant tasks. | Automatically run a heavy full pipeline for every simple question. |
| Hooks and permissions | Enforce narrow, testable boundaries and useful event handling. | Substitute prompt prose for security, or inject unrelated source into every message. |
| Subagents | Independent work whose parallelism and evidence value justify the handoff. | Multiply reviews, cost and context by default; permit plan-only requests to execute. |

The owner previously asked for parallel, high-effort research and current evidence. Those preferences remain in force until the owner chooses otherwise. A conditional, task-sized alternative is a recommendation to evaluate, not a claim that those directions have expired.

Current Headroom connection failed in this session. That is a connection failure, not evidence the server is unconfigured. Hindsight, Exa and Pomerado are configured or discoverable in some contexts, but this audit did not demonstrate their full end-to-end value or current privacy/billing properties. Do not delete or replace them based on presence alone.

## Example acceptance checks

- A plain-language question or incoming agent notification does not cause irrelevant cross-worktree source output. A real code question still finds the active worktree's relevant symbols.
- A plan-only prompt produces a plan and evidence, not a worktree, lane, deployment or browser action. An authorized execution prompt still proceeds autonomously within its stated scope.
- A Zero test or typecheck is routed to the approved remote host; a banned repo-wide formatting command is not suggested as mandatory. Unrelated projects retain their own test rules.
- A fresh session can locate the current hotel lock, guest-write restriction, latest owner ask, current hold and relevant historical evidence without treating an old status as current.
- A real P0/P1, missing approval or unresolved private-data boundary remains blocking. A redundant synthetic control does not become a prerequisite without a demonstrated purpose.
- Review the diff against current dirty files, then run the comparison without sending real guest or transcript contents to external services. Record effective model/provider and actual cost only where independently available.

## Cross-session ledger collision observed during this audit

Two independent sessions appended different requests under the same next number while this audit was running. The audit's request was relabelled `361-meta`; the other session's request and running work were left untouched. This is evidence that a shared incremental-number convention is not safe under concurrent writers, not evidence that a session should be stopped.

**Proposal:** Use a collision-resistant request identifier or one actual ledger writer for shared-file updates. Keep the human-readable original wording. Validate concurrent append behavior in a scratch copy and avoid introducing a central lock for unrelated product work. Do not rewrite existing request IDs en masse.

## Additional retrospective checks

- A review missed a no-live-mail boundary in one lane brief, and the lane accessed live mail. `docs/context/ledger/2026-10-22-sr3-overnight-retro.md:83` supports keeping a concise task-specific privacy and authority boundary in every relevant brief, not a blanket sandbox for unrelated work.
- The merge gate checked the actual review head in the October 26 run, but the retrospective could not confirm Apex mode from the check title. Do not claim verified Apex for those runs. See `docs/context/ledger/2026-10-26-or2-retro.md:96`.
- Holdout contamination recurred historically. Preserve independent truth, stable comparison rows and a final holdout not used for tuning. See `archive/lab-scratch/docs/solutions/workflow-issues/quote-hitl-loop-retro.md:32`.
- Correction to an earlier research hypothesis: the initial no-click request came from the owner, who later allowed relevant read-only clicks and scrolling. Do not attribute that original restriction to the assistant. The extra stop-gate controls and the safety defects found in that proposed gate are separate observations.

## Skill-body sizing, not cost attribution

The installed `ce-plan/SKILL.md` measured 96,417 bytes and `ce-compound/SKILL.md` measured 57,307 bytes. Both were invoked in this audit; the latter was called because `AGENTS.md` mandates its unsupported `mode:lane-close`. These are file sizes, not a measured context, latency or cost attributable to either skill. Skill metadata discovery is distinct from invocation.

**Proposal:** Characterize actual invocation frequency and behavior before changing the skills. If the full workflows are often triggered for narrow tasks, test a short front door with detailed references loaded on demand. Do not remove the plan workflow or alter the shared skill catalog without checking other projects and the host's shared-skill propagation procedure.

## Privacy issue requiring separate verification

A session transcript records that a hosted page containing cases described as private was fetched without authentication along that session's network path. The session also recorded that the case data predated its later page update. Source: `~/.claude/projects/-home-orca-orca-workspaces-zero-triage-pane-shape-20261027/72e3a61e-02b8-40e1-aa4b-08b8ecc919ee.jsonl:15869` and `:15942`.

The locally retained page source matches the historically served hash and contains embedded non-example-looking contact and reservation data. Seven legacy case payloads match a prior backup. The session described those as pre-existing private cases; that does not independently establish every identity or rule out newly visible derived fields. Source: `~/.gstack/projects/zero/designs/current-ui-showcase/outlook-side-pane-demo.html:532`. Historical no-credential access was observed from one machine, not proof of current access, internet-wide reachability, a new disclosure or any third-party access. No page URL, guest details or payload are reproduced here. A page making no external browser requests does not by itself prove the page requires authentication. Check current access and data sensitivity privately before considering changes; do not interrupt the other session or alter the page under this planning-only request.

A systematic read of the five in-scope main sessions found six `ce-plan` body injections across two sessions. They included explicit reinvocation and compaction reloads, so the count is not proof of unnecessary work or incremental spend. In the booking-planning session, a subsequent “no lanes started” claim was too broad: lane direction was sent and another worktree/terminal was created, although its briefing was denied and the census batch did not start. See the earlier session anchors at `:2278`, `:2290`, `:2296`, `:2324` and `:2339`.

## Mistake-log contradiction

`docs/context/MISTAKES.md:7` prescribes a 25-call research cap and cutting at ten minutes. `AGENTS.md:41` instead prohibits fixed command or time caps and calls for a ten-minute progress check, with steering or relaunch only for a drifting lane. Keep the observed lesson about narrow briefs and duplicate searches, but mark the conflicting old prescription as historical and follow the current project rule until the owner changes it. Do not delete the original incident.

`docs/context/MISTAKES.md:29` also says a hard handoff at 150K, while the later owner policy in `docs/context/OWNER-ASKS.md:345` explicitly rejects that hard cutoff and `AGENTS.md:39` records a different handoff guideline. Keep the original incident and cost evidence; label its old operational prescription superseded rather than repeating it as a current rule.

This audit also activated the bundled Claude API skill because the request named Claude. It included a TypeScript API introduction even though the task was about Claude Code configuration; the prompt-audit reference was useful. The broad trigger and built-in skill are not established to be user-editable. Treat narrowing this overlap as a product or skill-design proposal, not a change to user configuration or a claim about measured cost.

Keep the owner's ADHD-friendly and concise final-answer style. For internal workers, test whether a brief output schema can replace repeatedly loading full style-skill bodies without degrading the coordinator's final answer. This is a proposed measurement, not permission to override current global instructions or remove the owner's preference.

`361-meta` is an interim collision-free label, not a claim that all existing ledger parsers support suffixes. Before adopting any identifier scheme, inventory numeric-only consumers and preserve their compatibility.

## Target operating kernel

A compact startup should give an agent the following, with deeper documents loaded only when relevant:

1. The user's requested outcome and whether this turn is research, planning or authorized execution.
2. The applicable project, worktree and source revision, plus the current handoff and links to the relevant evidence.
3. The user's communication preferences, without forcing user-facing formatting workflows onto every internal worker.
4. The active safety boundaries: real-guest writes and sends, property locks, privacy, approved remote tests and deployment path.
5. When action is authorized: one owner per shared file or live property, parallelism only for independent work, and same-head review and verification appropriate to the change.
6. At handoff: actual result, evidence, remaining blocker and next acceptance check. State uncertainty and historical status rather than treating old run instructions as live permissions.

This is a design sketch, not a replacement for the complete product contract, current owner decisions, or the detailed procedures required for production actions. Candidate edits must preserve those through scope-specific links and behavioral checks.

## Official guidance and limits

A bounded documentation review found useful distinctions in the official [memory](https://code.claude.com/docs/en/memory), [skills](https://code.claude.com/docs/en/skills), [hooks](https://code.claude.com/docs/en/hooks), [permissions](https://code.claude.com/docs/en/permissions), [sandboxing](https://code.claude.com/docs/en/sandboxing) and [settings](https://code.claude.com/docs/en/settings) guides. The review used WebFetch summaries; some pages were only partially read. Exact wording, installed-version behavior, and effective policy in this host remain unverified.

- Instruction files and memory provide model context; they are not, by themselves, mechanical enforcement. Evaluate real execution boundaries separately.
- Skill discovery metadata is different from loading a full skill body. Test invocation behavior on the installed version before changing skills or drawing a cost conclusion.
- Hooks and permissions affect tool execution. Sandbox coverage is tool-specific; hooks and MCP servers must not be assumed to inherit the Bash sandbox. Test effective behavior, including the current permission mode, in an isolated configuration. Do not weaken existing protections.
- The settings guide describes a worktree permission-setting behavior that can affect the main checkout. Verify it in a disposable repository before changing any shared settings; do not assume worktree settings are isolated.

The reviewer suggested moving every prohibition into deny rules or hooks and imposing a short-file target. This audit does **not** adopt either as a blanket change: some controls already exist, scope and bypass behavior vary, prose still carries context, and an arbitrary size limit can lose essential rules. No permission, hook, sandbox or settings change is authorized by this planning request.
