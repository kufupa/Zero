# Targeted agent-rule cleanup: ask 371

2026-10-28. The owner authorized removing the five obsolete rule classes identified in the operating-model plan across the machine's CLI harnesses. Exact request and scope: [owner asks](../context/OWNER-ASKS.md). This is a partial cleanup, not authorization for a general rebuild, permission change, product action or test-cap rollout.

## Applied

- `.cursor/rules/nava-workflow.mdc`: replaced automatic multi-persona plan/design/DevEx and per-task TDD/review mandates with task-appropriate choices. Explicitly requested practices, existing work, project-required same-head review and verification remain.
- `AGENTS.md`: removed the blanket deterministic-only live-HMS restriction in favor of the product's current scoped rules; removed automatic per-slice compaction and the hard plan-lane call/time cutoff. The owner's later 250K/300K context guidance, model routing, Greptile gate, production protections and remote-check hold remain.
- Claude's indexed memory: corrected the stale deterministic-only and 150K handoff instructions, backtest/evidence time caps, and the mistaken claim that hold-blocked work is done. Original historical evidence remains. The memory index reflects the evidence-policy correction.
- Exact pre-edit copies and manifest: `/home/orca/.claude/rule-cleanup-371-1vly9w5f/`. No other session process was stopped or restarted. Existing sessions may retain earlier loaded instructions; effective reload behavior was not tested. The project edits are uncommitted in this worktree and are not proof other worktrees received them.

## Cross-harness coverage and blocker

A read-only inventory covered selected active Codex, Cursor, Gemini/Antigravity, Hermes and Claude instruction/config locations. It excluded private session content and historical archives. Registered hooks and dynamic injection were not executed, so effective behavior across every harness remains unproved. Cursor's project-specific rule was edited here; the shared Codex host guidance already lacked the targeted old instructions in the inspected files. The canonical shared skill catalog is also used by multiple harnesses, but its installed skills have not been edited.

The mandatory shared-skills sync was inspected, **not executed**. Its full run would rewrite unrelated Codex guidance and configuration; Orca's existing config has a begin marker without an end marker, so the script would append 116 existing disabled-skill entries. It also performs recursive ACL/ownership and other broad synchronization. The inspected snapshot showed no extra source-to-destination deletion candidates or visible duplicated Codex skill directories, but that does not establish safety under concurrent changes. Final permission effects are untested. The script has a dry-run option but no documented skill-scoped sync mode. A separate Ubuntu Claude TDD copy also needs review; the shared sync does not update it.

Consequently the installed shared skill guidance still contains the obsolete cutoff, live-HMS ban, TDD deletion instructions and/or review requirements. A reviewed targeted synchronization approach and authority for any unrelated permission/configuration changes are required before applying those edits. Do not claim host-wide completion.

## Verification and holds

- Exact edited snippets were compared with backups. `git diff --check` passed for the scoped tracked documentation. Product guest-write and penalty rules, property locks, Vitest database precautions, same-head Apex and the current remote-check hold were inspected and retained.
- No local test runner, typecheck, skill sync, hook bypass, deployment, flag flip, HMS browser or email was run. The existing cooperative three-slot gate is unchanged and does not enforce a host-wide limit.
- The owner’s explicit 250K/300K context guidance remains; the removed handoff rule was the stale 150K instruction and automatic compaction at every slice.

## Staged skill proposals

A separate read-only/staging lane prepared proposed changes for 17 files across 11 shared skills under `/home/orca/.claude/claude-cleanup-staged-20261028-783c2180/ask371/`. Its manifest records source and proposed hashes; an independent hash check confirmed all 17 staged originals and installed sources still matched at verification. These proposals have not been installed, live-tested or confirmed safe for the mandatory full sync. The separate Ubuntu Claude TDD file could not be read under the current account and has no staged proposal.
