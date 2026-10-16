# HANDOFF-POL2

Updated: 2026-10-16 04:27Z

## Status

Impl + focused tests green. Next: commit, remote typecheck (mail + server-pilot --baseline), `gh pr create`, `@greptileai`.

## Done criteria

| Check | How |
|---|---|
| (a) no yellow quote caveat when no quote | `rateCheck.length === 0` skips `ROOM_TYPE_CHANGED_COPY` |
| (b) each missing field once | hide new_booking Key into HMS when a Book card is showing |
| (c) direct defaults | Track=BAR, Source=Walk in, Guarantee=Non-Guaranteed Individual; party set → Track/Source empty |
| (d) room + rate | `matchRoomType` on room text; empty rate → BAR (PRE2 `rateCode` still wins) |

## Tests (this session)

- `apps/server-pilot`: aop-create-prefill 13, booking-draft 31, hms-todo-card 23, work-items-hms-todo 3 — pass
- `apps/mail`: booking-card 81, hms-todo-card 6 — pass

Production diff: 47+/12- on 4 allowed files. Under MaxLines 200.

## Not done

- No deploy (forbidden). Prod screenshots under `runs/proof/POL2/` need orchestrator after merge.
- No `gh pr` yet.
