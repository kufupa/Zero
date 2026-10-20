# 2026-10-20 quote backtest pool (read-only prod counts)

Read-only SQL on prod (`BEGIN READ ONLY … ROLLBACK`), 2026-10-20 ~02:20Z. Counts only, no mail content. Source: `message`, `mail_extraction` (latest succeeded, `kind='quote'`), `attachment`, `ai_workflow_run`. Arrival = `payload.stays[].requested.arrival`.

| Stage (last 45 days, inbound, kind=quote) | Count |
|---|---:|
| Quote asks | 161 |
| Staff replied in thread | 83 |
| Staff reply carried a PDF | 36 |
| Arrival date extracted | 134 |
| Arrival still in the future | 79 |
| **Future arrival AND staff PDF (price backtest pool)** | **24** |
| Future arrival AND any staff reply | 35 |
| Asks in last 7 days | 67 |

Nava's latest `staff_quote` run on the 24-row pool: succeeded+ready 6, no run 11, dead_letter 3, superseded 3, succeeded+null 1.

Why future-only: HMS cannot price a past stay, so a fair price backtest needs a stay that is still bookable. Prices may have moved since staff quoted; a mismatch needs an HMS-side reason (rate change, sold out) before it counts against Nava.

Caveats: `kind='quote'` is the extractor label (precision ~88% on the 431-row frozen set), so a few rows will not be real quote asks; false negatives in other kinds are not in this pool. Thread-window pairing, not In-Reply-To.

## First truth pass (2026-10-20 ~02:40Z, read-only: staff PDF via pdftotext on EC2, Nava run read_result)

24 rows collapse to ~12 unique threads (repeat mails in one thread). One row (b4afb3de) is a complimentary booking confirmation, not a quote. ~6 threads are groups (≥10 rooms or event proforma).

| Thread (arrival) | Staff PDF | Nava latest run (BAR) | Match |
|---|---|---|---|
| 16–20 Nov, 1 single B&B | R1 940/night, R7 760 | Std Twin BAR R1 940, R7 760 | **yes** |
| 03–07 Nov, 1 single B&B (+2 transfers) | R1 980 flat ×4 + transfer R1 200 | BAR R1 940,1 940,2 100,2 100 = R8 080; no transfer | no (dated 5 days apart; rate change possible) |
| 18–20 Nov, 1 single **DBB** | **R1 700** DBB | BAR B&B R1 940 + dinner needed | no — staff rate below BAR = contract rate |
| 18–19 Nov, 10 single + 5 double B&B | R1 560 single | BAR R2 140, 5 rooms | no — group rate + qty |
| 28–29 Nov, 40 twin B&B | R1 930 | BAR R1 810 | no — sharing occupancy / group |
| Not run: 22 Oct 16 single DBB, 08 Nov single DBB, 05 Jan 4 single DBB | all **R1 700 DBB** | — | — |

Pattern: R1 700 single DBB appears on 5 threads → a recurring contract/package rate Nava never picks (it prices BAR B&B). Biggest failure class for the price bar.
