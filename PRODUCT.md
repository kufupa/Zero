# PRODUCT.md — Nava reservationist (Centurion)

Owner-edited. Agents read this before planning or coding. Do not invent requirements. If an ask is missing here, append it under **Asks logged** and wait — do not treat chat as a second spec.

Staff-facing name: **Nava**. Model name (Luna) never shown to staff.

## What this is

AI reservationist for Legacy Hotels Centurion. Staff stay in classic Outlook. A VSTO add-in hosts a WebView2 pane (`apps/mail` `/outlook-pane`). Same pane in webmail. Nava reads the selected email, pre-fills fields, and runs **deterministic** Infor HMS tools via Playwright. Human in the loop on every write.

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
- One HMS browser lock. Subagents never drive live HMS.
- Never Nova Lite. Luna max for implementation; Opus for briefs, merges, deploys, live HMS, user-facing claims.
- Before Vitest: `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS TEST_DATABASE_URL`. Never test against pilot RDS. Never print secrets or `postgres://`.
- Deploy only from `.worktrees/recover-parse-failure` via `apps/server-pilot/deploy/ops-deploy.sh`. A pane fix is live only after staff’s bundle reloads.
- P0/P1 review findings fixed before merge. No `--no-verify`.

## Done (this is the overnight gate)

**Done = score on a golden set of real past mail**, not merged, not deployed, not “3 live threads went green.”

Target mix (~30): quote 12, amend 6, cancel 4, create 3, channel/system skip 5. Answer key from read-only HMS, not from whatever the agent last saw in Outlook. Overnight goal = move that scoreboard. Tests are allowed as a gate only when they encode this class of mail, not one thread.

Research already done: `docs/research/2026-10-13/README.md`. Do not redo it. Refresh the corpus snapshot if the mail mix is stale.

## How agents work this file

1. Read this + `docs/context/ACTIVE.md` + the research README.
2. Log new owner/staff asks here under **Asks logged**. Do not paraphrase them into a new plan and drop the original.
3. Argue the opposite once (will this overfit a thread? is this ROI?).
4. Ship the smallest slice that moves the scoreboard.
5. Stop when the slice’s acceptance test passes in staff terms.

## Asks logged

_(agents append dated one-liners; owner promotes into the spec above)_
