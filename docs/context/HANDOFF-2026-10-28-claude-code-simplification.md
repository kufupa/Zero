# Claude Code simplification handoff

Owner asks 368 and 369 authorize the cleanup and permit at most three concurrent local test runs across harnesses. Original wording is in `OWNER-ASKS.md`. Evidence and scope limits: [execution report](../research/2026-10-28-claude-code-simplification-execution-783c2180.md). The rollback snapshot is `/home/orca/.claude/claude-cleanup-backup-20261028-8poJMBtU/`.

## Earlier checkpoint

The ask 373 section below supersedes earlier staging and hook status where they differ.

- Project/global test and formatting contradictions, unsupported compound mode, stale research-cap memory and mandatory Hindsight instructions in host/Codex guidance were corrected. The current three-test direction is recorded with an explicit rollout hold. Product write/privacy rules, reviews and existing hooks remain.
- `/usr/local/bin/nava-check-slot` uses three root-owned shared lock files. Synthetic two-account probes showed three commands active and a fourth waiting. It is cooperative only. Unwrapped processes bypass it, and a surviving child that closes inherited descriptors can escape a killed supervisor. It does not establish a host-wide cap. Do not infer local-run readiness or bypass the existing typecheck hook.
- The compact [ACTIVE candidate](ACTIVE-candidate-2026-10-28-claude-783c2180.md) and its archive are staged only. The shared `ACTIVE.md` changed after the snapshot and the candidate predates ask 369. It also has unresolved historical line citations. Do not overwrite the shared file.
- The CodeGraph hook candidate and shared-skill proposals are staged under `/home/orca/.claude/claude-cleanup-staged-20261028-783c2180/`. The installed CodeGraph wrapper and shared skills are unchanged. The candidate still cannot detect a copied foreign index; active sessions may use a shared hook on their next prompt.
- Hindsight remains registered in some harnesses; Codex has it configured but disabled. The host no longer instructs Codex to search it unconditionally. Headroom was configured but failed to start in this session. No services were modified.

## Acceptance checks and holds

1. Before local tests are generally permitted, coordinate all relevant launchers and verify the maximum-three rule across accounts and harnesses, including failures and surviving descendants. Advisory locks alone are insufficient. Any stronger host enforcement must respect the user's no-permission-change and no-interruption boundaries.
2. Merge the current shared handoff into the compact proposal, handle historical line references, and compare retrieval and safety in a fresh isolated setup before replacing the import.
3. Fix copied-index provenance and test real CodeGraph behavior before any prompt-hook switch. Do not alter running sessions' hook behavior.
4. Review staged skill changes and the required shared-catalog sync. Its recursive ACL/ownership changes and deletion behavior exceed this run's safety boundaries; it was not executed. Do not claim those skills are fixed.
5. Keep separate Pomerado ownership and stop instructions; this work did not start, stop or inspect hotel browser work. Historical observations are not live authority.

## Ask 371: targeted cross-CLI rule cleanup

- Owner approved removing the specified obsolete rule classes. Cursor project rules, this worktree’s `AGENTS.md`, and relevant Claude memories were updated with exact pre-edit backups. Existing same-head review, guest/database safety and remote-check holds remain.
- Shared installed skills are **not updated**. Their required full sync would also rewrite unrelated Codex config/guidance and touch catalog permissions; it was not run. Other worktrees and already-loaded sessions have not been verified to receive the edits. [Evidence](../research/2026-10-28-agent-rule-cleanup-371-claude-783c2180.md).

- Ask 371 staged proposals for 17 files across 11 shared skills; originals and installed sources matched recorded hashes at the check. The separate Ubuntu Claude TDD copy was unreadable under the current account. Nothing was installed or synchronized.

## Ask 373: additional targeted cuts

- Supersedes the older CodeGraph/startup staging status above: this worktree imports `START-HERE.md`; the long `ACTIVE.md` remains intact. Current Claude settings point new CodeGraph hook registration to a separate no-op wrapper, and the previous wrapper was restored for already-loaded registrations. The stale overnight-state compaction registration was removed. Effective fresh-session behavior was not tested.
- Review severity and rounds, exploratory evaluation, reversible interpretation and supervision were changed as recorded in [ask 373 evidence](../research/2026-10-28-agent-rule-cleanup-373-claude-783c2180.md). Orca Codex guidance no longer mandates the broad skill sync.
- The shared catalog updates and two upstream `ce-plan` copies are applied. The old broad host sync was replaced by a read-only verifier that refuses bare calls; installed and bundled guidance match. Hashes, original backups, ownership, modes and ACLs passed post-update checks. See [evidence](../research/2026-10-28-agent-rule-cleanup-373-claude-783c2180.md) for race-probe limits and recovery. Previously unreadable Ubuntu-specific files remain untouched. The host-wide three-test limit is still not enforced.
