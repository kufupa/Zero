---
artifact_contract: ce-unified-plan/v1
artifact_readiness: requirements-only
product_contract_source: owner-ask-370-and-product
execution: code
---

# Rebuild the agent operating model

**Date:** 2026-10-28. **Authority:** planning only. Owner paused the earlier implementation and then requested this plan. This artifact does not authorize execution, changes to other sessions, configuration, permissions, HMS, flags, deployments or sends. Readiness is deliberately `requirements-only`: strict cap feasibility and safe rollout are not yet established, even though this plan specifies the staging work. A future go may authorize independent investigation and staging without authorizing an unproven global switch.

## Goal Capsule

Give each relevant agent a clear, accurate picture of Nava, its immediate task and the non-negotiable boundaries. Prefer evidence and practical judgment over mandatory rituals. Ship the full owner-approved scope quickly using independent lanes, meaningful verification and the fewest true dependencies. Replace harmful or redundant guidance without damaging ongoing work.

**Authority order:** system and applicable higher-priority harness safety requirements first; then current owner instructions and live-session scope; `PRODUCT.md` and repository instructions for product and project rules; dated evidence and memories as evidence rather than permission. Lower-priority instructions cannot override higher-priority rules. No owner approval is relayed between executing sessions.

**Inputs:** [owner's exact request and pasted assessment](../context/asks/2026-10-28-agent-operating-model-claude-783c2180.md), [peer plan](2026-10-28-005-refactor-agent-rules-and-test-cap.md), [previous audit](2026-10-28-claude-code-simplification-plan.md), [execution evidence](../research/2026-10-28-claude-code-simplification-execution-783c2180.md), and [current cleanup handoff](../context/HANDOFF-2026-10-28-claude-code-simplification.md). This plan supersedes neither another session's scope nor a more recent owner instruction.

## Product Contract

### Requirements

| ID | Requirement |
|---|---|
| R1 | Every relevant harness receives a concise, maintained view of the complete 10/10 product, plus task-specific context and current, separately verified state. No proposed vision is presented as an approved or shipped feature. |
| R2 | Agents research the decision-critical evidence, identify meaningful counterarguments, challenge weak assumptions, and proceed autonomously on reversible obvious decisions. They distinguish proof, historical report and unknown. |
| R3 | Agents select useful skills, MCPs, models and research depth for the task, subject to explicit owner choices and higher-priority rules. Avoid mandatory ceremonies, repetitive audits, speculative blockers and unmeasured model-speed claims. |
| R4 | Maximize useful safe parallelism. Separate work by real dependencies and owned files; serialize the same file, shared state, property browser and other genuine singletons. Preserve the three-local-test maximum across the supported host paths. |
| R5 | Preserve staff, guest, privacy, database, review, deployment and GitHub Actions boundaries. Keep ongoing sessions and their in-flight work undisturbed. A historical observation is not current authorization. |
| R6 | Preserve original asks, historical records and relevant citations. Reduce repeated automatic context, conflicting rules and stale injection, with a tested rollback for every live change. |
| R7 | Measure practical outcome and cost where reliable: task completion, elapsed critical path, reproducible failures, actual model/provider attribution and verification coverage. Do not invent a price, reliable ETA or success from an alias or miniature sample. |

### 10/10 product brief to deliver

Create one authoritative, short brief derived from the owner-maintained product specification, linked to the actual specification rather than replacing it. For relevant work, every harness or spawned worker receives the brief or a reliably loaded reference, plus a narrow task packet. Check real effective context, not just file existence.

The brief must explain:

- **Who and where:** Nava serves hotel reservationists in the existing Outlook and webmail experience. Infor HMS is the record. Do not confuse historical adoption or live-state observations with current facts.
- **What good looks like:** understand the inbound request and existing booking, prepare accurate facts and rates, show clear actionable progress, then support the staff member through the whole workflow. Staff must not troubleshoot with a terminal or see raw errors.
- **Full direction:** quote and booking first, followed by amend and cancel, then payment proof, vouchers, billing and group/event work as specified. Include the owner-requested HMS-shaped booking fields, multi-room and child details, rate preparation and native add-ons as direction, not as shipped or authorized implementation. Sequencing is not dropping approved scope. Treat the pre-stay self-mail and travel-agent policy as product rules, not one-message exceptions.
- **Autonomy and review:** reads and preparation can be automatic where authorized. HMS writes require the current owner authorization and staff approval, followed by a reviewable outcome. Never independently send mail or accept a cancellation-penalty dialog. Labtest exceptions are narrowly scoped.
- **Quality:** prove the relevant end-to-end staff outcome and current product acceptance bar, not a merge or single test. Treat both pane surfaces as in scope for pane features. State what is not yet proved.

Keep implementation status, file ownership, property locks and current flags in a short dated task/handoff layer, not in the enduring vision. Record sources and version/date so a brief cannot silently become a stale second specification.

## Planning Contract

### Decisions and pushback

1. **Three layers, not a new framework:** stable product brief; minimal rules for safety and behavior; a short current task/ownership handoff. Original asks, retros and deep evidence remain linked on demand. Existing mandatory harness context is respected rather than cloned into each layer.
2. **Review the peer plan, do not adopt it unchanged:** reuse its concern for safety, reversibility and staged validation. Add product vision, explicit constructive pushback, independent lanes, true child-process lifetime, existing-session treatment and effective-context proof. The peer's assumption that typechecks join the pool is not owner approval for local typechecks.
3. **No artificial writer cap:** launch only independent, useful lanes with separate worktrees and owned files where available. Review the integrated diff and run same-head required verification. Do not replace real review with a ritual, or discard an owner-required gate without new authority.
4. **Test cap means whole runners:** each independent concurrent test runner consumes a slot, including separate suites launched by one wrapper. Ordinary workers belonging to the same runner do not each require a slot. Its slot remains occupied until the complete job and surviving descendants stop. The existing shared wrapper is cooperative: direct unwrapped runs bypass it and a surviving child can escape the permit. No claim of cross-harness enforcement until live launch paths, jobs and descendants are accounted for and verified. Old local typecheck prohibition and denied hooks remain in force.
5. **Stage before shared activation:** edits to shared hook scripts may affect an already-running session on its next prompt. Prepare and prove a new-version path without changing behavior underneath existing sessions. Do not stop, restart, inspect private work of, or reconfigure another session to gain rollout access.
6. **Prefer smallest proven enforcement:** investigate whether a host-managed job supervisor using OS process groups or cgroups can hold a slot until the entire job is gone and prevent normal harness bypass. A daemon, extra privilege or permission change is not automatically approved. If full interception requires a permission/security change or an unavoidable interruption, leave the host-wide claim blocked and present the concrete trade; do not silently weaken the requirement.
7. **Don't invent a completion ETA:** no prior successful end-to-end cross-harness rollout was found. Ledger medians mix unrelated work and superseded outcomes. Measure the independent staging and cap canary after authorization before giving a forecast; do not use a guessed decomposition as measured evidence.

### Current state and exact limits

| Area | Evidence | Plan treatment |
|---|---|---|
| Existing cleanup | Several contradictory instructions were corrected. A backup and execution record exist. | Keep those edits and dirty work. Reuse, do not redo the audit. |
| Local cap | Three ordinary synthetic jobs and a waiting fourth worked across two accounts; an unwrapped job and a descriptor-closing survivor bypassed the cooperative guarantee. | Treat as an unproven prototype, not deployment. Continue current approved remote route while normal host-wide enforcement is unproved. |
| ACTIVE | Candidate predates concurrent edits and the latest cap direction. At least 30 textual historical line citations across seven files need version-specific handling. | Rebase from the live source, preserve each current owner's update, retain or map evidence by cited revision and check links. Never blindly replace. |
| CodeGraph | Wrong-worktree and copied-index cases were reproduced; staged hook still cannot prove copied-index origin. | Verify index provenance before rollout; absence of an origin marker must fail safely or avoid unsupported guarantees. |
| Skills | Proposed skill fixes are staged, not installed. The required catalog synchronization can change ownership/ACLs and delete files. The current plan skill also mandates a multi-persona review even when a smaller review is sufficient. | Inspect complete effects and devise a safe approved route first. Make reviews proportional while retaining owner-required gates. Do not run the broad sync or change shared skills under the current hold. |
| Hindsight / Headroom | Mandatory host search was removed; registrations or hooks remain elsewhere. Headroom connection failed in this session. | Inventory actual injection and current usage. Disable or remove only stale user-controlled entries after safe rollout; distinguish configured, enabled, invoked and broken. Do not claim absent. |
| Model routing | CLI alias maps through a local gateway. Effective served model and actual billing for previous samples were not independently verified. | Retain current explicit owner routing and safety rules until changed with authority. Compare task results and real cost attribution before proposing replacements. |

### Parallel schedule and dependencies

After the owner explicitly authorizes execution, start the following **independent preparation** together. These are ownership areas, not a fixed agent count. One coordinator integrates and owns the user-facing outcome.

| Lane | Owned work | Depends on | Cannot do |
|---|---|---|---|
| A: Product and rules | Draft product brief and minimal behavior/safety kernel; compare real harness context loading. | Current product and owner asks. | Invent features or downgrade an existing owner rule. |
| B: Session and handoff | Inventory active ownership without interruption; update a candidate short handoff and source/citation mapping. | Current shared file snapshot. | Replace live `ACTIVE.md` or treat stale runtime state as current. |
| C: Check-cap design | Map actual test-launch paths and process lifetimes; stage the smallest credible cross-account supervisor and admission integration. | Existing gate evidence; live-session inventory before activation. | Run a real local Zero test, bypass a hook or claim universal enforcement before verification. |
| D: Tool and skill cleanup | Inventory hook/MCP/skill effective use, develop safe staged proposals, including CodeGraph provenance and catalog sync. | Existing audit; installed configuration only as needed. | Alter live shared hook behavior or run broad destructive sync. |
| E: Measurements and integration | Define representative tasks and blinded old/new checks; integrate findings and verify rollback. | A–D drafts for final comparison, not for initial preparation. | Claim general performance from a tiny or unrelated sample. |

A–D have separate outputs. Serialize edits to the same instruction files. Effective-context comparison waits for A/B drafts; live cutover waits for non-interference and relevant tests. The three-test gate is a hard dependency only for moving local checks onto the VPS, not for drafting the product brief or isolated documentation review.

## Implementation Units

### U1. Make the product and operating kernel understandable

- **Targets:** `PRODUCT.md`, `AGENTS.md`, `CLAUDE.md`, `AGENT.md`, existing memory and relevant harness-entry instructions. Choose one canonical brief location during staging; avoid duplicate independent specifications.
- **Approach:** inventory effective instructions and classify each as keep, simplify, remove, uncertain or enforced elsewhere. Preserve the owner's exact wording where needed. Replace unsupported universal rules with task-appropriate judgment; do not weaken safety or direct user choices. Check current model routing and any pinned user instructions before suggesting a change.
- **Scenarios:** a new agent describes quote through review, the full longer-term roadmap, no independent send and Labtest boundaries; another is told an obsolete arbitrary scope cutoff and must reject it; a third must explain what is known, unknown and worth challenging. Probe the actual harness/worker context in sanitized isolated sessions, not by assuming `@` imports or shared filesystem access.
- **Done:** every supported harness loads the right product and task context without requiring the complete history. Each removed rule has its owner, reason, affected scope and rollback recorded. Existing sessions continue unchanged.

### U2. Make the current handoff small and accurate

- **Targets:** `docs/context/ACTIVE.md`, `docs/context/ACTIVE-candidate-2026-10-28-claude-783c2180.md`, `docs/context/ACTIVE-archive-2026-10-28.md`, `docs/context/OWNER-ASKS.md` and cited historical documents.
- **Approach:** take a new current snapshot, diff and merge all concurrent changes, retain independent session boundaries, current acceptance and unresolved holds. Keep stable heading links or map callers; identify actual cited revision for line-number references before redirecting them. Preserve exact originals and traceability. Avoid copied line citations that appear authoritative but refer to a different revision.
- **Scenarios:** recover a current session's next action and hold; follow an old heading; follow a line-number citation against its correct revision; handle a concurrent edit between snapshot and cutover; distinguish stopped Pomerado work from separately authorized work. A changed source aborts replacement until merged.
- **Done:** sanitized retrieval comparison shows current handoffs and historic evidence remain findable. The source hash and owner-approved rollback are recorded. No shared file is overwritten under concurrent edit.

### U3. Stop stale tool and skill guidance without breaking sessions

- **Targets:** affected harness instructions and settings; plan and document-review skills and other tracked skill sources where actually applicable; the existing CodeGraph and skill proposals identified by the [cleanup handoff](../context/HANDOFF-2026-10-28-claude-code-simplification.md).
- **Approach:** check per-harness effective rules, actual hook execution and registration, then remove stale mandatory Hindsight use and irrelevant automatic injection where authorized. Diagnose Headroom independently; an `ENOENT` connection result is not proof the configuration is absent. Resolve the copied-index provenance problem or stop claiming reliable worktree isolation. Remove the arbitrary cutoff, harmful deletion directive and stale AI-HMS blanket from affected skill sources only when a safe catalog-sync procedure is established. Replace blanket multi-persona plan-review requirements with proportionate review when appropriate, without removing owner-required gates. Keep meaningful review, targeted tests and genuine security checks.
- **Scenarios:** quoted notification text survives, real internal notification suppression works, a symlinked working directory resolves correctly, foreign linked and copied indexes are not trusted, session startup and prompt behavior match the intended scope, and sanitized users see no private data. Compare the synchronization tool's planned file and permission effects with an exact allowlist and verify rollback.
- **Done:** changes are limited to proven affected entries, all supported harnesses are checked, any live shared switch is non-disruptive, and no broad sync runs without required authority. An unresolved provenance or sync risk remains an explicit hold, not a claimed fix.

### U4. Establish the shared three-test limit

- **Targets:** shared check launcher and lock implementation named in the [cleanup handoff](../context/HANDOFF-2026-10-28-claude-code-simplification.md), host/harness launch hooks and repository test entry points, with focused test fixtures owned by this unit.
- **Approach:** inventory normal launches through Claude, Codex, Cursor, Antigravity/Gemini, Hermes, direct shell, worker subprocesses, test scripts and any enabled tool that can launch them. Establish which sessions are already running checks and how new launches can be governed without interruption. Prototype a cross-account supervisor that ties admission to the complete job's OS-managed lifetime; use the existing wrapper only as a narrow baseline. Check that supervisor runs jobs as their invoking user without widening privileges. A queue or regex wrapper alone does not prove all paths are intercepted.
- **Synthetic scenarios:** three concurrent jobs across accounts and supported harnesses, fourth waits; nonzero exit preserved; supervisor/runner crash, cancellation, child reparenting, descriptor closure and detached child do not prematurely release capacity; stale locks and service restart recover safely; lock/service/permission failure fails closed; nested invocation does not deadlock; unwrapped, indirect, background and MCP-launched tests cannot silently bypass any path claimed to be covered. Prove current already-running jobs are counted or delay cutover until they finish without stopping them. Prevent the check-to-cutover race: continuously account for or control new launches on every relevant path throughout transition and steady state. A snapshot of zero tests is insufficient. Record any path not enforceable.
- **Rollout:** continuously account for all relevant tests and new launches before and during cutover; a point-in-time empty host does not suffice. Gradually trial small real local tests only after the cap and hooks permit it, with real user accounts and harnesses represented. Monitor host headroom and return to remote checks if contention occurs. Preserve the Vitest database environment clearing, disposable-database restriction and existing hooks. Never run local typechecks unless the separate existing typecheck restriction is validly changed; count typechecks as a conservative shared resource only if explicitly authorized.
- **Done:** evidence covers each supported ordinary launch path, both accounts, real descendant lifetime and active-session coexistence. State precisely what is and is not enforced. If unmanaged direct shell or existing sessions cannot be controlled under the current safety constraints, the requested host-wide cap is **not complete**; keep local-check rollout on hold and present the smallest concrete permission or operational trade for owner decision.

### U5. Verify behavior, measure and roll out reversibly

- **Targets:** new brief and proposed rule changes, isolated harness configurations, `docs/research/` evidence and the existing handoff.
- **Approach:** choose a small representative, non-sensitive set drawn from actual past failures: product orientation, conflicting/stale rules, research with counterevidence, a simple coding task, a difficult integration task, correct safety/approval handling, and a parallel-file ownership task. Test actual harness startup, not merely miniature text prompts; compare baseline and candidate on the same inputs with expected actions, safety, retrieval quality, elapsed time and documented limits. Use actual provider billing evidence where available; otherwise state cost is unknown. No raw guest data goes to an unapproved external service.
- **Scenarios:** candidate preserves owner constraints, avoids invented requirements, flags an unsupported claim, selects useful tools without forced extra rituals, completes the permitted task, refuses unsafe execution and keeps active sessions unaffected. A rollout failure restores only the targeted version and does not overwrite newer work.
- **Done:** acceptance results and known gaps are recorded with source versions, used model/provider where verifiable, real outcomes and rollback. Calibrate completion forecast only once there are comparable measurements.

## Verification Contract

- **Planning:** no live configuration change, real test runner, browser work, shared-skill update, deployment or outside posting is authorized by this document.
- **Before execution:** inspect current working tree and exact target paths. Record current session ownership and versioned backups without copying over concurrent work. No remote publication, permission change or interruption is implied.
- **Unit checks:** use focused synthetic tests for launcher, process lifetime, context loading, link provenance and hook behavior. Record the actual test file paths when the implementation location is selected; this plan does not pretend a host supervisor or fixture already exists. No production DB or guest material in fixtures.
- **Integration checks:** run at approved locations, using actual supported launch paths, real cross-account identity and bounded workloads. Preserve no-local-typecheck and deny-hook rules unless separately authorized and safely updated. Keep local Zero tests remote until all cap criteria are established.
- **Quality:** review the precise changed rules and executable diff against owner scope, current authority, safety and same-head required project gates. A reviewed instruction is not proof it is effective; test effective context. Verify clean rollback without deleting another session's work.
- **No policy expansion:** GitHub Actions remain installer-only. Deployment remains through the designated SSM path. Do not send mail, flip flags, drive HMS or change real-guest data for this tooling plan.

## Definition of Done

1. Product and operating principles are concise, accurate, discoverable and actually loaded by each supported relevant harness/worker. Full roadmap and hard safety limits remain intact.
2. Rules and skills have an evidence-based keep/simplify/remove decision; stale active injections are removed where safely authorized, while useful review and existing user preferences remain.
3. A fresh handoff retains current owners and holds, and its historical citations remain traceable to the right versions. Current sessions are neither stopped nor silently reconfigured.
4. At most three independent local test runners can run across every **claimed covered** launch path and both accounts, with whole-job lifetime and continuous cutover accounting proven. Unsupported paths are named and the host-wide objective remains open until closed. Typecheck and DB protections are independently respected.
5. Actual comparison results, provider cost if verifiable, unresolved issues, rollback, and acceptance evidence are recorded. No false claim of speed, product completion or completed rollout.

## Blockers and alternatives

- **Cap versus unrestricted shell:** universal prevention cannot be asserted if an unrestricted shell can execute arbitrary unmediated test processes. Inventory first. Either close those paths safely or retain remote-only use for the affected paths. A stronger operating-system boundary that changes permissions or interrupts existing sessions requires a separate owner decision.
- **Shared catalog sync:** if the required sync cannot be scoped without changing permissions or deleting unrelated files, stage the skill edits but do not install them. A separate safe synchronization change needs its own authority and verification.
- **Existing sessions:** if new global behavior would affect a current session, use a staged version for new sessions or wait for natural completion. Do not interrupt or modify that session as a workaround.
- **Line references:** if the original source revision cannot be established, label the historical citation unresolved rather than mapping it to an arbitrary archive.
- **Estimate:** a conditional end-to-end elapsed forecast follows measured staging and an enforcement canary. Current data does not support a defensible number.
