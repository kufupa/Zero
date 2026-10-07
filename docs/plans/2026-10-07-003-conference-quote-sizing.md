# Conference quote sizing (v2 S5)

Aggregates only. No names or event titles.

**Date:** 2026-10-07. **Sources:** census-v2 flags, gap audit QW/PR.

## Volume

| Item | n | Source |
|---|---:|---|
| census-v2 `conference_or_group` | 178 | 1,189 rows |
| census-v2 `manual` bucket | 306 | includes conference + amend/cancel + long stay |
| QW genuine conference quote asks | 7 of 28 quote asks | delivery-week selection |
| PR event proposals (staff PDFs) | 52 | `[G]` earlier count |
| PR event contracts | 33 | `[G]` |

Luna already flags `conference_or_group` and the pane shows “handle manually”. Groups of 10+ rooms, delegates, or events take this flag (K2 mapping).

## Why not this sprint

Conference quotes need venue/day delegate rates, packages, and often a different HMS path than room quotes. Staff already handle them as a separate desk. Room-quote + booking drafts + extras cover the accommodation lane first.

## Sized follow-up (not scheduled)

- Keep the flag + “not supported yet” copy (already live).
- Do not loop `executeStaffQuote` for 10+ rooms.
- A later plan: conference packet = dates + pax + rooming vs day-delegate, priced only from HMS/staff rates, never the model.
- Revisit after amendment assist (178 `amendment_or_cancel` rows outrank conference for booking-desk mail).
