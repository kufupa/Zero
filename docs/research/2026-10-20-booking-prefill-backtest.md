# 2026-10-20 booking prefill backtest

**Result:** 10 future, person-authored `new_booking` mails sampled; only 1 has a same-thread HMS find receipt, and that receipt is not confirmation-linked. Its saved booking-card source matched dates, occupancy, board and rate, but selected wrong room code and had no party. Treat all scores as provisional, not a reliability estimate.

## Method

- Read-only production SQL snapshot on 2026-10-20. Filter: Centurion transport, inbound non-history mail, latest succeeded extraction within 45 days, `action=new_booking`, `origin=person`, future requested arrival.
- Pool: **26 messages / 23 threads**. Selected 10 unique threads, prioritizing the one with a later found-HMS receipt, then including single/multi-room, missing-field, `voucher_pop`-kind, and 35-room cases. Purposive sample, not random.
- Direct prefill evidence: same-message saved quote revision where present (**6/10**); remaining four had no persisted same-message revision. HMS truth: successful same-thread `find` receipt; outbound subject/PDF confirmation-code signal checked without exposing subjects, filenames, or full IDs.
- No guest names, contact details, email bodies, or full message/run IDs included. Company/agency names below come only from the extraction's party field.

## Per-mail comparison

`BB` = breakfast; `DBB` = dinner + breakfast. `—` = not observed. Prefill lists saved revision values, not a screenshot of the rendered card.

| Mail ID | Extracted request: dates; rooms × adults / type; board; party text | Saved prefill source | HMS truth / source | Score |
|---|---|---|---|---|
| `343045c4` | 2026-11-03→07; 1×1 / Single room; BB; GP Destination Management SL | 1×1, `SKNG`, BB / `BAR`; party absent | **Provisional:** find `a1b25f8b`, 2026-11-03→07, 1×1, `STQN`, BB / `BAR`; party unavailable. Find triggered by later `payment_proof` mail `2f9c2936`; no confirmation link to this inbound or staff PDF/subject. | Dates ✓; occupancy ✓; room type ✗; board/rate ✓; party unscored |
| `2808c4e6` | 2026-10-21→22; 1×1 / standard room; BB; Land & Agricultural Development Bank of South Africa | 1×1, `STWN`, BB / `BAR`; party absent | None; 1 later outbound, no linked confirmation | No truth |
| `b6bf230c` | 2026-10-26→29; 1×1 / type missing; DBB; Thompsons Travel | 1×1, `STWN`, BB / `BAR`; party absent; v3 bound agency | None; 1 later outbound, no linked confirmation | No truth |
| `db035c7d` | 2026-10-25→30; 1×1 / type missing; BB; Nexus Travel; total rooms missing | No saved revision; v3 bound agency | None; 2 later outbounds, no linked confirmation | No truth |
| `6a295292` | 2026-10-25→29; 1×1 / type missing; board missing; party missing | 1×1, `STWN`, BB / `BAR`; party absent | None; no later outbound | No truth |
| `e337f4a4` | 2026-10-25→30; 3×1 / type missing; DBB; Nexus Travel | 3×1, `STWN`, BB / `BAR`; party absent; v3 bound agency | None; no later outbound | No truth |
| `f2d04c93` | 2026-10-22→23; 4×1 / normal standard rooms; DBB; Modikwa Platinum Mine | No saved revision | None; 1 outbound + 1 PDF, no linked confirmation | No truth |
| `c2c8b962` | 2026-11-16→21; 2×1 / Standard Non Smoking; DBB; Tourvest Travel Services. Extraction kind=`voucher_pop`. | No saved revision | None; 1 later outbound, no linked confirmation | No truth |
| `7b58eaeb` | 2026-11-12→13; 2×1 SGL + 6×2 DBL + 2×2 TWN; BB; No Limits Travel & Tours | No saved revision | None; no later outbound | No truth |
| `c158c6a2` | 2027-10-26→28; 20×1 Single + 10×2 Double + 5×2 Twin; board missing; AllSports Travel | 20×1 `STQN` + 10×2 `STQN` + 5×2 `STWN`, all BB / `BAR`; party absent | None; 1 outbound + 1 PDF, no linked confirmation | No truth |

## Field score

Scores below use the **one provisional same-thread find** only. No row had an outbound confirmation-code match; strict confirmation-linked truth denominator is **0** for every field.

| Field | Provisional matches / truth rows | Note |
|---|---:|---|
| Dates | **1/1** | Exact arrival and departure |
| Room count / occupancy | **1/1** | One found stay; 1 adult, 0 children; one room inferred |
| Room type | **0/1** | Prefill `SKNG` (Standard King) vs HMS `STQN` (Standard Queen) |
| Board / rate | **1/1** | Breakfast and `BAR` match HMS meal plan and rate plan |
| Party | **0/0** | HMS receipt had no company/agency value; cannot score |

## Gap classes and caveats

1. **Room type is weakest extraction field.** Across the 26-mail pool, 14/31 room rows lacked type; 6/31 lacked board. One row each lacked room quantity and adults. The only provisional HMS-linked card prefill also chose wrong room code (`SKNG` vs `STQN`). Code map: `apps/mail/config/room-types.js`.
2. **Quote context can drift from request and lose party.** Two revision-backed DBB requests (`b6bf230c`, `e337f4a4`) had B&B revisions. All six saved revisions had no party in group context; two also had a successful v3 agency bind. `buildBookingDrafts` takes party from revision context, so that bind is not represented in these saved draft inputs.
3. **Voucher and pre-stay checks.** 1/26 future person rows had `kind=voucher_pop` with `action=new_booking`; it is ambiguous, not scored as a false positive because owner policy allows vouchers to be booking requests. No future `new_booking` pre-stay self-mail matched the Centurion self-sender/recipient + “Pre Stay” check. No GDS case was adjudicated from this redacted sample.
4. **Not a full card-accuracy or acceptance score.** `workstation.prepareBookingDraft` calls `buildBookingDrafts` with quote revision; unquoted flow calls `buildCreatePrefill` then `bookingDraftFromPrefill`. Those functions show the field sources, but exact rendered drafts and staff edits are not persisted in the queried tables. Six of ten rows had a same-message saved revision; four did not. The one find was triggered by later payment-proof mail, same thread and matching dates, but had no confirmation link. Strict gold truth remains absent.

Read code at worktree `5f4b66f5d` (`origin/main` `3e1acb694`); production query was read-only. No DB writes, HMS operations, or mail sends.