# PRODUCT.md — Nava reservationist (Centurion)

Owner-edited. Agents read this before planning or coding. Do not invent requirements. If an ask is missing here, append it under **Asks logged** and wait — do not treat chat as a second spec.

Staff-facing name: **Nava**. Model name (Luna) never shown to staff.

## What this is

AI reservationist for Legacy Hotels Centurion. Staff stay in classic Outlook. A VSTO add-in hosts a WebView2 pane (`apps/mail` `/outlook-pane`). Same pane in webmail. Nava reads the selected email, pre-fills fields, and runs **deterministic** Infor HMS tools via Playwright. Human in the loop on every write.

The client environment was recorded as live on 2026-10-14. The owner confirmed on 2026-10-29 that staff are not using Nava because the product is not complete. Never call it a demo. Deploys and flag flips can affect the client environment; bundle loads alone do not prove staff adoption. There is no staff-hours deployment window or advance-warning requirement. Any pane feature ships on both surfaces (Outlook pane and the webmail panel at nava-admin).

## Who it is for

Centurion reservations staff. Never ask them to run scripts, PowerShell, or terminals. Never show raw technical errors. If something takes >30s, say so in plain language.

## Workflows (ROI order)

Finish one before starting the next. Reads may be automatic. Writes are Prepare → Queue → Act → Review, with a screenshot.

1. **Quote** — company/agency contract rates (majority of bookings). Cover email + PDF. BAR B&B; dinner is an add-on, hotel-specific. Staff never name the company in the reply body. Fully booked = one-line decline, no alternative.
2. **Create reservation** — after quote, staff approve; Nava does the HMS create. Not typed by staff.
3. **Amend**
4. **Cancel** (lab only until owner says otherwise)
5. Payment proof / voucher, billing, group/event — after 1–4 actually work on real mail.

## Front door

Classify every inbound mail. **Skip** OTA / channel / automated / spam at the door. Travel-agent mail **stays in scope**. Examples in chats are examples — generalise the class, do not overfit the three live quote threads that happened to be open.

**Owner hard rule — pre-stay self-mail:** mail the hotel's own mailbox sends to itself (e.g. centurion@ → centurion@) titled "Pre Stay : Property … Confirmation No <conf> <name>" carries pre-arrival details for an **existing** booking. Read it as existing stay / pre-arrival info, never as a new booking, and never offer create. Build it as a general rule (own mailbox + pre-stay subject + confirmation number), not a Centurion string match.

## Pane (staff)

Keep the V1 look. One primary action per step. Hide dead controls.

- Header: active mailbox + sync status, then selected email, then **read as** (same vocabulary as Needs-you: quote / booking / amendment / cancellation / voucher-POP / other).
- **Quote contact — appears in the PDF** at top (name / email / phone). Company/agency on the quote is a separate field. Edits save to this request; they do **not** write HMS unless staff hits the explicit book action.
- Stay by date range. Room-**type** rows with counts and occupancy. Totals. No “Room 1 / Room 2”.
- Rates: HMS rates + one-off/saved + required “Authorised by” for discounts.
- After an HMS match: facts + **one** Copy confirmation + Open HMS only if the target is real. Hide Find after a result.
- Quote review: PDF, Excel, editable reply, save unsent draft. Nava never sends.
- Attachments: say **Download to this computer** if that is all the code does. Attaching into HMS is a separate, approved write.
- Needs-you: short to-do list. Dismiss has Undo and a Finished path.

## Hard rules

- No real-guest HMS writes unless the owner set `RESERVATIONIST_PANE_SAVE=on`. Bot never accepts cancellation-penalty dialogs.
- One HMS browser lock per hotel. An AI agent may drive live HMS (owner 2026-10-25), read-only on real guests; writes only on Labtest.
- Labtest (fake "Proof Labtest" guest, 2027+ stays) writes are always allowed on any hotel; never ask (owner 2026-10-25).
- Never Nova Lite. Model routing: see AGENTS.md (Grok orchestrator; Luna/Grok coders by risk).
- Before Vitest: `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS TEST_DATABASE_URL`. Never test against pilot RDS. Never print secrets or `postgres://`.
- Deploy only from `.worktrees/recover-parse-failure` via `apps/server-pilot/deploy/ops-deploy.sh`. A pane fix is live only after staff’s bundle reloads.
- P0/P1 review findings fixed before merge. No `--no-verify`.

## Done (this is the overnight gate)

**Done = score on a golden set of real past mail**, not merged, not deployed, not “3 live threads went green.”

Target mix (~30): quote 12, amend 6, cancel 4, create 3, channel/system skip 5. Answer key from read-only HMS, not from whatever the agent last saw in Outlook. Overnight goal = move that scoreboard. Tests are allowed as a gate only when they encode this class of mail, not one thread.

The golden set is versioned. Compare scores only on the same rows; when rows change, re-score the old build on the new rows before claiming a gain (2026-10-14: the set moved 30 → 27 → 26 rows overnight; v1 was re-scored each time, so 15/26 → 24/26 is a fair comparison). The golden set scores extraction and action class only; quote prices and party binds have their own bars below.

**Pass bars per workflow** (proposed in the 2026-10-14 retro; owner confirms or edits):

| Workflow / check | Pass bar | Unacceptable error |
|---|---|---|
| Party bind | 0 wrong auto-binds on the HMS answer key; auto-bind ≥ 70%; right party in top 3 ≥ 95% | any wrong bind → `PARTY_MATCH_V2` off |
| Quote (prepared or staff-run) | rate plan + price per night = what staff sent, on every plannable real ask in the proof set (≥ 10 threads) | a price that differs with no HMS-side reason |
| Front-door classifier | ≥ 90% agreement with outbound-grounded labels, ≤ 1% failures, at production concurrency and effort | a real booking/quote ask skipped |
| Amend / cancel find | right reservation found ≥ 95% on golden rows | a different guest's booking shown as the match |
| Any pane change | viewer run green + staff bundle load seen in nginx after the last deploy | "deployed" claimed without the bundle load |

A slice is **done** only when its bar passes on prod after the last fix. Merged, deployed or "tests green" is progress, not done.

Research already done: `docs/research/2026-10-13/README.md`. Do not redo it. Refresh the corpus snapshot if the mail mix is stale.

## How agents work this file

1. Read this + `docs/context/ACTIVE.md` + the research README.
2. Log new owner/staff asks here under **Asks logged**. Do not paraphrase them into a new plan and drop the original.
3. Argue the opposite once (will this overfit a thread? is this ROI?).
4. Ship the smallest slice that moves the scoreboard.
5. Stop when the slice’s acceptance test passes in staff terms.
6. **One workflow in progress at a time** (WIP = 1). Other lanes may only run evals, research or fixes that do not touch that workflow's files.
7. **Scope changes are trades.** A new item for a running plan names the item it displaces and the new ETA, and the owner approves before work starts. Never add a new feature to an overnight run unless its pass/fail check already exists.
8. Run contracts (overnight or daytime) follow `docs/context/RUN-CONTRACT.md`.

## Asks logged

_(agents append dated one-liners; owner promotes into the spec above)_

- 2026-10-14 (owner): skip Profitroom, Tiket.com, RateTiger and H-Pay (hospitality.cloud) at the door, exact host; Travelit and TBO stay in scope.
- 2026-10-14 (agent-proposed, owner approved): quote ready on open — Nava prepares the priced quote in the background (reads only) so staff don't click and wait.
- 2026-10-14 (owner): fully booked — alternatives are shown to staff in the pane only; the reply stays a one-line decline unless staff pick "Use this".
- 2026-10-14 (owner): action labels come from what staff did (outbound) first; else two models must agree; disagreements go to the owner.
- 2026-10-14 (owner policy): TMC cancellation notification = no action; a person asking to cancel = cancel; vouchers parked (find first, later); shuttle for a group = group/event, otherwise amend.
- 2026-10-14 (owner): DB route tests may use a local disposable Postgres on 127.0.0.1; never pilot RDS.
- 2026-10-14 (owner, after the client saw the live product): (1) pre-stay self-mail is an existing stay, never New booking (rule promoted to Front door above); (2) webmail panel shows "Access removed — contact Ansh" for centurion@ — diagnose the sync-owner denial and give webmail its own wording; (3) nava-admin "could not load this workflow folder" — error visibility first, then fix; (4) "Prepared by Nava" quotes must show in webmail too (`HMS_QUOTE_PREPARE` on remote-http as well).
- 2026-10-14 (owner): today's goal — every workflow (quote with price confidence, create, amend, cancel) to high accuracy. Work it one workflow at a time against the pass bars above.

- 2026-10-20 (owner): immediate goal is quote end-to-end in reservationists’ hands, preferably booking/amend/cancel/POP too; current request is deep planning and safe Orca cleanup, not implementation. Chat must contain technical steps, ETA evidence, ROI, alternatives/fallbacks and authority needs. Original asks: OWNER-ASKS.md 139–146.
- 2026-10-20 (owner): deploy whenever needed; no outside/before staff-hours cap. Existing write authorization and staff-bundle proof still apply.
- 2026-10-20 (owner): one mail may need multiple workflow actions; POP distinct from voucher; group typically ≥12 guests. Scope/readiness decision pending, not an overnight architecture rewrite approval.

- 2026-10-20 (owner): PDF click acceptable; autonomy means reliable end-to-end connections, not mandatory automatic PDF. Consider prominent Generate PDF + reply then review; editable Excel first-class. Replan technical scope and ETA basis before product execution. Original ask147 in OWNER-ASKS.

- 2026-10-20 (owner, D19): quote recall bar ≥85% (was 95%, arbitrary) on ≥100 independent outbound-grounded quote rows, not n=26.
- 2026-10-22 (owner, ask 175, client): ~66 h after a staff quote that states a validity/hold window, Nava drafts a follow-up in-thread for staff review. Never sends. Needs-you item.
- 2026-10-20 (owner): critically review best/elegant pilot product and exact first-release work/elapsed estimate; Grok final review with Sol coordination, not routine expensive Opus. Assessment only, no product execution approval. Original ask148 in OWNER-ASKS.
- 2026-10-22 (owner): one Outlook workstation with several mailboxes (e.g. Ayanda + Da Vinci); one Nava login across them; pairing may need multi-select for the one-month ingest. Design first. Ask 179, [handoff](docs/context/HANDOFF-2026-10-22-outlook-multi-mailbox.md).
- 2026-10-22 (owner): back to testing — no automatic real-guest bookings; `PANE_WRITE_CREATE=lab`. Ask 181.
- 2026-10-26 (owner, asks 238–261, planning only): “i want to use https://github.com/Pomerado/pomerado in order to build the add-on feature”; “don't forget any features ... note them all down”; combine unfinished handoff work with new booking UX, guest rows/individual child ages, clearer room counts and rate choices, automatic prefill/all-room rates, staff-first provisional confirmation, shuttle Add-On/removal/arrival-note workflow, and a complete ROI-ranked speed plan before the owner specifies a coding window. Preserve original phrases and every sub-ask in [intake](docs/context/2026-10-26-addons-ux-intake.md). Read-only research and planning, not implementation/install/deploy authorization.
