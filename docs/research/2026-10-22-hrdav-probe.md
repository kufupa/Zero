# HRDAV read-only probe — 2026-10-22

Orchestrator D0. No Save. Slot `hms-slot@hrdav` CDP `127.0.0.1:19225`, secret `nava-zero/server-pilot/infor-hms-read-davinci`. First command: `fetch-quote.mjs` with `propertyCode=HRDAV` — login + Hotel Availability succeeded (no `ACCOUNT_PROPERTY_MISMATCH` / `PROPERTY_MISMATCH`).

## Attempts

| Run | Outcome | Note |
|---|---|---|
| 02:35Z A1 | `execution_failure` | `HMS_DUMP_SALES_STRATEGY=1` ENOENT `.private/create-screen/` (our dump path). HA already open. |
| 02:35Z A2 | `execution_failure` | leftover UI, `startdate` timeout. No third same-selector retry. |
| 02:39Z A1 | **`quote`** rc=0 | 1 adult, 2026-11-16/17, 45 options |
| 02:40Z A2 | **`quote`** rc=0 | 2 adults, 2026-12-08/09, 45 options |

Evidence (EC2): `/home/ubuntu/repos/zero/.private/playwright-quote/sr3-d0/`
- `2026-10-22T02-39-34-190Z-fac425a2` (1 adult)
- `2026-10-22T02-40-10-266Z-54b4306d` (2 adult)
Screenshots: `login-complete.png`, `hotel-availability.png`, `group-1-criteria-applied.png`, `group-1-availability-results.png`.

## Sales strategies (Ext store dump)

| value | display |
|---|---|
| PROMO | Promotions |
| BAR | BAR |
| PRESET | Preset |
| WS | Wholesale |
| NC | Negoticated Contracted |
| GOV | Government |
| AIR | Airline Crews |
| DOML | Domestic Leisure |
| OTHER | Other |

Dump: `/home/ubuntu/repos/zero/.private/create-screen/sales-strategy-store.json`. Probe shops used `salesStrategy=BAR`.

## Rate plans observed (BAR shop)

| code | label |
|---|---|
| BAR | Best Available Rate |
| BARRO | Room Only BAR |
| BLRB | Lifestyle Rewards Programme Rate |
| BARDIS | BAR Discount |
| DEF | Default |

## Board labels observed

- `Bed & Breakfast R` (18/45)
- `null` / not shown (18/45) — BARRO room-only
- `Bed & Breakfast NR` (9/45)

Board **codes** not exposed on summary rows. Do not invent `BB`/`DBB`. Unknown stays unknown (KTD4).

## Rooms (max nightly inventory on 2026-11-16 BAR 1-adult)

| code | label | max inventory observed |
|---|---|---:|
| JNRSUI | Junior Suite | 5 |
| EXKNGB | Executive King Balcony | 3 |
| EXKNGR | Executive King Round | 6 |
| EXKNGS | Executive King Square | 5 |
| DLXPAT | Deluxe Patio | 9 |
| DLXKNG | Deluxe King | 6 |
| ACCES | Accessible | 2 |
| STKNG | Standard King | 84 |
| STWN | Standard Twin | 28 |

`buildingCode` null on sampled rows. Max occupancy not on quote option.room. Sum of max inv = 148 (n=1 night, not a brochure publishedRooms).

**Shared codes with HRCEN:** `DLXKNG`, `STWN`. Never treat as the same product. No Centurion fallback.

HRCEN profile rooms (for contrast): DLXKNG, DLXQN, DLXTWN, EXKNG, LUXKNG, SKNG, STQN, STWN, SUITE.

## Prices

Currency ZAR. Sample nightly `amount` strings (1 adult BAR): 6300.00, 5670.00, 5280.00, … not zero. `displayed` e.g. `R6,300.00`. `rateScope=public` on BAR shop. `resolvedContext={}`.

## DOM vs HRCEN

Existing `fetch-quote.mjs` Hotel Availability selectors worked on HRDAV (menu Front Desk → Availability → Hotel Availability, `input[name=startdate]`, Search). No selector fork required for BAR summary shop. Criteria JSON `propertyCodes=HRDAV`.

## Brand assets

`/home/orca/nava-research/davinci/` has Outlook Quick Parts (airport transfer, confirmation, rates 2026, …), no quote PDF letterhead/logo. Fork 7: DV PDF uses property name + address only. Owner follow-up.

## Not done in this probe

- `read-reservation-codes.mjs`: needs confirmation-number input list. No IDs invented. Rate/room/board taken from Hotel Availability instead.
- `party-lookup.mjs`: still queued (needs one DV-mail agency name from read-only SQL). DOM of party search not yet compared.
- Government/Preset extra shops: not run (KTD5 = staff Search only; D0 BAR only).

## D2 stop rule

Rate/room/board **codes exist**. D2 may map from this factsheet. Unknown board codes stay unknown. Do not copy HRCEN dinner add-on or room list.
