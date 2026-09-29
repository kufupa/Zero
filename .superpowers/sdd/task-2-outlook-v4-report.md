# Task 2 — device enrollment and native HMAC verification

Status: DONE_WITH_CONCERNS (broader server suite requires unrelated deployment
configuration; the focused DB-backed security tests and server build pass).

## Implementation

- Additive `0029_outlook_device_enrollment.sql` and Drizzle tables for SHA-256
  enrollment-code hashes, exact approved Outlook StoreID, operator-approved
  named staff/actual mailbox-transport pairs, encrypted persistent per-user
  device credentials, revocation/last handshake and one-use nonce receipts.
- A 32-byte separate `NAVA_OUTLOOK_DEVICE_WRAPPING_KEY` is required. AES-256-GCM
  wraps the 32-byte device secret, with a fresh IV for each device. Missing,
  malformed or wrong wrapping keys deny verification; plaintext secrets do not
  appear in responses, logs, or DB records. The operator-only shell script
  issues one 10-minute code after validating named user/active mailboxAccess
  and exact mailbox transport; grants can repeat for multiple pairs. The same
  restricted CLI revokes by UUID with explicit confirmation. There is no
  browser-based operator issuance/self-signup route.
- `POST /api/outlook/native/enroll` accepts bounded JSON redemption (max 4096
  bytes), checks actual observed store/version/random device ID/32-byte secret,
  atomically consumes a non-expired approval, and binds approved pairs in the
  same DB transaction. A duplicate, guessed, expired, or wrong-store code
  grants nothing. PostgreSQL `clock_timestamp()` is required here because
  `now()` is fixed at transaction start.
- `POST /api/outlook/native/challenge` returns a 60-second stateless random,
  server-authenticated nonce with the same response shape for enrolled,
  unknown and revoked devices. Unauthenticated issuance creates **no DB
  rows**, bounding public challenge storage; native-only signed verification
  inserts a unique nonce receipt atomically. HMAC-SHA256 authenticates method,
  pathname, hash of exact raw body bytes, device ID, timestamp, nonce and v4
  domain. Signature check uses `timingSafeEqual`. Valid signed requests touch
  only last-handshake metadata and prune expired nonce receipts. Callers then
  separately check live named staff, mailbox access, exact observed store and
  revocation via `isDeviceAuthorized`; there is no device-ID-only permission.
- Task 3 integration, canonical signature string, explicit non-goals and
  operator commands are documented in `src/outlook-security/README.md`.
  Task 3 owns per-navigation challenge registration/expiry/invalidation,
  session-bound one-use browser tickets and COM scope checks; this task has
  **not** exposed reusable grants or device secrets to JavaScript.

## TDD evidence

RED: `env -u DATABASE_URL -u VITEST_ALLOW_PILOT_RDS TEST_DATABASE_URL=<local disposable URL> CONFIRM_DISPOSABLE_TEST_DB=1 pnpm --filter @zero/server exec vitest run tests/outlook-device-enrollment.test.ts` failed because the new `outlook-device.js` schema/service did not exist. Subsequently the real PostgreSQL expiration test failed (`expected null, received {deviceId}`) when SQL used transaction-frozen `now()`, and the revocation challenge test exposed the registration-status leak in a stateful challenge. Switched to `clock_timestamp()` and stateless uniform public challenge; clarified the test's return contract. A separate full-suite DB test left unrelated persisted fixture rows, so the per-test grant-count assertion was scoped to its device ID.

GREEN: Same focused command: **7 tests passed**, 0 failures, including
independent-connection simultaneous enrollment consumption and independent-
connection simultaneous nonce consumption, expired/guessed/wrong-store code,
replay/tampered bytes/revocation, authorization scope, key validation and
leak-free HTTP responses. Latest run: 2026-09-29 00:21 UTC, 7/7, exit 0.

Final committed migration verified on a **separate new empty disposable local
PostgreSQL database**, `nava_outlook_v4_final_test`, created by connecting
directly to `postgres://postgres@127.0.0.1:55579/postgres?sslmode=disable`
after a read-only lookup confirmed this database did not yet exist. Docker
socket inspection was denied, so the explicit loopback Postgres port was used
instead; no pilot/prod host was contacted. Command:
`env -u VITEST_ALLOW_PILOT_RDS DATABASE_URL='postgres://postgres@127.0.0.1:55579/nava_outlook_v4_final_test?sslmode=disable' TEST_DATABASE_URL='postgres://postgres@127.0.0.1:55579/nava_outlook_v4_final_test?sslmode=disable' CONFIRM_DISPOSABLE_TEST_DB=1 pnpm --filter @zero/server db:migrate`.
Exit 0: `[✓] migrations applied successfully!`. Earlier additive migrations
emitted benign notices for long PostgreSQL identifiers and missing trigger
drop-if-exists; no error or migration failure occurred. A subsequent read-only
`information_schema.tables` and `pg_indexes` query against this exact local
database returned all five tables `outlook_device`, `outlook_device_grant`,
`outlook_device_nonce`, `outlook_enrollment`, `outlook_enrollment_grant` and
indexes `outlook_device_nonce_device_idx`, **`outlook_device_nonce_expiry_idx`**,
plus the expected primary-key indexes. Both migration and inspection exited 0.

`pnpm --filter @zero/server build`: exit 0 (TypeScript, rechecked after final code changes).

The broader `pnpm --filter @zero/server test` was attempted once against the
disposable DB with ambient `DATABASE_URL` and
`VITEST_ALLOW_PILOT_RDS` unset. Existing unrelated tests failed because
`PORT`, `BETTER_AUTH_URL`, `BETTER_AUTH_SECRET`, `AWS_REGION`, and `S3_BUCKET`
were not configured, plus deploy-config shell timeout tests. It was stopped
after those failures rather than suggesting a clean full-suite result; do not
interpret this as a Task 2 regression.

## Files and self-review

Changed: schema `outlook-device.ts`, schema index, migration 0029/journal,
`outlook-security/device.ts` and `README.md`, `http/outlook-native.ts`,
`main.ts`, `scripts/outlook-device-operator.ts`, and
`tests/outlook-device-enrollment.test.ts`; this report. Did not stage the
parent's dirty progress file or untracked plan. No `.env.production` read;
no production/pilot RDS contacted or mutated.

Self-review: SQL code/nonce claims and device+grant insertion are transactional;
concurrent DB sessions cannot redeem twice. Challenge issuance is stateless,
unknown/revoked IDs indistinguishable at that endpoint; requests and code
lengths bounded. Device metadata consists of ID/version/store/enrollment/
last handshake/revocation and separately encrypted secret and access binding;
no bodies, passwords, click telemetry, or plaintext secrets are persisted.
Because the key is not configured in this development shell, deployment must
provision it separately before enrollment. A key rotation requires planned
device re-enrollment. Production edge rate limits on enrollment guesses and
observability of repeated failures belong to Task 6 deployment hardening;
32-byte unpredictable codes make guessing infeasible, and no guessed code
creates a row. The only unauthenticated persistent write is a valid code
redemption; no public self-signup exists.

## Reviewer fixes — 2026-09-29

RED: Against the fresh disposable loopback PostgreSQL DB
`nava_outlook_v4_final_test`, with inherited `DATABASE_URL` and
`VITEST_ALLOW_PILOT_RDS` explicitly unset, ran
`env -u DATABASE_URL -u VITEST_ALLOW_PILOT_RDS TEST_DATABASE_URL='postgres://postgres@127.0.0.1:55579/nava_outlook_v4_final_test?sslmode=disable' CONFIRM_DISPOSABLE_TEST_DB=1 pnpm --filter @zero/server exec vitest run tests/outlook-device-enrollment.test.ts`.
Result: 7 passed, **4 expected failures**: unverified staff issuance resolved
instead of rejecting; forged local JS clock let an expired nonce pass against
the actual DB clock; a non-v4 UUID paired successfully; a no-Content-Length
stream delivered all 100 2KiB chunks before the 413 response instead of
stopping after the first three. Each failure demonstrated the reviewed gap.

GREEN: Streaming JSON now stops reading and cancels on crossing 4096 bytes,
even for chunked/no-Content-Length requests. Both the operator email lookup
and the transactional service require `user.emailVerified=true`; a real CLI
subprocess regression test verifies an unverified staff account cannot issue a
code. The native device ID must be canonical UUIDv4 with RFC 4122 variant.
Signed nonce consumption now uses a conditional `INSERT ... SELECT ...
ON CONFLICT DO NOTHING RETURNING` whose **database wall clock** checks nonce
issuance/expiry and signed timestamp in the same statement as the unique
nonce receipt. Test fakes an earlier JavaScript clock while PostgreSQL keeps
actual time and verifies no receipt is persisted. The code and CLI onboarding
documentation note Better Auth has `requireEmailVerification:false`: operators
must provision and verify staff accounts before pairing; this grants no public
signup. No migration changes were needed.

The same exact focused disposable-DB command above now reports **12 tests
passed / 0 failed**, exit 0 (including original independent-connection replay
and code races plus new CLI/stream/expiry tests). Fresh
`pnpm --filter @zero/server build` exits 0. Existing broad-suite environment
limitations from the earlier run remain unchanged; no pilot/prod DB contacted.
