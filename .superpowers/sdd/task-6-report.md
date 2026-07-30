# Task 6 Report — Add deterministic cutover, rollback, and audit controls

Date: 2026-07-30  
Branch: `triage-v5-quality`  
Base HEAD: `48b8f22bbca4ed141c6243211c61af0429843280`  
Commit: `90c20b6cf20290bbcf5cd41118ae15aa47879251`  
Subject: `feat(ai): add reversible triage cutover controls`  
Pushed: no

## Status

**DONE**

## What changed

| Path | Change |
|------|--------|
| `apps/server-pilot/scripts/snapshot-centurion-triage.mjs` | **New.** Snapshot Centurion threads into eligible/locked/blocked/allowed/outboundOnly cohorts; record trigger/sender/policy/spam/lock/AI slugs/custom-presence hash/pre-state + canonical `snapshotHash`; emit separately hashed target manifest; `bindApprovedTargetManifest` for refined category/urgent + rehearsal hashes; `verifySnapshotAgainstLive`. |
| `apps/server-pilot/scripts/restore-centurion-triage-snapshot.mjs` | **New.** Dry-run default; `--apply` restores only AI-managed category joins + `spam_at`/`spam_user_locked_at`; preserves custom categories + sender preferences; post-restore equality via snapshot verify. |
| `apps/server-pilot/scripts/audit-centurion-triage-retag.mjs` | **New.** Strict 100% audit: apply summary + approved manifest + key prefix + snapshot. Coverage, succeeded `applyMode='full'`, model/version/prompt hash, approved vs refined, zero draft, production input hash recomputed at run `finishedAt` (never vs regression hash), durable labels, excluded cohort immutability / no fresh-prefix runs. Nonzero exit on any error. |
| `apps/server-pilot/scripts/retag-centurion-triage.mjs` | Export `AI_MANAGED_SLUGS` for snapshot/restore/audit reuse. |
| `apps/server-pilot/deploy/deploy-ec2.sh` | `--quiesced`: sync/install/build/nginx; assert `http`/`worker`/`ai-worker` not online; skip all PM2 mutation + HTTP health. |
| `apps/server-pilot/deploy/ops-deploy.sh` | `--quiesced` forwards to `deploy-ec2.sh --quiesced`; skips HTTP health; retains VPN assert. |
| `apps/server-pilot/tests/centurion-triage-snapshot.test.ts` | **New.** Cohort/hash/tamper/bind/restore/custom-preserve/quiesced source contracts. |
| `apps/server-pilot/tests/centurion-triage-audit.test.ts` | **New.** Every seeded mismatch exits nonzero; happy path ok; run-time input recompute. |
| `apps/server-pilot/tests/deploy-config.test.ts` | Quiesced deploy contract; non-quiesced PM2/health launch-safety retained. |

## TDD evidence

### RED (before impl)

Command:

```bash
pnpm --dir apps/server-pilot exec vitest run \
  tests/centurion-triage-snapshot.test.ts \
  tests/centurion-triage-audit.test.ts \
  tests/deploy-config.test.ts
```

Result: suites failed to collect (missing snapshot/restore/audit scripts); quiesced deploy assertion failed (`--quiesced` absent).

Artifact: `.superpowers/sdd/task-6-red.txt`

### GREEN (after impl)

```bash
pnpm --dir apps/server-pilot exec vitest run \
  tests/centurion-triage-snapshot.test.ts \
  tests/centurion-triage-audit.test.ts \
  tests/deploy-config.test.ts
```

Result: **3 files / 49 passed**.

Artifact: `.superpowers/sdd/task-6-green-targeted.txt`

## Verification

| Check | Result |
|-------|--------|
| Targeted vitest (snapshot + audit + deploy-config) | PASS (49/49) |
| Retag regression `tests/retag-centurion-triage.test.ts` | PASS (15/15) |
| `pnpm --dir apps/server-pilot build` | PASS (`tsc -p tsconfig.json`) |
| snapshot→mutate→restore exact hash | Covered |
| Seeded audit mismatches nonzero | Covered |
| Quiesced path free of PM2 start/delete/save + HTTP health | Covered |
| Non-quiesced PM2 start + health retained | Covered |
| `VITEST_ALLOW_PILOT_RDS` | Never set |
| Schema migration | **none** |

Artifact: `.superpowers/sdd/task-6-build.txt`

## Design notes

- Target manifest remains Task-4 compatible (`validateApprovedRolloutManifest`); adds `snapshotHash`, optional bind fields (`approvedCategory`/`approvedUrgent`/`sourceHash`/`rehearsalResultHash`).
- Production input hash recomputed from run `finishedAt` as `asOf`; regression hashes ignored if supplied.
- Postgres drivers present for operator use; unit tests use memory drivers (never pilot RDS).
- Scripts stay LF, no shebang (Vitest-safe).

## Commit files (explicit stage)

- `apps/server-pilot/scripts/snapshot-centurion-triage.mjs`
- `apps/server-pilot/scripts/restore-centurion-triage-snapshot.mjs`
- `apps/server-pilot/scripts/audit-centurion-triage-retag.mjs`
- `apps/server-pilot/scripts/retag-centurion-triage.mjs`
- `apps/server-pilot/deploy/deploy-ec2.sh`
- `apps/server-pilot/deploy/ops-deploy.sh`
- `apps/server-pilot/tests/centurion-triage-snapshot.test.ts`
- `apps/server-pilot/tests/centurion-triage-audit.test.ts`
- `apps/server-pilot/tests/deploy-config.test.ts`

## Concerns

1. Quiesced stop-assert: absent process = OK; any non-empty status other than `stopped` refuses (covers `online`/`launching`/`errored`/`stopping`/…).
2. Audit postgres `recomputeProductionInputHash` duplicates `hashTriageInput` canonical JSON (avoids importing `dist` from `.mjs`); keep in sync with `triage-input.ts`.
3. Live bind/CLI emit of approved targets still operator-driven (Task 9 cutover); this task ships controls + tests only.

## Review fix notes (Important findings)

Date: 2026-07-30  
Base HEAD: `90c20b6cf20290bbcf5cd41118ae15aa47879251`

### Fixes

1. **`SNAPSHOT_PROMPT_HASH` gate** — `requireSnapshotPromptHash` only when `emitTargets` (`--targets-out`). Snapshot-only omits env. Bind/emit still needs valid hash via emit path.
2. **Audit coverage tests** — missing = drop eligible + rehash; extra = non-eligible target + rehash; duplicate = true duplicate `threadId`. Asserts real coverage/duplicate messages (not stale `manifestHash`).
3. **Quiesced stop assert** — refuse any non-empty status ≠ `stopped` (incl. `errored`/`stopping`).
4. **Quiesced source scrape** — depth-aware `if`/`fi` extract covers full QUIESCED branch past nested `fi`; asserts `quiesced deploy ok` + `exit 0` + no PM2 mutate.

### TDD

RED (`task-6-review-red.txt`): 3 failed / 47 passed — missing `requireSnapshotPromptHash`; stop-assert still `online`/`launching` only.

GREEN (`task-6-review-green.txt`):

```text
✓ tests/centurion-triage-audit.test.ts (9 tests)
✓ tests/centurion-triage-snapshot.test.ts (11 tests)
✓ tests/deploy-config.test.ts (30 tests)
Test Files  3 passed (3)
Tests  50 passed (50)
```

Command:

```bash
cd apps/server-pilot && pnpm exec vitest run \
  tests/centurion-triage-snapshot.test.ts \
  tests/centurion-triage-audit.test.ts \
  tests/deploy-config.test.ts
```

`VITEST_ALLOW_PILOT_RDS` never set. Non-quiesced `pm2 start` + `health attempt` launch-safety retained.
