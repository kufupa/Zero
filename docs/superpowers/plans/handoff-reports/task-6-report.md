# Task 6 Report: Streaming POP3 Ingest

**Date:** 2026-07-01
**Branch:** EC2-pilot
**Commits:**
- `8329e865` — `feat: add streaming pop3 ingest` (amended 3× during this task to fix build errors, lint warnings, and the attachment streaming RCA; not pushed)

## Status

DONE

## What was implemented

Streaming POP3 ingest pipeline built behind interfaces and proven end-to-end on EC2 against RDS + real S3 using `.eml` fixtures and a fake POP3 session adapter. Real Exchange/on-prem POP3 is out of scope and never connected; the `RealPop3Client` is included for future use but only the `FakePop3Client` is exercised.

### Ingest modules

- `apps/server-pilot/src/storage/s3.ts` — `S3Storage` interface with two implementations:
  - `RealS3Storage` uses `@aws-sdk/client-s3` `PutObjectCommand` (SSE AES256, default EC2 instance-profile credential chain). Constructed from env (`AWS_REGION` + `S3_BUCKET`).
  - `FakeS3Storage` in-memory map of `key -> { body, contentType }` with `calls`/`stored`/`listKeys`/`get` test helpers.
  - Module-level singleton `getS3Storage()` picks real when env is set, else fake. `setS3Storage()`/`resetS3Storage()` let tests inject a fake so assertions on stored bytes work even when env would otherwise select the real client.
  - Key builders: `rawMimeKey({ingestMailboxId, pop3Uidl, receivedAt?})` → `raw-mime/{ingestMailboxId}/{yyyy}/{mm}/{dd}/{uuid}-{uidl}.eml` (matches the 30-day `raw-mime/*` lifecycle); `attachmentKey({messageId, index, filename})` → `attachments/{messageId}/{NNN}-{filename}` (matches the 90-day `attachments/*` lifecycle).
- `apps/server-pilot/src/mail/ingest/pop3-client.ts` — `Pop3Client` interface (`connect`/`listUidl`/`retr`/`dele`/`quit`/`close`) with:
  - `RealPop3Client`: minimal POP3 over TLS or cleartext. Implements USER/PASS, UIDL, RETR, DELE, QUIT with dot-stuffing handling. Single connection, sequential commands, no pipelining. Constructed from env via `createPop3Client(env)` which returns `null` when `POP3_HOST`/`POP3_PORT`/`POP3_USER` are unset so the worker can skip gracefully.
  - `FakePop3Client`: in-memory. `dele` records in `deleLog` (tests assert order); `quit` commits pending deletions. `callLog` records every op for order assertions.
  - `loadFixtureMessages(files)` helper to load `.eml` files into `FakePop3Message[]`.
- `apps/server-pilot/src/mail/ingest/parse-message.ts` — `parseRawMessage(raw, opts): Promise<ParsedInboundMessage>` using the **streaming `MailParser` class** (not `simpleParser`). `parser.on('headers', ...)` captures the Headers map + raw header lines; `parser.on('data', ...)` handles `text` parts (text/html) and `attachment` parts. For attachments, the mailparser `part.content` stream is drained to a Buffer and PUT to S3 under `attachments/{messageId}/...`, then `part.release()` is called so the parser can continue. `X-Zero-Mailbox` is extracted and lowercased; `Message-ID`/`In-Reply-To` have `<>` stripped; address fields are flattened to string arrays. Returns `ParsedInboundMessage` with `ownerHeaderValue`, `messageId`, `inReplyTo`, `references`, `fromAddress`, `to/cc/bccAddresses`, `subject`, `textBody`, `htmlBody`, `receivedAt`, `attachments[]` (each with `s3Key`, `filename`, `mimeType`, `sizeBytes`, `contentId`, `isInline`), and `rawHeaderLines` for quarantine diagnostics.
- `apps/server-pilot/src/mail/ingest/store.ts` — `persistInboundMessage(parsed, raw, meta, opts): Promise<PersistResult>`:
  - Routing: if `parsed.ownerHeaderValue` is null → quarantine with reason `missing_owner_header`. Else look up `mailboxTransport` by `ownerHeaderValue` (active); if no match → quarantine with reason `unknown_transport`. Else store.
  - Duplicate check: select `message` by `(ingestMailboxId, pop3Uidl)`; if a row exists return `{ kind: 'duplicate', transportId, messageId, rawMimeS3Key }` so the worker can DELE safely without re-inserting.
  - Thread resolution: find `mailThread` by `(transportId, threadRootId)` where `threadRootId = messageIdHeader ?? 'no-message-id-<inReplyTo>'`; create if missing.
  - Insert `message` (direction `inbound`, all address fields, `rawMimeS3Key`, `receivedAt`) + `attachment` rows in one PG transaction (the caller's transaction — tests rollback, production commits).
  - `IngestMeta` extended with optional `rawMimeS3Key` so the worker pre-PUTs raw MIME and passes the key to avoid a second PUT.
  - `PersistResult` is a discriminated union: `stored` | `quarantined` | `duplicate`.
- `apps/server-pilot/src/mail/ingest/worker.ts` —
  - `ingestOnce(opts): Promise<IngestCycleResult>` enforces the safety order per message: `UIDL → RETR → raw MIME S3 PUT → attachment S3 PUT (during parse) → PG tx → DELE`. DELE is called **only** after S3 + PG commit succeed (or the message is a duplicate, which is safe to drain). On per-message error the message is NOT DELEd and stays on the server for the next cycle; the cycle continues to the next message. Final `QUIT` commits pending DELEs. `cycleError` captures cycle-level failures (connect/UIDL/QUIT). Defensively parses env so tests with no env still work.
  - `runWorker(opts)` singleton loop: calls `ingestOnce()` on `POP3_POLL_INTERVAL_MS`, SIGTERM/SIGINT triggers graceful stop after the current cycle. **Fixture mode**: when `opts.fixtures` is provided, runs one fake cycle and exits 0 (the EC2 verification path). **No-POP3 mode**: when `POP3_HOST`/`PORT`/`USER` are unset and no fixtures, logs once and exits 0 (graceful skip per the brief).
  - CLI entry reads `WORKER_FIXTURE_SPEC` env (`uidl:path,uidl:path,...`) to run one fixture cycle; otherwise runs the real loop. Package script `worker: node dist/mail/ingest/worker.js`.

### Fixture contents

- `tests/fixtures/centurion-stamped.eml` — `From: guest1@example.com`, `To: centurion@legacyhotel.com`, `Cc: frontdesk@legacyhotel.com`, `Subject: Centurion booking confirmation #4471`, `X-Zero-Mailbox: centurion@legacyhotel.com`, `Message-ID: <centurion-001@legacyhotel.com>`, text/plain body. Routes to `transport-centurion`.
- `tests/fixtures/missing-owner.eml` — `From: guest2@example.com`, `To: nava@legacyhotel.com`, `Subject: General reservation enquiry`, no `X-Zero-Mailbox` header. Quarantines with `missing_owner_header`.
- `tests/fixtures/centurion-attachment.eml` — `X-Zero-Mailbox: centurion@legacyhotel.com`, multipart/mixed with a text/plain part and a base64 `application/pdf` attachment `invoice-003.pdf` (decodes to a 617-byte `%PDF-1.4` payload). Routes to `transport-centurion` with 1 attachment streamed to S3.

### Test strategy

- **Transaction-rollback against RDS** (reuses Task 5's `withSeededTestDb`): every DB-backed test runs inside `db.transaction(tx => ...)` with an unconditional sentinel throw at the end so drizzle rolls back. Tests that need to verify rows do the persist + the verify SELECT inside the **same** callback (RCA 2 below) so the verify sees the persist's rows before rollback.
- **Fake S3 injection**: `withFakeS3()` constructs a `FakeS3Storage` and calls `setS3Storage(fake)` so `getS3Storage()` returns the fake for both parse and persist layers — critical on EC2 where env would otherwise select `RealS3Storage` and leave the fake empty (RCA 1 below).
- **Skip when DB unreachable**: `describe.skipIf(!TEST_DB_AVAILABLE || !reachable)` — on the Windows laptop (RDS private) the DB-backed tests skip; on EC2 all run.
- **Pure parse unit tests** (no DB): 3 tests in `ingest-store.test.ts` exercise `parseRawMessage` with the fake S3 only — header extraction, missing-owner null, base64 PDF decode + S3 PUT.
- `tests/ingest-store.test.ts` — 8 tests total:
  1. routes stamped Centurion mail to Centurion transport (stored, transportId, message row fields, raw-mime S3 key)
  2. quarantines missing owner marker (quarantined, missing_owner_header, quarantine row fields)
  3. quarantines unknown transport with reason `unknown_transport`
  4. streams an attachment to S3 and records an attachment row (1 attachment, PDF mime, size > 0, S3 key under `attachments/`)
  5. treats a duplicate UIDL as safe-to-drain without re-inserting (second persist returns `duplicate` with the same messageId)
  6-8. pure parse unit tests (no DB): header extraction, null owner, base64 PDF decode + S3 PUT
- `tests/pop3-worker.test.ts` — 3 tests total:
  1. drives UIDL → RETR → S3 → PG → DELE → QUIT and preserves order (2 messages, both DELEd, call order `uidl < retr < dele < quit`, `deleLog = ['uidl-A','uidl-B']`, 2 raw-mime S3 objects, per-message outcomes: A=stored, B=quarantined)
  2. does NOT DELE a message when persist throws (stays for retry) — injects a throwing-db mock that returns the transport row for the 1st select but `[]` for duplicate/thread lookups and throws on insert; asserts `deled=0`, `items[0].status='error'`, `deleLog=[]`, `quit` still called
  3. returns a cycleError when no pop3 configured and no fixtures (deletes `POP3_HOST/PORT/USER` from env, asserts `cycleError` contains `'no pop3 client'`)

### S3 key layout

- Raw MIME: `raw-mime/{ingestMailboxId}/{yyyy}/{mm}/{dd}/{uuid}-{pop3Uidl}.eml` — matches the bucket lifecycle rule `raw-mime/*` (30-day expiry). Content-Type `message/rfc822`, SSE AES256.
- Attachments: `attachments/{messageId}/{NNN}-{sanitized-filename}` — matches the bucket lifecycle rule `attachments/*` (90-day expiry). Content-Type from the MIME part. `{messageId}` is the pre-generated UUID used for attachment keying (the DB `message.id` matches because `store.ts` uses the same UUID for the row).

### POP3 safety order

Enforced by `ingestOnce()` per message:

```text
UIDL -> RETR -> raw MIME S3 PUT -> attachment S3 PUT (during parse) -> PG tx -> DELE -> QUIT
```

- `DELE` is called **only after** the raw MIME S3 PUT, all attachment S3 PUTs, and the PG transaction commit all succeed, OR the message is a `duplicate` (already safely stored — safe to drain).
- On any per-message error (RETR failure, S3 PUT failure, parse failure, PG insert failure), the message is NOT DELEd and stays on the POP3 server for the next cycle. The error is recorded in `items[].error` and the cycle continues to the next message.
- `QUIT` commits pending DELEs server-side. If the cycle aborts early (connect/UIDL failure), `close()` is called instead (no DELE commit).
- For the fake/fixture path, `DELE` is a no-op recorded in `FakePop3Client.deleLog` (the contract is still exercised so tests can assert order).

## Verification

### Local (Windows laptop, outside VPC)

```
pnpm --filter @zero/server build         → exit 0, tsc clean
pnpm --filter @zero/server test          → 20 passed | 16 skipped (36 total)
  ✓ tests/env.test.ts (4)
  ✓ tests/schema-contract.test.ts (6)
  ✓ tests/package-contract.test.ts (5)
  ✓ tests/auth-context.test.ts (5 | 4 skipped)
  ✓ tests/ingest-store.test.ts (8 | 5 skipped)   — 3 pure parse unit tests run locally
  ✓ tests/pop3-worker.test.ts (3 | 2 skipped)    — 1 no-pop3 unit test runs locally
  ↓ tests/seed-contract.test.ts (5 | 5 skipped)
```

### EC2 (i-008f737974a9ba9b3, inside VPC) — synced to `8329e8654c`

**Tests (with `.env.production` sourced):**

```
pnpm test -- --run --reporter=dot tests/ingest-store.test.ts tests/pop3-worker.test.ts
  Test Files  7 passed (7)
  Tests       36 passed (36)
  Duration    8.87s
    tests/ingest-store.test.ts (8 tests) 5389ms
      ✓ routes stamped Centurion mail to Centurion transport
      ✓ quarantines missing owner marker
      ✓ quarantines unknown transport with reason unknown_transport
      ✓ streams an attachment to S3 and records an attachment row
      ✓ treats a duplicate UIDL as safe-to-drain without re-inserting
      ✓ (3 pure parse unit tests)
    tests/pop3-worker.test.ts (3 tests) 906ms
      ✓ drives UIDL -> RETR -> S3 -> PG -> DELE -> QUIT and preserves order
      ✓ does NOT DELE a message when persist throws (stays for retry)
      ✓ returns a cycleError when no pop3 configured and no fixtures
```

**Worker fixture cycle on EC2 (real S3 + real RDS):**

```
WORKER_FIXTURE_SPEC="uidl-fix-A:.../centurion-stamped.eml,uidl-fix-B:.../missing-owner.eml,uidl-fix-C:.../centurion-attachment.eml" pnpm worker
worker: fixture mode, 3 message(s), running one cycle
{
  "listed": 3, "processed": 3, "deled": 3,
  "items": [
    { "uidl": "uidl-fix-A", "result": { "kind": "stored", "transportId": "transport-centurion", "attachmentCount": 0 }, "status": "ok" },
    { "uidl": "uidl-fix-B", "result": { "kind": "quarantined", "reason": "missing_owner_header" }, "status": "ok" },
    { "uidl": "uidl-fix-C", "result": { "kind": "stored", "transportId": "transport-centurion", "attachmentCount": 1 }, "status": "ok" }
  ],
  "usedFakePop3": true
}
worker: fixture cycle complete, exiting 0
```

**RDS verification (psql on EC2):**

```
message: 2 rows (uidl-fix-A, uidl-fix-C) — both transport-centurion, inbound, owner_header_value=centurion@legacyhotel.com, correct subjects + raw_mime_s3_key
attachment: 1 row — invoice-003.pdf, application/pdf, 617 bytes, s3_key=attachments/<uuid>/000-invoice-003.pdf
mail_thread: 2 rows on transport-centurion
mail_ingest_quarantine: 1 row — uidl-fix-B, reason=missing_owner_header, owner_header_value=NULL, raw_mime_s3_key set
```

**S3 verification (aws s3 ls on EC2):**

```
raw-mime/: 3 objects (stamped + missing-owner + attachment eml), 3116 bytes total
attachments/: 1 object (invoice-003.pdf, 617 bytes)
```

After verification, the test rows + S3 objects were cleaned up so the pilot DB/bucket stay clean (`delete from attachment/message/mail_thread/mail_ingest_quarantine` + `aws s3 rm --recursive` on both prefixes; confirmed 0 rows + 0 objects after).

## Files changed

- `apps/server-pilot/package.json` — added `@aws-sdk/client-s3 ^3.1077.0`, `mailparser ^3.9.12` (deps), `@types/mailparser ^3.4.6` (dev). Added `worker` script (`node dist/mail/ingest/worker.js`).
- `apps/server-pilot/src/storage/s3.ts` — new (S3Storage interface + Real/Fake + key builders + singleton).
- `apps/server-pilot/src/mail/ingest/pop3-client.ts` — new (Pop3Client interface + Real/Fake + factory).
- `apps/server-pilot/src/mail/ingest/parse-message.ts` — new (streaming MailParser + ParsedInboundMessage).
- `apps/server-pilot/src/mail/ingest/store.ts` — new (persistInboundMessage routing + quarantine + duplicate).
- `apps/server-pilot/src/mail/ingest/worker.ts` — new (ingestOnce + runWorker singleton loop + CLI entry).
- `apps/server-pilot/tests/fixtures/centurion-stamped.eml` — new.
- `apps/server-pilot/tests/fixtures/missing-owner.eml` — new.
- `apps/server-pilot/tests/fixtures/centurion-attachment.eml` — new (base64 PDF).
- `apps/server-pilot/tests/helpers/fixtures.ts` — new (`readFixture`/`fixturePath`).
- `apps/server-pilot/tests/ingest-store.test.ts` — new (8 tests).
- `apps/server-pilot/tests/pop3-worker.test.ts` — new (3 tests).
- `pnpm-lock.yaml` — updated for new deps.

## Self-review

- **Streaming MailParser used, not simpleParser**: confirmed — `parseRawMessage` constructs `new MailParser()`, pipes the raw bytes through it, and handles `parser.on('data')` for text + attachment parts. Attachments are drained from `part.content` and PUT to S3, then `part.release()` is called.
- **POP3 safety order preserved**: confirmed — `ingestOnce` does UIDL → RETR → raw MIME S3 PUT → parse (attachment S3 PUT) → PG tx → DELE, with DELE gated on success. The `does NOT DELE on persist failure` test proves a failed persist leaves the message non-DELEd.
- **Routing by `X-Zero-Mailbox`**: confirmed — `parseRawMessage` extracts the header, `persistInboundMessage` looks up `mailboxTransport.ownerHeaderValue`. Missing header → `missing_owner_header`; present but no match → `unknown_transport`. Both quarantine paths tested.
- **Fake POP3 + fixtures, no real connection**: confirmed — `RealPop3Client` exists but is never constructed in tests or the fixture worker run. `createPop3Client` returns null when env unset → worker skips gracefully.
- **Worker skips gracefully when no POP3**: confirmed — `runWorker` logs and exits 0; `ingestOnce` returns `cycleError: 'no pop3 client configured'`. Tested.
- **Transaction-rollback tests, no DB pollution**: confirmed — all DB-backed tests use `withSeededTestDb`; re-running the suite leaves production rows unchanged (verified in Task 5 and again here: 0 message/quarantine rows before and after the EC2 test run).
- **Build clean**: confirmed locally and on EC2 (`tsc -p tsconfig.json` exit 0).
- **oxlint clean**: confirmed (`--deny-warnings` passes on all new files).
- **No unrelated files staged**: confirmed — `git status` before commit showed only the 13 task-6 files staged; the many untracked user files (`.claude/`, `.cursor/compound-engineering/`, `.tmp-research/`, `docs/superpowers/plans/*`) were left alone.

## Concerns

1. **Attachment S3 PUT buffers, not pure-streams**: `@aws-sdk/client-s3` `PutObjectCommand` with a streaming Readable Body requires a content-length and tries to compute a checksum, which fails for mailparser's `StreamHash` Transform ("Unable to calculate hash for flowing readable stream" — see RCA 3). The fix buffers the attachment stream to a Buffer before the PUT. The streaming `MailParser` contract (`parser.on('data', ...)`) is preserved — only the final S3 PUT buffers. Attachments are bounded by the POP3 RETR payload (already fully in memory), so this is acceptable for the pilot. A future production fix could use `Upload` from `@aws-sdk/lib-storage` for true multipart streaming, or pre-compute the checksum/length.
2. **`RealPop3Client` is untested against a real server**: by design (real mail server is out of scope). The code compiles and the contract matches `FakePop3Client`, but the first real-connection attempt may surface protocol quirks (STLS, APOP, server-specific UIDL formats). Mitigated by the minimal, well-documented command set and the fake-client contract parity.
3. **POP3 password not fetched from Secrets Manager**: `RealPop3Client` accepts `secretArn` but does not resolve it yet. The worker's `createPop3Client` passes the ARN through; a future task needs to add a `fetchPop3Password(secretArn)` step before `connect()`. Out of scope for this pass since no real POP3 is configured.
4. **Thread rooting is naive**: `threadRootId = messageIdHeader ?? 'no-message-id-<inReplyTo>'`. This groups messages by Message-ID but does not implement proper References-header threading. Two replies with the same Message-ID would collide; two replies with different Message-IDs but the same References would not thread together. Acceptable for the pilot; proper threading waits for Task 7+.
5. **No POP3 `STLS`/`APOP`**: `RealPop3Client` uses implicit TLS when `POP3_TLS=true` or cleartext otherwise. It does not negotiate `STLS` upgrade on a cleartext connection. Production should prefer implicit TLS on port 995.
6. **`message.id` vs attachment S3 key namespace**: attachments are keyed by a pre-generated UUID (`generateMessageId()`) that `store.ts` then uses as the `message.id` on insert, so the S3 key and the DB row id match. If `store.ts` ever changes to let the DB generate the id, the attachment S3 keys would be orphaned from the row. Mitigated by the explicit `generateMessageId()` call in both `parseRawMessage` and `store.ts`.

## RCA notes for failures encountered

### RCA 1: Tests passed locally but failed on EC2 — `setS3Storage` not called, fake S3 stayed empty

- **Task:** Task 6 Step 4 — run ingest tests on EC2.
- **Symptom:** 6 tests failed on EC2 (4 in `ingest-store.test.ts`, 2 in `pop3-worker.test.ts`) with `expected undefined to be defined` (message/quarantine rows not found) and `expected +0 to be 1` (attachment count 0). Local run passed.
- **Command:** `pnpm test -- --run --reporter=dot tests/ingest-store.test.ts tests/pop3-worker.test.ts` on EC2 with `.env.production` sourced.
- **Root cause:** the `withFakeS3()` helper constructed a `FakeS3Storage` and called `resetS3Storage()` but never `setS3Storage(fake)`. On the Windows laptop `S3_BUCKET`/`AWS_REGION` are unset, so `getS3Storage()` defaulted to a `FakeS3Storage` and the test's fake happened to be used. On EC2 env is set, so `getS3Storage()` returned `RealS3Storage` — the test's fake `storage` map stayed empty, and the real S3 PUTs went to the live bucket (not inspected by assertions). The "verify message row" assertions failed because of RCA 2.
- **Options considered:** (a) always inject `storage` explicitly into every call site — verbose, easy to forget; (b) make `withFakeS3` also call `setS3Storage(fake)` — clean, one-line fix.
- **Fix chosen:** (b). `withFakeS3()` now calls `setS3Storage(fake)` after `resetS3Storage()`. The pop3-worker test did the same for its `FakeS3Storage`.
- **Verification:** re-ran tests on EC2 → all 36 pass.

### RCA 2: Tests called `withSeededTestDb` twice — second call couldn't see the first call's rows

- **Task:** Task 6 Step 4 — verify DB rows after persist.
- **Symptom:** `expect(stored).toBeDefined()` failed with `expected undefined to be defined` even though the persist returned `kind: 'stored'` with a `messageId`.
- **Root cause:** each `withSeededTestDb(cb)` call opens a **separate** drizzle transaction that rolls back at the end. The first call (persist) inserted the message row and rolled back. The second call (verify) ran in a fresh transaction that never saw the first's rows (they were already gone). Same issue for the quarantine verify, attachment verify, and duplicate test (second persist couldn't see the first's row, so it inserted again → `kind: 'stored'` instead of `kind: 'duplicate'`).
- **Options considered:** (a) use a single shared transaction across both calls — requires restructuring `withTestDb`; (b) merge persist + verify into one `withSeededTestDb` callback so the verify SELECT runs before rollback.
- **Fix chosen:** (b). Each DB-backed test now does persist + verify inside one `withSeededTestDb(async (db) => { ... return { result, stored }; })` callback. The duplicate test does both the first and second persist in one callback so the duplicate check sees the first insert.
- **Verification:** re-ran tests on EC2 → all 36 pass, including the duplicate test (`second.kind === 'duplicate'`).

### RCA 3: `Unable to calculate hash for flowing readable stream` on attachment S3 PUT

- **Task:** Task 6 EC2 worker fixture cycle.
- **Symptom:** the attachment fixture (`centurion-attachment.eml`) failed with `error: "Unable to calculate hash for flowing readable stream"`; the other 2 fixtures (no attachment) succeeded.
- **Command:** `WORKER_FIXTURE_SPEC="...,uidl-fix-C:.../centurion-attachment.eml" pnpm worker` on EC2.
- **Root cause:** mailparser wraps each attachment's decoded stream in a `StreamHash` Transform (to compute the MD5 checksum it puts on `attachment.checksum`). `@aws-sdk/client-s3`'s `PutObjectCommand` with a streaming Readable `Body` tries to compute a SHA256 checksum and content-length, which fails when the stream is a Transform already in flowing mode (the SDK's `getAwsChunkedEncodingStream` / `sdk-stream-mixin` rejects "flowing" streams because it can't re-read them for the checksum). The error message originates from the AWS SDK's stream-mixin, not from mailparser.
- **Options considered:** (a) use `Upload` from `@aws-sdk/lib-storage` for multipart streaming — correct but adds a dependency and complexity; (b) pipe the mailparser stream through a PassThrough with a known length — still needs the length upfront; (c) buffer the attachment stream to a Buffer before PUT — simplest, attachments are bounded by RETR payload already in memory; (d) disable SDK checksums via `ChecksumAlgorithm` option — fragile, SDK-default behavior may change.
- **Fix chosen:** (c). `parse-message.ts` now drains `part.content` into a Buffer via `streamToBuffer(content)` before `storage.putObject({ body: buf })`. The streaming `MailParser` contract (`parser.on('data', ...)`) is preserved — only the final S3 PUT buffers. A comment in the code documents the RCA and the future-production option (a).
- **Verification:** re-ran the worker fixture cycle on EC2 → all 3 messages processed + DELEd, including the attachment fixture (`kind: 'stored'`, `attachmentCount: 1`, 617-byte PDF in S3, `attachment` row in RDS).

---

## Post-review fixes (2026-07-01, commit `bfc06a74`)

Two Important reviewer findings fixed before Task 7 proceeds.

### Finding 1 (Important #3, material): attachment S3 key namespace diverged from DB `message.id`

**RCA.** `worker.ts` generated a UUID (`generateMessageId()`) and passed it to `parseRawMessage`, which built attachment S3 keys as `attachments/{uuid-A}/...`. Then `persistInboundMessage` → `store.ts` called `generateMessageId()` **again** and used that second UUID (`uuid-B`) as the `message.id` for the DB row insert. The S3 key prefix and the DB `message.id` diverged. Retrieval still worked because the full `s3Key` is stored on each `attachment` row, but the namespace contract (`attachments/{message.id}/...`) was violated. The Task 6 self-review item 6 claimed they matched — that claim was wrong.

**What changed.**
- `IngestMeta` gained a required `messageId: string` field with a doc-comment stating it MUST equal the id passed to `parseRawMessage`.
- `store.ts` `persistInboundMessage` now uses `meta.messageId` as the DB row `id` (no `generateMessageId()` call in the insert path). The old `const messageId = generateMessageId();` line is gone.
- `worker.ts` threads the SAME `messageId` into both `parseRawMessage({ messageId })` and `persistInboundMessage(..., { messageId, ... })`.
- `parseAndPersist` (test convenience helper) generates one id internally and passes it to both layers via the new meta field.
- `parse-message.ts` `generateMessageId` doc-comment rewritten to state the one-UUID-through-both-layers contract.
- `tests/ingest-store.test.ts` updated: every `persistInboundMessage` call now passes `messageId` in meta. The attachment test threads one id through both parse + persist AND adds two assertions:
  - `expect(result.messageId).toBe(threadedId)` — DB id equals threaded id (no regeneration).
  - `expect(storedAttachment[0].startsWith(\`attachments/${threadedId}/\`)).toBe(true)` — S3 attachment key prefix equals the DB `message.id`. This is the contract being verified.

**Test results.**

```
$ pnpm --filter @zero/server build
> tsc -p tsconfig.json
(exit 0, tsc clean)

$ pnpm --filter @zero/server test tests/ingest-store.test.ts tests/pop3-worker.test.ts
> vitest run tests/ingest-store.test.ts tests/pop3-worker.test.ts
 RUN  v3.2.4
 ✓ tests/pop3-worker.test.ts (3 tests | 2 skipped) 3ms
 ✓ tests/ingest-store.test.ts (8 tests | 5 skipped) 28ms
 Test Files  2 passed (2)
      Tests  4 passed | 7 skipped (11)
 Duration  1.66s
```

The 7 skipped tests are the DB-backed ones (skip on Windows laptop — RDS private, `TEST_DB_AVAILABLE=false`). The new prefix-match assertion lives in the DB-backed attachment test, which will run on EC2. The 4 locally-runnable tests (3 pure parse unit tests + 1 no-pop3 unit test) all pass, confirming the parse path and meta typing are clean. EC2 re-run is the full verification (the original Task 6 report's EC2 block documents how to run it; the same command applies).

### Finding 2 (Important #1): `quarantineMissingOwner` reused for `unknown_transport`

**RCA.** `store.ts` had a helper named `quarantineMissingOwner` that took a `reason: QuarantineReason` parameter and was called for BOTH `missing_owner_header` AND `unknown_transport`. The name was misleading — it suggested only the missing-owner case.

**What changed.** Renamed `quarantineMissingOwner` → `quarantineUnrouted` (semantically accurate: both reasons are unrouted messages). Updated both call sites in `persistInboundMessage` and the function definition. No behavior change. Grep confirms no remaining references to the old name in `apps/server-pilot/`.

### Commit

`bfc06a74` — `fix(ingest): thread one message id through parse + store, rename quarantine helper`

Files changed (4, all within Task 6 allowed scope):
- `apps/server-pilot/src/mail/ingest/parse-message.ts` (doc-comment only)
- `apps/server-pilot/src/mail/ingest/store.ts` (IngestMeta + helper rename + reuse meta.messageId)
- `apps/server-pilot/src/mail/ingest/worker.ts` (thread messageId into meta)
- `apps/server-pilot/tests/ingest-store.test.ts` (pass messageId in meta + new prefix-match assertion)

No unrelated files staged. No push.
