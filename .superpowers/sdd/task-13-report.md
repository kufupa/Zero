# Task 13 Report — Cut production to plan-scoped immutable releases

**Status:** DONE (local GREEN + production wiring fix commit)  
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
| C3 | Plan-before-I/O + Full gate unwired | `candidate-draft-agent` calls `executableReadStepsForPlan` / `canScoreFull` before tool I/O; refuses Full on omissions |
| I4 | Deploy CAS comment-only | `deploy/source-registry-cas.sh` + `ops/run-source-registry-cas.ts` invoke `runSourceRegistryTransaction`; wired from `ops-deploy` / `deploy-ec2` |
| I5 | Auth behavioral tests | `requireSessionAuthorization` reject without lease + accept with lease |
| I6 | Group/event without reservation | Cutover suite covers group + event direct steps; `detectDirectReadPlanRefs` in thread-context |

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

**Result:** 8 files / **236 passed** / 12 skipped. `pnpm build` GREEN.

## Deferred (acceptable)

- Live find/mail seed browser proofs on EC2
- Production registry flip / `registryCutoverComplete=true` on EC2
- Promote stays `BLOCKED_REGISTRY_CUTOVER_PENDING` until seeds + handler path active on instance
- No new Phase B tool promotes

## Friction

| Item | Class |
|------|--------|
| Plan file dirty — left unstaged | expected |
| Live EC2 find/mail proof + real release IDs | ops follow-up |
| New Phase B tool promote | blocked until cutover complete (by design) |

## Commits

- `0c74c927` — `feat(hms): activate reads from plan-scoped immutable releases`
- (this fix) — `fix(hms): wire plan-scoped auth into live read path`
