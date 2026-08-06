# Task 13 Report — Cut production to plan-scoped immutable releases

**Status:** DONE (local GREEN + C3 worker gate wiring)  
**Branch:** `phase-b-autonomous-read-expansion`  
**Base HEAD:** `7f0b28a2`  
**Worktree:** `C:/Users/gamin/.config/superpowers/worktrees/zero/phase-b-autonomous-read-expansion`

## What landed

- Registry v2 + fail-closed `loadValidatedActiveReadSet` / promote / rollback in `release-kernel.ts`
- Static handler index `(toolId, implementationSha256)` in `read-handler-index.ts` (find v1/v2 + mail v1 seeds)
- `executableReadStepsForPlan` + branch selection + omission/Full gate in `candidate-read-plan.ts`
- `ReadCandidateChild.requestBranchId` sibling-swap reject in `candidate-graph.ts`
- Per-context `HmsSessionAuthorization` on `openReadSession` (runtime)
- `BLOCKED_REGISTRY_CUTOVER_PENDING` on `read-promote` until find+mail seeds + handler path active
- Typed source+registry CAS with crash injection + incomplete restore exit `20` in `source-registry-transaction.ts`
- PM2 / env / deploy markers for `HMS_ACTIVE_REGISTRY_PATH`, `HMS_RELEASE_ROOT`, CAS crash points

### Review FAIL fix (Critical + Important)

| # | Finding | Fix |
|---|---------|-----|
| C1 | Live path process-wide Guest Stay | `live-guest-stay-driver` passes per-tool `sessionAuthorization`; production `requireSessionAuthorization: true` |
| C2 | Worker never loads cutover | `loadWorkerActiveReadSet` at HMS runtime create; handlers via `createReadToolHandler` |
| C3 | Plan-before-I/O + Full gate unwired | Agent gate + **worker/session pass `candidateBindings` + `requesterAuthorization`** via `resolvePlanScopedDraftGate` whenever `activeReleases` non-empty; fail closed if releases present without bindings |
| I4 | Deploy CAS comment-only | `deploy/source-registry-cas.sh` + `ops/run-source-registry-cas.ts` invoke `runSourceRegistryTransaction`; wired from `ops-deploy` / `deploy-ec2` |
| I5 | Auth behavioral tests | `requireSessionAuthorization` reject without lease + accept with lease |
| I6 | Group/event without reservation | Cutover suite covers group + event direct steps; `detectDirectReadPlanRefs` in thread-context |

### C3 re-review fix (worker path)

Prior FAIL: agent only gated when bindings/auth passed; worker called `runClaimSafeCandidateDraft` without them → fell back to `executableToolIdsForPlan`.

| Wire | Where |
|------|--------|
| `resolvePlanScopedDraftGate` | `candidate-read-plan.ts` — mint auth + build bindings from lookup candidates + releases |
| Live session factory | `worker.ts` `createLiveHmsCandidateSessionFactory` attaches gate onto session |
| HMS + non-HMS draft calls | `worker.ts` passes `candidateBindings` + `requesterAuthorization` into `runClaimSafeCandidateDraft` |
| Fail closed | `candidate-draft-agent.ts` — non-empty releases without bindings → no browser I/O (`planScopedGateMissing`) |
| Behavioral proof | `hms-candidate-agent.test.ts` C3 case: releases+bindings → find executes / Full refused on omissions; empty releases → cutover-pending block |

## Suites (local)

```
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
pnpm exec vitest run \
  tests/hms-read-tools-registry.test.ts \
  tests/hms-portfolio-release.test.ts \
  tests/hms-registry-cutover.test.ts \
  tests/hms-candidate-agent.test.ts \
  tests/ai-worker-contract.test.ts \
  tests/hms-production-boundary.test.ts \
  tests/hms-runtime.test.ts \
  tests/deploy-config.test.ts
```

**Result:** 8 files / **237 passed** / 12 skipped. `pnpm build` GREEN.

## Deferred (acceptable)

- Live find/mail seed browser proofs on EC2
- Production registry flip / `registryCutoverComplete=true` on EC2
- Promote stays `BLOCKED_REGISTRY_CUTOVER_PENDING` until seeds + handler path active on instance
- No new Phase B tool promotes
- Real mailbox-issued `TrustedRequesterAuthorization` (plan gate uses run-scoped mint until mailbox trust path lands)

## Friction

| Item | Class |
|------|--------|
| Plan file dirty — left unstaged | expected |
| Live EC2 find/mail proof + real release IDs | ops follow-up |
| New Phase B tool promote | blocked until cutover complete (by design) |

## Commits

- `0c74c927` — `feat(hms): activate reads from plan-scoped immutable releases`
- `f98dafa2` — `fix(hms): wire plan-scoped auth into live read path`
- (this) — `fix(hms): pass candidate bindings into plan-scoped Full gate`
