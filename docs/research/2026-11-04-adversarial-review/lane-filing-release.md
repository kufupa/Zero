# U3–U6 adversarial audit

**Verdict:** U3 is a real staff-path gap, not a backend/parser gap. Reuse the existing HMS search/find builders; add editable target criteria, selectable rows, and stale-state fencing in the shared pane. U4 should promote workflows independently through the checked-in writer. Keep truthful canaries and release/readback gates; cut the private helper’s joint Create+Attach dependency and duplicate release ceremony.

- **Audited:** deployed snapshot `1e2b2f7a0fa968acc2ad593d6ebb7fcc4c12f746`; current M1 receipts through 2026-11-04 00:24 UTC.
- **Read-only:** no code edits, tests, HMS/EC2 calls, or deploys. Only this requested report is output.

## 1. Filing UI cannot recover from missing or ambiguous extraction

| Gate | Current behavior | Finding |
|---|---|---|
| Search inputs | Search starts only when extracted surname and arrival both exist, with no conflicting values ([`voucher-find.ts:101–110`](/tmp/advrev-main/apps/mail/lib/quote-workflow/voucher-find.ts#L101-L110)); request is built from those extracted values ([`voucher-find-card.tsx:201–216`](/tmp/advrev-main/apps/mail/components/quote-workflow/voucher-find-card.tsx#L201-L216)). | Missing surname/date or extraction conflicts leave staff no editable Nava criteria. |
| Result choice | Filing is enabled only for exactly one result whose surname matches ([`voucher-find-card.tsx:223–230,452–457`](/tmp/advrev-main/apps/mail/components/quote-workflow/voucher-find-card.tsx#L223-L230)). Multiple rows get “Open a booking in HMS” links, not a Nava target picker ([`voucher-find-card.tsx:595–629`](/tmp/advrev-main/apps/mail/components/quote-workflow/voucher-find-card.tsx#L595-L629)). | Multiple stays or no extracted identity block preview/bind, even when staff could identify the right stay. No auto-pick is correct; no selection path is the gap. |
| Fallback | Current copy says “Find the booking by name in HMS”; save fallback says “Saved. Upload it in HMS Documents.” ([`voucher-find.ts:56–76`](/tmp/advrev-main/apps/mail/lib/quote-workflow/voucher-find.ts#L56-L76)). | That is manual HMS filing, not M1 Nava Filing. |
| Async scope | Voucher card key is mailbox + transport + message only ([`booking-voucher-card.tsx:107–120`](/tmp/advrev-main/apps/mail/components/nava-pane/blocks/booking-voucher-card.tsx#L107-L120)); adjacent Amend/Approve keys include selection epoch and source hash ([same file:87–104](/tmp/advrev-main/apps/mail/components/nava-pane/blocks/booking-voucher-card.tsx#L87-L104)). Preview key includes file/guest/result but not source hash or selection epoch ([`voucher-find-card.tsx:231–234`](/tmp/advrev-main/apps/mail/components/quote-workflow/voucher-find-card.tsx#L231-L234)). | U3.3’s source/hash/attachment/selection invalidation is justified. Existing server revalidation is a second safety net, not a reason to keep stale UI state. |

## 2. Reuse search primitives; do not mount Amend panel as-is

- `amend-find.ts` already builds `search_guest` and exact confirmation `find` requests ([`amend-find.ts:550–558,710–735`](/tmp/advrev-main/apps/mail/lib/quote-workflow/amend-find.ts#L550-L735)). `AmendLookupPanel` has the surname/date form and selectable result pattern ([`amend-lookup-panel.tsx:739–835,850–908`](/tmp/advrev-main/apps/mail/components/quote-workflow/amend-lookup-panel.tsx#L739-L908)).
- Do **not** mount the whole Amend panel alone: parent renders it only with amendment context and `readOnlyAmend`; write card is explicitly non-amend ([`booking-voucher-card.tsx:86–105`](/tmp/advrev-main/apps/mail/components/nava-pane/blocks/booking-voucher-card.tsx#L86-L105)). Reuse its interaction pattern/builders in `VoucherFindCard`.
- `booking-card.tsx` guest candidates are Create-time guest-profile choices following a Create preview ([`booking-card.tsx:1272–1282`](/tmp/advrev-main/apps/mail/components/quote-workflow/booking-card.tsx#L1272-L1282)); they are not reservation/stay search and do not solve Filing target selection.

## 3. Backend guards are strict, but do not require extraction to identify the stay

| Guard | Evidence | Normal-voucher impact |
|---|---|---|
| Exact target + source | Preview requires HRCEN target, current source authority, fresh `findStay`, exact confirmation/arrival/surname, then re-reads the same PDF source ([`pane-filing-preview.ts:55–97`](/tmp/advrev-main/apps/server-pilot/src/ai/pane-filing-preview.ts#L55-L97)). | Safe after staff selects a row. Server does not require NLP to have produced surname/date; current UI does. |
| Unique attachment provenance | Source resolver requires one scoped DB row, one duplicate-free attachment, one matching artifact role/receipt; linked-source path also requires unique artifact/origin/latest/source/observation records ([`voucher-filing-source.ts:43–78,118–185`](/tmp/advrev-main/apps/server-pilot/src/ai/voucher-filing-source.ts#L43-L185)). | Refuses missing, duplicate, stale, or inconsistent source evidence—not ordinary ambiguity in guest search. POP3 path also requires one exact message/attachment row ([same file:193–225](/tmp/advrev-main/apps/server-pilot/src/ai/voucher-filing-source.ts#L193-L225)). |
| File bounds | Strict `.pdf`, application/pdf, nonempty ≤10 MiB, `%PDF-` header, and SHA-256 match ([`voucher-filing-contract.ts:5–43`](/tmp/advrev-main/apps/server-pilot/src/ai/voucher-filing-contract.ts#L5-L43)). | Valid guard; blocks oversized/non-PDF/corrupt or changed bytes. 10 MiB is an explicit edge for a larger real voucher. |
| Uncertain-upload recovery | Recovery requires exact unique fresh Documents listing and exactly one consumed approval event ([`pane-cloud-attach-recovery.ts:20–32,126–176`](/tmp/advrev-main/apps/server-pilot/src/ai/pane-cloud-attach-recovery.ts#L20-L176)). | Recovery-only. Do not mistake this strict readback/count fence for an ordinary-upload gate. |

## 4. No current-code PDF upload/readback proof

- M1 state says no Create native Save or Filing upload; at 00:24 stage 2 and canaries were still absent. Selected PDF existed, but surname/arrival extraction was absent and Filing had not reached upload ([`STATE.md:19–20,28,36,42–43`](/home/orca/.codex/m1-20261103-203425/STATE.md#L19-L43)). This supports U3’s missing staff override, not a new parser project.
- Earlier 2026-11-01 discovery saw a 64-byte synthetic text upload return HTTP 200 and a separate Documents read show matching metadata; refresh verification was false, tree completeness unknown, and bytes were not compared ([`document-discovery-handoff.md:3–25`](/tmp/advrev-main/docs/research/2026-11-01-hms-cloud-document-discovery-handoff.md#L3-L25)). That is not a normal PDF end-to-end pass on this snapshot.
- Existing module tests are not native proof. **No fake PDF upload plus fresh Documents readback is evidenced on deployed `1e2b2f7`.**

## 5. Promotion can be per workflow; canary is not inherently circular

- Checked-in writer checks workflow flags that newly widen to `on`; for HRCEN it requires matching workflow/property and exact 40-character live SHA ([`write-ec2-remote-env.sh:466–599`](/tmp/advrev-main/apps/server-pilot/deploy/write-ec2-remote-env.sh#L466-L599)). Narrow Labtest bootstraps permit Create dispatch / Attach worker while corresponding `PANE_WRITE_*='lab'` ([same file:573–579](/tmp/advrev-main/apps/server-pilot/deploy/write-ec2-remote-env.sh#L573-L579)). Fake proof can therefore precede real-mode promotion; not a code-level circle.
- Caveat: checked-in code consumes `CANARY PASS …` tokens; no in-repo token producer or current genuine token was found. Do not fabricate one. Mint only from a successful native fake operation on exact final SHA. An unchanged `on` flag does not trigger writer canary check on every later deploy; still verify final-SHA live capability before claiming it is on.
- Private `m1-cutover.sh stage2` requires **both** exact HRCEN Create and Attach canaries, then sets all four M1 flags on, calls writer/restart, and checks deployed SHA ([`m1-cutover.sh:97–145,343–400`](/home/orca/.codex/m1-20261103-203425/release/m1-cutover.sh#L97-L400)). Separate Filing helper also requires a fresh Create receipt ([`filing-fake-preview-bind.sh:9–30`](/home/orca/.codex/m1-20261103-203425/filing-fake-preview-bind.sh#L9-L30)). These are helper coupling, not requirements of checked-in per-flag writer; plan explicitly allows a verified existing fake stay ([recovery plan:189–195](/home/ubuntu/projects/zero/docs/plans/2026-11-04-001-feat-m1-recovery-plan.md#L189-L195)).
- Per-workflow route: change only durable `PANE_WRITE_ATTACH`, run supported `write-ec2-remote-env.sh --m1-only` with final SHA/canary, then `ops-restart.sh`; inspect effective flags/build/health for all four PM2 processes. Do not hand-edit remote env or run raw PM2. Restart validates env, serializes mutation, refreshes processes, checks health/readiness ([`ops-restart.sh:32–60,87–160`](/tmp/advrev-main/apps/server-pilot/deploy/ops-restart.sh#L32-L160)).

## 6. Release gates and measured time

- Merge gate is safety: verify exact PR head, fetch complete review-thread/comment pagination, block unresolved P0/P1, squash-merge with `--match-head-commit` ([`merge-gate.sh:13–36`](/tmp/advrev-main/scripts/orch/merge-gate.sh#L13-L36)). Gate runtime itself was not separately timed. Plan checkpoints: 10 min to launch review/checks, 10 min per actual finding, 15 min merge/bundle audit; #999’s 11m27 comparable included review tail, not just deploy ([`plan:197–203`](/home/ubuntu/projects/zero/docs/plans/2026-11-04-001-feat-m1-recovery-plan.md#L197-L203)).
- Receipts show **2 successful deploys on Nov 3 UTC**: `593d0541` finished 22:33, `b6a3e5b2` finished 22:59; `1e2b2f7a` finished Nov 4 00:05 ([`STATE.md:8,36`](/home/orca/.codex/m1-20261103-203425/STATE.md#L8-L36)). Commit timestamp alone is not deploy time: `1e2b2f7a` commit is 23:57 Nov 3, but its deploy crossed midnight.
- Logged deploy **step sums**, not stopwatch wall time: Nov 3 mean `(330s + 311s)/2 = 320.5s` (**5m21s**). Including Nov 4’s 315s receipt: 318.7s (**5m19s**). Individual receipts: [`deploy-593d0541.log`](/home/orca/.codex/m1-20261103-203425/deploy-593d0541.log), [`deploy-b6a3e5b2.log`](/home/orca/.codex/m1-20261103-203425/deploy-b6a3e5b2.log), [`deploy-1e2b2f7a.log`](/home/orca/.codex/m1-20261103-203425/deploy-1e2b2f7a.log).

| Deploy step | 593 / b6a / 1e2 seconds | Why keep |
|---|---:|---|
| HOLD + clean main/worktree/SHA preflight | Not separately timed | Refuse hold, dirty checkout, wrong branch/head ([`ops-deploy.sh:39–77`](/tmp/advrev-main/apps/server-pilot/deploy/ops-deploy.sh#L39-L77)). |
| Bundle sync / shipping SHA | 37 / 37 / 38 | Match bundled and remote commit ([same:101–117](/tmp/advrev-main/apps/server-pilot/deploy/ops-deploy.sh#L101-L117)). |
| Restore hook / frozen install | 10 / 9 / 10; 16 / 17 / 16 | Avoid install failure; reproducible deps. |
| DB compatibility / env bootstrap check | 14 / 13 / 10; 9 / 9 / 10 | Compatibility before activation; bootstrap only if env absent ([same:119–160](/tmp/advrev-main/apps/server-pilot/deploy/ops-deploy.sh#L119-L160)). Explicit migration was not run. |
| On-box deploy | 143 / 125 / 129 | Server/mail builds, protected runtime dirs, hashed SPA assets, ownership and dual-plane Nginx checks ([`deploy-ec2.sh:172–212,280–308,378–419`](/tmp/advrev-main/apps/server-pilot/deploy/deploy-ec2.sh#L172-L419)). |
| Health / last-good marker read / EC2 clock | 10 / 10 / 9; 10 each; 10 each | Verify services; bound next dead-letter readiness window ([`ops-deploy.sh:214–293`](/tmp/advrev-main/apps/server-pilot/deploy/ops-deploy.sh#L214-L293)). |
| Remote-admin lifecycle readiness / VPN assert / write marker | 52 / 51 / 53; 10 each; 9 / 10 / 10 | Operational readiness, network path, and safe next-deploy boundary ([same:294–363](/tmp/advrev-main/apps/server-pilot/deploy/ops-deploy.sh#L294-L363)). |

- Promotion/restart and standalone merge-gate durations were not isolated in receipts. `ops-restart.sh` SSM limit is a timeout ceiling, not a likely-duration estimate. Do not add it to the 5m19 deploy step sum.

## MIN FILING PATH

1. In `VoucherFindCard`, add editable surname + arrival, seeded from usable extraction; show when missing/conflicted. **~15–25 LOC.**
2. Reuse `searchRequestFor`; explicit Search. Scope jobs/results by source hash, message/attachment identity, selection epoch, and submitted criteria. **~15–25 LOC.**
3. Render selectable HMS rows; require one explicit choice, then reuse `findRequestFor` to resolve exact confirmation/arrival/surname. No auto-pick. **~20–30 LOC.**
4. Invalidate old row/detail/preview on source or criteria change; freeze inputs during bind and while pending/unknown/persisted. Use existing Filing preview/bind and server readback guards. **~10–20 LOC.**
5. **Total: ~60–100 product LOC**, mainly `voucher-find-card.tsx` + `booking-voucher-card.tsx`; no parser/backend search engine. Existing plan expects zero new tests; prove installed fake PDF upload plus fresh Documents readback, not just preview/bind ([plan:173–187,205–210](/home/ubuntu/projects/zero/docs/plans/2026-11-04-001-feat-m1-recovery-plan.md#L173-L210)).

## RELEASE: KEEP vs CUT

| KEEP | CUT |
|---|---|
| Exact clean-main/bundle SHA; HOLD; deploy lock; compatible DB; preserve unrelated env; final process/effective-env audit. | Joint Create+Attach promotion as a Filing prerequisite; fresh Create when a verified fake stay already exists. |
| One independent final-diff review; resolve P0/P1; affected existing checks on final source; merge exact reviewed head. | New test corpus or repeated full checks for unchanged code; plan says zero new tests. |
| Genuine per-workflow exact-HRCEN/final-SHA canary on transition; installed fake Create readback and fake PDF Documents readback; final-SHA live capability check. | Fabricated token, manual-only upload counted as Nava Filing, or re-canary demanded by writer on every deploy while flag stays on. |
| `--m1-only` writer + `ops-restart` + all-four-process health/env audit. One bundle when ready slices coincide; ship earlier ready slice independently. | New rollout wrapper or duplicate deploy of identical SHA for ceremony. Keep the private wrapper’s env-preservation checks if useful, but remove its unrelated-workflow dependency. |
