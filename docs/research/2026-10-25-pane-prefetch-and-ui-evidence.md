# Pane pre-lookup, background jobs, caps and UI gaps — evidence (2026-10-25)

Owner ask 223. Code at `c5533f1bf` (origin/main = live `20e5389ee` + docs). Prod read-only SQL via SSM 2026-10-25 ~19:40 UK. Paths: S = `apps/server-pilot/src`, M = `apps/mail`.

## 1. Pre-lookup (before staff open the mail)

| Lookup | Trigger | Prod flag | Pane reads it on open |
|---|---|---|---|
| Find booking / guest search | after live extraction (S/ai/worker.ts:5489) | `HMS_PREFETCH_ENABLED=1`, `HMS_JOB_QUEUE=on` | yes, M/components/nava-pane/amend-lookup-panel.tsx:208 |
| Party (agency/company) | after extraction, quote mail (S/ai/hms-jobs.ts:2661) | same + `PARTY_MATCH_V2/V3`, `PARTY_HISTORY_BIND=on` | yes, party-picker.tsx:504 |
| Rates quote ("Prepared by Nava") | after party done (hms-jobs.ts:2608-2675) | `HMS_QUOTE_PREPARE=true`, `HMS_DAVINCI_MAKE_QUOTE=on` | yes, nava-pane.tsx:1031-1110 |
| Availability probe | after extraction (worker.ts:5486) | `HMS_AVAILABILITY_PREFETCH` **unset (off)** | **no reader in the pane** |

- Current build (since 2026-10-25 05:00Z, by transport): 6 staff quotes Centurion (p50 59 s run, 2 s wait), bg find/party/search_guest a handful each, **0 background rate quotes**.
- Today's quote work items: 3 (transport-davinci 07:42Z, 09:47Z; transport-faith 03:59Z). All extracted OK with dates (2027-03-12→20, 2026-11-11→13, 2027-01-14→30). **None got a background staff_quote run**; 09:47Z and 03:59Z got a party run only. Cause not yet proven (candidates: plan has no plannable inputs, e.g. null board/room; Faith's 03:59Z mail names "Centurion Hotel" so target guard may refuse a Da Vinci mailbox; DV target refusal). Needs a gate-reason log — `evaluateQuoteReadyForMessage` returns a reason but it is not persisted.
- 7-day figures (142 ok / 34 dead-letter bg quotes) mix older builds and pre-setup Da Vinci → not a current-build metric (owner, ask 223).
- Dead-letter causes 7 d: TRANSIENT_NETWORK staff quote 29, TRANSIENT_NETWORK lookup 20, prepared quote yielded to staff 5, run deadline 1.

## 2. Per-hour caps — provenance

| Cap | Default | Introduced | Stated reason |
|---|---|---|---|
| HMS_PREFETCH_PER_HOUR | 30 | 4cb208313 #124 2026-10-10 | none measured |
| HMS_AVAILABILITY_PER_HOUR | 6 | 1eb1fc919 #126 2026-10-10 | "a busy quote day cannot use up the prefetch budget" |
| HMS_GUEST_PREFETCH_PER_HOUR | 12 | 5e8cc0af8 #182 2026-10-11 | none |
| HMS_QUOTE_PREPARE_PER_HOUR | 6 (prod 20) | fbf60b10e 2026-10-14 | "safe default" |
| PARTY_USER_PER_HOUR | 12 | b1b91316c 2026-10-13 | none |

- Guesses, not measurements. Per **transport**, not per property (HRDAV has 5 transports → ~5× budget on one browser). Over-cap mail is **dropped** (no deferred row, no catch-up sweep found); staff fall back to a click. The real protection is already elsewhere: one lock per property (property-read-lock.ts:76), staff priority 10 > background 0, background yields to staff quotes (hms-jobs.ts:3530), live-admission gate (#376). Recommendation: remove the caps, or replace them with "defer, don't drop".

## 3. Login / session reuse

- Each job spawns a Node CLI, attaches to the long-lived slot browser over CDP (party-lookup.mjs:1129; hms-slot@ systemd), opens a **new context and logs in** each time (party-lookup.mjs:1131-1147).
- storageState reuse exists but Infor rejects it: cold login 7.98 s, "no speedup" (ledger/2026-10-19-afternoon-retro.md:17; party-lookup-v3.md:56). #390 cut party to one login per job.
- Kept-alive logged-in page ("next slice", chatA-handoff.md) **not built**: `slot-session.ts` has no importers. Measured: login 4–6 s + Guest Stay nav 4–5 s + search 2–4 s; ~75% of a party job was login+nav (chatA-handoff.md:23-27).
- HRCEN and HRDAV: separate slot browsers (19223 / 19225), separate locks, can run in parallel (#362).

## 4. Staff actions after clicking away

| Action | Server job? | Survives switching mail | Rehydrates |
|---|---|---|---|
| Get rates / Run quote | queued job p10 | yes | yes (poll 3 s, "Rates ready" toast) |
| Approve amend/cancel | queued hms_write | yes | yes |
| Prepare PDF + reply | plain request, 120 s | **PDF in React state only** (nava-pane.tsx:549) | **no** |
| Book in HMS preview | plain request | **lost** | no |
| Book in HMS commit | plain request, 27 min | result saved on work item | yes; cut-off mid-request unverified |
| "Save quotation to HMS" | does not exist; Infor has no quote entity found (Pro Forma print only) | — | — |

Book in HMS = real reservation create (status Reserved), gated `PANE_WRITE_CREATE` / `RESERVATIONIST_PANE_SAVE=lab` → Labtest 2027+ only. Whether Infor auto-sends the confirmation letter on Save is **unverified** (letter arrives ~12 min after staff reply, median).

## 5. Infor screens (what we know)

- Hotel Availability grid: 14-day room type × rate plan, price + rooms left per night; `fetch-quote.mjs` already parses it including rooms left (fetch-quote.mjs:369-463). One shop = one sales strategy, all room types. HRDAV WS shop: 133 room/rate rows, 16 plans, ~3.4 s (2026-10-25-hrdav-dom-read.md:86).
- HRDAV create screen required: Arrival, Departure, Adults, Source of Business, Guarantee Type, Room Type, Rate Plan, Market Segment, Track, Reservation Note, Last/First name, T&C. Meal plan comes from the rate.
- Staff's real Infor click order: **never recorded** (only our automation's fill order).
- Custom/one-off rates + "Authorised by": Bongi call → 10-09 plan U13; in PRODUCT.md line 40.

## 6. Pane UI audit (live code)

- No per-field AI marker (only "from email" blue / "Your note" grey chips); no field undo, reset-to-AI or global undo/redo.
- Status line garbled: one `<p>` concatenates "…you can keep working · 45 s elapsed · Queued" + "Still working — you can keep going" with no separator (hms-queue-status.tsx:89-93).
- Extras render **outside** the Stay card border (panel:1866-1871 sibling of the `<article>`).
- Room-type dropdown: code/label only, no rate or rooms left (requirement-card.tsx:415).
- Half-entered dates: picking check-in clears departure and the run is blocked; auto-start has no debounce (nava-pane.tsx:1316). The owner's "Rates failed" needs a trace of that exact mail.
- Duplicated copy: 5 different "Search availability" labels; HMS notes named 5 ways; "Needs you" vs "Needs your answer"; two lookup status lines in party picker.
- .xlsx shown as "not a PDF" (quote-workflow-synced-selection.ts:451) — todo, low ROI.

## 7. Why the last two pane reviews missed this

U13 review = source read only, no screenshots (pane-dup-review.md:42), data fields only. U13a review = one failure fixture, 380 px, stale 08-30 CSS, outside Outlook. Nobody opened the live pane (0 nginx bundle loads after deploy). Next review must be: live pane (webmail at nava-admin, real build) × ≥6 real mails covering quote/new/amend/cancel/attachment/queued/half-entered states, every string listed, owner sees screenshots.
