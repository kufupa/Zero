# Overnight plan: Centurion quote pilot (2026-10-12 23:30 UTC → 2026-10-13 06:30 UTC)

Owner: Opus 5.5 orchestrator, running autonomously. The user is asleep. Live status goes in `/home/ubuntu/projects/zero/.worktrees/OVERNIGHT-STATUS-2026-10-13.md`.

## 0. Goal and done

**Goal:** tomorrow, Centurion reservationists use the pane (Outlook and webmail) to finish a real quote end-to-end. Nava has already read the email and looked up the company/agency and rates in HMS. Staff check, edit, add a special price if needed, and insert the reply with the PDF and Excel. Everything runs in the background, and the pane tells them when HMS answers.

**Done means all of these hold on prod, after the last deploy:**
1. **Quote:** live proof on at least 3 real quote threads of different shapes (company/contract rate, agency, plain BAR/walk-in). For each: party prefilled, rates priced, PDF and Excel generated, reply text ready. Webmail and the pane path both work.
2. **Rates ready on open:** for a new quote email, the party and rates jobs ran before anyone opened it (`read_tool` rows exist with priority prefetch).
3. **Amend/cancel:** the pane shows the confirmation Nava found on arrival (or a clear "not found"), plus Copy and the Booking.com chip.
4. **Needs you:** shows only mail since the pilot cutoff.
5. **UI:** design review at 360 px and 1280 px has no P0/P1 usability issues left. Every visible control works or is hidden.
6. ~~Create reservation~~ **HOLD (00:00 UTC, research):** no TEST property exists. The 'lab' is a Labtest guest on Centurion itself (HRCEN), nothing structurally keeps writes off Centurion, and the full approve→background-write path is ~690 min scaled. Not built tonight. Morning ask: get a TEST tenant/secret; then the sync path is ~198 min.
7. Merged to `main`, deployed through `ops-deploy.sh`, pm2 healthy, morning report written.

## 1. Facts this plan rests on (verified 2026-10-12 23:00–23:30 UTC, read-only)

- Prod runs `bfc45f2c976` (main #190 + store-root auto-accept). `HMS_JOB_QUEUE=on` and `RESERVATIONIST_STAFF_QUOTE_CONFIGURATION` are set for `http`, `worker` and `ai-worker`.
- Webmail goes to `remote-http` (:8789), which is **isolated by design** (no HMS keys, `write-ec2-remote-env.sh`). Every inline HMS read there fails with "borrowed CDP required". Fix: run reads as `ai-worker` jobs. Only the `HMS_JOB_QUEUE` flag is added to the remote allowlist.
- On the pane path, party search takes 10–27 s per kind and the staff quote 60–90 s, both inline.
- Prefetch `find` and `search_guest` jobs run on arrival: 52 find + 25 guest searches in 3 days, 0 failures.
- 0 Nava quote documents have ever been stored, and 0 custom-rate rows.
- Device: last handshake Oct 9 and 0 read roots, so sync starts only when staff open Outlook. Morning item, not overnight.
- The pane UI is served from our server (`apps/mail/app/(routes)/outlook-pane`), so a deploy reaches the installed 1.0.17 pane without a reinstall. Confirm the bridge version gate in the morning check.

## 2. Waves

| Wave | Window (UTC) | Work | Who |
|---|---|---|---|
| W0 | 23:28–~01:00 | **Running.** Lane A party job + prefetch + named states. Lane B staff quote as job (webmail rates). Lane C guided steps, read-only contact, HMS-done notice, dates. | Luna max ×3 (codex) |
| W1 | when each lane lands | Opus reads every diff on critical paths (`hms-jobs.ts executeHmsJob`, staff quote extraction, lock/yield). Haiku narrow review per lane (diff only, <100k). Fix P0/P1 through Luna resume or directly. | Opus, Haiku |
| W1b | ~01:00–01:45 | Merge A+B+C into `feat/quote-mvp-live`. Local gate (§4). Greptile loop (≤3, fix P0/P1 only). PR → merge to main → `ops-deploy.sh`. Prod env: add `HMS_JOB_QUEUE=on` to `.env.remote-common` (single-key edit, backup, diff), restart `remote-http`, health. | Opus |
| W1c | ~01:45–02:30 | **Live proof 1** with `nava-preview-gate.sh` on EC2. Chromium runs on EC2, **not this VPS**. 3 real quote threads, one at a time. Fix and redeploy until it passes. | Opus + Luna fix |
| W2 | from ~01:00, parallel, max 3 Luna lanes total | Lane D **rates ready on arrival**: after party prefetch, queue the staff_quote job at prefetch priority with BAR/default plan + prefetched best party, system signer; the pane shows it as "Prepared by Nava". Lane E **amend/cancel confirmation found** + Needs-you cutoff constant. Lane F **create reservation** (only if research is green): approve → background write job → screenshot review, behind `HMS_CREATE_RESERVATION` flag + test-property guard. | Luna max |
| W3 | ~03:00–04:15 | **UI review:** gstack `design-review` / `plan-design-review` against the staff rules (§6) on renders at 360 px and 1280 px. Renders through the existing shot daemon (one Chromium, serial) or on EC2. Lane G fixes. | Haiku review + Luna fix |
| W4 | ~04:15–05:30 | Merge W2/W3 → gate → Greptile → deploy 2. **Live proof 2**, generalisation: 8–10 diverse real quote threads + 2 amend/cancel, scored table (party right?, priced?, docs ok?, time-to-ready). Create reservation proven on the TEST property only. | Opus |
| W5 | 05:30–06:30 | Buffer for overrun (quote lanes ran 2.07× on N2). Morning report, ETA close rows, nightly retro, worktree cleanup list. | Opus |

Lanes may start early when their inputs are ready. Order of value if time runs short: W1c > P > R > D > E > W3. (F dropped, see Done #6.)

**Added 23:52 UTC after research (002, 003):**
- **Lane P (proof driver):** generic `nava-quote-proof.ts` + `--quote` gate mode. Needed for W1c and W4. Prompt is `/tmp/qm/p.md`. Starts in the first free lane slot.
- **Lane R (reply ready):** no server-side reply body exists, so staff currently type it. Prefill the reply from the gold 5-line wrapper (`apps/mail/lib/quote-proposal/copy.ts`) with the PDF attached. Fix the SKNG→Suite / EXKNG→Single labels. Joins Lane D's slot or runs before it.
- **W3 checklist** = rules in 002: totals row, 30 s flag, one Find per section, Coming-soon purge outside the quote flow (booking-card, approve-card, amend panel), translation collapsed, Needs-you Undo/Finished.

## 3. Models and money

| Role | Model | Rule |
|---|---|---|
| Orchestrate, critical diff review, merge, deploy, live proof | Opus 5.5 (this session) | Keep own context lean: delegate file reads, read diffs by `git diff --stat` + targeted hunks |
| All coding | GPT-6 Luna max via `codex exec -C <wt> -s workspace-write --skip-git-repo-check -c multi_agent_v2=false -o <out> - < prompt` | One worktree per lane, base `feat/quote-mvp-live` |
| Reviews, research | Haiku 5.5, effort max, fresh agent, diff-scoped (<100k) | Never resume a big reviewer |
| PR gate | Greptile CLI (`greptile`, greploop skill), ≤3 rounds | Fix P0/P1 only; reply to each P1; ignore P2 |
| Never | Sonnet; GitHub Actions; any new workflow file | |

Budget: about **$30–40** (Opus ~$18, Haiku ~$10, Luna ~$6). If spend looks set to pass $60, cut W3 to critique-only and drop Lane F.

## 4. Gates (every merge)

1. Local only, never GitHub checks: `pnpm exec tsc --noEmit` for server-pilot and mail, oxlint/eslint on changed files, vitest on changed + related tests (`--maxWorkers=2`). Known reds that are not ours: `outlook-pane-render.test.tsx` 400 s timeout, `work-event-immutability` FK text.
2. Opus read of critical hunks. Haiku diff review.
3. Greptile local loop: P0/P1 fixed and replied.
4. Merge to main with a merge commit. `apps/server-pilot/deploy/ops-deploy.sh`. Exit 1 from the dead-letter gate may be a false alarm: check health by hand (`prod-health.sh`) and run `vpn-health-assert.sh`.
5. Live proof under the real runtime (pm2 / EC2 gate), after the last fix.

## 5. Safety and crash guard

- **VPS is 4 cores / 15 GB and already at load ~8 with 3 codex lanes.**
  - Max 3 Luna lanes at once; a 4th is allowed while load < 4 and available memory > 6 GB (changed 00:34 UTC: lanes are API-bound, load sat at 1–2).
  - Max 1 heavy local job (tsc or vitest) at a time per lane; vitest `--maxWorkers=2`.
  - **Chromium on this VPS: only the shot daemon (one browser, serial queue).** Never launch parallel browsers or screenshot jobs here.
  - Live UI proofs run on EC2 (`nava-preview-gate.sh`), one at a time.
  - Before any render or proof: `free -m` available > 3 GB and load < 10, else wait.
- **HMS:** reads only on Centurion. Create reservation only on the TEST property, behind a flag, and the guard refuses Centurion's property code. Never flip any write flag for Centurion.
- **Prod:**
  - Allowed env edits: single-key `HMS_JOB_QUEUE=on` in `.env.remote-common`, plus any new flag this plan adds (default off), each backed up and diffed.
  - Never run `write-ec2-env.sh`. Never send email. Never delete data.
- **Holds (write to the status file, do not do):** Centurion HMS writes, sending mail, new GH workflows, anything irreversible outside this plan. Everything else: decide, act, log.

## 6. UI rules for the pilot

Merged from the staff call transcript (`bongi UI call transcript.md`), the Oct 9 relay and the user's notes, plus the research file `docs/plans/2026-10-13-002-staff-ui-feedback.md` (written by the research pass).
- Contact (name, email, phone, company) sits at the top, read-only, with "Correct" (saves to this request only, HMS unchanged).
- Steps follow the staff's own order: contact → stay → company/agency → rates → quote.
- Rooms are named by type ("Double ×2"), and the type sits next to the count. Dates are unambiguous ("Sun 9 Nov 2026"), with nights shown.
- No control that does nothing. No "Coming soon" inside the quote flow. No generic errors: every HMS state has plain words and a next step.
- Waiting on HMS never blocks: "Looking up in HMS — you can keep working", elapsed time, and a top banner when done.
- Replies go out in English even when the email isn't. Show the translation.
- The special price needs "Authorised by". The booker's name comes from the email.

## 7. Generalisation testing

- Pick test threads by shape, not by name: company/contract, agency, walk-in BAR, group 10+ rooms, multi-stay, foreign language, children, missing dates. Pick from the last 14 days of quote work items. See `docs/plans/2026-10-13-003-quote-corpus-notes.md` (research pass).
- Score per thread: extraction fields right, party best-match right, priced or a clear refusal, docs generated, minutes until ready.
- Pass: ≥8/10 priced or clearly explained, 0 wrong-party binds, 0 crashes.

## 8. Morning report (06:30 UTC)

`OVERNIGHT-STATUS-2026-10-13.md`:
- What's live (with proof links)
- What staff should try first
- The 3 morning actions: open Outlook to start sync and check the root row; your go/no-go on create reservation for Centurion; the pilot cutoff time
- Spend by model
- Holds
