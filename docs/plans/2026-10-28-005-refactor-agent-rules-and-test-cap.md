---
title: Simplify agent rules and coordinate VPS checks
date: 2026-10-28
type: refactor
status: planned
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
execution: code
product_contract_source: ce-plan-bootstrap
---

# Simplify agent rules and coordinate VPS checks

## Goal capsule

The owner wants faster coding with less obsolete process, and has replaced the Zero-only remote-check restriction with permission for **at most three concurrent tests on the VPS, across CLIs and agent harnesses**. Audit the rules that agents actually encounter, remove or scope counterproductive instructions, and make the limit observable and enforceable for real execution paths. Retain safeguards that prevent real guest, production database, or deployment harm. This is a planning artifact; no runtime, rule, skill, or hook change has been made by this audit.

## Product contract

- **R1. Shared limit:** Across users, worktrees, CLIs, harnesses and their agents, at most three test invocations run at once. A fourth waits, with visible status and preserved exit code. An invocation means an independent test runner/suite, not each test case or ordinary worker inside one runner; one wrapper must not hide multiple concurrently running independent runners under one permit.
- **R2. Typechecks:** Until the owner specifies otherwise, count local typechecks in the same three-slot pool. This is a conservative implementation assumption, not a claim that the owner explicitly set a typecheck cap. Lightweight targeted lint and formatting do not use permits unless measured resource use justifies a later change.
- **R3. Safety:** Continue to prevent tests against pilot/production databases; use disposable test data. Keep the existing `PRODUCT.md` instruction to unset DB variables before Vitest and reconcile it with the approved, explicitly configured disposable-DB path before running DB-required suites. Keep real-guest and production-write boundaries, live hotel/browser locks, post-action verification, and accurate result reporting. Test slots are not HMS/property locks.
- **R4. Simplicity:** Replace contradictory, unsupported and unnecessarily universal process rules with short, scoped, current instructions. Preserve the original owner requests and the record of incidents; dated history is evidence, not automatically current policy.
- **R5. Effective behavior:** Audit instructions, skills and hooks on the supported installed harnesses, including their real execution paths and shared-source synchronization. A sentence in a prompt, a hook, or a wrapper does not by itself establish host-wide enforcement.
- **R6. Continuity:** Keep the information agents need to continue active work: current objective, owners, holds, next acceptance check and links. Do not overwrite the changing ACTIVE candidate, another session's edits, or unrelated work.
- **R7. Evidence:** Compare outcomes and latency before and after for representative work. Keep useful independent same-head reviews; remove automatic or duplicated ceremony only when its contribution and scope are assessed. Do not infer model rankings or dollar savings from unmatched tasks or document size.
- **R8. Hindsight:** Do not restore Hindsight. Identify and remove stale requirements and active configuration that reintroduce it, without deleting stored data. Validate actual activation before describing a configured registration as running.

## Planning contract

### Current evidence and decisions

| Topic | Evidence | Decision |
|---|---|---|
| Local check ban | `AGENTS.md` describes two freezes on an 8-vCPU/30-GB machine; `docs/context/MISTAKES.md` records load 27 and 85% I/O wait. Current host reports 8 CPUs and about 31 GiB RAM. | Owner's new limit supersedes remote-only text. The old incident is real; neither 32 GB nor a three-job count proves three heavy suites are safe. Observe CPU, I/O, swap and worker fan-out. |
| Conflicting instructions | `AGENTS.md` bans all local tests; `docs/context/ACTIVE.md` permits targeted local checks. Cursor's always-on workflow mandates red-first TDD and multiple review steps, while `AGENTS.md` says no red-first runs or self-review subagents. | Make one current policy consistent at the shared host source, repo and participating harness adapters. Scope tests and reviews to the change and expected value. |
| Existing controls | The full-suite wrapper serializes only its own users. Claude/Cursor's local hook matches some command strings; Codex's configured hook set has no corresponding local-test blocker, and Hermes reports no shell hook. Indirection and bypasses are possible. | No existing three-slot shared limit was found. Inspect actual effective configuration and command paths before selecting enforcement. |
| Remote gate cost | `docs/context/ledger/2026-10-26-or2-retro.md` reports 46 typechecks plus 66 test runs, about 149 lane-minutes, median remote call 97 seconds and p90 204 seconds. `docs/research/2026-10-26-dev-speed-analysis.md` records larger repair and idle bottlenecks in another run. | Measure comparable local-versus-remote checks; lane-minutes are not wall-clock savings and SSM is not established as the dominant bottleneck. |
| Startup context | `CLAUDE.md` imports `docs/context/ACTIVE.md`, observed at 106,937 bytes. A smaller candidate and archive are changing concurrently; the candidate says it is staged and still contains superseded remote-only text. | Build a small current-state entrypoint from fresh evidence. Preserve current handoffs and asks; do not deploy the candidate as-is. Bytes are not measured tokens, time or cost. |
| Rules already modified | Existing uncommitted changes in `AGENT.md`, `AGENTS.md` and `docs/context/MISTAKES.md` remove a contradictory blanket check instruction, make compounding conditional, and mark old call/time and handoff caps historical. Their author and approval are unknown. | Preserve, reconcile and inspect before touching. This audit did not make those changes. |
| Models | `docs/context/OWNER-ASKS.md` contains dated explicit model-routing decisions; the 26 October retrospective's Grok/Luna times are confounded by different tasks. | Inventory current owner directions and effective settings; recommend simplifying rigid, universal model routing only where superseded or measured to hurt. Preserve explicit model prohibitions until superseded. |
| Safety and review | `PRODUCT.md` states production/guest boundaries and database precautions. The 26 October speed study reports about 21 real production-path defects among 27 P1 review comments in one run. | Preserve useful review and safety boundaries while reducing unnecessary mandatory repetitions. |
| Hindsight | Codex's Hindsight MCP is disabled; Cursor has an always-applied Hindsight instruction, plus hook and MCP registrations; Claude has an MCP registration. Registration does not establish execution. | Check current activation and disable remaining instruction/injection paths without deleting memory data or disturbing unrelated sessions. |

### Architecture and alternatives

1. **Preferred:** a host-shared, cross-user three-permit queue. Prototype the existing host lock/wrapper pattern first; introduce a supervisor or service only if needed for verified paths. A permit represents a live independent test runner or typecheck; it must remain held until that runner and its accounted descendants exit, even if its supervisor crashes. Harness adapters route supported commands to it. Surface running count, owners, waiting jobs and cancellation. A nested job must not deadlock by holding all permits while waiting; transfer a permit only after its parent ceases being an independently running test, otherwise queue or refuse safely. Treat nested commands and runner fan-out explicitly.
2. **Enforcement boundary:** enumerate actual installed Codex, Claude, Cursor and Hermes entrypoints, user accounts, shell execution modes, scripts, direct and background launches. Test direct paths and nested subprocesses, including bypass modes. Hooks, shell aliases and prose are cooperative controls and may be bypassed. If a non-bypassable common OS boundary is needed, assess available permissions, executables and cgroups before selecting it. Do not claim a strict host-wide guarantee if any normal path remains uncovered; record coverage and the exact remaining gap.
3. **Why not the current full-suite lock?** It serializes one wrapper, does not include targeted tests or typechecks, and is not shared enforcement across all runners.
4. **Why not retain EC2-only?** The owner has explicitly changed the rule. Keep remote execution as an option for load, environment parity or a heavy check, but do not route routine local checks remotely by default merely because an old instruction says so.
5. **Why not blindly delete review or history?** Review has caught real bugs; current handoffs and safety holds are needed. Keep the minimum useful current entrypoint and retain traceable historical evidence, while removing redundant always-on rituals.

Use an existing host-managed source and installation pattern if one fits; otherwise keep the queue/supervisor source versioned in a suitable repository and install a shared pinned executable. A separate service, privileged OS policy, or new persistent process is justified only if needed for coverage and can be maintained; check feasibility before choosing. Never rely on shell-string regex as proof that every invocation is covered.

### Implementation units

**U1 — Establish actual authority, coverage and baseline.**

- Read `PRODUCT.md`, `docs/context/ACTIVE.md`, `docs/context/OWNER-ASKS.md`, `docs/context/FACTS.md`, `docs/research/CATALOG.md`, `docs/research/README.md`, `AGENTS.md`, `AGENT.md`, `.cursor/rules/`, and `CLAUDE.md`; inspect applicable home-level and shared host configuration for every installed harness. Use `docs/plans/2026-10-28-claude-code-simplification-plan.md` as the previous audit, superseded on remote-only tests by this owner request.
- Inventory which rules are automatically loaded or executed, their shared source, precedence, current owner decision, operational purpose and enforcement coverage. Distinguish always-on instructions from skills loaded only when explicitly or implicitly selected and archives loaded only when requested.
- Snapshot without changing live sessions; record running worktree owners, existing dirty edits, background checks and test/database safeguards. Record baseline cold-start context if measurable, check queue/wait and end-to-end timings, and observed test-worker/resource usage.
- Output a concise keep/change/unknown table with exact sources. Do not claim a full audit of inaccessible or uninspected files.

**U2 — Shared check queue and harness integration.**

- Prototype an atomic, cross-user three-slot lock/queue and prove a feasible interception boundary for normal direct, script, package-manager, background and subprocess launch paths before committing to a service. Known nested paths include `scripts/ci/local-ci.sh`, `apps/server-pilot/scripts/outlook-sync-test-gate.ts` and Playwright through `packages/testing/package.json`; verify current callers rather than relying on shell command text. If no common boundary covers normal supported paths, mark host-wide R1 blocked and report partial coverage; a list of bypasses is not completion.
- Use protected queue state accessible to the participating accounts. Each check retains the submitter's UID, GID, working directory and intended environment; never run arbitrary submitted commands as root or log the environment or secrets. Verify access and accounting in both account directions.
- Keep queue metadata non-sensitive; preserve signals, output and status. Retain a permit while an accounted child survives parent or supervisor death, including SIGKILL/reparenting; reconcile surviving processes on restart and fail closed when uncertain. Avoid leaked permits, double-acquisition and deadlocks. Do not assume unprivileged cgroup control: the observed cgroup root is root-owned and read-only to ordinary users.
- Before admitting jobs on rollout or queue restart, identify already-running test/typecheck processes across users and account for them or wait for them to drain naturally; also prevent old sessions from launching unaccounted new runners during migration. Do not interrupt unrelated sessions. If existing or newly launched legacy jobs cannot be accounted for reliably, do not represent the limit as enforced; avoid starting additional checks that would violate the known total.
- Make supported harness entrypoints use the same installation and queue. Handle programs that fan out independent runners; limit workers separately if measured pressure requires it. Keep EC2 available as a fallback.
- Before changing old blocks, verify local pilot/production DB protections and resource limits. Use a fail-closed test environment for each supported route; validate the existing disposable DB path rather than relying on a hostname marker in one Vitest config. Never print DB secrets. Reconcile `PRODUCT.md`'s unset instruction with the explicitly isolated local database workflow, and report skipped DB-required tests as unverified. Then update the shared host source, generated user copies, project guidance and applicable hooks together; avoid sync undoing the fix. A partial rollout must state coverage rather than claiming universal enforcement.
- **Verification:** use harmless stand-in jobs first to prove three cross-user/harness invocations acquire slots and a fourth waits, then starts when one exits. Repeat for typecheck, failure, SIGINT, supervisor SIGKILL with a surviving child, restart with legacy and new jobs, nesting, concurrent starts, background execution and script/package-manager aliases. Verify output/exit codes and cleanup. Exercise bypass/`--bare` and direct paths explicitly; report any that cannot be enforced. Use fake endpoints to verify production-DB refusal and the explicitly validated disposable-DB route without touching live production. Record required, skipped and executed DB tests.
- Stage real checks after the stand-ins: one heavy check with existing worker/CPU/I/O limits first; increase toward three only if measured headroom supports it. Abort or reduce concurrency on sustained resource pressure. The owner sets three as a maximum, not a requirement to run three heavy suites at once.

**U3 — Simplify current instructions and startup.**

- Reconcile `AGENTS.md`, `AGENT.md`, `.cursor/rules/`, `CLAUDE.md`, host shared rules and harness-specific instructions against the inventory. Remove superseded remote-only wording and redundant blanket skill/approval/review requirements; retain task-appropriate verification and current safety controls. Scope TDD to useful behavior checks, instead of a universal delete-and-restart or mandatory red-first ritual.
- Replace unconditional fixed model/harness routing only where a later owner instruction supersedes it or concrete evidence supports a recommendation; document unresolved tradeoffs. Do not change the user's selected models merely on the basis of date.
- Create a concise `docs/context/ACTIVE.md` from the *latest* state, merge concurrently added holds and links, preserve archive/history and original asks, check inbound references, and coordinate edits with other writers. Do not replace it using the in-progress candidate without reconciliation.
- **Verification:** check effective instructions in fresh representative sessions for each harness, a simple edit, an involved change, planning-only work and a live-write scenario. Ensure current asks and holds are discoverable; measure loaded bytes/tokens and useful-answer latency where tooling supports it.

**U4 — Skills, hooks and Hindsight.**

- Inventory shared skills that are frequently invoked or enforce unconditional round trips. Inspect actual trigger and invocation behavior; selectively simplify repetitive gates without stripping skills or owner preferences wholesale. Check cross-project users before touching shared skills; after any skill change run the shared-catalog synchronization required by host policy.
- Verify whether Hindsight instructions, hooks or MCP registrations actually trigger for each harness; remove stale references and disable injection/registrations in the relevant configuration while retaining stored data. Test fresh isolated sessions; do not interrupt concurrent work or revive memory.
- Scope CodeGraph and similar hooks to relevant prompts and worktrees where reproduced evidence supports it. Preserve useful on-demand navigation, timeouts and safe fallbacks.
- **Verification:** representative fresh-session and hook fixtures demonstrate correct behavior, no obsolete Hindsight requirement, no unrelated cross-worktree injection, and unchanged production/data safeguards. Preserve rollback copies.

**U5 — Compare and report.**

- Verify obvious contradiction fixes directly without blocking on a benchmark. Gather before/after measurements during real follow-on work; use small matched comparisons for changes whose benefit or risk remains uncertain. Include representative simple and complex work, planning-only behavior, test execution and an action with a safety boundary as relevant. Record outcome, time to useful answer, unnecessary questions, queue time, failures, peak CPU/memory/I/O and cost only when available. Record task and sample count. Evaluate same-SHA and isolated checkout requirements for parallel gates.
- Roll out one surface at a time. Roll back a change that drops a current ask, leaks data, loses a safety hold, corrupts a session, or weakens the observed test limit. Record effective enforcement coverage, remaining bypasses, kept/removed rules and realistic measured time saved.

### Dependencies and ownership

U1 precedes every change. U2 precedes removing the old hard check blockers, so the new cap is live and verified before the old protection disappears. U2 owns all test-cap edits in shared rules and hooks first; U3 and U4 wait for those overlapping files, then edit them serially with explicit per-file ownership. Work on disjoint files may run independently after U1 and concurrent-session ownership checks; U5 verifies each rollout. Preserve the user's currently changing worktree. Never run checks against production data, restart active sessions, delete histories, or deploy product changes as part of this cleanup.

### Risks and open execution facts

- Three heavy suites can still exhaust memory, CPU or I/O; adjust worker settings and queue starts based on measurements while never exceeding three permits.
- A command can hide an independent runner inside another process. The supervisor and adapters must count it or prevent concurrent fan-out. If reliable host-wide interception is infeasible, disclose exact coverage and maintain a conservative cooperative limit; do not advertise enforcement that is not present.
- Crashes and detached descendants make simple lock-file cleanup insufficient; verify supervisor/process lifetime rather than assuming it.
- Existing user configuration is synchronized from a shared source, and other sessions may be editing the same files. Check source and ownership immediately before each edit.
- Some previously explicit owner model decisions may still apply. Date alone does not revoke them; reconcile the latest decisions and make uncertainty visible.
- Current Codex and Claude instruction loading differ; inspect installed versions and actual sessions. File bytes alone are not a cost estimate.

## Verification contract and definition of done

Done means: the owner's three-check maximum is implemented for every supported normal launch path, including already-running jobs at rollout; any intentional privileged bypass is explicitly reported. An uncovered ordinary direct, scripted or harness launch leaves host-wide enforcement incomplete, even if cooperative coverage is useful. Local checks succeed with production database safety; required DB cases are not silently skipped; cancellations and nested jobs cannot silently leak slots or exceed the accounted maximum; old remote-only rules and conflicting always-on instructions are reconciled; active asks and safety holds remain discoverable; stale Hindsight injection is removed where confirmed; pre-existing work is preserved; and the report distinguishes measured results from assumptions. Report what was kept, removed, changed and still unknown, with exact configuration locations and rollback instructions.

## Sources

- `PRODUCT.md`, `AGENTS.md`, `AGENT.md`, `CLAUDE.md`, `.cursor/rules/nava-workflow.mdc`, `.cursor/rules/pilot-rds-safety.mdc`.
- `docs/context/ACTIVE.md`, `docs/context/OWNER-ASKS.md`, `docs/context/FACTS.md`, `docs/context/MISTAKES.md`, `docs/research/CATALOG.md`, `docs/research/README.md`.
- `docs/context/ledger/2026-10-26-or2-retro.md`, `docs/research/2026-10-26-dev-speed-analysis.md`, `docs/plans/2026-10-28-claude-code-simplification-plan.md`, `docs/research/2026-10-28-claude-code-audit.md`.
- [Codex project instructions](https://developers.openai.com/codex/guides/agents-md), [Codex hooks](https://developers.openai.com/codex/hooks), [Claude Code hooks](https://code.claude.com/docs/en/hooks).
