# HANDOFF-F4 — amend in the pane (dates / room / guests)

Updated: 2026-10-16

## Done

PR https://github.com/kufupa/Zero/pull/348 (`feat/g-F4-10160221`, `3b8f24de1`)

Staff find a Labtest stay → pane amend form (HMS now | requested, changed rows highlighted) → **Preview** (HMS fills the diff, nothing saved) → **Approve** (digest-bound commit) → read-back screenshot.

`RESERVATIONIST_PANE_SAVE=lab`. Commit refused unless env is exactly `lab`.

## Selectors (probe is orchestrator)

CLI `AMEND_FIELDS` unchanged: `arrivaldate`, `departuredate`, `adults`, `children`, `roomtype`. Preview now fills those then shots `diff.png` before return. If a selector fails live, fix in `amend-stay.mjs` `SELECTOR_BY_FIELD` first.

## Proof this lane owns

- Unit: preview refuses non-Labtest when mode=lab; commit refuses a stale digest; form `amend-diff-row` is only changed fields.
- Remote typecheck `--baseline` (mail + server-pilot).
- PR + `@greptileai`, ≤2 fix rounds.
- Greptile round 1: fixed P1 edits leaking across bookings; clear ready preview on edit. Left HITL `recordedToolRun` P2 — no `amend_preview`/`amend_commit` kind without a schema change.

## Next (orchestrator)

1. Live probe, 20 min: `amend-stay.mjs` preview on a Labtest stay (`lab-proof.sh` if none). Confirm AMEND_FIELDS found.
2. Live proof (after F1): Labtest stay → arrival +1 day in the pane → Preview diff screenshot → Approve → HMS read-back shows the new date → cancel via F2 button.

## Not doing

Deploy, env flip, live HMS from this lane.
