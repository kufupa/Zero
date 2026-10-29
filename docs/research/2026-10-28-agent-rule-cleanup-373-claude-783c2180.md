# Agent-rule cleanup: ask 373

2026-10-28. Owner wording and scope: [ask 373](../context/OWNER-ASKS.md). This report concerns local instructions and tooling, not a Nava deployment or live hotel run. Reference `origin/main` at check: `00d814ca3`.

## Applied instruction changes

- Claude's automatic CodeGraph prompt registration now uses a separate no-op wrapper. The previous wrapper was restored byte-for-byte, so sessions already holding its path do not receive an in-place wrapper change. The compaction hook that labelled a recent overnight state file authoritative was removed from the current settings. Settings JSON and the no-op wrapper were checked; fresh-session effective loading was not verified.
- `CLAUDE.md` imports a short [startup map](../context/START-HERE.md) instead of the historical `ACTIVE.md`. The long handoff remains untouched. Its older line citations are not safely redirected by the previously staged archive candidate.
- `AGENTS.md` now uses impact-based severity, allows necessary further review rounds and labelled exploratory evaluations, and makes supervision proportionate. `PRODUCT.md` permits ordinary reversible interpretation while retaining material-decision and safety holds. The conflicting supervision memory was updated. Existing same-head review and guest/database/property safeguards remain.
- Orca's Codex guidance no longer instructs the broad shared-skill sync. Other users' unreadable guidance files were not accessed or modified. Existing sessions may retain previously loaded instructions.

## Shared skills and sync

The old helper could rewrite unrelated Codex settings and recursively touch catalog ACLs, ownership and files. It was replaced with a read-only verifier that refuses bare invocations. Updated `vps-shared-skills` guidance requires deliberate file-scoped updates and makes the verifier's limited coverage explicit. Installed and bundled copies match. Host and Orca Codex guidance now point to scoped updates; the previously unreadable Ubuntu-specific guidance remains unverified and untouched.

The reviewed proposals were applied to 17 existing files across 11 shared skills, plus the shared-sync skill and two matching upstream `ce-plan` files. The cuts cover invented scope cutoffs, mandatory review rituals and deadlines, destructive test-first language, and obsolete blanket HMS prohibitions. Product safety and explicit test-first requirements remain. The upstream `ce-plan` copies match the catalog.

An independent review rejected the original generic privileged manifest installer due to path races, excessive scope, metadata risk and partial updates. It was never installed or run. A narrower, one-time updater used explicit hash-pinned targets, per-file leases, directory-anchored atomic exchange and retained originals. The final reviewer found no confirmed P1 data-loss blocker. A post-update verifier checked all 23 host and skill targets, original backup bytes, ownership, modes and extended attributes. It also checked catalog links and caller readability; the bare old sync invocation fails closed.

Synthetic fixtures checked named-user ACL retention, existing open-file refusal, stale-file refusal, concurrent opens and competing renames. One initial race-probe assertion expected `concurrent edit during exchange`, but observed `STOPPED: installed target changed; original retained in backup` at the later check. The corrected assertion passed and confirmed both the other edit and original were retained. These fixtures are not a proof against all future concurrent changes. Private backup indexes are under `/home/orca/.claude/rule-cleanup-373-zfvzq1dh/`; displaced inodes remain in the owner-specific backup directories recorded in the updater output. Do not blindly restore backups over newer changes.

## Retained boundaries and limitations

- The owner's maximum-three local-test policy is not enforced host-wide. Existing Zero remote-check rules and hook denials remain; no project test runner or typecheck was run.
- No service, existing session, hotel browser, deployment, production flag, database, guest booking or email was touched by this cleanup. No commit or push was made.
- Changes in this worktree do not prove other worktrees have reloaded them. The upstream `ce-plan` source copies are ignored by Git and are local machine changes, not a tracked commit. Hindsight remains available to this session through higher-priority runtime instructions; no Hindsight configuration was changed in ask 373.
- Earlier inaccessible Ubuntu-specific files remain unverified and were not accessed through elevation. The broader operating-model rebuild was not part of this targeted cleanup.
