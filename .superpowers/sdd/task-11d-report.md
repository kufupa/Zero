# Task 11D Report — Action-specific Phase B gates

**Status:** DONE  
**BASE_BEFORE_THIS_TASK:** `898e34c6`  
**Commit:** (pending pin) — `feat(hms): restore Phase B action-specific evidence gates`  
**Slice:** preflight/status/doctor action matrix + role-proof v2 fixture update + find demotion absorption  
**Out of scope (later):** asm-exec / provision / PM2 (11E), live operator (12), registry cutover (13)

---

## What landed

| Area | Files | Behavior |
|------|-------|----------|
| Action-specific preflight | `phase-b-read-preflight.ts` | Table-driven gates → `DISCOVERY_READY\|PROOF_READY\|PROMOTE_READY\|ROLLBACK_READY`; exit `0` on ready |
| Non-circular discovery | same | Sealed fixture + closed discovery ops/branches only — **not** role-proof / exact manifest / prior discovery digest |
| Proof gate | same | Role-proof v2 (new schema) + reviewed manifest + discovery evidence + driver/controls |
| Promote / rollback | same | Promote: immutable release + loadable handler; rollback: active registry only (ignores live evidence) |
| No success-then-block | same | `PHASE_B_BLOCKED` removed from result union |
| Status snapshot | `phase-b-status.ts` | `PhaseBReleaseCapabilitySnapshot.productionActiveReadToolIds`; default `[]`; static `READ_TOOLS` = fixture contract only |
| Doctor | `phase-b-doctor.ts` | Consumes snapshot; find demotion → empty productionActive + decoupled; discovery codes = `DISCOVERY_READY` for HMS fixtures |
| Fixtures | preflight tests | Role-proof v2 fixture matches 11B schema (`operator_observed_runtime`, HMACs, surfaces) |

---

## Tests

```bash
cd apps/server-pilot
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
pnpm exec vitest run \
  tests/phase-b-read-preflight.test.ts \
  tests/phase-b-status.test.ts \
  tests/phase-b-doctor.test.ts \
  tests/hms-portfolio-release.test.ts \
  tests/hms-read-tools-registry.test.ts \
  tests/hms-live-proof.test.ts
pnpm build
```

**Result:** 6 files / 77 passed. `pnpm build` exit 0. No pilot-RDS. No AWS/browser/live HMS.

Coverage highlights:
- discovery ready without role-proof/manifest for fixture_verified find + quote
- proof blocks on stale v2 shape / missing discovery / missing driver; ready → `PROOF_READY` not `PHASE_B_BLOCKED`
- promote/rollback action-specific blockers + ready codes
- status/doctor empty productionActive by default; snapshot injection only for activation

---

## Commit scope

Staged Task 11D sources + tests + this report.  
Excluded: `docs/superpowers/plans/2026-08-05-phase-b-hms-read-expansion.md`

---

## Concerns

- `ops-hms-proof.sh` still emits stub `PHASE_B_BLOCKED` for some CLI paths — Task 12 owns live operator unlatch.
- Proof/promote/rollback injectables (`discoveryEvidencePresent`, `driverAndControlsReady`, release/handler/registry flags) are explicit seams until live paths wire real artifacts (12/13).
- `hms-contracts.test.ts` may still assert find-only productionActive — outside this slice suite; registry tests already expect `[]`.
