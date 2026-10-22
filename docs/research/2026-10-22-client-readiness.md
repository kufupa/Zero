# 2026-10-22 client readiness: Centurion (HRCEN) and Da Vinci (HRDAV)

**Verdict: no workflow meets "live and proven" yet. Centurion uses Nava daily for reads (triage, prepared quotes, lookups), but quote accuracy is unproven and stay lookup fails often. Writes are Labtest-only. Da Vinci has mail ingest and pane HMS reads, but no quote pricing and no writes.**

Sources:
- Read-only prod SQL at 2026-10-21 ~23:55Z, on `b11e5ac52` (7-day counts, no PII).
- Prod flags read from `/proc`: `RESERVATIONIST_PANE_SAVE=lab`, `HMS_DAVINCI_READS=on`.
- Code on `origin/main`.
- Luna lane L3 (`/tmp/sr2/retro/lanes/L3.out`).

## 1. Live usage, last 7 days (HMS tool runs)

| Tool | Centurion ok / failed / refused | Da Vinci ok / failed / refused |
|---|---|---|
| quote | 97 / 0 / 144 (`PRECONDITION_FAILED`, missing inputs) | 0 / 0 / 6 |
| stay_lookup | 71 / 90 / 66 (`refused_lock_busy`) | 8 / 0 / 0 |
| guest_search | 43 / 24 / 0 | 9 / 0 / 0 |
| booking_draft | 17 / 0 / 26 (`quote_revision_unavailable`) | — |
| stay_preview / stay_commit (Labtest) | — | 3 ok; commit 1 ok / 1 failed |
| cancel_preview / commit (Labtest) | — | 4 ok, 2 failed; commit 2 unconfirmed |

- **Correction (2026-10-22 ~00:30Z):** the 7-day window mixed in old code. The 66 `refused_lock_busy` were one burst on 10-16, and most failures were a 10-17/18 night burst, all before the SR2 rewrite. Only runs since deploy #7 (`b11e5ac52`, 2026-10-21 10:58Z) judge the current build: so far stay_lookup 3 ok / 3 failed (the 3 failures are one input retried), guest_search 3/3 ok, quote 1 ok / 2 refused. n is too small to call. Failed lookups store no error text.
- Workflow runs in 7 days: inbound_extraction 3,531 succeeded; inbound_triage 1,570; read_tool 589 succeeded, 42 dead-lettered.

## 2. Workflow × client

| Workflow | Centurion | Da Vinci | Blocker |
|---|---|---|---|
| Front-door triage | Live, unproven (gold n=6) | Live, unproven | DV: the 3,363 promoted rows skipped AI; new DV mail not yet proven. The legacy pre-stay matcher hardcodes HRCEN (`triage.ts:955–959`) |
| Quote (prepared + staff) | Live, unproven: 5/8 class+board+room, 2/8 exact price, n<10 | **Not built** | Staff quote routes require Centurion origin (`workstation.ts:817–881`); the draft worker is HRCEN-only |
| Stay lookup / guest search | Live; current-build n too small (since deploy #7: 3/6 lookups ok, 3/3 searches ok) | Live (small n) | No error text on failures |
| Create booking | Labtest only (Save passed) | Not built | Writer pinned to HRCEN (`pane-stay-save.ts:22–24`) |
| Amend | Labtest only, refuses on blank deposit | Not built | Owner payment rule (D1) |
| Cancel | Labtest only (PRODUCT.md) | Not built | Commit unconfirmed ×2 |
| POP / voucher | Find booking + download attachment; staff upload in HMS | Same, via HRDAV search | No HMS attach write |
| Multi-stay | Pane UI live, unscored | Not built | No multi-stay score |

## 3. What this means for handing it to staff

- **Centurion:** not yet released to staff; staff are not using the pane (owner, 2026-10-22). Release needs the Make quote price score on the current build and an end-to-end flow where staff only approve.
- **Da Vinci:** not ready beyond reading mail and looking up bookings. Quote pricing needs HRDAV rate reads; writes need an HRDAV writer and lock.
