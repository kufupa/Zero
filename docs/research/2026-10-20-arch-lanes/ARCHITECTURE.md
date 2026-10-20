# Stay-request architecture — final recommendation (2026-10-20)

Opus synthesis of lanes L0–L6, Exa ultra, Opus critique ([README](README.md) C1–C10) and the Grok 4.7 xhigh outside review ([grok-4.7-review.md](grok-4.7-review.md)). Supersedes [PROPOSAL-draft.md](PROPOSAL-draft.md). Recommendation only: no code, flag, deploy or HMS write is approved by this file. Owner asks 155–161.

## 1. Verdict

- **Keep the current Mastra + Postgres agent.** Evidence does not justify a router rewrite or a memory framework now.
- **One intake, one prefill, two end buttons:** "Make quote (PDF/Excel/reply)" and "Create provisional booking (letter = proforma)". The owner's "quote and booking are one flow" holds for intake and pricing. It does not hold for the end state (Grok Q3, accepted).
- **First release = rate grid + no-forced-party on the live quote pane.** That moves the quote bar staff use today.
- **Unknown and unlinked are their own screen.** Never fold them into "new stay" or "paid amend".

## 2. What changed from the draft, and why

| Draft claim | Change | Evidence |
|---|---|---|
| Quote = new booking, one STAY flow ending in a provisional create | Two end buttons; quote stays the default | Quote PDF and letter both follow replies. By lead time: 0–6 d letter 24/42 vs quote PDF 4/42; 7–30 d 4/18 vs 3/18; 31+ d 2/14 vs 3/14 ([l1](l1-linkage-domains.md) asset table). Far-out asks lean to a quote PDF. The letter census cannot see quotes that never became bookings ([l2](l2-amend-payment.md) Answer) |
| Create-on-quote is safe | **Risk: Save may auto-mail the letter to the guest** — an HMS send, not covered by "Nava never sends" | L0 says the letter is auto-mailed after save. L4 says send-on-save is unproven. Cancel is lab-only, so a bad create has no prod undo |
| "1,700 DBB is the highest-volume rate" (C3) | Withdrawn. It is the modal price+board pair; B&B boards outnumber DBB 750 to 410 | [l3](l3-missing-info-rooms.md) line 91 |
| Letter ±30 min is "the usual next artefact" | 39/103 replied core asks (38%); recall unchecked | l1 |
| Amend = edit in place | Still the best reading, but weak: 14/74 same number, 0 new, 60/74 no letter | l2 |
| `paid\|unknown` → paid-amend review | Unknown gets its own state | 125/223 unknown at amend (l2); Infor deposit/guarantee field still unidentified |
| Letter party line = party truth (S6) | Hypothesis only. Use existing sender history (109/150 right, 0 wrong) first | Opus recount 1,001/1,174 (README C1), no lane appendix yet; [l0](l0-known-facts.md) line 75 |
| Memory A/B now (S7) | Deferred until the quote bar passes | The BM25 bar (6/20 useful, one rater) is too noisy for a +10 pt test; moves no golden-set bar |

## 3. Workflow (pseudocode)

```
on mail(thread):
  door: OTA/channel/system/H-Pay/pre-stay self-mail -> skip or existing-stay info   # unchanged rules
  read = extract(thread + prior mail + attachments)          # today's extractor; multi-ask later
  link = find_booking(read)       # conf ref > HMS guest+dates search; show candidates, never auto-pick on ambiguity
  state = hms_state(link)         # none | provisional | guaranteed | paid | cancelled | UNKNOWN
  route:
    no link & stay ask              -> QUOTE pane (default)
    link ambiguous / state UNKNOWN  -> CHECK screen: candidates + "what Infor shows"; staff decides
    change & provisional            -> AMEND (in place, staff approves)
    change & paid/guaranteed        -> AMEND + money/fee review
    cancel                          -> CANCEL (lab only)
QUOTE pane:
  1 Who: quote contact (prints on PDF) | guest | bill-to company | booking agency
       ranked suggestions: email-named > sender history > domain; never a forced pick
  2 Stay: dates, room-type rows, board
  3 Prices: every room type x rates the party qualifies for, rooms left   (extend all-room helper with board + party)
  4 Staff picks -> [Make quote PDF/Excel/reply]   or   [Create provisional booking] (approved write; check send-on-save first)
  5 Review; Nava never sends
blank/ambiguous field -> question for staff to ask the client, never a default (e.g. single -> Queen and Twin both shown)
```

## 4. Slices

| # | Slice | Why now | Depends on | ETA guess (ledger-scaled) |
|---|---|---|---|---|
| 1 | Price grid before room pick on the quote pane (helper + board + qualifying rates) | Owner ask 158; quote bar | Helper extension; one read-only Labtest probe | ~90 min incl. gates + deploy |
| 2 | Party step: ranked suggestions, no forced company; split quote contact vs bill-to | Owner asks 157 (Nexus thread), "quote contact on new booking" bug | Same pane file as #1 → **runs after #1** (WIP = 1, same files) | ~60 min |
| 3 | Labtest DOM probe: where deposit/guarantee/payment live; does Save auto-mail the letter? | Blocks every payment branch and the create button | One HMS lock, Opus-driven | ~30 min |
| 4 | CHECK screen for unknown/ambiguous links | Prevents wrong-guest matches (pass bar) | #3 | later |
| 5 | Multi-ask (one card per guest/date) | 17/164 threads | Extractor schema | later |
| 6 | Memory A/B (Postgres hybrid vs Hindsight) | Defer | Quote bar passes; ≥100 labelled queries, 2 raters | later |

ETAs are judgement until a lane is briefed against the code (ledger: UI median 0.81, live-HMS 0.80).

## 5. Facts still missing (cheapest source)

| Fact | Source |
|---|---|
| Human Infor screen order | Reservationist screen-share of one booking (client call) |
| Where paid/guaranteed is recorded | Same call, or slice #3 |
| Does Save e-mail the letter automatically? | Slice #3 on Labtest (test guest only) |
| Rate-only ask → do staff save a reservation? | One question on the call |
| Dinner allowance vs DBB plan | Same call |
