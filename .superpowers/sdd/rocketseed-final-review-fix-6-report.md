# Rocketseed final review fix wave 6 report

## Repair

- Persist bounded `candidateAttachmentCleanupKeys` in quarantine `parsed_headers`
  before candidate cleanup.
- On quarantine replay, merge safe persisted keys with newly parsed candidate
  keys, save that union, then retry every tracked key.
- Keep successful cleanup keys in metadata so POP3 `DELE`/`QUIT` commit failure
  remains idempotent.
- Reject malformed persisted entries before S3 deletion.

## RED

First RED run found a worker-test snapshot timing error. Corrected test-only
timing, with no production edit, then reran:

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
export TEST_DATABASE_URL='<approved local disposable database>' \
  CONFIRM_DISPOSABLE_TEST_DB=1 \
  ROCKETSEED_TRANSACTIONAL_TEST_REQUIRED=1
pnpm --dir apps/server-pilot exec vitest run \
  tests/rocketseed-returned-copy-reconciliation.test.ts \
  tests/pop3-worker.test.ts --maxWorkers=1
```

Observed RED: 2 failed, 28 passed.

- Malformed returned-copy quarantine did not persist first candidate key.
- Worker second pass removed only retry candidate; first failed candidate object
  remained.

## GREEN

Same focused transactional command: 2 files, 30 tests passed.

Final suites:

```bash
unset DATABASE_URL TEST_DATABASE_URL CONFIRM_DISPOSABLE_TEST_DB \
  VITEST_ALLOW_PILOT_RDS ROCKETSEED_TRANSACTIONAL_TEST_REQUIRED
pnpm --dir apps/server-pilot run test:rocketseed
```

- DB-free Rocketseed: 12 files, 116 tests passed.

```bash
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
export TEST_DATABASE_URL='<approved local disposable database>' \
  CONFIRM_DISPOSABLE_TEST_DB=1 \
  ROCKETSEED_TRANSACTIONAL_TEST_REQUIRED=1
pnpm --dir apps/server-pilot exec vitest run --maxWorkers=1 \
  tests/rocketseed-returned-copy-reconciliation.test.ts \
  tests/outbound-delivery-outcome.test.ts \
  tests/outbound-claim-lease.test.ts \
  tests/attachment-access.test.ts \
  tests/pop3-worker.test.ts
```

- Transactional Rocketseed: 5 files, 48 tests passed.
- Scoped Prettier write/check and Oxlint: passed.
- `pnpm --dir apps/server-pilot build`: passed.
- `git diff --check`: passed.

No pilot/prod environment, deployment, or production env sourcing used.
`.superpowers/sdd/progress.md` remained untouched; its existing dirty change
was excluded.
