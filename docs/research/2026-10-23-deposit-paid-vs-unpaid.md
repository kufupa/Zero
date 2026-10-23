# Deposit paid vs unpaid (HRCEN) — 2026-10-23

Masked confs only. No guest names.

## Unpaid Labtest (stay-lookup find with arrival)

| conf | arrival | status | room/plan | avg | balance | guarantee | deposit in stay JSON | deposit in record-form.html |
|---|---|---|---|---|---|---|---|---|
| 66865808-1 | 2027-12-08 | Reserved | STQN / BAR | 2060.00 | 0.00 | Non-Guaranteed Individual | **missing key** | `depositreceived`, `depositreceivedcurrency` present |
| 25526053-1 | 2027-10-12 | Reserved | STQN / BAR | 2060.00 | 0.00 | Non-Guaranteed Individual | **missing key** | (same dump path) |

P1 cancel preview on 66865808-1: `preview_ok`, clickedOk=false, **penaltyText=null**, stay still Reserved.

## Paid POP controls (SQL)

10 unique `mail_extraction.kind=voucher_pop` confs in last 30d (no names, arrival empty in payload):

`46870354-1`, `99289422-1`, `15993631-1`, `62631758-1`, `91718486-1`, `68899503-1`, `31801521-1`, `38174465-1`, `29149611-1`, `95445187-1`

**HMS field reads did not run.** `read-reservation-fields.mjs` hit `session_stub` on the built-in positive control (`59898948-1`) twice and **broke the loop** (`read-reservation-fields.mjs:477`). No paid row has `guaranteetype` / `depositreceived` from HMS.

## Root cause (session_stub ×2)

1. Slot reused after stay-lookup / cancel-preview / create-preflight. Guest Stay search returned session-stub HTML (813 bytes).
2. Reader does `login` once (`:455`), then on stub **exits the batch** (`:477`). No second login, no recover.
3. `hms-job.sh` refuses raw `.mjs` (only `src/ops/hms-proof-run.ts`). Cannot wrap this reader in U0 until a find/read subcommand exists.

Fix: re-login once on `session_stub` and retry the same conf; do not abort the paid list on the Sep-15 control.

## Amend/cancel go-live

Blocked on paid deposit vs unpaid. Unpaid = Non-Guaranteed, balance 0, no penalty on cancel preview. Paid = unknown until a recovered read.
