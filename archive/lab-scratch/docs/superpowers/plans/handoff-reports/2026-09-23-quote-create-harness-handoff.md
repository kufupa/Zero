# Handoff — Quote create harness (continue from evidence, not the empty checkboxes)

**Date:** 2026-09-23
**Branch:** `feat/centurion-dashboard-tools`
**Worktree:** `/home/ubuntu/projects/zero/.worktrees/centurion-dashboard-tools`
**Chat transcript (full JSONL):**
`/home/orca/.cursor/projects/home-ubuntu-projects-zero-worktrees-centurion-dashboard-tools/agent-transcripts/a3d2cd84-1d91-4f05-8dfd-76d5eaeb1d31/a3d2cd84-1d91-4f05-8dfd-76d5eaeb1d31.jsonl`
**Binding plan that was executed (do not edit; checkboxes are stale):**
`/home/orca/.cursor/plans/Quote create harness-a3d2cd84.plan.md`
**Follow-up plan, already executed:**
`/home/orca/.cursor/plans/Penalty warning check-a3d2cd84.plan.md`
**Private evidence (gitignored):**
`.private/create-screen/` and `.private/playwright-quote/runs/2026-09-22T19-32-44-421Z-ba882ac0/`

This file is for a **new LLM**. Read the locked decisions and the do-not list before touching HMS, the lab index, or the Luna prompt. The quote-create plan's checkboxes are still empty because that run was forbidden to edit the plan. This file plus the JSON proofs are the source of truth.

---

## 0. What this workstream is

One pass to finish the quote lab scar and the create-reservation lab proof. Quote first, then create.

It is **not**:

- A production booking tool
- A guest-profile link tool
- A penalty void or a stay delete
- A second quote driver or a lab Run button

---

## 1. Locked decisions

- Quote holdout stays closed. Do not retune it.
- Create holdout of 15 ids was opened once. Do not reopen it. Split: `.private/create-screen/split.json`. Seed `20260922`. Holdout 15, slice1 7, slice2 7, tune 126. Total 155.
- Three Luna call sites stay `gpt-6-luna` with `model_reasoning_effort=max`. No `-max` suffix. No fallback to `gpt-5.6-luna`. Home `~/.codex/config.toml` stays `model = "gpt-5.6-luna"`.
- Live PMS clicks are GPT-6 Astra via `codex exec -m gpt-6-astra` and `model_reasoning_effort=xhigh`. Grok does not click HMS.
- One borrowed Chromium on EC2 `i-008f737974a9ba9b3`, CDP port 19223. Do not start a second owner. If the local tunnel is down, reopen the one port-forward. `ENOTFOUND` from this VPS only means this machine is not on hotel DNS.
- Overlay is `apps/server-pilot/scripts/overlay-centurion-lab-spa.sh`. Do not use `ops-deploy.sh`. Do not hard-reset.
- Never Vitest against `nava-zero-mail-pilot`. Run `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS` before tests. Never set `VITEST_ALLOW_PILOT_RDS=1`.
- Do not Save a corpus or mailbox guest. Do not paste the lab screenshot onto a mailbox guest card.
- Keep guest profile **45552**. It is not an HMS login. The operator login was reused. HMS minted 45552 because the lab script typed a name and did not open a guest lookup.
- Do not click the penalty dialog OK. That click may post 2060.00 onto that folio. The folio is unread.

---

## 2. Done

| Piece | State | Where |
| --- | --- | --- |
| `boardBasis` and board enums gone | Done | `apps/mail/lib/lab/centurion-eval-schemas.ts`, `apps/mail/lib/lab/quote-stay-route.ts` |
| Tests expect `boardBasis` undefined | Done | `apps/mail/tests/centurion-eval-lab.test.tsx` |
| Trap: a mail phrase is not an HMS field | Done | `.cursor/skills/building-hms-playwright-tools/references/traps.md` |
| One fetch-quote, `held: false`, shot on the quote tool | Done | `.private/playwright-quote/runs/2026-09-22T19-32-44-421Z-ba882ac0/` |
| Astra empty New Record. No Check Availability. No Save | Done | `.private/create-screen/new-record.md` |
| Luna sites `gpt-6-luna` / effort `max` | Done | three scripts in §2.4 |
| Dev fill, clean slices, one 15-id holdout | Done | `.private/create-screen/split.json` |
| Far-future Save, then cancel | Done | confirmation **11110906-1** |
| 155 create rows painted, overlay | Done | stamp `20260922-create-paint` |
| No mailbox guest. Tests without pilot RDS | Done | last lab Vitest that session: 20 passed, `DATABASE_URL` unset. Not re-run on 2026-09-23 |
| Wednesday HMS check | Up | `.private/create-screen/proof/hms-up.json` |
| Folio / 2060 posted? | Unknown | `.private/create-screen/proof/penalty-folio.json` `posted: null` |

### 2.1 Quote

`boardBasis`, `dinner_bed_breakfast`, `breakfast`, and `full_board` are gone from the lab schema and the quote filler. The quote tool shows `/lab/quote-rate-proof.png` from `apps/mail/components/lab/centurion-eval-lab.tsx`. The fetch-quote outcome is `quote`. Every option is `held: false`. No new quote driver and no lab Run button. The quote holdout was not reopened.

### 2.2 Create screen

Astra thread `01a0caaa-73d3-7b31-8514-c23a60111d41` copied the empty Guest Stay New Record: Stay, Guest, Guarantee, Settlement. Asterisks came from the DOM. No Check Availability, Save, Documents, or Auto Transfer.

Create required keys: arrival, departure, adults, sourceOfBusiness, roomType, ratePlan, track, firstName, lastName. Guarantee Type had no red asterisk on the empty form. Save still required it. The successful fill used **Non-Guaranteed Individual**.

### 2.3 Lab stay

Typed fields only: first Nava, last Labcancel, arrival 08-JUN-2027, departure 09-JUN-2027, 1 adult, source Internal, room STQN, rate BAR, track BAR, guarantee Non-Guaranteed Individual. No email, phone, card, or settlement.

HMS then minted profile **45552**, filled the meal plan, and priced the night at **2060.00 ZAR**. Confirmation **11110906-1**.

First Save failed because Guarantee Type was blank. No confirmation existed yet. Second Save wrote the confirmation with status Reserved.

Script cancel failed: the Guest Stay date window hid June 2027, then the Cancellation Reason OK matched two Ext buttons. Ext ids rot. Do not patch `apps/server-pilot/tooling/playwright-quote/cancel-lab-stay.mjs` and do not run it. Do not run `create-lab-stay.mjs` in Save mode.

The user overrode the plan rule "stop after two cancel failures" for this confirmation only. Astra thread `01a0cb65-85cd-7790-8404-579d6799c11e` cancelled that stay and no other.

Cancel proof: `.private/create-screen/proof/cancel-result.json` has `cancelled: true`, before status `Reserved`, after status `Cancelled`. Screenshot: `.private/create-screen/proof/cancel-after.png`. Reason `Test Reservations`. Note `Lab proof cancel`.

### 2.4 Luna

Call sites, all `gpt-6-luna`, effort `max`:

- `apps/server-pilot/scripts/centurion-eval-launch-luna.sh`
- `apps/server-pilot/scripts/classify-centurion-nine-day-corpus.ts` (`DEFAULT_LUNA_MODEL_ID`)
- `apps/server-pilot/scripts/compare-centurion-human-gold.ts` (`GOLD_COMPARATOR_MODEL_ID`)

The CLI warned that model metadata was missing. That was not a slug reject. Prompt: `.private/create-screen/prompt.txt`.

The first tune batch was red: invented rate names, source "E-Mail" because the message was email, adults taken from room counts, dates not in the text. The prompt was tightened from tune rows only. A later slice pair was clean. The 15-id holdout was opened once, was clean, and was not used to edit.

Paint covered 155 create rows, 7 at a time. Two adult fills failed the phrase check and were set to null on merge into `.private/lab-centurion-index.json`. The prompt was not edited on that paint. The holdout was not reopened.

### 2.5 Overlay and the lab image

Overlay stamp `20260922-create-paint`. The quote card shows the rate shot. The create card still shows the **Reserved save** image:

- Published: `apps/mail/public/lab/create-lab-stay.png`
- Cancelled proof, not published: `.private/create-screen/proof/cancel-after.png`

A later instruction said not to overlay again after cancel. Do not treat the published image as proof of cancel.

### 2.6 Wednesday check

Operator report: HMS is a LAN deployment and can go down for a couple of hours on Wednesday. No clock window was given. At 10:14 UTC on 2026-09-23 the borrowed browser already had Guest Stay 11110906-1 open. `hms-up.json` says `outcome: up`. The hotel date on screen was 23-SEP-2026. HMS was not down during that check.

At 10:16 UTC the folio read stopped. The penalty modal's mask covers the Folio tab. `penalty-folio.json` says `posted: null` and `outcome: blocked_by_warning`. Clicks: 0. Neither OK was pressed.

---

## 3. Do not

- Do not reopen the quote holdout or the create 15.
- Do not run `create-lab-stay.mjs` in Save mode.
- Do not run `cancel-lab-stay.mjs`. Selector patches already failed.
- Do not click OK on "Cancellation Penalty of 2060.00 may be added to account."
- Do not click the separate "The record was successfully saved" OK if it is still up.
- Do not void, delete the stay, or delete profile 45552.
- Do not reinstate. Arrival 08-JUN-2027 is not the hotel date. [Reinstating a reservation](https://docs.infor.com/hms/2026.08/en-us/hmsolh/s_t1424428573702.html) only allows reinstate when arrival equals the hotel date.
- Do not start a second Chromium or a second SSM tunnel while one forward is up.
- Do not click CRS Check Availability, Reserve, or Shop by Day.
- Do not commit `.private/` or the lab index.

---

## 4. Open

- Whether 2060 posted to the folio of 11110906-1 is unknown. The official post path puts a cancellation fee on the guest folio and, if a guarantee card exists, charges that card. This stay has no card. [Canceling guest reservations](https://docs.infor.com/hms/2026.08/en-us/hmsolh/s_t1424428573546.html). The exact sentence "may be added to account" is not in that page. If a fee line is later found, the void path is Folio, Actions, Void Record, on that line only. [Working with folios](https://docs.infor.com/hms/2026.08/en-us/hmsolh/s_t1424428571861.html). Do not void without a new yes.
- Next create work must link an existing guest profile when one matches, and must mint a profile only when none does. Guest profile, Primary Booking Agency, Organization, and A/R Account are separate links on the same stay. That lookup behavior is unread on the live screen. Profile 45552 is the lab guest to link in a later test.
- Republish the cancel shot only if someone asks the lab card to show Cancelled. Copy `cancel-after.png` over `apps/mail/public/lab/create-lab-stay.png` and run the existing overlay. No repaint. No prompt edit.

---

## 5. Next LLM start

1. Read this file.
2. Read `.private/create-screen/proof/cancel-result.json`, `hms-up.json`, and `penalty-folio.json`.
3. Do not attach CDP unless the user asks for a new HMS action.
4. If they do, the identity gate is confirmation `11110906-1`, last name `Labcancel`, first name `Nava`, arrival `08-JUN-2027`. Any mismatch: stop and cancel nothing.
