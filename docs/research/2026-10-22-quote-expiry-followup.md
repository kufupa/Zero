# Quote-expiry follow-up — corpus counts (ask 175)

Read-only. Counts only. No mail bodies. No prod query.

**Source:** `/home/orca/nava-research/corpus/2026-10-13` (R1 frame: 12,433 messages, 2026-07-30 → 2026-10-13). Script: `/tmp/quote-expiry-counts.py` plus a tightened quote detector.

## Staff quotes

| Set | n | Definition |
|---|---:|---|
| Staff outbound | 3,438 | `direction=outbound`, from `legacyhotels.co.za` |
| Tight quote replies | **349** | wrapper “please see attached quotation” **or** quote-named PDF **or** PDF “Valid until: 3 days” |

Of those 349:

| Signal | n | Notes |
|---|---:|---|
| Wrapper body | 345 | Gold cover mail |
| Quote-named PDF | 111 | filename `Quote` / `Quotation` / `Proposal` |
| PDF “Valid until: 3 days” | 125 | 125/127 quote-named PDFs |
| Body “no rooms are currently being held” | 297 | gold disclaimer; **not** an inventory hold |
| Body claims rooms **are** held | **1** | |
| Body says 72 hours | 0 | |

## 72 hours vs 3 days

| Where | n | What the match is |
|---|---:|---|
| Confirmation PDFs with “72 hours” | 1,176 / 1,179 | deposit: “amount is required, 72 hours after tra…” |
| Quote-named PDFs with “72 hours” | 0 | |
| Quote-named PDFs with “Valid until: 3 days” | 125 / 127 | the quote validity window |

Client “valid for 72 hours” = the PDF’s **3 days**. Confirmation-letter 72 h is a different clause.

## Follow-up before expiry (after the 349 quotes)

| Outcome | n |
|---|---:|
| No later staff mail | 244 |
| Client inbound within 72 h | 86 |
| Later staff mail | 105 |
| …of which next staff mail is another quote | 98 |
| Chase-like (not quote, not OOO) | **7** |
| Chase-like **before** any client reply | **0** |

Hour buckets for any later staff (mostly a revised quote): 0–6 h 50, 6–24 h 14, 24–48 h 10, 48–66 h 1, 66–72 h 4, 72–96 h 6, 96 h+ 20.

Chase-like wording on those 7 (after a client reply): check-in/follow-up 4, did-you-receive 1, other 3, still-interested 0, expiry words 0.

## Product read

Staff do not chase unanswered quotes before the 3-day window ends. They state **no rooms held** and put **Valid until: 3 days** on the PDF. Nava’s 66 h draft is new work, not a copy of current staff mail. Trigger = validity/hold-*window* language (gold cover or “valid until”), not an HMS hold.
