# Luna Plan v4.1: feature-complete MVP overnight for the Oct 8 reservationist call

Status: DRAFT, awaiting user go. Orchestrator: Claude Code, Opus 5.5. Revised 2026-10-07 ~23:35 UTC after user feedback ("build features, not a testing night").

## Goal

Cover every staff email type with a working pane flow by morning:
- Quotes: single, multi-date, group rooms.
- Bookings: one-click copy.
- Amendments and cancels: auto-find the reservation.
- Plus an instant pane, a visible queue, and a clean sign-in.

Testing is a TDD part of each item, plus one combined prod smoke at the end. There is no separate "testing phase".

## Window (UTC; BST = UTC+1)

- T0 is about 23:20 UTC. The hard deadline is **07:30 UTC** (user confirmed at 23:15).
- 3 deploy waves, each Runbook B (about 5 min, background): W1 about 01:00, W2 about 03:30, W3 about 05:45.
- Freeze at 06:00. Combined smoke 06:00–06:50. Handoff and `HANDOFF_DONE` at 07:15. The 07:15–07:30 buffer is for the ladder only (no deploys).
- Where the timeline table below says 05:15 / 05:30 / 06:30 / 06:45, shift those wave, freeze, smoke and handoff times later to match. The extra ~45m goes to W3 features.
- Stop guard: `.claude/settings.local.json` Stop hook (`.claude/hooks/overnight-stop-guard.sh`) blocks stopping before 07:30 UTC unless the ledger has `HANDOFF_DONE` or `.superpowers/sdd/luna-v4-wait-until` holds a future epoch. Remove it after the run.
- Rollback: Runbook D to the last green sha.

## Starting state (verified 22:40–23:05 UTC)

- **Prod:** `b22ece75` (#35). Health ok. `RESERVATIONIST_PANE_SAVE` is unset. Luna is on.
- **Already shipped from v3:** H2 Treat-as, H3 group routing, H4 Tell Luna, H5 click-cache, and H8 Preview/Commit (server code only).
- **Installer:** 1.0.14 is hosted. PR #36 (sign-in) is open, with uncommitted changes in the `outlook-pane-signin-fix` worktree.
- **Open bot P1s:**
  - `session.ts:553`
  - `pane-stay-save.ts:94`
  - `quote-workflow.ts:295–306` (×3)
  - The r1 cache-poison P1 is already fixed.
- **Lab stay:** `57291630-1` is still Reserved. H1 reader parked.

## Every candidate, by ROI (volume/day from the ~10-day census)

Estimates are wall-clock including TDD and Haiku review. v3 code ran 3–6 min of agent time per feature, so estimates are mostly integration + test time.

| # | Item | Origin | Volume/day | Value | Est | Decision |
|---|---|---|---|---|---|---|
| F1 | Fix 4 reachable bot P1s (Tell Luna edits lost; fallback Treat-as broken ×2; note mixes dates) | NEW (v3 left them) | every Tell Luna / Treat-as | Demo features don't break | 45m | **DO, W1, P0** |
| F2 | Sign-in fix #36 (light theme, visible toggle) | NEW | every user | First screen | 20m | **DO, W1, P0** |
| F3 | Booking card one-click copy, in HMS Guest Stay field order | NEW | bookings ~10 | Copy-paste → 1 click per field | 40m | **DO, W1, P1** |
| F4 | Instant pane: cache warmer on live admission (same analyse path + cache key) | NEW (cheap L2) | all ~150–180 | "Instantly loaded" vision | 1h30 | **DO, W2, P0** |
| F5a | Amend/cancel **find** (read): Luna `workflow=amend\|cancel` + conf no. / guest+dates → pane runs `hms_find_reservation` (deterministic Playwright, audited, screenshot) → current stay next to the requested change | v3 M2 (upgraded) | amend ~10 + cancel 1.7 = **biggest bucket** | Staff skip the HMS lookup | 2h30 | **DO, W2, P0**. Prompt change gated by census regression |
| F5b | **Cancel tool** (write, deterministic Playwright like quote/create): Preview = find → open → Cancel dialog → read penalty (e.g. R2,060) + reason list → screenshot → stop. Commit = staff-chosen reason + penalty decision → cancel → readback "Cancelled" | NEW | cancels ~1.7 | Also our lab cleanup path (needed for F9) | 2h + lab | **DO, W3, P1**. Lab-only guard; real-guest flag off |
| F5c | **Amend tool, dates/nights only** (write): Preview = new dates filled + Check Availability + rate diff + screenshot. Commit = save + readback | NEW | part of amend ~10 (mix unknown) | Most common amend guess | 3h + lab | **STRETCH**: only after F5b is lab-proven. Haiku job tonight: census breakdown of amend types to pick the next amend tool |
| F6 | HMS queue/progress: position, ETA, "HMS down" state | v3 M4 | all quote runs (~16) | Call-day pile-up | 1h | **DO, W2, P1** |
| F7 | Multi-date quotes: ≤5 serial date options → one PDF | v3 M1 | ~0.3–0.9 quotes | Complete quote coverage | 1h30 + 1 live | **DO, W3, P1** |
| F8 | Multi-ask checklist: an email with quote + booking (or 2 stays) shows ordered tasks, each with its own Run | ADHD-chat D/E | unknown, small | Perfect-desk flow | 1h30 | **STRETCH, W3** |
| F9 | **Bot books it:** pane Preview (fill + Check Availability + screenshot) → staff review → Commit (Save, return conf no.). Duplicate check runs through the live-proven `hms_find_reservation` facade shared with F5, not the broken H1 script. Lab-proven on ≤2 Labtest stays, **only if F11 proves the cancel path first** | v3 H8 + ADHD "copy-paste unacceptable" | bookings ~10 | Replaces copy-paste | 2h + lab | **DO, W3, P0-code / P1-lab-proof**. Real-guest flag stays OFF until the user watches the lab proof and approves in the morning. F3 copy buttons stay as the fallback while the flag is off |
| F10 | Auto-start quote on open when fields are complete and confident | v3 M5 | quotes ~6.5 | Saves 1 click + wait | 1h | **STRETCH, flag off** |
| F11 | Lab stay `57291630-1` cancel (1 try, 20m) | v3 H7 leftover | — | Hygiene | 20m | **DO, HMS lane** |
| F12 | Group 10+ room live proof | v3 H3 live | groups ~1.4 | Proof | in smoke | **DO, in smoke** |
| F13 | Morning pack: install sheet, device-code steps, "what Luna does" card | NEW | — | Smooth call | 30m | **DO (Haiku)** |
| F14 | `vsto` submodule bump to 1.0.14 + ledger | NEW | — | Records | 10m | **DO (Haiku)** |
| X1 | H1 reader + 182 reads + H6/C1 code mining | v3 H1/H6 | — | Blank code dropdowns get defaults | 2h+ (2h13 already sunk) | **CUT**. Root cause unknown; staff pick codes themselves |
| X2 | H7 auto-email check | v3 H7 | — | Gates the morning flag flip | 0 extra | **RESTORED into the F9 lab proof**: Labtest guest email = a mailbox we control; check whether HMS sends anything after Save. The folio penalty is answered by F5b Preview |
| X3 | Quote-speed fix (4m35s) | v3 M3 | quotes | Big UX | 30m profile + risky fix | **CUT the fix**; record phase timings during smoke only |
| X4 | Outlook colour categories in the inbox list | v3 L4 | all | Nice | 2–4h + new installer | **CUT** (new installer = SmartScreen risk again) |
| X5 | Pre-run quotes at ingest | v3 L3 | quotes | — | 4–6h | **CUT** (TTL/token conflict; burns the serial lane) |
| X6 | Full chatbot | v3 L6 | — | Tell Luna covers 80% | 1–2d | **CUT** |
| X7 | Venue/DDR quotes, HMS group blocks | v3 L5 | ~2.1 | — | 2–4d + rate cards | **CUT** (client data needed) |
| X8 | HMS concurrency | v3 L7 | — | — | needs a 2nd HMS user | **CUT** (client question) |
| X9 | Quote TTL 15m → 3h | NEW | — | Reuse prior quotes | 10m | **CUT** (needs user/client decision) |

Totals:
- **DO = 14 items, about 10h of work.** Across 3 parallel Haiku lanes that is about 4h wall, plus waves and smoke.
- **STRETCH = 3.** **CUT = 9** (each cut item names its blocker).

## Lanes (file ownership, no overlaps)

| Lane | Owns | Items in order |
|---|---|---|
| A, server (Haiku max) | `apps/server-pilot/src/trpc/routes/quote-workflow.ts`, `src/ai/*`, ingest hook, census script | F1 server → F4 warmer → F5 server (prompt + find enqueue) → F7 server (multi-date) |
| B, pane (Haiku max) | `apps/mail/lib/quote-workflow/*`, `apps/mail/components/**/quote-workflow*`, booking card, `outlook-pane/*` | F1 `session.ts` → F3 copy → F6 queue UI → F5 pane (stay vs change view) → F7 pane → F8/F9 |
| C, tooling/ops (Haiku max) | `apps/server-pilot/src/hms/*` lock-status endpoint, `vsto` submodule, docs | F14 → F6 server (queue status API) → F13 docs → F10 |
| Orchestrator (Opus) | merges, Greptile, deploys, sole CDP owner | F2 #36, F11, wave gates, live proofs (F5 find, F7 2-date, F12), smoke |

## Timeline (UTC)

| Time | A | B | C | Orchestrator |
|---|---|---|---|---|
| 23:45–00:00 | — | — | — | preflight: ledger, worktrees, HMS + tunnel up, park v3 leftovers |
| 00:00–00:50 | F1 | F1, then F3 | F14, then F6 api | F2 #36; F11 lab cancel |
| 00:50–01:15 | F4 | F3 | F6 api | **W1**: review, Greptile, merge, deploy (F1 F2 F3) |
| 01:15–03:15 | F4 → F5 | F6 → F5 pane | F13 drafts | live F5 find proof; review |
| 03:15–03:30 | — | — | — | **W2**: F4 F5 F6 (census regression must pass) |
| 03:30–05:00 | F7 | F7 → F8 | F10 | live 2-date proof; review |
| 05:00–05:15 | — | — | — | **W3**: F7 + finished stretch. Unfinished → PR only |
| 05:30–06:30 | — | — | — | combined smoke (below); rollback if red |
| 06:30–06:45 | — | — | — | handoff + morning pack |

**Combined smoke** (single pass, about 45m, serial HMS):
- normal quote
- 10+ room group quote
- 2-date quote
- amend email → auto-find shows the stay
- Treat-as
- Tell Luna
- warmed first click under 1s
- extras PDF
- re-quote
- booking copy

## Timebox policy (estimates are guesses; the deadline is not)

Each item has an estimate E and a priority.

| Priority | At 1.5×E | At 2.5×E | Never |
|---|---|---|---|
| P0 (F1 F2 F4 F5) | Progress check | Escalate (fresh Haiku with evidence → Opus slice) **and** shrink scope to the smallest shippable slice (e.g. F5 = button-triggered find, no auto). Never skip P0 | — |
| P1 (F3 F6 F7) | Progress check | Park in the "parked queue" with notes; revisit if slack | — |
| Stretch | Park | — | Never delays a wave |

- **Progress check:** is there new evidence since the last check (a new passing test, a new error class, a narrowed hypothesis)? Yes → one extension of 0.5×E. No → apply the next column now.
- **HMS live debugging:** 2 runs failing with the same error class means park. (H1 burned 4.4× its timebox on this.)
- **Deadline-driven cut line:** at each wave gate, recompute the slack to the freeze. If negative, drop the lowest-ROI remaining items first. Freeze and smoke times are fixed.
- **Parked queue** gets worked in ROI order whenever a lane is idle. Nothing is silently dropped; every park is logged.

## Model routing

User facts:
- Only **Opus 5.5** and **Haiku 5.5** are available. There is no Sonnet.
- Input cost is **$4 vs $0.10 per MTok, about 40×**.

So Opus tokens are the budget to protect, and Haiku does everything that isn't a judgement call.

| Role | Model |
|---|---|
| All implementation, tests, Greptile triage, log/terminal digests, file reading for the orchestrator, docs, census jobs | **Haiku 5.5 max**, `isolation: worktree` for editors, tight briefs (owned files, acceptance test, vitest-safety unset, commit-only, no push/deploy) |
| Escalation step 1 | Fresh Haiku 5.5 max with the failure evidence + narrowed scope (a new context often fixes a stuck one) |
| Escalation step 2 (P0 only, or 2 Haiku failures) | Opus 5.5 subagent, scoped to the single failing slice |
| Orchestrate, merge, deploy, HMS live runs, 1 fresh-context diff review per wave (3 total) | Opus 5.5 |

**Opus-lean rules for the orchestrator:**
- Never read big files or logs directly; a Haiku digest returns conclusions.
- Briefs and handoffs go through files, not pasted context.
- No Opus polling loops: background agent notifications or `/loop` heartbeats (1200s+) only.

## Clarity standard (applies to every pane change; user: staff are slow to pick things up)

Reference: [demo pane](https://hermes.trynava.io/designs/outlook-side-pane-demo.html). It has explicit steps, live status, a source tag on each value ("2 Nights (Email)"), legends, and "Audit Saved → Inspect Full" screenshots.

A pane change is not Done unless all of these hold:
1. **Plain labels.** The button says the outcome ("Fix with a note to Luna"), not a feature name. A one-line hint underneath says when to use it.
2. **Every wait has words.** "Checking HMS… 2nd in line, ~6 min", "Luna is reading the email…".
3. **Every error says the next step.** E.g. "Luna couldn't read this. Click *Treat as quote* or type a note."
4. **Source on every value:** Email / Staff note / Default / HMS.
5. **Every HMS run** (quote, find, preview, commit, cancel) shows a "See what Luna did in HMS" screenshot, with full-screen inspect.
6. **Write tools** show a plain summary before Commit: "Luna will cancel 5912… for Mr X. Penalty R2,060. Nothing is saved until you press Commit."

| # | Item | Est | Decision |
|---|---|---|---|
| F15 | Clarity pass on the existing pane. A Haiku audit vs the demo + the checklist above produces a copy/label/hint/error-text diff; then implement it. No layout rewrite | 1h | **DO, W2, P1** |
| F16 | Staff guide with real screenshots of each flow (part of F13 morning pack) | +20m | **DO** |

## Keep-alive and never-idle ladder

**Mechanisms:**
- Run under `/loop` (dynamic). ScheduleWakeup fires a 1200–1800s fallback heartbeat, so a turn that ends early is resumed.
- A Stop hook blocks stopping before 06:45 UTC unless the ledger says `HANDOFF_DONE`.
- At least one background agent is always in flight.
- Ledger-first resume after compaction.

**When a lane is idle, it takes the next rung:**
1. Parked queue (ROI order).
2. Remaining stretch items (F8, F10).
3. Deepen shipped items: edge-case tests from census rows, Greptile P2s.
4. Code-only slices of cut items:
   - X3 phase-timing report
   - the dinner-allowance wording question list
5. Expand the smoke to more real census emails (read-only).

Stop only when the clock passes the deadline or the ladder is empty.

## Rules carried from the v3 retro

1. The orchestrator never codes features.
2. Ready code joins the next wave. Waves never wait on HMS work.
3. No HMS write without a proven cleanup path. No new lab saves.
4. Greptile: 1 round per wave, plus r2 only if r1 had P1s. Wait for the bot on the final commit (max 15m). Bot P1s are fixed or waived in the ledger.
5. No HMS run during a PM2 bounce. One CDP owner. Only deterministic scripts.
6. Ledger: `.superpowers/sdd/luna-v4-progress.md`, with start/end UTC per item.
7. Safety:
   - Run `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS TEST_DATABASE_URL` before every vitest.
   - No migrations, no real-guest writes, no sends, flag unset, no PII in git.
   - Greptile runs with `-b origin/main`.
8. The F5 prompt change ships only if a census regression shows quote/booking labels did not drop vs `b22ece75`. If not, F5 ships as a manual "Find reservation" button with no prompt change.

## Locked user answers

- Lab stay: the bot gets 1 try (20m), else a human cancels it.
- #36: land it.
- Warmer: all reservations mail.
- Haiku max for coding.

## Done criteria

- [ ] W1–W3 deployed, health green, shas recorded.
- [ ] Smoke list green on prod, or failing items rolled back / flagged.
- [ ] Zero open bot P1s on main, or each waived with a reason.
- [ ] Morning pack at `docs/plans/handoff-reports/2026-10-08-luna-pilot-morning.md`, with a kept/cut/parked table and planned-vs-actual times.
- [ ] Lab stay cancelled, or handed to a human with steps.
