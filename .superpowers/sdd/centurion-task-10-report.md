# Centurion Task 10 — Retag / snapshot / restore / audit v6

Status: DONE_WITH_CONCERNS

## Scope

- Retag defaults now use `triage-v6` and `inbound-triage-retag-v6`.
- Retag/snapshot/restore manage legacy primaries, all workflow primaries, and
  `urgent`; retag also clears stale invent-WHO joins.
- Retag `clearSpamAt` refuses to clear a thread with
  `spam_user_locked_at` set.
- Audit accepts canonical v6 output (`primaryFolder`/`isSpam`), uses run
  `createdAt` for production input hash `asOf`, reads `spam` joins explicitly,
  and enforces spam/no-primary versus non-spam/workflow-primary durable state.

## TDD evidence

Baseline characterization, before Task 10 tests/implementation:

```text
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS NODE_ENV
pnpm --filter @zero/server exec vitest run \
  tests/retag-centurion-triage.test.ts \
  tests/centurion-triage-snapshot.test.ts \
  tests/centurion-triage-audit.test.ts

3 files passed; 36 tests passed
```

RED, after adding v6 tests and before production changes:

```text
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS NODE_ENV
pnpm --filter @zero/server exec vitest run \
  tests/retag-centurion-triage.test.ts \
  tests/centurion-triage-audit.test.ts

2 files; 4 failed, 24 passed
```

Failures covered v6 defaults/managed slugs, lock-safe spam clearing, and
canonical v6 audit output.

GREEN/final focused suite:

```text
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS NODE_ENV
pnpm --filter @zero/server exec vitest run \
  tests/retag-centurion-triage.test.ts \
  tests/centurion-triage-snapshot.test.ts \
  tests/centurion-triage-audit.test.ts

3 files passed; 40 tests passed
```

Additional checks:

```text
node --check <four Centurion .mjs scripts>                          PASS
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS NODE_ENV
pnpm --filter @zero/server exec tsc --noEmit --pretty false -p tsconfig.json PASS
git diff --check -- <Task 10 paths>                                 PASS
```

No pilot/production RDS access used; safety env vars were unset for every
Vitest/typecheck command.

## Changed paths

- `apps/server-pilot/scripts/retag-centurion-triage.mjs`
- `apps/server-pilot/scripts/snapshot-centurion-triage.mjs`
- `apps/server-pilot/scripts/restore-centurion-triage-snapshot.mjs`
- `apps/server-pilot/scripts/audit-centurion-triage-retag.mjs`
- `apps/server-pilot/tests/retag-centurion-triage.test.ts`
- `apps/server-pilot/tests/centurion-triage-audit.test.ts`

## Commit

Implementation: `0811a37a` (`fix(ai): harden Centurion v6 retag audit`)

## Concerns

Scoped Prettier check reports existing style/import-order warnings across the
legacy script/test files. Files were not auto-formatted to avoid unrelated
churn; syntax, typecheck, focused tests, and diff checks pass.

## Review fix — 2026-09-01

Status: FIXED. Addressed all three Important findings plus requested safe
Minor coverage.

- Excluded-thread audit now filters the pre-existing `spam` join from the
  snapshot category comparison while retaining explicit spam-primary checks.
- Retag, snapshot, restore, and audit now share `RETAG_UNSETTLE_SLUGS`; legacy
  invent-WHO joins are snapshotted/restored as retag-managed state, while
  custom categories remain untouched.
- Spam + urgent audit now matches durable worker behavior: `spam_at` set,
  zero managed joins (including `urgent`), no primary.
- Audit requires boolean `approvedUrgent`; canonical workflow approval and
  lock-race behavior have regression coverage.

Files:

- `apps/server-pilot/scripts/retag-centurion-triage.mjs`
- `apps/server-pilot/scripts/snapshot-centurion-triage.mjs`
- `apps/server-pilot/scripts/restore-centurion-triage-snapshot.mjs`
- `apps/server-pilot/scripts/audit-centurion-triage-retag.mjs`
- `apps/server-pilot/tests/retag-centurion-triage.test.ts`
- `apps/server-pilot/tests/centurion-triage-snapshot.test.ts`
- `apps/server-pilot/tests/centurion-triage-audit.test.ts`

TDD:

- RED: focused suite exposed rollback pre-state failure, excluded spam false
  fail, spam + urgent durable mismatch; lock-race regression also failed.
- GREEN: `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS NODE_ENV; pnpm --filter
  @zero/server exec vitest run tests/retag-centurion-triage.test.ts
  tests/centurion-triage-snapshot.test.ts tests/centurion-triage-audit.test.ts`
  — 3 files, 45 tests passed.
- `node --check` all four scripts: PASS.
- `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS NODE_ENV; pnpm --filter
  @zero/server exec tsc --noEmit --pretty false -p tsconfig.json`: PASS.
- `git diff --check`: PASS.

Implementation commit: `22ba459b` (`fix(ai): reconcile Centurion rollback and audit state`).

Concerns: snapshots emitted before this fix that contain legacy invent-WHO
joins need regeneration before rollback; those old snapshots hashed the joins
as custom state. No pilot/production RDS access used.
