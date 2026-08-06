# Task 11B Report — Evidence schemas & negative certification

**Status:** DONE  
**Commit:** `2493c0fa` — `feat(hms): add Phase B evidence schemas and negative gate`  
**Slice:** release-kernel v2 schemas + negative certificate binding/canonical digest + sole-path import boundary  
**Out of scope (later):** runtime/production-runtime auth wiring, preflight/status/doctor action matrix, asm-exec, env/PM2

---

## What landed

| Area | Files | Behavior |
|------|-------|----------|
| Role proof v1/v2 | `release-kernel.ts` | v1 moved out of `production-runtime` (no reverse import); strict v2 with `operator_observed_runtime`, HMAC bindings, TTL `>0` `<=30d`; `validateRoleProofV2ForTool` + `roleProofV2Path` |
| Receipt v2 | `release-kernel.ts` | Discriminated `discovery \| proof`; HMS-only toolId; discovery omits proof fields |
| Release v2 | `release-kernel.ts` | HMS\|mail evidenceKind + `live_verified`\|`shadow_enabled` qualification |
| Evidence binding | `release-kernel.ts` → `negative-result.ts` | Shared `HmsEvidenceBindingV1` |
| Negative cert | `negative-result.ts` | Certificate carries binding; canonical SHA-256 in schema field order; sole branded adapter to `BUSINESS_NOT_FOUND` |
| Import boundary | `production-boundary.ts` | Expanded sole-path scan (drivers, contracts, browser-artifacts, claim-envelope, worker, live-proof) |

---

## Tests

```bash
cd apps/server-pilot
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
pnpm exec vitest run \
  tests/hms-negative-result.test.ts \
  tests/hms-portfolio-release.test.ts \
  tests/hms-production-boundary.test.ts \
  tests/hms-read-kernel.test.ts \
  tests/hms-browser-artifacts.test.ts \
  tests/hms-claim-envelope.test.ts
pnpm build
```

**Result:** 6 files / 78 passed / 3 skipped. `pnpm build` exit 0. No pilot-RDS. No AWS/browser/live HMS.

Coverage highlights:
- canonical cert digest ignores key-order permutations; rejects digest mismatch / duplicate evidence / binding drift
- role proof TTL + cross-operation + mail rejection
- discovery/proof receipt discrimination; HMS/mail release qualification
- sole-path `collectBusinessNotFoundAssignments()` empty
- portfolio-release expectations updated for empty production-active set (post-11A find digest clear)

---

## Commit scope

Staged only Task 11B sources + tests + this report.  
Excluded: `docs/superpowers/plans/2026-08-05-phase-b-hms-read-expansion.md`

---

## Concerns

- `phase-b-read-preflight` / status / doctor still use old role-proof v2 fixture shape → will fail `safeParse` until later slice updates fixtures (deferred per brief).
- claim-envelope requester-auth seam not wired this slice (not required for schema compile).
- portfolio-release now asserts zero production-active tools; later live-digest cutover must restore expectations.
- Receipt builders still write v1 `normal|live_proof` (Important #3 deferred); do not load flat legacy JSON as receipt v2.

---

## Review fix (Important #1 + #2)

**Status:** DONE  
**Commit:** `98692ce4` — `fix(hms): move role-proof loaders and bind negative evidence`

### Changes

1. **Loaders in `release-kernel.ts`.** Moved `loadHmsReadRoleProof` (+ v1 denied-action / TTL floor) out of `production-runtime`. Added `loadHmsReadRoleProofV2` / `loadHmsReadRoleProofV2ForTool` (path helper + `validateRoleProofV2ForTool`). `production-runtime` re-exports v1 loader; `runtime` default dynamic import points at release-kernel (no reverse import).
2. **Binding↔artifact match.** `verifyEvidence(gate, ref, binding)` returns `NegativeGateEvidenceArtifact | null`. Validator rejects missing evidence, digest/id mismatch, and binding drift on tool/version/operation/snapshot/property/role/branch/source/verifier (+ credential/runtime/key version). Helpers: `evidenceArtifactForBinding`, `negativeGateEvidenceMatchesBinding`.

### Verify

```bash
cd apps/server-pilot
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
pnpm exec vitest run \
  tests/hms-negative-result.test.ts \
  tests/hms-portfolio-release.test.ts \
  tests/hms-production-boundary.test.ts \
  tests/hms-read-kernel.test.ts \
  tests/hms-runtime.test.ts
pnpm build
```

**Result:** 5 files / 97 passed / 3 skipped. `pnpm build` exit 0. No pilot-RDS.
