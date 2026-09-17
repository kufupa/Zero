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

## U3 review fixes (2026-09-17)

- The CLI now leaves the worker transport injectable and defaults to the explicit
  unavailable Luna boundary. It writes `centurion_classification.blocked`, exits
  with code `2`, and includes `luna_worker_transport_unavailable` in the coverage
  audit and daily report. Any unresolved core worker/parse/context result also
  blocks the CLI; it is never reported as a successful classification.
- Worker result parsing is fail-closed for unknown or duplicate labels, invalid
  or inconsistent primary/secondary workflows, malformed uncertainty reasons or
  context flags, and missing uncertainty reasons for `unknown_review`/`other`.
- Sealed manifests now validate the fixed window/timezone, transport, snapshot
  identifier, ordered hash, source counts and derived partition counts. Normal
  and quarantine records validate their required schemas, enums, nullable values,
  arrays, timestamps, attachments, MIME metadata and evidence types.
- Coverage reconciliation now compares validated source candidate IDs and
  manifest counts against emitted classification IDs independently. The audit
  persists source/emitted counts, missing/unexpected IDs and both ID hashes.
- Private output writing resolves a canonical repository/private/corpus/output
  chain, rejects symlinked roots or parents, and applies the same guard to the
  exported writer.

Focused review-fix verification ran with `DATABASE_URL` and
`VITEST_ALLOW_PILOT_RDS` unset:

```text
pnpm exec vitest run tests/centurion-corpus-classification.test.ts --reporter=dot
17 tests passed

pnpm exec vitest run tests/centurion-corpus-classification.test.ts tests/centurion-quarantine-export.test.ts tests/centurion-corpus-export.test.ts tests/centurion-thread-corpus-postgres-reader.test.ts tests/export-centurion-thread-corpus-live.test.ts tests/centurion-thread-corpus-exporter.test.ts --config vitest.config.ts --reporter=dot
6 files, 54 tests passed

pnpm exec tsc --noEmit -p tsconfig.json
passed

pnpm exec prettier --check scripts/classify-centurion-nine-day-corpus.ts tests/centurion-corpus-classification.test.ts
passed
```

The real approved GPT-5.6-Luna-Max worker transport remains unavailable in this
runtime; no live classifications were invented and no production/RDS test or
external model call was made.

## Residual P2 fix (2026-09-17)

The uncertainty guard now requires a nonempty reason whenever `unknown_review`
or `other` occurs anywhere in the full label set, including secondary labels.
An offline regression covers `booking_quote` with secondary `unknown_review` and
no reason. Focused verification passed with production variables unset: 18
tests, TypeScript, and Prettier.
