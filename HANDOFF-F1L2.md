# HANDOFF-F1L2 — booking card at once, guest names editable

Updated: 2026-10-16T02:41Z

## Done

Single-stay `create_booking` mail asks `prepareUnquotedBookingDraft` **on open**, in parallel with staff-quote job polling. A priced quote that binds first still wins (reducer drops the unquoted draft).

Booking card:

| Field | Before | After |
|---|---|---|
| First / last name | Read-only `CopyRow` | `RoomTextField`, prefilled, kept until Book |
| Empty name | Book still offered | Preview/Book locked: `Set first name` / `Set last name` |
| `schemaErrors` | Raw `$.roomType required` | Not rendered (field-level Set line already says it) |
| `Nava does not write to HMS` | Shown on Key into HMS above Book | Hidden for `new_booking` |

## Proof

- mail `tests/booking-card.test.tsx` **78 passed**
- mail `tests/hms-todo-card.test.tsx` **6 passed**
- mail `tests/nava-pane-render.test.tsx` unquoted-on-open + restored-rate tests **passed**
- Screenshots: `runs/proof/F1L2/book-card-editable-names.png`, `book-card-empty-first-name.png`
- Remote typecheck `--app mail --baseline`: **new=0** (62/62)
- Greptile: round 1 P1 (unquoted card aborted quote poll) **fixed** (`priorQuoteKey` no longer includes `bookingDrafts`). Round 2 P1 (keep unquoted card across `staff_quote_ready`) **stripped** — quoted rooms use different `groupId`s, so keeping the mounted card would empty `ratePlan`/choices. Spec: priced quote wins; card remounts on the quoted draft.

## Not doing

Deploy, env edits, live HMS, quote-workflow-panel.tsx (not in Allowed).
