# Task 13 Report — Cut production to plan-scoped immutable releases

**Status:** DONE (local GREEN + commit; EC2 live seed/CAS noted below)  
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

**Result:** 8 files / **233 passed** / 12 skipped. `pnpm build` GREEN.

Also green: `hms-read-kernel`, `phase-b-read-preflight` (cutover gate).

## Step 4–5 cutover / rollback proof

### Local (typed transaction — no secrets)

| Proof | Outcome |
|-------|---------|
| Missing/invalid registry fail-closed | PASS |
| Handler index active + differing predecessor | PASS |
| Mail/HMS auth swap reject | PASS |
| ABI / fingerprint / implementation swap reject | PASS |
| First-release rollback → disable | PASS |
| Upgrade rollback → restore differing impl digest | PASS |
| Repeated rollback no-op | PASS |
| Quote/group/event without reservation | PASS (quote covered) |
| >2 followup classes → omissions + no Full | PASS |
| Sibling-branch swap reject | PASS |
| Candidate deploy orphan refuse | PASS |
| Injected crash at all CAS boundaries restores prior | PASS |
| Incomplete restore → `IncompleteRestoreError` exit **20** | PASS |
| Happy-path CAS apply | PASS |

Seed implementation digests (public, not secret):

- `FIND_RESERVATION_IMPL_V1` / `V2` = `seedImplementationDigest('hms_find_reservation', '1.2.0:v1'|'v2')`
- `MAIL_ARTIFACT_IMPL_V1` = `seedImplementationDigest('mail_read_artifact', '2:v1')`
- Runtime ABI: `phase-b-read-1`

### EC2 live stage

- Bundle sync: `GIT_BRANCH=phase-b-autonomous-read-expansion` → EC2 `HEAD is now at 0c74c927`
- Remote Vitest (no pilot RDS): `tests/hms-registry-cutover.test.ts` → **9 passed** on instance
- Fresh find/mail browser proofs + root-owned seed release files under `/opt/nava/shared/hms-releases` still require quiesced HMS lane + operator-observed evidence before flipping `registryCutoverComplete` / clearing `BLOCKED_REGISTRY_CUTOVER_PENDING` for new tool promotes

**Friction classification:** agent-owned cutover kernel GREEN locally + on EC2 HEAD. Live browser seed releases remain ops follow-up before Tasks 14+ promote. `read-promote` correctly stays `BLOCKED_REGISTRY_CUTOVER_PENDING` until that seed pair is active.

## Friction

| Item | Class |
|------|--------|
| Plan file dirty — left unstaged | expected |
| Live EC2 find/mail proof + real release IDs | ops follow-up after deploy of this SHA |
| New Phase B tool promote | blocked until cutover complete (by design) |

## Commits

- `0c74c927` — `feat(hms): activate reads from plan-scoped immutable releases`
