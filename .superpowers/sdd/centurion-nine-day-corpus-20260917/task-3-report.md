# U3 exhaustive classification and daily-report report

Status: DONE_WITH_RUNTIME_BLOCKER

## Scope implemented

- Added `classify-centurion-nine-day-corpus.ts`, a DB-free local reader and report
  writer for the sealed U1 normal snapshot and U2 quarantine snapshot.
- Verifies each sealed manifest schema and ordered-record SHA-256 before reading
  message bodies. The worker request carries the complete body and HTML without
  truncation, sampling, pending-work filtering, thread-label reuse, unread-state
  use, regex classification, or future-thread aggregation.
- Added an injectable worker transport with a bounded batch size of at most five,
  fresh opaque worker IDs per attempt, bounded retries, strict response parsing,
  deterministic primary-workflow selection, secondary multi-intent labels,
  evidence locations, provenance and uncertainty.
- The default runtime transport is fail-closed and emits explicit
  `luna_worker_transport_unavailable` coverage evidence. It never invents a
  business direction, origin, workflow or evidence when the real Luna-Max
  transport is unavailable.
- Canonical workflows cover booking/quote, servicing, reconciliation,
  money/proof-of-payment, delivery/documents, recovery, guest experience,
  partner/channel, automated-channel, unknown-review and `other`.
- Writes owner-only `daily-classification.jsonl`, `daily-tables.md`,
  `daily-tables.json` and `coverage-audit.json`; core daily totals reconcile to
  unique source-scoped IDs, and September 17 spillover remains separate.
- Added the root `.private/centurion-corpus/` ignore rule and focused offline
  tests. No unrelated read-agent files were changed by U3.

## Verification

All test commands ran with `DATABASE_URL` and `VITEST_ALLOW_PILOT_RDS` unset.

```text
pnpm exec vitest run tests/centurion-corpus-classification.test.ts --config vitest.config.ts
7 tests passed

pnpm exec vitest run tests/centurion-corpus-classification.test.ts tests/centurion-quarantine-export.test.ts tests/centurion-corpus-export.test.ts tests/centurion-thread-corpus-postgres-reader.test.ts tests/export-centurion-thread-corpus-live.test.ts tests/centurion-thread-corpus-exporter.test.ts --config vitest.config.ts
6 files, 44 tests passed

pnpm exec tsc --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext --strict --skipLibCheck --esModuleInterop --types node scripts/classify-centurion-nine-day-corpus.ts
passed

pnpm exec tsc --noEmit -p tsconfig.json
passed

pnpm exec prettier --check scripts/classify-centurion-nine-day-corpus.ts tests/centurion-corpus-classification.test.ts
passed
```

## Concerns / evidence boundary

- A safely approved GPT-5.6-Luna-Max worker transport is not available in this
  runtime. The production-facing CLI therefore uses the deterministic fail-closed
  boundary and records worker-error/retry/blocker statuses; it does not claim
  model classifications or live corpus completeness.
- No RDS/S3 extraction, pilot-RDS test, mail/PMS action, deployment, schema
  change or external model/API call was performed.
- The report and tests contain no raw mailbox body, attachment bytes, addresses
  or other production payload. Private output is created only beneath the root
  `.private/centurion-corpus/<snapshot>/` path by the CLI and uses mode `0700`
  directories and mode `0600` files.

## Report path

`.superpowers/sdd/centurion-nine-day-corpus-20260917/task-3-report.md`
