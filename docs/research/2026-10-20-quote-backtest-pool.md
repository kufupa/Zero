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

## Scoreboard — individual threads, prod `593d36283` (2026-10-20 ~04:10Z)

**Truth set (n=8).** Inbound quote asks, individual (non-group), stay still in the future, staff priced. Truth is the staff PDF (pdftotext) or the staff reply text. Groups are out (owner ask 150). The ≥10-thread bar was **not reachable**: widening to 120 days only added groups.

**Method.**
- Each ask was priced once on Nava's HMS login through the live prepared-quote path (`buildPreparedStaffQuotePlan` → serial HMS `staff_quote` job, priority 0).
- Input = the ask's **pre-reply** extraction. 6/8 carry a later history-aware extraction (`extract-3e750d4a3e7c`, 10-18/19 backfill) that marks them `no_action` because staff had already replied. Live prepare correctly skips those, so live prepare can't be backtested on answered mail.
- The script was untracked on EC2: `apps/server-pilot/scripts/_backtest-reprice-20261020.ts`. Runs are marked `metrics.backtest='2026-10-20'`, keys `hms-job:staff-quote-backtest-20261020*`. Read-only HMS; no writes.

**Match rule.** Plan class + board + room category/occupancy.
- Plan class: BAR / government / contract.
- Board: BB / DBB.
- Room: standard vs deluxe, and occupancy. A staff "single" is occupancy 1 on any standard room.
- Price is reported separately.

| Msg | Ask as extracted | Nava (593d36283) | Staff truth | Class | Board | Room | Result |
|---|---|---|---|---|---|---|---|
| b0b003f2 | DBB 1×1ad | NGOVDB SKNG DBB R1 700 | NGOVDB R1 700 | ✅ | ✅ | ✅ | **match, exact price** |
| f0ad8779 | BB 1×1ad | BAR SKNG BB R1 940 | BAR R1 940 | ✅ | ✅ | ✅ | **match, exact price** |
| 5af62fbf | BB 1×1ad | BAR SKNG BB avg R2 020 | R1 980 flat | ✅ | ✅ | ✅ | match (price moved; quoted 5 days apart) |
| 9526392b | BB 2 rooms ×2ad | BAR STWN+SKNG BB R1 912 | BAR R1 940 single / R2 140 double | ✅ | ✅ | ≈ | match class (price differs, no HMS reason found) |
| c307df06 | BB 1×1ad | BAR STWN BB R1 940 | "government rate BB" (NGOVB), no staff price | ✗ | ✅ | ✅ | miss: government B&B ask not detected |
| f127953c | BB 1×1ad | BAR SKNG BB R1 780 | Tourvest contract R1 140 | ✗ | ✅ | ✅ | miss: no party run, so no contract |
| 6508204c | **BB** 1×1ad (extraction miss) | BAR SKNG BB R1 940 | NGOVDB DBB R1 700 | ✗ | ✗ | ✅ | miss: extraction said BB |
| e547b629 | DBB **4×2ad** (extraction miss) | NGOVDB STQN DBB R2 310 | NGOVDB R1 700 single | ✅ | ✅ | ✗ | miss: extraction occupancy |

**Score: 5/8 plan class + board + room** (2/8 exact price).
- Pre-deploy baseline on the same 8 rows (latest prod run per ask, 2026-10-19 runs on `1181ca923`): **1/8** (f0ad8779). Every DBB ask was priced BAR B&B or dead-lettered.
- n=8 is below the PRODUCT.md bar (≥10), so the quote bar is **not passed**.

**Misses by cause.**
- Extraction board/occupancy: 2.
- Party/contract not bound: 1.
- Government B&B ask not detected: 1, counted as a class miss. Only DBB maps to Government today.

**Run-health findings (not fixed tonight).**
1. **Queue TTL:** a `staff_quote` still queued after 10 min is superseded (`run-ledger.ts` `HMS_STAFF_QUOTE_QUEUE_TTL_MS`). 3 of 8 expired when 8 were queued at once (~2 min each). A morning burst of ≥5 prepares loses the tail.
2. **One attempt for prepared quotes:** a transient failure dead-letters a prepared quote after 1 attempt (`hms-jobs.ts` `retryOrFail(... systemPreparedQuote ? 1 : JOB_MAX_ATTEMPTS)`). 2 of 8 dead-lettered, then succeeded on a manual retry minutes later. This matches the ~15% "staff quote execution failed" dead-letter class.

## Post-run production check — 2026-10-20 10:18Z

Read-only prod SQL and nginx check; current deploy remained `3e1acb694`.

| Queue tier | Rows in window | Wait p50 / p90 | Caveat |
|---|---:|---:|---|
| 10 (staff) | 10 succeeded | 3 s / 82 s | Small 05:00–10:05Z sample; not a reliability estimate. |
| 0 (prefill) | 48 succeeded, 1 dead-letter | 3 s / 50 s | Dead-letter was `staff_quote`; prepared-quote retry/TTL issue remains. |
| DEV | 0 observed | — | No DEV rows means staff-hours hold behavior remains unproved. |

Nginx recorded `nava-pane-D0woVfWG.js` at 05:12:56Z and 10:18:57Z (200; two distinct source IPs). Requester identity was not verified; this proves asset requests after deploy, not staff identity or viewer completion. See [full run retro](2026-10-20-overnight-quote-retro.md).
