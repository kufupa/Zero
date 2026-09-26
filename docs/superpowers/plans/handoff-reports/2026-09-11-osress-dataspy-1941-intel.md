# OSRESS / dataspy 1941 — Infor intel capture (Wave 0)

Date: 2026-09-11.  
Owner surface: Guest Stay search (`OSRESS`).  
Sanitized fixture: `apps/server-pilot/evals/hms/osress-grid-dataspy-1941.live-shape.v1.json`.

## Surface

| Item | Value |
|------|-------|
| Path | `/web/base/OSRESS.search` |
| GRID_NAME | `OSRESS` |
| DATASPY_ID | `1941` (“All”) |
| SYSTEM_FUNCTION_NAME | `OSRESS` |
| USER_FUNCTION_NAME | `OSRESV` |

## GRID DATA keys (live)

**Present:** `confirmationnumber`, `externalconfirmation`, `primaryguest`, `lastname`, `firstname`, `arrivaldate`, `departuredate`, `status`, `room` (room number).  
**Absent on search grid:** `roomtype`, `rateplan` — do not invent; rates/room type → Guest Stay detail / Rate Details (`hms_read_reservation`).

## Sentinels

- `primaryguest: "-1"` (and other numeric-only) is **not** a display name.
- Compose display from `lastname` + `firstname`.

## Search filter aliases (exact body)

Posted OR-chain includes: `confirmationnumber`, `room`, `lastname_filter`, `secondlastname`, `alternatelastname`, `aliaslastname`, `loyaltynumber`, `externalconfirmation`, plus date window on `departuredate`/`arrivaldate`.  
**No `firstname` filter** on this scaffold — Wave 0b uses surname (lastname family) + dates only until a dump proves otherwise.

## Denied / mutate

Find must not open Guest Stay detail (`open_guest_stay_detail` denied on find registry). Search grid only.

## Cross-links for later tools

| Fact | Owner |
|------|--------|
| Display name / label | Find GRID (compose) |
| ratePlan / nightly rates / policies | `hms_read_reservation` (Rate Details / detail) |
| roomType (catalog type, not room #) | Detail if GRID lacks `roomtype` |
| Folio / deposits | `hms_read_folio` |
