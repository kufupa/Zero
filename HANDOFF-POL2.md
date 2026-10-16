# HANDOFF-POL2

Updated: 2026-10-16 04:42Z

## Status

**LANE_DONE PR=355** https://github.com/kufupa/Zero/pull/355

## Shipped

A single-stay new-booking mail shows one Book card:

| Check | Implementation |
|---|---|
| (a) no yellow quote caveat when no quote | `ROOM_TYPE_CHANGED_COPY` only if `rateCheck.length > 0` |
| (b) each missing field once | hide new_booking Key into HMS when a Book card is showing |
| (c) direct defaults | Track=BAR, Source=Walk in, Guarantee=Non-Guaranteed Individual. Party kind or name set → Track/Source empty |
| (d) room + rate | `matchRoomType` on room text; empty rate → BAR (PRE2 `rateCode` still wins) |

Greptile round 1 P1: nameless agency got Walk in. Fixed with optional `partyKind`. Round 2 check: success, no new comments.

## Tests

- server-pilot: aop-create-prefill 14, booking-draft 31, hms-todo-card 23, work-items-hms-todo 3
- mail: booking-card 81, hms-todo-card 6
- remote typecheck `--baseline`: mail 0 new, server-pilot 0 new

## Not this lane

- No deploy. Prod screenshots under `runs/proof/POL2/` need orchestrator after merge.
- `prepareUnquotedBookingDraft` (workstation.ts) is outside Allowed; it still omits `partyKind`. Name-based partySet still covers named agencies.
