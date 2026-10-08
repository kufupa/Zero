# Luna v4 pilot: morning handoff (2026-10-08)

Final state at 06:48 UTC. Prod HEAD **`f80777c0`** (morning wave 6, PR #47), health green, deploys frozen. Call 08:00 UK = 07:00 UTC.

Pilot docs: [staff guide](../../pilot/2026-10-08-staff-guide.md) · [install + onboarding](../../pilot/2026-10-08-install-and-onboarding.md) · [call script](../../pilot/2026-10-08-call-script.md)
PRs tonight: [#37](https://github.com/kufupa/Zero/pull/37) · [#38](https://github.com/kufupa/Zero/pull/38) · [#39](https://github.com/kufupa/Zero/pull/39) · [#40](https://github.com/kufupa/Zero/pull/40) · [#41](https://github.com/kufupa/Zero/pull/41) · [#42](https://github.com/kufupa/Zero/pull/42)


## 0. Morning sprint (Plan v5, 05:50–06:48 UTC)

| Item | Result |
|---|---|
| **Change/cancel: find by guest name** (89% of change emails have no HMS number) | ✅ LIVE. Prefilled surname + dates → "Search HMS" → pick the booking. Prod smoke: found the lab booking in 30s. Number-only refs are tried as `<n>-1`. |
| **Dinner-B&B under BAR** (HMS has no BAR dinner rate; only Government has NGOVDB) | ✅ LIVE. Clear "no rate for this meal plan" message + one-click "Quote as B&B + dinner allowance". The PDF is blocked until staff enter the allowance. |
| **Quote ~44s faster** (`QUOTE_TRACE_ASYNC`) | 🟡 Deployed **OFF**. Review: don't switch it on during the call (screenshot/PDF client timeouts). Turn on after the call, once the timeouts are raised. |
| **Agency/company picker** (party on 70% of quotes) | ❌ Not shipped. Draft PR #48. Live party lookup for "Tourvest Travel Services" / "Tourvest" returned `no_match`. Next: find which HMS profile type and search these agencies live under. |
| Installer SHA-256 | ✅ `e5e8a99b89f77aa2b88b933e249598afcfd7073c029bfa6ffadb070e9b07b5df` (in the install doc) |
| Live API checks | ✅ Tell Luna corrected the dates; Treat-as quote/booking switched the workflow |
| Multi-room quotes | ✅ 2 rooms B&B quotes fine (live). Only dinner under BAR failed (now handled). |

## 1. TL;DR

- **Biggest catch of the night:** staff HMS quotes from the pane had **never worked on prod**. The server path had never run there before (0 workflow runs). An HMS menu race failed every quote at about 30s. Fixed in #40 and proven end to end on prod: quote ready in about 2 min (120–135s), screenshots, valid PDF.
- **Live and smoke-tested on prod:** instant pane (warm cache, 9–21ms), change/cancel detection plus "Find this booking in HMS" (27s), staff quote → screenshot → PDF, HMS queue line.
- **Built but OFF:** the bot books / cancels in HMS. Lab-proven with Labtest `61143613-1` (created, found, cancelled, read back Cancelled). Flag `RESERVATIONIST_PANE_SAVE` unset.
- **Do first:** rotate the prod DB credential `zero_admin` (see 2.1).
- **Not shipped:** agency/company rates (HMS can't resolve free-text names), quote speed-up (flagged branch), booking-code mining, Outlook colours, chatbot, venue quotes.

## 2. Do before the call

1. **Rotate `zero_admin` (prod DB).** At about 01:10Z a psql error printed `DATABASE_URL` into SSM command-output history. Treat it as exposed.
   - Rotate the password → update `DATABASE_URL` in `/home/ubuntu/repos/zero/apps/server-pilot/.env.production` → `pm2 restart all --update-env` → check `/health` on 8788 and 8789.
   - Not done overnight: rotating a prod credential while unattended risked an outage right before the call.
2. **Classic Outlook only** on staff PCs. New Outlook can't load the add-in.
3. **Installer 1.0.14:** `https://nava.legacyhotels.co.za/download/NavaOutlookSetup.exe`. Close Outlook first. Edge: Keep → Keep anyway. SmartScreen: More info → Run anyway, only if IT approves.
4. **Device code, one per Windows user.** You run `outlook-device-operator.ts issue` (see the install doc). It expires in 10 min.
5. **One quote at a time on the call.** HMS runs one job at a time, about 2 min each. Other staff see "1 quote ahead of yours".
6. **Fill the placeholders** (names/phones) in the 3 pilot docs.

## 3. Live on prod, with proof

| Feature | Staff see | PR | Prod proof (UTC) |
|---|---|---|---|
| Sign-in fix | Light sign-in, visible password toggle | #36 (W1) | Health ok, pane 200 |
| Tell Luna / Treat-as fixes | Edits kept, overrides work when AI is down | #37 | Tests + Greptile |
| Booking copy buttons | Copy per field, HMS order | #37 | Bundle strings |
| **Instant pane** | Badge + prefill already there on click | #38 + #39 backfill | 03:44: 5 newest emails 9–21ms (cache hits); backfill 150/150 warmed |
| **Change / Cancel** | Badge "Change to booking"/"Cancellation"; click "Find this booking in HMS" (about 30s) → stay + screenshot; arrival-mismatch line | #38, #40, #42 | 04:58: server findStay → found, all fields, 27s, screenshot |
| Agency ref guard | "That's the agent's reference, not an HMS number" | #40 | Live amend had `####SH######` → now handled |
| **Staff quote → PDF** | Run → queue/progress → "See what Luna did in HMS" → PDF → Insert draft | #38, #40, #41 | 04:30 + 04:58: ready 120–135s, 7 screenshots, PDF 1.89MB valid |
| HMS queue line | "1 quote ahead of yours, about N min" / step line | #38 | 04:58: waiting → running observed |
| Multi-date | Each date option + "Create one reply with all date options" | #38 | Tests only (no live 2-date run) |
| Plain-English copy | Labels, hints, waits, errors | #38, #41 | 171 strings |
| Installer pin 1.0.14 | n/a | #38 | CI contract tests green |

**Known quote limit:** 2 rooms + dinner-B&B returned `native_quote_capture_scope_or_completeness_invalid`, so HMS couldn't price that combo. Staff now see "HMS couldn't price this exact combination… try one room type or B&B first, or quote in HMS" (#41).

## 4. Built but OFF (flag `RESERVATIONIST_PANE_SAVE` unset)

- **Bot books it:** Preview (fill + check availability + screenshot) → Book in HMS (waits for the conf number; never shows "failed" if HMS may have saved).
- **Bot cancels it:** Preview (reads the reasons list and any penalty) → Cancel (never accepts a penalty dialog; polls the status).
- **Lab proof, live HMS, via the same CLIs the server spawns:** Labtest `61143613-1` created 01:06 → found → cancel preview (13 reasons, no penalty) → cancelled 01:45 → read back Cancelled, balance 0.00. Lab stays open: **0**.
- Guard in code: only guest `Labtest` + arrival ≥ 2027.

**Answer before switching on for real guests:**
1. `createdBy = NAVAAI`: is the hotel OK with bot attribution?
2. Does HMS auto-email the guest on Save? Not checked.
3. Who handles cancellation penalties? The bot always stops at them.
4. Run Preview → Book once through the pane on a lab stay.

**Switch on:** add `RESERVATIONIST_PANE_SAVE=on` to `.env.production` → `pm2 restart http --update-env`. To switch off, remove the line and restart.

## 5. Not done / parked

| Item | Why | Next |
|---|---|---|
| Agency/company rates (`feat/luna-v4-a`) | Live run: "Tourvest Travel Services" → `CONTEXT_INPUT_GAP`, not unique in HMS | Agency picker with the exact HMS profile |
| Quote speed −44s (`QUOTE_TRACE_ASYNC`, `feat/luna-v4-d`) | Untested live; PDF timeout risk | Test with the flag on in a quiet hour |
| Prompt: confirmation = hotel number only (`7bcc198e`, reverted) | Would have thrown away the 150-entry warm cache the night before | Ship with the next census run |
| Smoke runner script (lane D) | Agent overran; stopped | The manual smoke in §6 is the record |
| Greptile P2s | #39 help text / exit code; #40 menu-retry tests, default reader detail; #42 cancel failure logging | Small follow-ups |
| Booking-code mining, Outlook colours, chatbot, venue quotes, HMS concurrency | Out of scope tonight | — |

## 6. Smoke results (prod, real HMS)

| Check | Result |
|---|---|
| Health / PM2 / VPN | ✅ a19a260b |
| Warmed first click | ✅ 9–21ms, source luna |
| Amend detection | ✅ 8 amend + 1 cancel in last 120 inbound |
| Find booking (server route) | ✅ found 27s, screenshot |
| Staff quote | ✅ ready 120–135s (×4 runs) |
| Quote screenshot | ✅ 39KB |
| Quote PDF | ✅ valid, 1.89MB |
| Queue status | ✅ waiting → running |
| 10+ room group / 2-date / Tell Luna / Treat-as via pane | ⚪ not run live (unit/integration tests only) |

## 7. Timeline (UTC)

| Time | Event |
|---|---|
| 23:15 | Start; 4 Haiku lanes |
| 00:50 | W1 live (#37) |
| 01:06–01:45 | Lab book + cancel proof |
| 02:52 | W2 live (#38) |
| 03:30 | W3 live (#39); backfill 150 warmed by 03:43 |
| 03:46 | Smoke: quote fails (P0) |
| 04:10 | Root cause: HMS menu race; path never ran on prod |
| 04:17 | W4 live (#40); quote works 04:22 |
| 04:31 | Smoke: find fails (no browser env for pane tools) |
| 04:55 | W5 live (#41, #42); everything passes 04:58 |

## 8. Risks + rollback

- One HMS browser for everything: quotes and lookups queue (lock waits 20s, then "HMS is busy").
- `hms-ai-worker` is off by design. Not needed: all HMS work uses the borrowed-Chrome scripts.
- Warmer: on for new mail, 60/h cap. **Proven live:** 10 of 12 overnight emails warmed automatically (`luna_warm_ok` is in the rotated `ai-worker-out-*.log` files; `pm2 logs` only shows the current process). Backfill re-run at 05:00 (2 new) and again at about 06:30 for morning mail.
- `launch-readiness NOT_READY outboundBacklogEmpty` is pre-existing; every deploy exits 1 at that check after a successful restart.
- Before every deploy: `ssm-run-command.sh 'chmod u+w /home/ubuntu/repos/zero/.husky/_/h'` (husky EACCES hit once).
- **Rollback** (Runbook D): `git branch -f rollback/<SHA> <SHA>` → `GIT_BRANCH=rollback/<SHA> bash apps/server-pilot/deploy/sync-ec2-git-bundle.sh` → deploy-ec2 via SSM. Targets: `f80777c0` (now) · `a19a260b` (05:00) · `2ef04602` (W4) · `586a81c8` (W3) · `2d6ff252` (W2) · `8e572b17` (W1) · `b22ece75` (before tonight; **quotes broken there**).
- Housekeeping: remove the overnight Stop hook (`.claude/settings.local.json` + `.claude/hooks/` in the centurion-dashboard-tools worktree).
