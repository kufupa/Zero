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

Disposable DB migration: `DATABASE_URL=<local disposable URL>
TEST_DATABASE_URL=<same local URL> CONFIRM_DISPOSABLE_TEST_DB=1
pnpm --filter @zero/server db:migrate`: exit 0 (`migrations applied
successfully`). This DB had already applied migration 0029 before the final
additive nonce-expiry index was included in its SQL; a clean migration of the
final migration file should be run on a new disposable DB during integration.

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
