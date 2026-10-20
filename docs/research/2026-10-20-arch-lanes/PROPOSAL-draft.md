# Stay-request architecture — draft for outside review (2026-10-20)

Draft by Opus from lanes L0–L6 + Exa ultra (this folder). Not approved. Planning only: no code, no flags, no HMS writes.

## 1. Problem

Today the pane routes each mail to one of several workflows (quote / new booking / amend / cancel / voucher-POP) chosen by a classifier, then each workflow has its own step list. Owner complaints (asks 155–160): wrong workflow shown (quote contact on new bookings), forced company pick, multi-guest threads, cross-thread follow-ups, rates shown only after a room is picked, paid vs unpaid amends handled the same.

## 2. Evidence that shapes the design

| # | Fact | Source |
|---|---|---|
| E1 | HMS confirmation letter = proforma: provisional wording 1,163/1,174, deposit 0 on 1,114/1,174 | L2, lifecycle doc |
| E2 | Letter follows the staff reply within ±30 min for 39/103 core asks (manual precision 30/30) | L1 |
| E3 | Letter prints bill-to party line on 1,001/1,174; never the guest | Opus recount, README C1 |
| E4 | Amend → same confirmation number 14/74, new number 0/74 | L2 |
| E5 | Payment state at amend: paid 44, unpaid 54, unknown 125 of 223; not visible in letters | L2 |
| E6 | Multi-guest threads 9/164; each guest/date got own confirmation 9/9 | L1 |
| E7 | Domain → party profile mixed for big domains (gmail 34 variants/108, Nexus 5/35) | L1 |
| E8 | ZAR 1,700 DBB = 32% of letter prices; government → 1,700 DBB 19/22 | L3 |
| E9 | "single" → Queen 6/12, Twin 5/12 | L3 |
| E10 | All-room rate prefetch helper exists, unused by pane | L4 |
| E11 | BM25 precedent: useful@3 6/20; answer-type prediction no better than majority | L6 |
| E12 | Human Infor screen order: undocumented | L0, L4, L5 |

## 3. Proposed workflow (pseudocode)

```
on mail(thread):
  read = extract(thread incl. prior thread mail + attachments)   # one LLM read
  asks = read.asks[]            # 0..n, each = {want, guest, dates, rooms, party clues, conf refs}
  if channel/OTA/system: skip
  for ask in asks:
    link = find_booking(ask)    # conf ref > guest+dates HMS search > recent letter to same address ±30m
    state = hms_state(link)     # none | provisional | paid/guaranteed | cancelled   (HMS read, never mail)
    card = StayCard(ask, link, state)
    route(card):
      want=stay & state=none            -> STAY flow (quote and new booking are one flow)
      want=change & state=provisional   -> AMEND-UNPAID (edit in place)
      want=change & state=paid|unknown  -> AMEND-PAID (money/fee review first)
      want=cancel                       -> CANCEL (lab only; never accept penalty dialog)
      want=voucher/POP                  -> attach to linked booking; mark guarantee pending staff
STAY flow (pane order):
  1 Who: contact + bill-to party (ranked suggestions: email-named > sender history > domain; never silent default)
  2 Stay: dates, room-type rows (counts, occupancy), board
  3 Rates & availability grid: every room type x applicable plans (BAR, contract, government DBB), rooms left
  4 Staff picks row(s)  -> quote PDF/Excel/reply (if they want a quote)  OR  provisional HMS booking (letter = proforma)
  5 Review: screenshot + HMS result; Nava never sends
Blank/ambiguous field -> show question for staff to ask client; never default (e.g. single -> Queen vs Twin both shown)
```

## 4. Data model

App-owned Postgres: `stay_case` (thread, ask index, want), `booking_link` (conf, source, confidence), `hms_snapshot` (state, deposit, guarantee, read_at), `fact` (field, value, source mail/HMS/staff edit). Precedent retrieval = advisory side panel, not routing.

## 5. Memory framework

Keep Mastra + Postgres. A/B Postgres hybrid (FTS + pgvector + rerank) vs Hindsight 1.0.0 on ~120 chronological held-out asks. Metric: human-judged useful@3 + fact recall (rate, board, party). Bar: BM25 useful@3 = 6/20. Adopt only on ≥10 pt gain and 0 leaks/wrong links.

## 6. Slices (parallel lanes, disjoint files)

| Slice | What | Depends on |
|---|---|---|
| S1 | Multi-ask read: extractor returns asks[] (schema + prompt + eval on golden) | — |
| S2 | find_booking + hms_state read (deposit/guarantee/status) | Infor DOM probe on Labtest |
| S3 | Router: want × state → flow; replace single-label routing | S1, S2 |
| S4 | Pane: rate grid before room pick using existing all-room helper | — |
| S5 | Pane: who-step ranked party suggestions, no forced pick | — |
| S6 | Letter linker: ±30 min letter → case; letter party line as party truth | — |
| S7 | Precedent A/B harness | — |

## 7. Open questions only staff can answer

1. Screen-share one real Infor booking creation (pane order).
2. Where paid/guaranteed is recorded in Infor (deposit field? folio? guarantee type?).
3. Dinner allowance vs DBB plan: when each.
