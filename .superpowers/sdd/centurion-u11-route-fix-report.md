# Centurion U11 route-fix report

Status: DONE

## Root cause

`directionOverride: 'outbound'` was applied inside `persistInboundMessage`
after transport routing. True ReserveCloud staff copies have no Centurion
identity in their headers, so normal routing quarantined them before the
promotion direction override could run.

## TDD evidence

RED, before production changes:

```text
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS NODE_ENV
pnpm exec vitest run tests/promote-quarantine.test.ts -t \
  'routes true ReserveCloud staff promotion'

1 failed: stored=0, quarantined=1
```

GREEN, after the smallest route fix:

```text
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS NODE_ENV
pnpm exec vitest run tests/promote-quarantine.test.ts -t \
  'routes true ReserveCloud staff promotion'

1 passed; 13 skipped
```

Related ingest/promote tests:

```text
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS NODE_ENV
pnpm exec vitest run tests/promote-quarantine.test.ts tests/ingest-store.test.ts

2 files passed; 15 passed; 26 skipped (DB-backed cases safely skipped)
```

Additional checks:

```text
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS NODE_ENV
pnpm run build

tsc -p tsconfig.json: PASS
git diff --check 43a2a003^ 43a2a003 -- \
  apps/server-pilot/src/mail/ingest/store.ts \
  apps/server-pilot/src/mail/ingest/promote-quarantine.ts \
  apps/server-pilot/tests/promote-quarantine.test.ts: PASS
```

No pilot/production DB access used.

## Change

`PersistOptions` now accepts only the promotion-scoped
`transportOverride: 'transport-centurion'`. Persistence resolves that exact
transport from an active DB row before ordinary owner-header/direct-To
routing. Unknown override values cannot select arbitrary transports. Promote
passes this route together with the existing outbound direction override;
attachments, AI behavior, duplicate handling, and atomic quarantine deletion
remain unchanged.

## Files

- `apps/server-pilot/src/mail/ingest/store.ts`
- `apps/server-pilot/src/mail/ingest/promote-quarantine.ts`
- `apps/server-pilot/tests/promote-quarantine.test.ts`
- `.superpowers/sdd/centurion-u11-route-fix-report.md`

## Commit

Implementation: `43a2a003` (`fix(mail): route Centurion quarantine promotions explicitly`)

## Concerns

- DB-backed promotion tests require a disposable test database and were not
  run under the required DB-free environment.
- Repository-wide `git diff --check` also reports pre-existing trailing
  whitespace in unrelated dirty paths; scoped U11 commit check is clean.
- Override is intentionally a literal-only Centurion route; no sender or
  recipient predicate was broadened.
