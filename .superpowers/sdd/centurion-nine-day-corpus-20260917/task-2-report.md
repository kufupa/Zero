# U2 quarantine recovery and source reconciliation report

Status: DONE_WITH_CONCERNS

## Scope implemented

- Added `export-centurion-quarantine-live.ts`, a guarded Centurion quarantine export command.
- Reads `mail_ingest_quarantine`, mailbox metadata, outbound queue evidence and existing message UIDL/raw-key metadata in one repeatable-read, read-only Postgres transaction.
- Uses a local `mailparser` stream parser. It does not import or invoke an ingest parser, re-ingest operation, attachment uploader, quarantine promotion or raw-MIME rehydration path.
- Tries the recorded primary raw-MIME key and the deterministic quarantine-archive key read-only, preserving source status, byte length, SHA-256, content type and a private raw-byte artifact path.
- Emits a complete private quarantine JSONL ledger and manifest with measured source counts. `parseFailureCount` is derived from the observed Centurion rows; no incident count is hardcoded.
- Preserves quarantine-created time independently from RFC `Date`; invalid or missing RFC dates remain `undated`.
- Records effective sender, owner-header match/mismatch, recipient/BCC/self-loopback evidence, queue correlation and `inbound`, `outbound`, `ambiguous`, `unattributed`, `missing_object` and `parse_error` dispositions.
- Preserves complete text, HTML, canonical/raw headers, participants, reply identifiers and attachment metadata/hashes. GIF/PNG/JPG content is marked `unsupported`; oversized and malformed attachment streams retain explicit statuses without object-storage writes.
- Separates the Johannesburg core window `[2026-09-07T22:00:00Z, 2026-09-16T22:00:00Z)` from September 17 spillover `[2026-09-16T22:00:00Z, 2026-09-17T22:00:00Z)`.
- Added focused offline tests covering all U2 brief scenarios plus read-only SQL/transaction behavior.

## Verification

All test commands ran with `DATABASE_URL` and `VITEST_ALLOW_PILOT_RDS` unset.

```text
pnpm exec vitest run tests/centurion-quarantine-export.test.ts --config vitest.config.ts
11 tests passed

pnpm exec vitest run tests/centurion-quarantine-export.test.ts tests/centurion-corpus-export.test.ts tests/centurion-thread-corpus-postgres-reader.test.ts tests/export-centurion-thread-corpus-live.test.ts tests/centurion-thread-corpus-exporter.test.ts --config vitest.config.ts
5 files, 35 tests passed

pnpm exec tsc --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext --strict --skipLibCheck --esModuleInterop --types node scripts/export-centurion-quarantine-live.ts
passed

pnpm exec tsc --noEmit -p tsconfig.json
passed
```

Static review of the U2 script found no calls/imports for production ingest parsing, quarantine promotion, raw-MIME rehydration, attachment upload helpers or SQL write statements. The focused fake-Postgres test observed only `SELECT` statements inside `isolation level repeatable read read only`.

## Concerns / evidence boundary

- No live EC2/RDS/S3 extraction was run. The task explicitly forbids production/pilot test access and mutation; live row completeness, the observed incident count and object availability remain unverified until the guarded command is run on the approved host with private output configured.
- Raw MIME bytes are retained in private runtime memory until the snapshot writer publishes owner-only artifacts. A very large observed quarantine corpus may require a future streaming writer to reduce peak memory, without changing the read-only contract.
- Unrelated mailbox rows remain in the source ledger with `unrelated_mailbox` disposition for reconciliation, but their raw objects are intentionally not read.
- No raw PII or production payload was added to Git, test output, collaboration messages or this report.

Commit: final worktree commit reported in the task handoff (`feat(centurion): add read-only quarantine reconciliation`)

## Review fixes and re-verification (2026-09-17)

- Date extraction now uses the raw RFC `Date` header line rather than MailParser's normalized `Date` value. Strict grammar, component bounds, calendar-day bounds and timezone bounds reject invalid, unparseable and overflow values as `dateStatus: invalid`, with `messageDate` and report partition remaining undated.
- Persisted and raw owner headers are now reconciled fail-closed. Any disagreement, or any explicit owner outside the Centurion transport identities, produces `status: unattributed` and `routingStatus: owner_mismatch`; no business direction is derived from those records.
- Existing-message reconciliation now filters by `m.created_at < asOf` in SQL and in the offline snapshot seam, preventing future messages from marking historical quarantine rows as duplicate UIDLs.
- Added regression coverage for invalid/overflow dates, both owner-conflict directions, the future-message duplicate guard and the SQL timestamp predicate.

Review verification ran with `DATABASE_URL` and `VITEST_ALLOW_PILOT_RDS` unset:

```text
pnpm exec vitest run tests/centurion-quarantine-export.test.ts --config vitest.config.ts
13 tests passed

pnpm exec vitest run tests/centurion-quarantine-export.test.ts tests/centurion-corpus-export.test.ts tests/centurion-thread-corpus-postgres-reader.test.ts tests/export-centurion-thread-corpus-live.test.ts tests/centurion-thread-corpus-exporter.test.ts --config vitest.config.ts
5 files, 37 tests passed

pnpm exec tsc --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext --strict --skipLibCheck --esModuleInterop --types node scripts/export-centurion-quarantine-live.ts
passed

pnpm exec tsc --noEmit -p tsconfig.json
passed
```
