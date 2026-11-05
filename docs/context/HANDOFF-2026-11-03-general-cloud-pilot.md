# Handoff: General Cloud pilot

**Written:** 2026-11-03. **Purpose:** Give the next LLM the owner's direction, evidence, prepared policy patch and remaining work. Recheck the repository, PR heads and runtime before acting; this is a snapshot, not an authorization to run the plan.

## Owner's direction

- Build general, reusable HMS Cloud product tools first. `Proof Labtest` is test data passed to those tools, not a separate production tool family.
- Cover the Centurion pilot end to end: triage, quote, single-room Create, Multi-room, Filing and full Amend on the shared Outlook and webmail pane. Develop a generic Cloud Cancellation tool in parallel.
- Prefer small, coherent PRs around 500 product lines, but remove the hard size gate. Run Greptile Apex on every final PR code head. Remove the mechanical requirement for a successful Greptile check at each merge and the empty per-head gate record. Keep review and valid P0/P1 triage, plus integrated checks before release.
- The owner accepts some risk to improve speed. That does not remove existing write-authorization rules, permit unapproved changes to a stay, or authorize accepting a penalty dialog.
- The owner requested this handoff. This request does not itself launch implementation, authorize a live real-guest write or flag change, or request a commit, push or deploy. Follow the owner's next actual request and the current repository rules.

## Read first

1. `PRODUCT.md`, `AGENTS.md`, `docs/context/START-HERE.md` and `/usr/local/share/nava-codex/AGENTS.md`. Current workspace and owner instructions take precedence over older handoffs.
2. **Main deliverable:** `docs/plans/2026-11-03-002-feat-general-cloud-real-pilot-plan.md`. It contains product requirements, source seams, lane ownership, dependencies, rough LOC estimates, tests and definition of done. It is currently untracked and marked `requirements-only`: independent coding can be planned, but actual release and real-write authority and cancellation fee/scope evidence are unresolved.
3. **Previous run handoff:** `docs/research/halloween/2026-11-02-llm-retro/2026-11-03-next-pilot-planning-notes.md`, especially the 12:30 UTC cutoff section around lines 414–421. Its runtime statements are reports from the previous run, not live observations from this session.
4. Prior plan: `docs/plans/2026-11-03-001-feat-connected-pilot-next-tranche-plan.md`. The earlier connected plan, `docs/plans/2026-11-02-005-feat-connected-pilot-final-plan.md`, explicitly scheduled a fake booking before lifting Labtest-only checks. That explains the sequence, but does not justify making fake identity part of the reusable production tool contract.

## Repository and policy patch state

At handoff creation:

- Shared root `/home/ubuntu/projects/zero` was on `main` at `6bb282ae7`, behind the inspected `origin/main` snapshot `0da451edd5cbc6188d45fb05e619d5e2e12c97e0`. The root has many unrelated dirty/untracked files. `AGENTS.md` was already modified before this session. Do not reset, stash, overwrite, delete or interrupt anyone else's work.
- This session created the untracked general-pilot plan and appended a continuity entry to `docs/context/OWNER-ASKS.md`.
- The requested process changes were prepared in isolated worktree `/home/ubuntu/projects/zero/.claude/worktrees/agent-a8d639a6e94efe62b`, based on `0da451edd`. Changes are uncommitted in `AGENTS.md`, `PRODUCT.md`, `scripts/orch/merge-gate.sh` and `scripts/orch/test-orch.sh`. Preserve this worktree and its changes.
- **The patch is not on main and is not active in the shared root.** Until it is adopted, follow the current rules and merge gate. Do not imply the user asked to merge or deploy it.
- The patch keeps exact-head merge protection and blocks known unresolved P0/P1 review threads. It removes the line-count, Greptile-success and empty-record blockers. It requires a completed independent review of shipped diffs and integrated affected-app checks before release, with a fallback reviewer if Greptile is unavailable or unfinished. It plans generic Cancellation but retains the existing real-guest owner-authorization requirement.
- The release-review requirement is policy, not an enforced new deployment gate. If the patch is adopted, coordinate the existing deploy process so merged but unreviewed work is not released prematurely.
- Isolated fake-GitHub test `bash scripts/orch/test-orch.sh` passed. `bash -n` on the two changed shell scripts and `git diff --check` passed. No app typecheck or Vitest was run for this Bash/Markdown patch. No real GitHub merge occurred.

## What the previous run proved and did not prove

At its owner-extended 12:30 UTC stop, Create #982, Filing #981 and Multi-room #986 had merged. The previous handoff reports `0da451e` deployed, write workers off and readiness available; this session did not independently verify those runtime claims. Amend #987 was open at candidate head `19c0cf1860bc11fadc138f779a1fe5dc20c2d156`.

The previous handoff did **not** establish deployed pane-Go Create, Filing, Amend or Multi-room write/readback. Quote attempts did not prove deployed-pane rate retrieval and may have changed internal work-item state; do not reuse that driver blindly. Outlook/webmail source-switch smoke used mocked authentication, API and bridge, not installed Outlook.

The product lanes ran from 03:20 to the owner-extended 12:30 cutoff: 550 minutes wall clock. This is not active coding time. Create, Filing and Multi-room PR open-to-merge intervals overlapped and must not be summed or presented as review-only delay. The previous assistant's 0.8k–1.5k whole-pilot product-line forecast was speculative and has been withdrawn. No credible completion ETA was established. Follow `~/.claude/CLAUDE.md` and its ETA ledger rules if making an actual forecast.

## Architecture findings and remaining gaps

| Area | Evidence-backed state and next concern |
|---|---|
| Create | Native guest/profile, party, form and CMS picker primitives are partly reusable. The connected Cloud save remains HRCEN Labtest-specific. Real Cloud create currently forces CMS send off. Generalize inputs and exact readback, including recipient, message and send semantics. Do not silently treat existing-profile lookup as new-profile creation. |
| Multi-room | #986 supplies serial single-room execution and partial outcomes, but sibling verification and persistence still carry Labtest assumptions. Generalize after single-room Create; preserve positive resolution of previous rooms and stop on uncertainty. Do not assume native HMS linking. |
| Filing | #981 binds source bytes and selected stay, but real-guest attachment write is refused and native attach is fake-specific. Current source is PDF-specific. Outlook attachment-byte parity is unproved. HMS Documents listing proves observed metadata, not byte-for-byte stored contents or complete tree coverage. |
| Amend | At `19c0cf1`, #987 supports only a narrow fake, unpaid, one-night, same-plan, retain-yes date/adult slice. A valid P1 remains: after the retain-rates prompt, the second Save can use a fresh snapshot without proving it matches the staff-approved prices and values. The separate history-resume fix does not resolve this P1. Bind both Saves to the same approved operation and re-review the actual head. Full scope includes dates, occupancy, rate plan and retain choice; manual amount is dropped. |
| Cancellation | `apps/server-pilot/tooling/hms-cloud/guest-stay-cancel.mjs` is fake-specific. The older HRCEN pane path refuses cancellation and is not the general Cloud writer. Current preflight cannot prove prospective fees or complete linked-room scope. Historical HRDAV evidence and the current Cloud contract show a cancellation can take effect before a penalty dialog. Never accept the dialog. If Save may have dispatched, read HMS before any retry. Blocking all unknown-fee cases could make the entire tool unavailable; assuming unknown means no fee is also unsupported. Build independent generic work while resolving evidence and policy. |
| Quote / triage | Preserve the existing general workflow and product rules. Identify and fix the actual selected-pane to rate-request boundary before estimating its change size. Nava saves unsent drafts; it never sends. |

**Design recommendation:** Move fake identity, future dates and no-send expectations into fixtures. Keep server-derived authority, exact approved target/intent, suitable native preimage and duplicate checks, guarded dispatch, screenshots, fresh readback, partial outcomes and an uncertain state. Never expose `allowRealGuest` as a browser-selected authorization. Existing `workItem.state` and `workEvent` may be enough for durable intent and batch outcomes, but atomicity, retention, indexing and coverage of older writers were not established. Do not add a new table merely by assumption, and do not claim the old store is sufficient without checking.

## Review evidence

A bounded review of PRs #982, #981, #986 and #987 found six code-supported Greptile P1 comments. Five had visible follow-up fixes; the #987 second-Save issue remained unresolved at the inspected head. Examples include a requested track not applied, a filename readback mismatch and a completed batch blocking a later batch. Four final-head Greptile check runs lasted 1m57s–3m26s. GitHub metadata identified the Greptile app, not its Apex engine tier. Four PRs are not enough to measure miss rate, false-positive rate or the effect of PR size. A successful check did not mean no P1 comments.

## Safety and proof boundaries

- Current `PRODUCT.md` is authoritative. Real-guest writes require owner authority in the executing session, and staff writes require the applicable staff Go and runtime flags. Do not infer authorization from a prior run or this handoff.
- Fake writes for `Proof Labtest`, 2027+ stays, are always allowed under current product rules; do not ask for those. Tests keep CMS send off. Real reads and unsaved staging are allowed.
- Never accept a cancellation-penalty dialog. Never blind-retry an uncertain write. Do not send credentials or secrets externally.
- Before tests, unset `DATABASE_URL`, `VITEST_ALLOW_PILOT_RDS` and `TEST_DATABASE_URL`. Never test against pilot RDS. Check resources and shared local-test concurrency under current `AGENTS.md`. Run typechecks only through `remote-typecheck.sh`; report skipped DB suites as skipped.
- GitHub Actions are reserved for the authorized Outlook installer workflows. Do not add, enable or trigger other workflows. Never use `--no-verify`.
- Deployment and workflow-on claims require current approved deploy procedure, effective environment checks for every affected PM2 process, property readiness and appropriate final-head deployed-pane proof. Fake bridge evidence is not proof of installed Outlook or native Outlook attachment bytes.

## Suggested resumption

Recheck current worktree status, ownership and latest PR heads without touching unrelated changes. Read the plan and isolated patch. If the owner's next request is to execute, use its actual scope and authority, keep independent lanes moving, and address the policy patch and shared-contract ownership explicitly. Do not start a run solely because this handoff exists.
