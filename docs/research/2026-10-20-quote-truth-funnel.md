# Why the quote truth set is 8 threads, and the 10-thread bar (2026-10-20)

Read-only prod SQL (`BEGIN READ ONLY … ROLLBACK`), 2026-10-20 ~10:40Z. Counts only. Follows the [backtest pool](2026-10-20-quote-backtest-pool.md).

## The 10-thread bar

PRODUCT.md "Pass bars" row Quote: "≥ 10 threads". Added in commit `ba9b37696` (2026-10-14 retro), marked "proposed in the 2026-10-14 retro; owner confirms or edits". It is an agent-proposed minimum sample, not derived from volume or statistics. At n=8, 5/8 has a Wilson 95% interval of ~31–86%.

## Extraction only exists from 2026-09-21

| Week (Mon) | Inbound | Extracted |
|---|---:|---:|
| 07-27 … 09-14 | 522–941/wk | 0 |
| 09-21 | 687 | 51 |
| 09-28 | 879 | 878 |
| 10-05 | 924 | 900 |
| 10-12 | 1,647 | 1,619 |

"Widened to 120 days" added nothing because mail before 09-21 has no extraction. The `payload.action` field exists from ~10-06.

## Quote asks per day (latest extraction, action=quote_availability, SAST)

Mon 10-19: 8 quote, 22 new_booking. Fri 10-16: 9 / 19. Thu 10-15: 5 / 16. Weekends ~0.

Caveat: the 10-18/19 history-aware backfill (`extract-3e750d4a3e7c`) relabels mail that staff already answered as `no_action`, so older answered quotes drop out of action counts.

## Funnel to the backtest set

| Step | Count |
|---|---:|
| kind=quote inbound msgs, 45 days | 161 |
| … staff replied | 83 |
| … staff reply had a PDF | 36 |
| … arrival still in future (HMS can't price past dates) | 24 msgs ≈ 12 threads |
| … minus groups (≥10 rooms / event proforma, owner ask 150) | ~6 threads out |
| … plus reply-text truth (no PDF) | 8 threads scored |

Lead time arrival − ask (quote_availability): p25 1 d, p50 5 d, p75 16 d, p90 154 d. Most asks are for stays a few days out, so by backtest time the stay is past and cannot be re-priced.

## Miss detail (pre-reply extraction the backtest used)

| Msg | Extractor | Rows as extracted | What went wrong |
|---|---|---|---|
| 6508204c | `8648bac4f269` (10-13) | board **null**, 1 room, 1 adult | Board blank → prepare defaulted to B&B. Later version reads `dbb`. |
| e547b629 | `8648bac4f269` (10-12) | dbb, 4 rooms, adultsPerRoom **null** | 4 singles asked; null occupancy defaulted to 2 → double rate R2 310 vs R1 700 single |
| c307df06 | `17eec6648104` (10-15) | bb, 1, 1 | Board right; "government rate" not mapped (only DBB maps to Government) |
| f127953c | `609cf5391609` (10-16) | bb, 1, Single | Backtest script did not run party lookup, so no Tourvest contract — may be a backtest artifact |

## Yesterday (Mon 10-19 SAST)

262 inbound, 230 with a succeeded extraction, 32 with no extraction row (reason not checked). Extraction cost: ~$0.0011 per call (`usage.extraction.costUsd`); 10-19 UTC total $1.56 over 1,395 calls includes the history backfill. HMS runs created that day: staff_quote 55 succeeded / 35 superseded / 13 dead_letter; party 137 / 58 / 2.

## Pro forma and amend evidence

- Outbound PDFs named "pro forma", 60 days: 34 PDFs on 28 threads; 16 filenames name a group/tour/event. Filenames are hand-named ("… Revised Pro Forma Invoice.pdf"), not an HMS pattern like `HRCEN_Confirmation_Letter_<conf>.pdf`.
- Confirmation letters re-sent in the same thread (60 d): 3 threads, all reused the same confirmation number (n=3, weak).
