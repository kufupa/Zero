# Luna v4 pilot: morning handoff (2026-10-08)

Snapshot: ledger last entry 03:35 UTC, written 03:38 UTC. Prod HEAD `586a81c8` (W3). Smoke 06:00–06:50 UTC. Call 08:00 UK = 07:00 UTC.

Sources: [ledger](/home/ubuntu/projects/zero/.worktrees/centurion-dashboard-tools/.superpowers/sdd/luna-v4-progress.md) · [plan](/home/ubuntu/projects/zero/.worktrees/centurion-dashboard-tools/docs/plans/2026-10-08-001-luna-plan-v4-overnight.md) · [ops sheet](/home/ubuntu/projects/zero/.worktrees/centurion-dashboard-tools/.superpowers/sdd/luna-v4-ops.md) · briefs in `/home/ubuntu/projects/zero/.worktrees/centurion-dashboard-tools/.superpowers/sdd/briefs/` · [call script](../../pilot/2026-10-08-call-script.md) · [install + onboarding](../../pilot/2026-10-08-install-and-onboarding.md) · [staff guide](../../pilot/2026-10-08-staff-guide.md) · PRs [#37](https://github.com/kufupa/Zero/pull/37) · [#38](https://github.com/kufupa/Zero/pull/38) · [#39](https://github.com/kufupa/Zero/pull/39)

## 1. TL;DR

- **Live:** W1 00:50 (#37), W2 02:52 (#38), W3 03:30 (#39). Health ok after each wave.
- **Lab proof (CLI, not pane buttons):** Labtest `61143613-1` created, found, cancel-previewed, cancelled, read back Cancelled. Lab stays open: 0.
- **Book / cancel in HMS: built, OFF** (`RESERVATIONIST_PANE_SAVE` unset). Lab-only in code. Four questions to answer before turning on (section 4).
- **Blockers before the call:** rotate `zero_admin`; full SHA-256 for 1.0.14 is TBC; contact placeholders unfilled in all 3 docs; Classic Outlook and IT approval unconfirmed; Windows never tested on a real PC.
- **Clock:** 08:00 UK (BST) = 07:00 UTC. The plan's handoff (07:15) and deadline (07:30) are UTC, so they fall after the call. The founder reads at 07:30 UK = 06:30 UTC, while smoke is still running. Confirm which clock the plan meant.
- **Not shipped:** agency/company rates, QUOTE_TRACE_ASYNC, booking-code mining, colour categories, chatbot, venue quotes, HMS concurrency.

## 2. Do before the call (top first)

- [ ] **1. ROTATE prod DB credential `zero_admin`.**
  - Why: a psql error printed `DATABASE_URL` into SSM command output history at ~01:10Z. Treat as exposed. Not rotated overnight (prod risk).
  - When: after the backfill finishes (`/tmp/luna-backfill.log` on EC2), before smoke at 06:00. No HMS run during a PM2 bounce (plan rule 5).
  - How: rotate the password, update `DATABASE_URL` in `/home/ubuntu/repos/zero/apps/server-pilot/.env.production` (sourced by `deploy-ec2.sh:104`), restart pm2 with `--update-env`, check `/health` on 8788 and 8789.
  - Never paste the URL into chat, tickets or docs.
- [ ] **2. Confirm Classic Outlook** on the staff PC. New Outlook is not supported.
  - Shared mailbox must be the default Drafts store, or **Insert draft in Outlook** is refused by design. If not, leave that step out of the call.
- [ ] **3. Installer 1.0.14 + SmartScreen.**
  - URL: `https://nava.legacyhotels.co.za/download/NavaOutlookSetup.exe`
  - Full SHA-256 **TBC**. Docs hold only the partial `e5e8a99b…07b5df`. Get the full value from the 1.0.14 release record. Mismatch = stop.
  - IT must approve the publisher/cert. No approval, no install on the call. Never turn off antivirus.
  - Edge: **Keep**, then **Keep anyway**. Windows: **More info**, then **Run anyway**, only after hash match and IT approval.
  - Old 1.0.11 on the PC: close Outlook and install 1.0.14 over it, or the operator disables the old client.
- [ ] **4. Device codes, one per Windows user.**
  - Operator runs `outlook-device-operator.ts issue` (install doc Part 2) with the exact StoreID from the PC.
  - One-use code, **expires in 10 min**. Give in person or by phone, never chat. If expired, issue a new one.
- [ ] **5. One quote at a time.**
  - One person clicks **Run next**. A quote takes about 5 min. A find cannot run during a quote.
  - Test emails and test stays only. Nobody presses Send. No Preview, Book or Cancel (flags off).
- [ ] **6. Pilot docs in `docs/pilot/`.**
  - Replace every `[PLACEHOLDER]` (operator, founder, IT: name and phone) in the install doc, call script and staff guide. Send the staff guide ahead.
  - Check the change panel shows no amber "not supported yet" note (install doc checklist).
  - Skim staff guide §2d and Multi-date. Greptile's last review on #38 (`46317fe9`) left a P2 on this wording. Merged with it open.
  - Install doc says build "wave 2 (`7c9a4032`) or later". Live `586a81c8` is later, so it passes.

## 3. What's LIVE on prod

| Feature | What staff see | Wave / PR | Proof |
|---|---|---|---|
| Sign-in fix | Light sign-in shell, visible show-password toggle. Sign in → Confirm Account & Connect → Run system check | #36 (merged 22:58Z) → live W1 00:50 | Health ok, /outlook-pane 200. No real-PC test yet |
| Tell Luna / Treat-as fixes | Tell Luna re-read keeps staff edits. "This is a quote request" / "This is a booking" work | W1 #37, 00:50 | Router 36/36, session + booking-card 101/101. Greptile 5/5 |
| Booking copy buttons | Copy per field, in HMS Guest Stay order | W1 #37, 00:50 | Booking-card tests. Copy strings in bundle |
| Instant pane (warmer + backfill) | Results already loaded when staff click | W2 #38 (warmer, 02:52). W3 #39 (backfill script, run 03:32) | **Not yet proven.** 0 warm log lines at 02:52. Backfill result not in ledger; 63 cache files at 03:34. Warmer flag is committed in `pm2.config.cjs` |
| Change/cancel badge + "Find this booking in HMS" | "Change to booking" / "Cancellation" badge. Find takes 1–2 min, read-only, with screenshot and arrival-mismatch line | W2 #38, 02:52 | Live on Labtest `61143613-1`: 01:43 (57 s, all fields); 02:04 arrival-hint (60 s) |
| HMS queue / progress | "1 quote ahead of yours, about N min", step line, "HMS not responding" | W2 #38 | Unit tests (queue 11). Not seen live |
| Quote screenshots | "See what Luna did in HMS" | W2 #38 | Unit tests (screenshot 9). Not seen live |
| Multi-date + combined reply | Date options, one PDF per option, "Create one reply with all date options" | W2 #38 | F7 tests: 12 new + 63 pass. **No live 2-date run** |
| Clarity copy | Plain labels, hints, waits, error next steps | W2 #38 (F15 `2c396ef9`) | 171 strings, no new test fails. No visual sign-off |
| Installer pin 1.0.14 | Installer NavaOutlookSetup.exe 1.0.14 | W2 #38 (vsto → 1.0.14) | CI green. Full SHA-256 TBC |

## 4. Built but OFF (flag `RESERVATIONIST_PANE_SAVE` unset)

- Flag must equal `on` exactly. Unset on prod.
- Staff see Preview / Book in HMS / Save draft (booking) and Preview cancellation / Cancel booking in HMS (cancellation), greyed out with "coming soon".
- **Lab proof** via CLI scripts on borrowed Chrome (`create-lab-stay.mjs`, `stay-lookup.mjs`, `cancel-stay.mjs`). The pane buttons were not clicked live.
  - Create: Labtest `61143613-1`, 12–13 Oct 2027, saved ~01:06Z. `createdBy = NAVAAI`.
  - Found: 01:43, 57 s, all fields.
  - Cancel preview: 01:43, 73 s, 13 reasons, no penalty, no click.
  - Cancel commit: 01:45. Separate find reads back Cancelled, balance 0.00. The script's own readback was too fast and labelled `cancel_unconfirmed`. Polling fix merged in W2, no re-run in the ledger.
  - Earlier misses, fixed: create readback mislabelled `save_failed` (now `save_unconfirmed`, 90 s wait). 01:10 cancel preview `not_found`.
- Other lab stay `57291630-1`: already Cancelled (F11, 23:47, no write).
- **Lab guard in code:** lastName `Labtest` and arrival ≥ 2027-01-01 (`pane-stay-save.ts`). Flag on does not open real guests. Real-guest writes need a code change and your approval.

**Answer before turning on:**

1. **Audit attribution:** lab writes show `createdBy = NAVAAI`. HMS audit names a system user, not the staff member. Accept it, or add attribution first (code change).
2. **Auto-email to guest: not checked.** Nothing in the ledger shows HMS sends no mail to the guest after Save. Check with a mailbox we control.
3. **Cancellation penalties: the bot never accepts one.** A penalty stops the run, and a human must cancel in HMS. Decide that staff process.
4. **Duplicate check on Commit:** CLI search, fail-closed (PR #38). Not run live through the pane. Prove it on a lab stay first.

**How to turn on (only after the 4 answers):**

1. Add `RESERVATIONIST_PANE_SAVE=on` to `/home/ubuntu/repos/zero/apps/server-pilot/.env.production` on EC2. It is not in `pm2.config.cjs`, so the env file is the place. Any other value = off.
2. `set -a; . /home/ubuntu/repos/zero/apps/server-pilot/.env.production; set +a; pm2 restart http --update-env`. http only (same `--update-env` idea as `deploy-ec2.sh:111`). Not during a quote run.
3. Verify: `/health` ok, and Preview is enabled on a lab booking only.
4. To turn off: remove the line, repeat step 2.

## 5. Not done / parked

| Item | Reason |
|---|---|
| Agency / company rates (`feat/luna-v4-a` 9847ab72..bdc543ff, not shipped) | Live run 03:05 with a real agency name: `CONTEXT_INPUT_GAP`, "did not resolve uniquely", 176 s. HMS cannot resolve free-text names. Public-rate fallback roughly doubles quote time. Next: agency picker with exact HMS profile |
| QUOTE_TRACE_ASYNC (`feat/luna-v4-d` e48ef1e4, flag off) | Saves ~44 s p50 per quote (trace stop + sanitize). Untested live. PDF 60 s client-timeout risk. Bigger lever is the public reset: 96 s p50 (40% of quote time). That needs HMS and product sign-off |
| Booking-code mining (H1) | Root cause unknown. H1 burned 4.4× its timebox. Staff pick codes by hand |
| Outlook colour categories | Needs a new installer, so SmartScreen risk again. 2–4 h |
| Chatbot | 1–2 d. Tell Luna covers ~80% |
| Venue / conference quotes | 2–4 d plus rate cards. Client data needed |
| HMS concurrency | Needs a second HMS user. Client question |
| Greptile P2s, PR #39 | (a) help text shows `node dist/…js`, which is not built. Use `pnpm exec tsx scripts/luna-warm-backfill.ts`. (b) exit code 0 even when every warm fails. Read the counts in the log |
| Also not started | F5c amend write tool (after F5b proof, ~3 h + lab). F8 multi-ask checklist. F10 auto-start quote (flag off). X5 pre-run quotes (TTL/token conflict). X9 quote TTL 15m→3 h (client decision). Smoke runner (lane D) not shipped, so smoke is manual |

## 6. Planned vs actual times (UTC)

| Item | Planned (plan) | Actual (ledger) | Result |
|---|---|---|---|
| V0 preflight | 23:45–00:00 | 23:15–23:22 | Early |
| F1 server / pane; F3 copy | 00:00–00:50 (est 45 m / 40 m) | 23:29 / 23:36 | Shipped W1 |
| F14 vsto 1.0.14; cancel-stay.mjs | 00:00–00:50 (est 10 m) | 23:47 | Shipped (pin in W2) |
| F11 lab cancel | 00:00–00:50 (est 20 m) | 23:46–23:47, no write | Already Cancelled |
| W1 gate | ~01:00 | Merged 00:46, live 00:50 (deploy #1 failed, husky EACCES) | Live |
| F4 warmer | 00:50–01:15 (est 1 h 30) | Code 00:01 | Live W2 02:52 |
| F5a find | 01:15–03:15 (est 2 h 30) | Server 00:17, pane 00:33, live find 01:43 | Live W2 |
| F5b cancel tool | W3 (est 2 h + lab) | Code 00:09, pane 00:46 | In W2, flag off |
| F6 queue | W2 (est 1 h) | Server 00:02, pane 00:47 | Live W2 |
| F7 multi-date | 03:30–05:00 (est 1 h 30 + live) | Phase 1 00:28, phase 2 00:54 | Live W2, no live 2-date run |
| F9 book / cancel code | W3 (est 2 h + lab) | Server 00:24, pane 00:46, cancel grant 00:55 | Live W2, flag off |
| F13 docs | 01:15–03:15 (est 30 m) | 00:59; refreshed 02:21 | Done |
| F15 clarity | W2 (est 1 h) | 00:18 | Live W2 |
| X3 quote speed | Timings in smoke only | Report 01:03 | Report only, no fix |
| Lab proof (create + cancel) | W3, after F11 path | Create ~01:06, cancel 01:45 | Done; several script misses fixed on the way |
| W2 gate | 03:15–03:30 | Merged 02:49, live 02:52 | ~40 min early |
| W3 gate | 05:00–05:15 | Merged 03:26, live 03:30 | ~1.5 h early |
| Backfill run | ~05:30 | Started 03:32 | Running at ledger end |
| Smoke | 06:00–06:50 | — | Pending |
| Handoff | 07:15 (plan clock) | This draft 03:35 | See clock flag (section 1) |

## 7. Known risks for tomorrow

- **hms-ai-worker is off by design.** Only `ops-hms-shadow.sh` starts it (own Chromium and login, session-kick risk). Find and quote use the borrowed-Chrome CLI path. The worker queue path would hang.
- **Lookups and quotes share one HMS browser.** Property lock. A find waits 20 s, then says "HMS is busy… try again in a minute".
- **Warmer cap 60/h**, queue ≤50.
- **launch-readiness NOT_READY `outboundBacklogEmpty`** (pre-existing). The deploy script exits 1 before the VPN assert. Run Runbook C by hand.
- **Luna census** vs current main (00:50): quote 95, booking 52, amend 72, cancel 22, invented 0. Gate passed on judgment. Baseline census-v2 is stale.
- **Windows and Classic Outlook never tested** on a real PC (install doc, gap 7).
- **Backfill:** started 03:32 on EC2, log `/tmp/luna-backfill.log`. Its exit code is 0 even on failures (PR #39 P2). Read the counts in the log. The ledger has no result.
- **`briefs/smoke-method.md` is stale** (written 01:08, before W2). Its NOT_DEPLOYED list and `8e572b17` state no longer apply. Head is `586a81c8`.
- **Old lab stay `46184891-1`:** cancelled earlier, penalty posting unknown (ops sheet §4). Not tonight. Check in HMS.
- **Overnight Stop hook** still installed (`.claude/settings.local.json`, `.claude/hooks/`, untracked in centurion-dashboard-tools). Remove after the run.

## 8. Rollback

Runbook D from the ops sheet (§1). Substitute `<SHA>`.

| Target | SHA | Live since | What it contains |
|---|---|---|---|
| Current | `586a81c8` | 03:30 | W3 (#39): backfill script |
| W2 | `2d6ff252` | 02:52 | #38: instant pane, amend/cancel, queue, multi-date, gated writes |
| W1 | `8e572b17` | 00:50 | #37: Tell Luna fixes, booking copy (sign-in #36 included) |
| Before tonight | `b22ece75` | Prod at 23:00 | PR #35. Ops-sheet example uses `6462ab1f` (its parent), one step further back |

```bash
cd /home/ubuntu/projects/zero/.worktrees/recover-parse-failure
git branch -f rollback/<SHA> <SHA>
bash apps/server-pilot/deploy/ssm-run-command.sh 'chmod u+w /home/ubuntu/repos/zero/.husky/_/h'   # ledger 00:47: do this before every deploy
GIT_BRANCH=rollback/<SHA> bash apps/server-pilot/deploy/sync-ec2-git-bundle.sh
bash apps/server-pilot/deploy/ssm-run-command.sh 'export NVM_DIR=/home/ubuntu/.nvm; . $NVM_DIR/nvm.sh; export PATH=$HOME/.local/share/pnpm:$PATH; cd /home/ubuntu/repos/zero && bash apps/server-pilot/deploy/deploy-ec2.sh'
```

- Verify with Runbook C (ops sheet §1): `8788` and `8789` health, public `/health`, `/outlook-pane` 200, pm2 status, `vpn-health-assert.sh`.
- If health fails: stop deploys. No migrate, wipe or Vitest.
- Code rollback only. No migrations in W1–W3 (PR bodies). HMS has nothing to undo (lab stays already Cancelled).

## Smoke results (06:00 UTC)

_Placeholder. Fill during the smoke window (06:00–06:50 UTC). Check the NOT_DEPLOYED list in `smoke-method.md` against `586a81c8` first._

| Check | Result | Notes |
|---|---|---|
| Normal quote | | |
| 10+ room group quote | | |
| 2-date quote | | |
| Amend email → find shows stay | | |
| Treat-as | | |
| Tell Luna | | |
| Warmed first click under 1 s | | |
| Extras PDF | | |
| Re-quote | | |
| Booking copy | | |
