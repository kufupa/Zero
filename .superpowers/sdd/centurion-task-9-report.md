# Task 9 report — narrow ReserveCloud quarantine promotion

Date: 2026-09-01

## Scope

Implemented exact-sender quarantine discrimination, outbound direction override,
CLI dry-run class reporting, wrapper/noreply rejection, and preserved duplicate
and attachment-cleanup paths. Only `missing_owner_header` rows are queried.

Pure tests contain the fixture addresses; this report contains no message PII.

## TDD evidence

RED, before production implementation:

```text
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS NODE_ENV && \
  pnpm --filter @zero/server exec vitest run tests/promote-quarantine.test.ts
```

Failed as expected because the new discriminator export did not yet exist:
`3 failed, 3 passed, 6 skipped`.

GREEN:

```text
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS NODE_ENV && \
  pnpm --filter @zero/server exec vitest run tests/promote-quarantine.test.ts
```

`1` file passed; `6` pure tests passed and `7` DB tests safely skipped because
no disposable DB was available.

Additional verification:

```text
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS NODE_ENV && \
  pnpm --filter @zero/server exec tsc --noEmit
```

Passed.

## EC2 dry-run

Safely skipped. No EC2 credentials or approved read-only remote access are
available in this local session, so no remote DB/S3 read or write was attempted.

## Changed paths

- `apps/server-pilot/src/mail/ingest/promote-quarantine.ts`
- `apps/server-pilot/src/mail/ingest/store.ts`
- `apps/server-pilot/scripts/promote-quarantine.ts`
- `apps/server-pilot/tests/promote-quarantine.test.ts`
- this report

The stale `.superpowers/sdd/task-9-report.md` was not touched.

## Final recheck

After lint cleanup, the required env-unset focused suite passed again (`6`
passed, `7` DB-skipped), and the server-pilot TypeScript check passed. The
commit contains only the five paths listed above.
