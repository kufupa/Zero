# Stay-request lifecycle: what staff actually send, and how quote/booking/letter link (2026-10-20)

Status: evidence file for the agent-architecture rethink (owner asks 155–160). Every number names its query/source. Read-only prod SQL (`BEGIN READ ONLY … ROLLBACK`) and a read-only S3 PDF sample on EC2, run 2026-10-20 10:20–11:30Z by Opus. Inferences are marked **(inference)**. Owner claims are marked **(owner)**.

## 1. Answer first

- Infor HMS emails one document after a booking is saved: `HRCEN_Confirmation_Letter_<conf>.pdf`, subject `The Centurion Hotel_Confirmation Letter_<Guest> (n°<conf>)`. **It is the "proforma"**: the PDF body has a "Proforma" table (nights × rate, Nett, VAT, Deposit paid, Total) and the "remains provisional … unless guaranteed" clause (owner pasted one; sample below agrees). Owner was right; my earlier "pro forma is separate" was half wrong: hand-named "… Pro Forma Invoice.pdf" files also exist, mostly for groups/events.
- So **quote and new booking converge**: a large share of quote asks are answered by creating a provisional booking in HMS, which auto-emails the priced letter/proforma.
- The HMS letter arrives in its **own thread**, a median **12 min** after the staff text reply → cross-thread linking is required and a ±30–60 min window fits **(owner heuristic, supported)**.

## 2. Outbound since 2026-09-09 (prod SQL `j.sql`)

| Measure | Count |
|---|---:|
| Outbound messages | 2,106 |
| … with a PDF or Excel | 1,041 |
| … with an `HRCEN_*` PDF (HMS-generated) | **625** (624 Confirmation_Letter, 5 `HRCEN_Offer`) |
| … with a non-HRCEN PDF | 418 |
| … with Excel | **9** |

Non-HRCEN PDF families by first word: "Quote …" 64, scanner `doc…` 32, "Amazing …" 22, "Room …" 15, "CTI …" 12, "Bank …" 12, group names, vouchers, function sheets. **Hand-made "Quote" PDFs ≈ 64 in 6 weeks (~2/working day)**; Excel quotes are rare (9).

Correction: my earlier "16 quote-PDF threads" counted only replies inside the same thread as an extracted quote ask (45 d). It undercounted; the mailbox-wide number is 64 Quote PDFs since 09-09. Weekly outbound coverage looks complete (298–488/week).

## 3. HMS letter content (200 random letters since 09-09, pdftotext on EC2, `letters.sh`)

| Variant | Letters |
|---|---:|
| Proforma table + "Deposit paid 0.00" + provisional clause, Bed & Breakfast | 123 |
| Same, Dinner, Bed & Breakfast | 56 |
| No proforma table (B&B / DBB) | 15 |
| Other / "TENTATIVE" text present | 2 |
| Any letter with **Deposit paid > 0** | **0 / 200** |
| "Dinner allowance / meal allowance" text | 0 / 200 |

- Email bodies/subjects of 625 HMS letter mails: 0 contain "tentative" (`k.sql`). "Tentative reservation confirmation" appears inside a few PDFs only (2/200) **(inference: a different HMS template/print option, not the norm)**.
- Every sampled letter is provisional with deposit 0 → the letter is sent at **save time, before payment**. It does not by itself say paid vs unpaid; payment state needs another source (POP mail, voucher, HMS deposit/folio read).
- Board split in letters: B&B ~64%, DBB ~30%. DBB letters show "Rate Includes: Dinner, Bed & Breakfast"; no separate "allowance" wording seen. Dinner allowance as an add-on: **not found in letters; ask client**.

## 4. Quote/booking ask → staff reply → HMS letter (prod SQL `j.sql`, asks since 09-21)

Population: first inbound per thread where the latest extraction kind ∈ {quote, booking}, sender address known: **642 asks**.

| Measure | Count |
|---|---:|
| HMS letter to the same sender address within 3 days | **92 (14%)**, lower bound |
| … letter within ±30 min of the first staff reply in the ask thread | 53 |
| … within ±60 min | 54 |
| Lag letter − staff reply, p25 / p50 / p75 | **2 / 12 / 20 min** |

- Lower bound because: agents often send from one address and receive at another; letters go to the address typed in HMS, not always the sender; extraction kind misses; history-backfill relabels.
- Earlier figure "37/128 quote threads (29%)" was kind=quote only, 45 d. Both are lower bounds.
- Send minutes in the Aug outbound index cluster at :01 and :21–:22 **(inference: HMS batch send ~every 20 min; owner was told ~15 min)**. Window recommendation: match on sender/recipient + guest name + ±60 min after staff reply, falling back to ±3 h.

## 5. Quote asks per day and the truth funnel

See [quote truth funnel](2026-10-20-quote-truth-funnel.md): 5–9 quote asks per weekday, ~22 new_booking; the 10-thread bar is an agent proposal (commit `ba9b37696`), never owner-confirmed.

## 6. Party "history" (what it is today)

Not a local copy of HMS profiles. It is **sender → HMS party learned from past bookings and staff picks** (migration 0051, #410/#414/#417/#418). Leave-one-out: agencies 82/107 right, 0 wrong, 25 abstain; companies 37/115 right, 2 wrong ([decision](2026-10-19-party-strategy-decision.md) E5/E7). Owner idea "same profile staff used for this domain" = this mechanism; it can be extended with letter-derived truth (letters name the agency/company line, e.g. "Phophi Travel Tour and Projects / Department of Transport").

## 7. Owner decisions recorded (2026-10-20 ~11:00Z, ask 160+)

- OK to switch quote scoring to "Nava's prepared price vs staff's same-day reply/letter"; OK to keep repricing old quotes; OK to change the ≥10 bar.
- Do **not** start the three quick UI fixes yet; architecture and Infor-order research first, then design the pane from it.
- Payment state is the big split: **unpaid** (quote, provisional booking) = in scope now and high confidence; **paid** amend/cancel = second phase.
- Cross-thread linking must handle travel agents sending many requests in short windows, inside and outside threads.
- Missing-info patterns (names for "3 pax", child ages, room sharing, "would you like dinner") should come from the corpus.
- Outside-voice review: Grok 4.7 xhigh via grok CLI, never fast models.
- Exa: agent "auto" first on mem0/Letta/Hermes viability; then a longer xhigh/ultra run if gaps remain.

## 8. Open, not yet checked

- How staff pick Queen vs Twin for a "single" (letter example: single on Standard Twin).
- When staff send a hand "Quote" PDF vs create a provisional booking (letter).
- Whether "HRCEN_Offer" (5) is the HMS quote-without-booking document **(inference)**.
- Paid vs unpaid detection source per booking.
