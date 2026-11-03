# U7 amend — 2026-11-03

- Status: WIP; HRCEN Go held. No U7 live write proof or PR.
- Narrow draft: `/home/orca/.codex/worktrees/hrcen-occupancy-retain-20261103/zero`.
- Full draft: `/home/orca/.codex/worktrees/amend-connected-20261103/zero`.
- Do not reset, stash or overwrite either tree.

## Scope and holds

- Draft first slice: one-night Proof Labtest; adult count change; unchanged rate; retain=yes; NGI; send off; empty guest email and linked parties. Dates, children, changed rate, retain=no and linked parties refuse.
- `cloudAmendWriteReady()` and native rate/recovery proof functions still return false. Do not toggle: live rate/retain behavior and recovery remain unproved.
- Flag readiness also remains unproved: the draft gates only remote flag flips, not legacy/remote parity or an already-on flag on each new SHA. Parent owns shared deploy files. Keep U7 off until the final-SHA canary and four-process parity are verified.
- Shared HRCEN UNKNOWN must span availability, Save and retain continuation. Only confirmed commit permits the fenced request. Uncertainty stays held; no blind retry or staff-note clear.
- `#983` drain merged at `755aca7`. `#982` / `#981` shared claim and worker work not merged at this snapshot. Integrate actual main first; preserve source/hash, actor/session, lease, evidence and readback checks. Do not reset the two drafts.
- Narrow WIP now gives U7 its 25-minute claim ceiling, preserving any earlier deadline; the worker still requires a 14-minute dispatch reserve. Integrate with Filing's prompt-specific branch after #981 lands.
- UNKNOWN records owned writer identity for later quiescence proof. No U7 operator recovery driver is implemented; a failed write may remain blocked indefinitely.

## Size

- Combined U3/U6 scratch tree `1cb49fa202b97e2ac998fa42e9a9e759c202e9e5`: 2,283 gross product lines with unresolved merge markers; this is not a final count. U7's nonconflicting files alone add 1,847 gross. Projection artifacts: `/tmp/nava-u7-projection-4oaolq_e/`.
- Conflicts: approval card, mail approval client, remote flags, HMS approval, shared dispatch, run ledger, worker, HMS approval router, native save route chain, and two tests. Rebase only after #982/#981 actually land; preserve both lanes in every conflict.
- Explicit waiver: 1,600. No demonstrated single reuse saves the required 247+ lines. U6's mounted runner shares claim, lease, screenshots and result handling, but its attachment form/source and single native upload differ from U7's three phases and retained-price proof. Generalizing it may reduce code, but requires U7-specific validation and new cross-lane tests; no safe net saving is yet measured. The shared mail approval client lacks U7's same-message content hash and invalidation checks. Do not remove those guards to meet the cap.

## Evidence

- Synthetic owned-writer binding: `/tmp/nava-u7-writer-identity-native-20261103.log` (17/17 Node) and `/tmp/nava-u7-writer-identity-dispatch-20261103.log` (10/10 Vitest).
- Synthetic screenshot event lock regression: `/tmp/nava-u7-evidence-lock-20261103.log` (10/10 Vitest). Private synthetic PostgreSQL claim: `/tmp/nava-u7-current-claim-EvzeR3nr/result.log`; source, access and evidence mutations waited for commit, UNKNOWN blocked replay. Writer identity mocked; no production schema or multi-writer proof. Private cluster stopped.
- Deadline checks: `/tmp/nava-u7-claim-budget-20261103.log` (12/12 Vitest), `/tmp/nava-u7-budget-native-20261103.log` (28/28 Node).
- U7 claim-deadline scope: `/tmp/nava-u7-claim-deadline-20261103.log` (4/4 mocked-ledger Vitest). Native combined suite: `/tmp/nava-u7-combined-native-20261103.log` (64/64; includes localhost Chromium). No live rate persistence proof.
- Synthetic queued-worker → claim → result: `/tmp/nava-u7-runner-integration-20261103.log` (3/3). The DB, Go and native session are mocked; not a staff-flow or HMS proof. A changed preimage and an after-image seal failure stay UNKNOWN.
- Runner WIP preserves a locally read after-image if S3/ledger sealing fails, including an `ENOENT` from the sealer; the synthetic integration test covers it. Retained private evidence still needs a bounded retention/recovery policy. U6 has added its own bounded private retention in its WIP.
- DB variables unset; pilot RDS not tested. These results prove neither a live amend nor rate persistence.

## One-shot canary

- Private harness: `/tmp/nava-u7-one-night-go-4xktpjkh`; no live dispatch without coordinator freeze and explicit signal.
- Await a new, independently read-back one-night U3 fake stay on a profile with no unresolved historical write. Never reuse the historical uncertain targets.
- After target and read-only authorization: prepare, seal and abort-only rehearse against the exact product files. Product changes require reseal and another rehearsal.
- Canary uses synthetic Go and a private hold. Even a successful canary does not prove the staff UI → queue → worker → readback path.

## Next

1. After `#982` / `#981` land, rebase in a new isolated continuation; reconcile the named conflicts and preserve the drafts. Reuse the merged shared dispatch and actor/session checks where the source and lock-order contracts match.
2. Evaluate extracting genuinely common U6/U7 runner and approval logic, including pre-effect evidence, browser drain/close, source/session checks and per-operation readback. Measure the resulting gross PR diff before review; the current slice exceeds 1,600. Merge both prompt-specific run deadlines.
3. Obtain a newly created, independently read-back one-night fake stay on a clean profile. Under a coordinator-controlled freeze, prepare, seal and abort-only rehearse the private canary. One-shot live dispatch needs that exact freeze authorization; retain UNKNOWN on ambiguity. Existing uncertain profiles stay held.
4. Prove native availability/retain semantics and positive price/stay readback; then prove the real staff approval → queue → worker → native → fresh-readback path. A synthetic-Go canary alone is insufficient. Complete dates, child occupancy and changed-rate choices in follow-up.
5. Final-head focused tests, both remote typechecks, Apex, coordinator diff review, merge gate, final-SHA canary and four-process flag parity, deployed webmail/Outlook walks and deployed proof remain required. Do not enable U7 flags or claim completion before those checks.
