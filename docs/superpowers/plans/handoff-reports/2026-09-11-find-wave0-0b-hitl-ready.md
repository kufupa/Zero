# Handoff: find Wave 0 + 0b HITL ready

**Date:** 2026-09-11  
**Branch:** `feat/centurion-dashboard-tools`  
**Tool:** `hms_find_reservation`  
**Stop:** Wave A not started

## Delivered

1. **Wave 0 (exact):** live packaging + Match payload compare green (run6). Sentinel `guestName` fixed; honest `claimKeys` (no `ratePlan`).
2. **Wave 0b (surname+dates):** live packaging + compare green (run7). Mail admission candidate-id mismatch allowed only for `surname_dates`. Lastname filter fill unit-proved; ambiguous honesty unit-proved.
3. **HITL packet:** private checklist at `.private/hms-find-reservation-live-20260911/HITL-PACKET-wave0-0b.md` pointing at both evidence dirs (videos + result/oracle/compare).

## Human next

- Batch-review HITL packet videos + JSON.
- Sign off before authorizing Wave A (remaining reads).

## Code touchpoints (non-exhaustive)

- `apps/server-pilot/src/hms/live-guest-stay-driver.ts` — guest name composition / sentinel skip
- `apps/server-pilot/src/hms/reservation-candidate-session.ts` — honest claims; surname opens browser
- `apps/server-pilot/src/hms/live-read-manifest.ts` — surname lastname filter body
- `apps/server-pilot/src/ops/hms-proof-composition.ts` — `allowCandidateIdMismatch` for surname proof
- `apps/server-pilot/src/ops/hms-live-proof.ts` — `HMS_PROOF_SURNAME_CANDIDATE_PATH` axis
- `apps/server-pilot/src/ops/hms-find-match-compare.ts` — Match compare helper

## Safety

- Live overlays only; no Nava deploy/restart for this proof path.
- Private evidence stays under `.private/`; no PII in SSM stdout.
