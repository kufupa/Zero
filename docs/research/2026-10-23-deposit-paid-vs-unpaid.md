# Deposit paid vs unpaid (HRCEN) — 2026-10-23

Masked confs only. No guest names.

## Unpaid Labtest (stay-lookup find with arrival)

| conf | arrival | status | room/plan | avg | balance | guarantee | deposit in stay JSON | deposit in record-form.html |
|---|---|---|---|---|---|---|---|---|
| 66865808-1 | 2027-12-08 | Reserved | STQN / BAR | 2060.00 | 0.00 | Non-Guaranteed Individual | **missing key** | `depositreceived`, `depositreceivedcurrency` present |
| 25526053-1 | 2027-10-12 | Reserved | STQN / BAR | 2060.00 | 0.00 | Non-Guaranteed Individual | **missing key** | (same dump path) |

P1 cancel preview on 66865808-1: `preview_ok`, clickedOk=false, **penaltyText=null**, stay still Reserved.

## Paid POP controls (SQL)

10 unique `mail_extraction.kind=voucher_pop` confs in last 30d (no names). Re-read 2026-10-23 08:40Z via `stay-lookup.mjs --mode find` on live `bf22d01a0` after #518 (blank deposit stays `''`). Masked confs only.

| conf | outcome | arrival | status | guaranteeType | depositReceived | classifyAmendPayment |
|---|---|---|---|---|---|---|
| 46870354-1 | found | 2026-11-18 | Reserved | Guaranteed By Deposit | `''` | guaranteed |
| 99289422-1 | not_found | | | | | — |
| 15993631-1 | found | 2026-10-24 | Reserved | Deposit Requested | `''` | guaranteed |
| 62631758-1 | found | 2026-10-26 | Reserved | Guaranteed By Deposit | `''` | guaranteed |
| 91718486-1 | found | 2026-10-25 | Reserved | Guaranteed By Agent | `''` | guaranteed |
| 68899503-1 | found | 2026-10-22 | In-house | Deposit Requested | `''` | guaranteed |
| 31801521-1 | not_found | | | | | — |
| 38174465-1 | not_found | | | | | — |
| 29149611-1 | not_found | | | | | — |
| 95445187-1 | found | 2026-10-25 | Reserved | Guaranteed By Deposit | `''` | guaranteed |

**U5-E bar: 0 of 6 found classify as `unpaid`.** Paying guarantee (`Guaranteed*` / `Deposit Requested`) returns `guaranteed` even when Deposit Received is a confirmed blank. 4 not_found (no arrival on the confirmation-only search).

`hms-proof-run.ts find` cannot read these rows: `assertLabRequest` returns `refused_not_lab`.

## Root cause (session_stub, morning)

1. Slot reused after stay-lookup / cancel-preview / create-preflight. Guest Stay search returned session-stub HTML (813 bytes).
2. Reader does `login` once, then on stub **exits the batch**. No second login, no recover.
3. Open path #516/#517 + stay-lookup find is the reader used above.

## Amend/cancel go-live

#518 live: blank deposit is `''`, not null. Unpaid Labtest = Non-Guaranteed + Reserved + blank/0 deposit. Paid POP controls above do not classify unpaid.
