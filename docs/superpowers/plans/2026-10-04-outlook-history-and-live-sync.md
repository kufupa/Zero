---
title: Outlook Mailbox Isolation — Pre-merge Plan
type: feat
date: 2026-10-05
updated: 2026-10-05
origin: docs/plans/2026-10-02-002-feat-outlook-mailbox-history-sync-plan.md
execution: code
---

# Outlook Mailbox Isolation — Pre-merge Plan

Execution posture: Planning only now. When explicitly launched, extend the existing Outlook sync PR in an isolated worktree; do not rebuild its completed sync pipeline. Finish at a reviewed, green PR. Production merge, deployment and staff publication remain a separate release decision.

## Goal

Keep every reservationist inside their own real Outlook mailbox while reusing the history/live sync already built.

- One real inbox = one mailbox transport.
- Every stored message belongs to one transport; each user sees only transports with an exact grant.
- A reservationist gets their mailbox only. An admin may get several explicit grants and switch mailboxes in the web inbox.
- Same Message-ID in different mailboxes stays separate. POP3 and Outlook copies inside the same mailbox may share one canonical message.
- The pane signs in, syncs its approved source and shows source progress. It does not choose mailbox permissions, switch mailboxes, or display email.
- Searchable message projections, sync receipts and attachment references stay in PostgreSQL/RDS; original messages and attachment bytes stay in private S3.

## Global Constraints

- This plan adds mailbox isolation to the existing history/live implementation in Zero PR #28 and native PR #4. R1–R16/U0–U9 from that implementation remain the accepted sync behavior; do not re-specify or rebuild them here.
- Work only in a clean sibling worktree based on the existing PR #28 branch. The current checkout is feat/reservationist-backtest with unrelated dirty changes.
- Keep exact-grant authorization, private S3, accepted customer originals and the current wrapping key. Never infer ownership from sender, recipient, uploader, sink address or user role.
- No production test runner. Before Vitest, unset DATABASE_URL and VITEST_ALLOW_PILOT_RDS. Use disposable PostgreSQL only; never source .env.production into a test process.
- No destructive Git, forced pushes, hook bypasses, customer-data deletion, secrets in commits, or production merge/deploy/publication in this plan.
- Prove mailbox behavior on disposable data first. Real Outlook/profile acceptance is a later operator release gate.

## Autonomous Execution Mandate

**Autonomous execution applies only when this plan is explicitly launched.** Finish the mailbox-isolation delta as a reviewed, green PR without routine checkpoints. This planning/review turn does not launch implementation. The goal ends at the PR: merging, deploying, and publishing require a separate release instruction.

### Communication

- Orchestrator and agents: `/caveman ultra`; keep technical names exact.
- Use standard non-fast subagents for independent work and review. If unavailable, work inline.

### Decision authority

- Reuse existing mailbox ACL, sync-source and storage code. Choose the smallest safe change; log any deviation.
- Keep one owner for shared schema and authorization edits. Use test-driven development and an independent final reviewer.
- Better route to the done criteria may be taken; record what changed and why.

### AWS and release references

| Resource | ID / path |
|---|---|
| EC2 | `i-008f737974a9ba9b3` (`af-south-1`) |
| RDS | `nava-zero-mail-pilot` (PostgreSQL 16) |
| S3 | `nava-zero-mail-845242190536-af-south-1` |
| Repo on EC2 | `/home/ubuntu/repos/zero` |
| Primary deploy | `apps/server-pilot/deploy/ops-deploy.sh` (`--migrate` when schema changes) |
| App restart | `apps/server-pilot/deploy/ops-restart.sh` |
| Box reboot | `apps/server-pilot/deploy/ops-reboot.sh` |
| Fallback | `sync-ec2-git-bundle.sh`, `deploy-ec2.sh`, `ssm-run-command.sh` |

The Zero overlay permits these wrappers, seed without `--rotate`, read-only SSM/PM2/health checks, and disposable-database tests. **This plan's scope is pre-merge only:** use read-only checks if needed; do not deploy, migrate pilot RDS, restart/reboot production, seed production, or publish an installer. Those actions require a separate release instruction.

### Safety and verification

- Follow `.cursor/skills/overnight-autonomous-zero/SKILL.md` and `.cursor/rules/pilot-rds-safety.mdc`.
- Before every Vitest command: `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS`. Use disposable PostgreSQL only. Never use `nava-zero-mail-pilot`, another production DB, `VITEST_ALLOW_PILOT_RDS=1`, or `.env.production` in a test process.
- Never force-push protected branches, bypass hooks, use destructive Git, expose secrets or customer PII, or weaken safety checks.
- Verification loop: implementation → focused tests → relevant broader tests/build/lint → inspect evidence → fix red checks → repeat.
- Red check or review finding: reproduce → identify root cause/mechanism → smallest correct fix → rerun the relevant gates. Do not skip a failing gate.

### Execution-backend outage

If Cursor reports `Execution backend unavailable. Do not retry tool calls — the execution environment is down.`, treat it as an agent-tool outage, not an app failure. Retry Shell/Write/StrReplace after about 5, 15 and 45 seconds until `echo shell_ok` works. On recovery, inspect Git status and `.superpowers/sdd/*progress*`, then resume existing work. Only report a blocker if the bridge remains unavailable for about five minutes; do not invent an application RCA. See `docs/solutions/workflow-issues/cursor-execution-backend-unavailable.md`.

### Done criteria

- [ ] Every sync source and trusted ingest route has one verified mailbox transport.
- [ ] User, message, thread, attachment, search and export tests prove cross-mailbox reads are denied.
- [ ] A future active transport creates no implicit user or operator-export access.
- [ ] Same-transport source twins deduplicate; identical Message-IDs in different transports remain separate.
- [ ] Existing history/live CI remains green; new DB tests pass on disposable PostgreSQL.
- [ ] PR #28 contains the Zero changes and fresh review/checks. Update native PR #4 and its Zero gitlink only if native code changes.
- [ ] Handoff records exact PR heads, check evidence and the remaining human Outlook-profile release test.
- [ ] No merge, production deploy, or installer publication is performed as part of this plan.

True blockers: missing access that cannot be obtained safely, ambiguous ownership that needs an operator, required human-only Outlook/profile interaction, a safety conflict, or an external outage that prevents required proof. Routine coding choices and test failures are not blockers.

## Execution Mode

Autonomous when explicitly launched: resume at the first incomplete task, work through the reviewed-PR milestone without routine user checkpoints, and stop at the separate release boundary above. Use test-driven and subagent-driven development where specified.

## Current Branch and PR State

Verified against GitHub on 2026-10-05 UTC.

| Item | State | How it fits |
|---|---|---|
| Zero PR #28 — [feat/outlook-history-live-sync](https://github.com/kufupa/Zero/pull/28) | Open, merge state CLEAN; listed CI and Greptile checks pass on `f976afcda51ac3681d4b2fa8721d3528290b30b4`. Not merged or deployed. | Main feature branch. Its VSTO gitlink pins native SHA `32738e4d1764340b66fce3cdfb3262d56614edb9`. Add this isolation delta here; do not create a duplicate sync branch. |
| Native PR #4 — [feat/outlook-history-live-sync](https://github.com/kufupa/nava-outlook-addin/pull/4) | Open, merge state CLEAN; both Windows build checks pass on `32738e4d1764340b66fce3cdfb3262d56614edb9`. Candidate 1.0.13 is unpublished. | Linked add-in source at the exact SHA pinned by #28. Merge this reviewed native SHA before Zero #28; change it only if an isolation test proves native code must change, then update #28's gitlink. |
| Zero PR #3 — [FE-demo-refactor](https://github.com/kufupa/Zero/pull/3) | Open, old, merge state UNKNOWN. No exact changed-file overlap with #28; its body reports lint debt. | Separate UI transport refactor, not a dependency. Run the final hosted-pane/inbox smoke after it lands if it is merged first. |
| Zero PR #2 — [frontend startup perf](https://github.com/kufupa/Zero/pull/2) | Open draft against staging. | Separate work; not a prerequisite for mailbox isolation. |
| Current local checkout | feat/reservationist-backtest at 0b57af14; many unrelated edits. This plan is untracked here. | Do not commit this plan or unrelated files on this branch. Execution starts from PR #28 in a clean worktree. |

## Product Contract

| Boundary | Rule |
|---|---|
| Mailbox identity | mailbox_transport.id identifies one actual inbox. Separate Da Vinci addresses get separate transports. |
| User access | mailbox_access(user_id, transport_id) is the grant. A role or hotel name grants nothing by itself. |
| Outlook sync | An approved device/store root is bound to one transport; the server persists that transport on its sync source. |
| POP3/server ingest | A trusted configured route assigns the transport. Strip untrusted owner headers; quarantine missing or conflicting routes. |
| Canonical data | message.transport_id and mail_thread.transport_id identify ownership. Attachments inherit access from their parent message. |
| Web inbox | Existing mailbox context/switcher selects one granted transport. List, search, detail, download and send stay within it. |
| Duplicate handling | Deduplication is transport-scoped. Two mailboxes with the same RFC Message-ID remain two rows and two inbox items. |
| Pane | Sign-in, sync and per-source progress only. No permission workflow, mailbox picker, mailbox switching or email view. |

A message’s From/To addresses describe the conversation; they do not determine which mailbox owns the stored copy.

### Data flow

~~~text
Approved Outlook root ─┐
                       ├─ trusted transport ─> PostgreSQL message/thread/search
Trusted POP3 route ────┘                            │
                                                    └─ attachment references
                                                         │
                                                         └─ private S3 originals

User ─> exact mailbox_access grant ─> one transport in /mail/inbox
Unknown/conflicting source route ─> quarantine
~~~

## What Already Exists

- Zero already has mailbox_transport, mailbox_access and a mailbox context resolver. A requested transport is accepted only when that user has its exact grant; without a requested transport, the resolver chooses one default rather than merging mailboxes.
- PR #28 already adds outlook_device_read_root and outlook_sync_source.transport_id. The root is checked against the named user/device/mailbox grant; the source stores its transport. Native PR #4 already does staff-bound read-only scanning, history, catch-up and live capture.
- Canonical messages and threads already carry transport_id. PR #28 scopes history identity matching by transport and keeps source receipts. The existing PR checks include PostgreSQL persistence tests.
- Private S3 stores original sync artifacts; RDS stores searchable projections and ownership references.
- Verified gaps in the current base/PR:
  - applyPilotMailboxAccess in apps/server-pilot/src/db/seed.ts grants Nava every active transport. Adding Da Vinci would silently widen access.
  - The connected-mailbox dump discovers every active transport. Audit the thread-corpus exporter for the same default and require an explicit transport allowlist for operator exports.
  - Root approval checks the exact grant and serializes approvals per device, but it still permits another active root or transport mapping for the same enrolled device/store.
  - message.thread_id references a thread by ID without a database constraint that the thread has the same transport.
  - PR #28 tests same-mailbox twins, but not the key case: the same RFC Message-ID in two transports must remain separate.
  - Existing mailbox context is the right web permission boundary; add regression coverage for the inbox read/download paths instead of a new permission service.

## Minimal Implementation

### 1. Make grants and source ownership explicit

- Replace the seed’s “all active transports” grant loop with an explicit user-to-transport list. Keep intended admin/service grants explicit; a newly added transport must grant nobody until deliberately listed.
- In the existing read-root approval transaction, allow one active Outlook root per enrolled device/store for this rollout. Reuse its existing per-device row lock; reject a second active root or a second transport mapping. Do not add multi-mailbox-per-device support.
- Keep the server’s root/source binding authoritative. The pane payload cannot select or relabel a transport.
- Preserve the trusted POP3 route stamp. Unknown/conflicting route ownership is quarantined before canonical insertion.

### 2. Enforce ownership through RDS and reads

- Add one composite database relationship requiring a message’s thread and message to have the same transport. Preflight existing rows first; a mismatch blocks the migration and is investigated, never silently retagged.
- Add a regression test proving a shared RFC Message-ID creates separate canonical rows across transports while same-transport POP3/Outlook twins still link.
- Enforce the root limit atomically under the existing per-device lock. Test sequential and simultaneous attempts to bind one device/store to transports A and B; at most one binding may succeed.
- Confirm existing /mail/inbox list, search, thread detail, attachment/inline-image download and send paths use the exact active mailbox context. A user with only transport A must not access transport B by guessed message, thread or attachment ID.
- Test a user granted only A who submits B as the requested send transport: deny before writing or enqueueing any B-owned message.
- Keep the existing web mailbox switcher; verify it shows one transport at a time and clears old mailbox data when switching. Add no sync-pane permission or mailbox-selection UI.
- Audit each operator export entry point. The connected-mailbox dump must stop defaulting to every active transport; keep existing explicit corpus scopes. Any omitted or empty scope fails closed.

### 3. Audit and provision without reassigning history

Before any rollout, run read-only checks of existing grants, transports, message/thread ownership, sync sources and trusted ingest routes.

- Keep confirmed Centurion history with Centurion.
- Treat navaai@ as an ingest route/service identity, not the owner of every delivered message.
- Keep PMBobo ownership based on its trusted configured route. Do not assign by sender/recipient alone.
- Quarantine unresolved legacy ownership for an operator decision; do not re-tag based on mailbox-looking headers or uploader.
- For Da Vinci, create one transport per real reservations inbox; give each reservationist only their transport grant. Give an admin multiple rows only for mailboxes they should access. Bind each Outlook root and trusted POP3 route to the matching transport.

## Verification

All database tests use a disposable PostgreSQL database. The current PR #28 sync and native CI remain required gates; this plan adds only the following isolation cases.

Add the cases to these existing suites. PostgreSQL cases are integration tests under the required disposable-DB gate; the SPA cache case is a client-state regression:

| Test file | Type | Required regression |
|---|---|---|
| `apps/server-pilot/tests/seed-contract.test.ts`; `apps/server-pilot/tests/connected-mailbox-markdown-dump.test.ts`; `apps/server-pilot/tests/export-thread-corpus.test.ts` | Unit/CLI contract | New transports grant nobody by default; implicit dump scope is removed and corpus export scope stays explicit. |
| `apps/server-pilot/tests/outlook-sync-authorization.test.ts` | PostgreSQL integration | **CRITICAL:** sequential and concurrent A/B approvals for one device/store cannot create two active mailbox bindings. |
| `apps/server-pilot/tests/ingest-store-routing.test.ts` | Ingest integration | Missing, forged or conflicting owner stamps cannot choose a transport; quarantine before canonical insertion. |
| `apps/server-pilot/tests/outlook-sync-dedup.test.ts`; `apps/server-pilot/tests/outlook-sync-ingest.test.ts` | PostgreSQL integration | **CRITICAL:** equal RFC Message-ID across A/B stays separate; same-mailbox twins deduplicate; cross-transport thread link violates the database constraint. |
| `apps/server-pilot/tests/mail-router-isolation.test.ts`; `apps/server-pilot/tests/attachment-access.test.ts`; `apps/server-pilot/tests/mail-send.test.ts` | Router integration | **CRITICAL:** A-only guessed-ID reads/downloads and spoofed-B sends fail before data or bytes escape. |
| `apps/mail/tests/account-switch-cache.test.ts` | Client state | A→B switch displays one mailbox and clears A's cached data. |

| Case | Expected result |
|---|---|
| Reservationist has grant A; requests B list/search/thread/download IDs | Denied; no B data or attachment bytes returned. |
| Admin has explicit A and B grants | Can switch in the web inbox; each view/query is for one transport only. |
| New transport is added after seed | No existing user/admin/service grant appears automatically. |
| Same device/store is approved twice, or concurrently for A and B | Only one active root/transport binding succeeds; no race can create two. |
| POP3 route is missing, forged or conflicts with configured route | Quarantined; sender, recipient and uploader do not assign ownership. |
| Same RFC Message-ID arrives in A and B | Two canonical messages and threads; each visible only through its grant. |
| POP3 and Outlook observe the same message inside A | One canonical item with independent source receipts. |
| Message in A is attached to a B thread | PostgreSQL constraint rejects it. |
| Operator export omits transport IDs | Fails closed; explicit A export contains no B data. |
| Staff sends while A is selected | The outbound canonical row belongs to A; switching to B cannot expose it. |
| A-only user spoofs B in the send request | Denied before send or persistence; no B-owned row is created. |

### Coverage and failure map

| Failure | Test / protection | User-visible result |
|---|---|---|
| Wrong root or POP3 route assigns a message to another mailbox | Source-binding, route-stamp and quarantine tests | Sync denied or item held for operator review |
| New transport silently broadens Nava/admin grants | Seed contract test with a newly added transport | No new access |
| Cross-transport thread link or dedup | Composite FK and two-transport identity test | Wrong link blocked; each mailbox retains its own item |
| Inbox/attachment route omits grant check | Guessed-ID tests for list/search/detail/download | Forbidden/not found; no bytes |
| Export includes every active transport | Explicit-scope exporter tests | Export refuses missing scope |

Performance: reuse transport indexes and existing sync limits. No new queue, cache, RLS policy, stress framework or performance subsystem is needed for this delta.

## Release and One-Month Acceptance

This work does not deploy or publish anything. After the isolation PR is reviewed and merged under a separate release instruction:

1. **Merge order:** merge native PR #4 at `32738e4d1764340b66fce3cdfb3262d56614edb9` first, then Zero PR #28 with its gitlink still pointing at that same reviewed SHA. If native code changes, rebuild/review #4, update the #28 gitlink and rerun its gates before merging.
2. Under a separate release instruction, deploy matching Zero schema/server code using the existing [Outlook release runbook](https://github.com/kufupa/Zero/blob/feat/outlook-history-live-sync/apps/server-pilot/deploy/outlook-v4-security-release-runbook.md). This plan itself does not deploy.
3. Privately install the reviewed, unpublished native candidate on the nominated Centurion Classic Outlook profile **before** acceptance. Publish only after acceptance passes; PR #4’s 1.0.13 candidate is not yet published.
4. Sign in, bind the approved root to the Centurion transport and start sync. The first window is one Africa/Johannesburg calendar month, frozen at first native activation. Message/search/coverage projections and receipts go to RDS; original messages and attachments go to private S3. Live capture runs while Outlook and the staff session are available; reopening catches up missed mail.
5. **Pass:** every eligible discovered item has either a committed canonical row with required original receipts or an explicit, item-level gap; discovered = copied + gaps, with no unexplained remainder or duplicate within Centurion. “Copied” means committed ingestion, not upload. Verify restart/catch-up, inbound and saved outbound, RDS search/attachments, and denial for a second user without the grant. Follow the exact profile cases in the [onboarding checklist](https://github.com/kufupa/Zero/blob/feat/outlook-history-live-sync/docs/production-readiness/outlook-history-live-sync-onboarding.md).
6. Keep the outbound BCC macro until saved Sent-copy coverage and deduplication pass. The operator removes the named-PC macro manually.
7. Before each Da Vinci reservationist signs in, create one transport per actual inbox and verify its explicit user grant and device/root binding. Admin access uses separate explicit grants.

The detailed sync proof and supervised acceptance are in [PR #28’s evidence](https://github.com/kufupa/Zero/blob/feat/outlook-history-live-sync/docs/production-readiness/outlook-history-live-sync-pr-evidence.md) and [onboarding checklist](https://github.com/kufupa/Zero/blob/feat/outlook-history-live-sync/docs/production-readiness/outlook-history-live-sync-onboarding.md).

## NOT in Scope

- Rebuilding history, catch-up, live capture, S3 sealing, sync receipts or pane progress already implemented in #28/#4.
- A hotel/tenant ID, new mailbox ACL table, permission-management service, RLS, or per-user message copies.
- A merged cross-mailbox inbox, duplicate suppression across different mailboxes, or mailbox selection/access UI in the pane.
- Multi-mailbox sync from one physical device. The requested onboarding is one reservationist mailbox per enrolled device; revisit only if operations require a shared multi-mailbox workstation.
- Automated retirement of the named-PC BCC macro; an operator removes it after acceptance.

## Worktree and Parallelization

Sequential. The remaining changes share Zero’s mailbox ownership and query boundaries; one owner should update the seed, source authorization, schema and read/export tests in PR #28. Use a separate reviewer for the final diff.

- **Shared checkout:** `/home/ubuntu/projects/zero/.worktrees/centurion-dashboard-tools` is `feat/reservationist-backtest`, dirty with unrelated work, and stores this untracked plan. At the 2026-10-05 check, all locally visible Codex CLI processes reported this directory as their current directory. Process inspection cannot map a process to a chat window, so treat this checkout as shared. The plan edit is visible there; implementation must not touch its code or stage unrelated files.
- **Recommended Cursor worktree:** `/home/ubuntu/projects/zero/.worktrees/outlook-history-live-sync` is a separate worktree on `feat/outlook-history-live-sync`, at PR #28 HEAD `f976afcda51ac3681d4b2fa8721d3528290b30b4`. It was clean and tracking `origin/feat/outlook-history-live-sync` when checked; no locally visible Codex CLI process had this directory as its current directory. Recheck the path, branch, current PR head and clean status before editing. Separate worktrees isolate files and indexes; Git refs are shared.
- If the recommended worktree is dirty, occupied or no longer safely based on PR #28, preserve it: do not reset, clean, stash, switch its branch or overwrite changes. Stop before edits and report a concurrency/safety blocker if no clean route can update PR #28 without taking over another session.
- Read this plan from its absolute path and treat it as read-only during implementation; report task completion in the executor’s final handoff rather than editing this shared copy.

## Implementation Tasks

Tasks from this review; no unrelated TODO was found in the repository.

- [ ] **T1 (P1)** — Make default grants and exports explicit.
  - Files: `apps/server-pilot/src/db/seed.ts`; `apps/server-pilot/src/ops/connected-mailbox-markdown-dump.ts`; inspect `centurion-thread-corpus-snapshot.ts` and `centurion-thread-corpus-exporter.ts`, editing only if they lack explicit scope; focused tests listed above.
  - Verify: adding an active transport grants it to nobody; an export without explicit transport IDs is rejected.
- [ ] **T2 (P1)** — Enforce root, message and thread ownership.
  - Files: apps/server-pilot/src/outlook-security/device.ts; apps/server-pilot/src/db/schema/mail.ts; reviewed Drizzle migration; authorization/dedup/ingest tests listed above.
  - Verify: one active root per device/store is enforced under concurrency; PostgreSQL rejects cross-transport message/thread links; identical Message-ID stays separate across transports.
- [ ] **T3 (P1)** — Prove web mailbox isolation and operator provisioning.
  - Files: existing mailbox context, router/attachment/send tests and operator checklist; no new pane workflow.
  - Verify: one-grant user cannot list/search/open/download/send into another mailbox; admins see only explicitly granted mailboxes; Centurion/Nava/PMBobo ownership audit is read-only and unresolved rows are held.
- [ ] **T4 (P1)** — Update PR #28 with evidence and run fresh gates.
  - Verify: Zero sync CI, disposable-PostgreSQL migration tests, Greptile/final review on the exact head; rerun native CI only if PR #4 changes.

No root TODOS.md exists. The deferred items above are outside this rollout and do not need a new backlog item.

## GSTACK REVIEW REPORT

| Review | Trigger | Runs | Status | Findings |
|---|---|---:|---|---|
| Eng review | plan-eng-review | 1 fresh pass | Clear after scope reduction | Existing #28/#4 implementation retained; plan reduced to the mailbox-isolation delta and concrete missing protections. |
| Simplicity review | ponytail | 1 pass | Clear | Reuse mailbox ACL, root/source binding and RDS/S3. No new permission service, hotel schema, RLS or pane workflow. |
| Independent challenge | Standard subagent | Completed | Resolved | Added atomic device/store root exclusivity and concurrent A/B test; denied spoofed-B send before persistence; corrected private-install/acceptance and PR #4→#28 merge order; defined one-month reconciliation pass rule. No cross-model review claimed. |
| Existing implementation CI | Zero #28 / native #4 | Latest listed checks | Passing, not merged | Zero PR checks and both native Windows builds pass on their current heads. |
| GStack helpers | Review log/dashboard binaries | Unavailable at configured path | Not generated | Content review and plan-file checks are reported directly; no helper-generated dashboard claimed. |

VERDICT: The existing sync PR is the implementation base. The only planned product delta is explicit per-mailbox ownership, grants, reads and exports. Merge/deployment and the real one-month Outlook acceptance remain later release steps.

NO UNRESOLVED DECISIONS

## Cursor CLI Goal Handoff

Start a **fresh Cursor CLI chat** with its working directory set to `/home/ubuntu/projects/zero/.worktrees/outlook-history-live-sync`, then paste:

```text
/goal
Implement the mailbox-isolation plan at:
/home/ubuntu/projects/zero/.worktrees/centurion-dashboard-tools/docs/superpowers/plans/2026-10-04-outlook-history-and-live-sync.md

This is a zero-context handoff. Read the whole plan and the applicable repository instructions before editing. Follow its Autonomous Execution Mandate, task list, and Zero RDS safety rules.

Work only in `/home/ubuntu/projects/zero/.worktrees/outlook-history-live-sync` on `feat/outlook-history-live-sync`. First verify the worktree is clean and compare its branch/HEAD with the current Zero PR #28 head. This worktree was clean at `f976afcda51ac3681d4b2fa8721d3528290b30b4` when the plan was updated; recheck it. The plan file lives in a different, shared dirty checkout: read it only. Do not edit that checkout, switch its branch, stash, reset, clean, or stage its unrelated files. If the target worktree is dirty, occupied, or unsafe, preserve it and report the blocker rather than overwriting another session.

Execute T1–T4 sequentially and autonomously to a reviewed, green update of Zero PR #28. Use disposable PostgreSQL only; before each Vitest run unset `DATABASE_URL` and `VITEST_ALLOW_PILOT_RDS`. Never test against pilot/production RDS. Commit only explicit feature files and use a normal, non-forced push after confirming the PR branch/head. Change native PR #4 or its gitlink only if a proven requirement demands it.

Stop at the reviewed PR. Do not merge either PR, deploy/migrate production, restart production, or publish the installer. Do not automate removal of the named-PC BCC macro.

Final handoff: report branch, commit and PR head; changed files; focused/broader tests and hosted checks; review findings; deviations; any blocker; and the remaining merge, deployment, mailbox-provisioning and one-month/live/catch-up acceptance steps. Keep it concise so it can be reviewed in the coordinating chat.
```
