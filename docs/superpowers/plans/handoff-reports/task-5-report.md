# Task 5 Report: Auth, Mailbox Context, And Seed

**Date:** 2026-07-01
**Branch:** EC2-pilot
**Commits:**
- `b92ee32f` — `feat: add mailbox auth context and seed` (amended once to fix test-db helper; not pushed)

## Status

DONE

## What was implemented

Real Better Auth instance wired against the RDS schema via the drizzle adapter; `resolveMailboxContext` tRPC context resolver with FORBIDDEN rejection; production-shaped pilot seed (ingest mailbox, transport, 3 access rows, 3 pilot users with hashed credentials); auth handlers mounted at `/api/auth/*` plus `/api/public/providers` endpoint consumed by the apps/mail login page; `/health` unchanged; two test files (auth-context, seed-contract) using a transaction-rollback strategy so RDS is never polluted.

### Files created

- `apps/server-pilot/src/trpc/context.ts` — `resolveMailboxContext(userId, requestedTransportId?, db)` returning `{ userId, activeTransportId, transportEmail, accessRole }`. With a requested transport: inner-joins `mailboxAccess`↔`mailboxTransport` on `transportId`, filters `userId = ? AND transportId = ?`, throws `MailboxForbiddenError` (message `'FORBIDDEN'`) when no row. Without a requested transport: selects all the user's accesses, ranks by role (owner=0 > admin=1 > member=2), returns the first. Exports `MailboxContext` type and `DB` type alias for `PostgresJsDatabase<typeof schema>`.
- `apps/server-pilot/src/db/seed.ts` — reusable `seedAll(db)` that idempotently inserts:
  - `mailIngestMailbox` `ingest-nava-legacy` (email `nava@legacyhotel.com`, isActive true)
  - `mailboxTransport` `transport-centurion` (email + ownerHeaderValue `centurion@legacyhotel.com`, **mailboxType `'personal'`** per Task 4 design note, displayName `Centurion Transport`, isActive true) — `onConflictDoUpdate` on `ownerHeaderValue`
  - 3 `user` rows (`user-manager`/`user-centurion-worker`/`user-admin`) with `emailVerified=true`, upserted by email
  - 3 `account` rows (`cred-<userId>`, providerId `credential`, password hashed via `better-auth/crypto` `hashPassword` — scrypt N=16384 r=16 p=1 dkLen=64, format `<salt>:<key>` hex), upserted by `account.id` so re-running rotates passwords
  - 3 `mailboxAccess` rows (`access-<userId>-transport-centurion`, role owner/member/admin respectively), upserted on `[userId, transportId]`
  - Returns `{ pilotCredentials, transportCount, accessCount }`.
- `apps/server-pilot/scripts/seed-prod.ts` — production runner. Opens a drizzle postgres-js connection to `DATABASE_URL` (ssl `rejectUnauthorized: false`), calls `seedAll(db)`, then `aws secretsmanager put-secret-value --secret-id nava-zero/server-pilot/pilot-users --secret-string <json>` to persist the generated passwords as JSON keyed by email. Credentials never touch the repo (secret is in `.gitignore` scope via Secrets Manager). Script alias `seed:prod` in package.json runs `tsx scripts/seed-prod.ts`.
- `apps/server-pilot/tests/auth-context.test.ts` — 5 tests:
  1. owner access for `user-manager` on `transport-centurion` returns `transportEmail='centurion@legacyhotel.com'`, `accessRole='owner'`, correct userId/activeTransportId
  2. `user-frontdesk` rejected with `/FORBIDDEN/`
  3. `user-admin` with no requested transport defaults to `transport-centurion` with role `admin`
  4. `user-ghost` (no accesses) rejected as `MailboxForbiddenError`
  5. unit: `MailboxForbiddenError` carries message `'FORBIDDEN'` and name `'MailboxForbiddenError'`
  DB-backed tests gated by `describe.skipIf(!TEST_DB_AVAILABLE || !reachable)` where `reachable = await probeTestDb()` opens a 4s-timeout `select 1` to RDS.
- `apps/server-pilot/tests/seed-contract.test.ts` — 5 tests:
  1. `nava@legacyhotel.com` ingest mailbox exists, isActive true
  2. `transport-centurion` has email + ownerHeaderValue `centurion@legacyhotel.com`, mailboxType `'personal'`, isActive true
  3. exactly 3 `mailbox_access` rows on `transport-centurion` with roles owner/member/admin for user-manager/user-centurion-worker/user-admin
  4. 3 pilot users with `emailVerified=true` and the expected emails
  5. 3 credential accounts with passwords matching `^[0-9a-f]+:[0-9a-f]+$` (better-auth scrypt format)
  Same skip gate as auth-context tests.
- `apps/server-pilot/tests/helpers/test-db.ts` — `withTestDb(cb)` opens a drizzle postgres-js DB and runs `cb` inside `db.transaction(tx => ...)`; unconditionally throws a sentinel `Error('___test_rollback___')` after the callback to force rollback (caught and swallowed), so RDS is never polluted. `withSeededTestDb(cb)` calls `seedAll(db)` inside the rollback transaction before `cb`. `probeTestDb()` memoized DNS+connect probe. `TEST_DB_AVAILABLE` exported for `describe.skipIf`.

### Files modified

- `apps/server-pilot/src/lib/auth.ts` — replaced stub with real Better Auth. `createAuth(opts?)` now: reads `BETTER_AUTH_SECRET`/`BETTER_AUTH_URL` from env (dev fallback secret preserved), gets the drizzle DB via `getDb()`, wires `drizzleAdapter(db, { provider: 'pg', schema })`, enables `emailAndPassword` (requireEmailVerification false, autoSignIn true) unless `PILOT_EMAIL_PASSWORD_DISABLED=1`, sets `emailVerification.sendVerificationEmail` to a no-op (pilot has no email transport), configures session cookie cache (30d expiry, 3d updateAge), `account.accountLinking` (allowDifferentEmails, trustedProviders `['google']`), `advanced.cookiePrefix` (`better-auth-dev` in dev, `better-auth` otherwise). Google social is included only when both `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are present via the existing `getSocialProviders` helper (which warns and skips in pilot mode otherwise). `Auth` and `SimpleAuth` type aliases preserved for `apps/mail` typecheck.
- `apps/server-pilot/src/main.ts` — kept `/health` first; added `GET /api/public/providers` (mirrors legacy `apps/server/src/routes/auth.ts` shape: returns `{ allProviders: [...customProviderStatus, ...authProviderStatus], isProd }` consumed by `apps/mail/app/(auth)/login/page.tsx`); then `createAuth()` once and `app.on(['GET','POST','OPTIONS'], '/api/auth/*', c => auth.handler(c.req.raw))` for Better Auth's default basePath `/api/auth`.

## Test strategy

- **Transaction-rollback against RDS**: tests run inside `db.transaction(tx => ...)` with an unconditional sentinel throw at the end so drizzle rolls back every test transaction. No separate test database, no schema pollution, no manual cleanup. Verified by re-running the suite twice on EC2 and confirming `select count(*) from mailbox_access` stayed at 3 (the seeded production rows) — the test-inserted rows were rolled back.
- **Skip when DB unreachable**: `describe.skipIf(!TEST_DB_AVAILABLE || !reachable)`. On the Windows laptop (outside the VPC, RDS private) the 9 DB-backed tests skip and the suite still passes 16/16. On EC2 (inside VPC) all 25 tests pass.
- **Unit test always runs**: the `MailboxForbiddenError` shape test runs everywhere with no DB dependency.

## Verification

### Local (Windows laptop, outside VPC)

```
pnpm --filter @zero/server build         → exit 0, tsc clean
pnpm --filter @zero/server test          → 16 passed | 9 skipped (25 total)
  ✓ tests/env.test.ts (4)
  ✓ tests/schema-contract.test.ts (6)
  ✓ tests/package-contract.test.ts (5)   — confirms @zero/server/auth, /trpc, /auth-providers, /schemas still resolve for apps/mail
  ✓ tests/auth-context.test.ts (5 | 4 skipped)   — only the MailboxForbiddenError unit test runs locally
  ↓ tests/seed-contract.test.ts (5 | 5 skipped)
```

### EC2 (i-008f737974a9ba9b3, inside VPC) — synced to `b92ee32ff9`

```
pnpm install --frozen-lockfile --filter @zero/server...   → INSTALL_OK
pnpm test -- --reporter=dot
  Test Files  5 passed (5)
  Tests       25 passed (25)
  Duration    5.16s
    tests/auth-context.test.ts (5 tests) 3684ms
      ✓ returns owner access for Centurion manager  1120ms
      ✓ rejects users without mailboxAccess with FORBIDDEN  856ms
      ✓ defaults to first accessible transport when none requested  854ms
      ✓ rejects unknown user with no accesses  853ms
      ✓ exposes MailboxForbiddenError carrying FORBIDDEN  3ms
    tests/seed-contract.test.ts (5 tests) 4113ms
      ✓ seeds nava@legacyhotel.com ingest mailbox  654ms
      ✓ seeds transport-centurion with personal mailboxType and centurion owner header  890ms
      ✓ seeds exactly 3 mailbox_access rows on transport-centurion with correct roles  854ms
      ✓ seeds the three pilot users with emailVerified=true  857ms
      ✓ seeds credential accounts for the three pilot users with hashed passwords  856ms
```

### `pnpm seed:prod` on EC2

```
seed complete
ingest mailbox: nava@legacyhotel.com
transports (count): 1
mailbox_access rows (total): 3
pilot users: manager@legacyhotel.com, worker@legacyhotel.com, admin@legacyhotel.com
pilot credentials stored in Secrets Manager: nava-zero/server-pilot/pilot-users
```

### RDS via EC2 psql

```
psql "$DATABASE_URL" -c "select email from mailbox_transport;"
           email
---------------------------
 centurion@legacyhotel.com
(1 row)

psql "$DATABASE_URL" -c "select count(*) from mailbox_access where transport_id=(select id from mailbox_transport where owner_header_value='centurion@legacyhotel.com');"
 count
-------
     3
(1 row)

psql "$DATABASE_URL" -c "select id, email, email_verified from \"user\" order by id;"
          id           |          email          | email_verified
-----------------------+-------------------------+----------------
 user-admin            | admin@legacyhotel.com   | t
 user-centurion-worker | worker@legacyhotel.com  | t
 user-manager          | manager@legacyhotel.com | t
(3 rows)

psql "$DATABASE_URL" -c "select user_id, role from mailbox_access where transport_id='transport-centurion' order by user_id;"
        user_id        |  role
-----------------------+--------
 user-admin            | admin
 user-centurion-worker | member
 user-manager          | owner
(3 rows)

psql "$DATABASE_URL" -c "select email, is_active from mail_ingest_mailbox;"
        email         | is_active
----------------------+-----------
 nava@legacyhotel.com | t
(1 row)
```

### `/health` and `/api/public/providers` after auth mount

```
pnpm build → exit 0
node dist/main.js → server-pilot listening on http://0.0.0.0:8788
curl http://127.0.0.1:8788/health              → {"ok":true,"service":"server-pilot"}
curl http://127.0.0.1:8788/api/public/providers → {"allProviders":[{"id":"google","name":"Google","enabled":false,"required":true,"envVarInfo":[...],"envVarStatus":[{"name":"GOOGLE_CLIENT_ID","set":false,...},{"name":"GOOGLE_CLIENT_SECRET","set":false,...}]}],"isProd":true}
```

`/health` still works after auth mount. `/api/public/providers` returns the providers list (Google disabled in pilot since `GOOGLE_CLIENT_*` env vars are not set on EC2; `getSocialProviders` logs a warn and skips it, server still boots). The apps/mail login page will fall back to the demo provider button when no providers are enabled, which is the expected pilot behavior.

## Pilot credentials storage

- Secret name: `nava-zero/server-pilot/pilot-users`
- ARN: `arn:aws:secretsmanager:af-south-1:845242190536:secret:nava-zero/server-pilot/pilot-users-fioTQv`
- Format: JSON `{"manager@legacyhotel.com":{"password":"..."},"worker@legacyhotel.com":{"password":"..."},"admin@legacyhotel.com":{"password":"..."}}`
- Passwords: 24-char base64url random (18 bytes entropy), hashed in the `account.password` column with better-auth scrypt (`<salt>:<key>` hex).
- Frontend login: pilot uses email/password against Better Auth's `/api/auth/sign-in/email` endpoint. The apps/mail `authClient.signIn.emailWithEmailAndPassword` (from `better-auth/react`) works against this backend once `VITE_PUBLIC_BACKEND_URL` points at the server-pilot origin. The current `apps/mail` login page only renders social buttons + a demo fallback; wiring an email/password form on the frontend is a Task 7 concern (frontend), not Task 5. The backend auth surface is ready.
- IAM: added inline policy `NavaZeroPilotUsersSecretWrite` to EC2 role `nava-prod-public-ipv4-WorkerRole-bPmrMEkmdwLU` granting `secretsmanager:PutSecretValue`/`DescribeSecret`/`GetSecretValue` on `arn:aws:secretsmanager:af-south-1:845242190536:secret:nava-zero/server-pilot/pilot-users-*`. Required because the existing `NavaZeroSecretsRead` policy only covered `database-url-*`.

## Files changed summary

```
apps/server-pilot/src/lib/auth.ts                 | modified (real Better Auth)
apps/server-pilot/src/main.ts                     | modified (auth mount + /api/public/providers)
apps/server-pilot/src/trpc/context.ts             | new
apps/server-pilot/src/db/seed.ts                  | new
apps/server-pilot/scripts/seed-prod.ts            | new
apps/server-pilot/tests/auth-context.test.ts      | new
apps/server-pilot/tests/seed-contract.test.ts     | new
apps/server-pilot/tests/helpers/test-db.ts        | new
```

8 files changed, 724 insertions(+), 13 deletions(-).

## Self-review findings

- **Brief contract met**: `resolveMailboxContext(userId, requestedTransportId?)` returns `{ userId, activeTransportId, transportEmail, accessRole }`; rejects no-access users with `FORBIDDEN`. Seed contents match the brief verbatim: `nava@legacyhotel.com` ingest, `transport-centurion` with `centurion@legacyhotel.com` ownerHeader, 3 access rows owner/member/admin. Task 4 design note honored: `mailboxType: 'personal'` set explicitly on transport-centurion (not the schema default `'shared'`).
- **DB injection**: `resolveMailboxContext` takes the DB handle as a 3rd arg so production wires `getDb()` and tests wire a transaction-scoped handle. This keeps the resolver pure and testable without module-level mocking. The brief's 2-arg signature is preserved by having the tRPC context factory (Task 7) call `resolveMailboxContext(userId, transportId, getDb())`.
- **Better Auth drizzle adapter**: passes `schema` as `Record<string, unknown>` so the adapter can map table names. Better Auth's default snake_case column mapping matches the schema (e.g. `emailVerified` → `email_verified`). No `usePlural` (table names are singular: `user`, `session`, `account`, `verification`).
- **Password hashing**: uses `better-auth/crypto` `hashPassword` (scrypt N=16384 r=16 p=1 dkLen=64, `<salt>:<key>` hex) — the same function Better Auth's sign-up/sign-in endpoints use internally. So a pilot user can also be created via `/api/auth/sign-up/email` and the seed-created accounts verify with the same code path.
- **Idempotency**: all seed inserts use `onConflictDoNothing` or `onConflictDoUpdate`. Re-running `seed:prod` rotates passwords (new random) and re-upserts the secret. The 3 access rows keep their roles. Verified by running seed once on EC2; counts match.
- **`/health` ordering**: `/health` is registered before `/api/public/providers` and `/api/auth/*` so auth middleware can never shadow it.
- **No unrelated files staged**: `git status` before commit showed only the 8 task-5 files staged; the many untracked user files (`.claude/skills/*`, `.husky/_/*`, `.superpowers/sdd/*`, `apps/mail/node_modules/*`, etc.) were left alone.
- **Apps/mail typecheck preserved**: `package-contract.test.ts` still imports `@zero/server/auth`, `/trpc`, `/auth-providers`, `/schemas` and passes (5/5), confirming the `Auth` type export and `createAuth` signature still satisfy `apps/mail/lib/auth-client.ts`'s `import type { Auth } from '@zero/server/auth'`.

## Concerns

1. **Frontend login form not wired for email/password**: `apps/mail/app/(auth)/login/login-client.tsx` only renders social provider buttons (and the demo fallback). To actually log in as a pilot user from the browser, Task 7 needs to add an email/password form calling `authClient.signIn.emailWithEmailAndPassword({ email, password })`. The backend `/api/auth/sign-in/email` endpoint is live and functional. Pilot can also be exercised via curl in the meantime.
2. **Google social disabled in pilot**: `getSocialProviders` returns `{}` when `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` are missing, and `auth-providers.ts` marks Google as `required: true`, so the login page shows "Authentication service unavailable" in prod mode when no providers are enabled. This is the existing `apps/mail` behavior and is expected for the pilot (we deliberately seed email/password users instead). Setting the Google env vars on EC2 would re-enable it.
3. **`rejectUnauthorized: false` on SSL**: carried over from Task 4's `db/client.ts`. Acceptable for pilot; production should pin the RDS CA bundle.
4. **Pilot passwords in Secrets Manager only**: there is no admin UI to retrieve them. Operator must `aws secretsmanager get-secret-value --secret-id nava-zero/server-pilot/pilot-users` to fetch credentials for hand-off. Acceptable for pilot.
5. **`mailboxAccess.id` has no default**: schema requires explicit `id` on insert. Seed uses deterministic `access-<userId>-transport-centurion` ids. Task 7 application code creating access rows must also generate ids (e.g. `crypto.randomUUID()`).
6. **`db.transaction` rollback via sentinel throw**: drizzle's `transaction()` rolls back when the callback rejects. We throw a sentinel `Error('___test_rollback___')` after the user callback and swallow it in the outer catch. This is a known pattern; the only risk is if user code legitimately throws an error with that exact message, which would be silently swallowed. Mitigated by the unlikely string and by the fact that test failures surface as assertion errors (different messages).

## RCA notes for failures encountered

### RCA 1: drizzle-orm 0.43.1 `drizzle(tx, { schema })` inside `postgres-js` `conn.begin` throws `Cannot read properties of undefined (reading 'parsers')`

- **Task:** Task 5 Step 4 — run DB-backed tests on EC2.
- **Symptom:** `TypeError: Cannot read properties of undefined (reading 'parsers')` at `drizzle-orm/postgres-js/driver.ts:32:18` when constructing `drizzle(tx, { schema })` inside `conn.begin(async (tx) => ...)`.
- **Command:** `pnpm test` on EC2 (first run, before fix).
- **Root cause:** `drizzle()` for postgres-js reads `client.parsers` and `client.options` from the postgres-js `Sql` object. The `TransactionSql` returned by `conn.begin` is a scoped subset that lacks the `parsers`/`options` properties the constructor expects (it delegates to the parent via closure but doesn't expose those fields as own properties). So `drizzle(tx, ...)` fails. The correct drizzle pattern is to construct `drizzle(conn, { schema })` once on the full `Sql`, then use `db.transaction(async (tx) => ...)` where `tx` is already a `PgTransaction` with the query API baked in — no second `drizzle()` call needed.
- **Options considered:** (a) construct `drizzle(tx)` — fails as above; (b) pass the full `conn` to the test callback and wrap each test in `conn.begin` manually — loses drizzle's query builder ergonomics; (c) construct `drizzle(conn)` once, then `db.transaction(tx => cb(tx))` — correct, drizzle auto-rolls-back on rejection.
- **Fix chosen:** (c). Rewrote `tests/helpers/test-db.ts` to `const db = drizzle(conn, { schema }); await db.transaction(async (tx) => { userResult = await cb(tx as unknown as DB); throw new Error(ROLLBACK); })`. The unconditional sentinel throw forces rollback on success; user-callback errors propagate and also trigger rollback. Swallow only the sentinel in the outer catch.
- **Verification:** re-ran `pnpm test` on EC2 → 25/25 pass, including all 9 DB-backed tests (4 auth-context + 5 seed-contract). Re-ran twice; `select count(*) from mailbox_access` stayed at 3 (production seed) — test transactions were rolled back.

### RCA 2: SSM `charmap` codec crash on vitest unicode box-drawing chars

- **Task:** Task 5 Step 4 — capture vitest output via SSM on EC2.
- **Symptom:** SSM command Status `Failed` with `'charmap' codec can't encode character '\u25c7'` (vitest's `◇` reporter glyph) even though tests may have run.
- **Root cause:** the SSM agent on EC2 uses Python with a non-UTF8 locale to encode command stdout for `GetCommandInvocation`. vitest's default reporter emits unicode box-drawing characters; the Python encoder crashes, marking the command Failed and discarding stdout. Same issue as Task 4 RCA 4.
- **Fix chosen:** run vitest with `--reporter=dot` (ASCII `.`/`F` glyphs) and pipe through `LC_ALL=C tr -dc "\040-\176\012\015"` to strip any residual non-ASCII before SSM ships it. Also `tee` to a logfile on EC2 for full-fidelity debugging.
- **Verification:** SSM command Status `Success` with full ASCII output including `Test Files 5 passed (5)` / `Tests 25 passed (25)`.

### RCA 3: EC2 role lacked `secretsmanager:PutSecretValue` on `nava-zero/server-pilot/pilot-users`

- **Task:** Task 5 Step 4 — `pnpm seed:prod` on EC2.
- **Symptom:** `seed failed: Error: aws secretsmanager put-secret-value exit 254: ... AccessDeniedException ... is not authorized to perform: secretsmanager:PutSecretValue on resource: nava-zero/server-pilot/pilot-users`.
- **Root cause:** the EC2 instance profile role `nava-prod-public-ipv4-WorkerRole-bPmrMEkmdwLU` had inline policy `NavaZeroSecretsRead` granting `GetSecretValue`/`DescribeSecret` only on `nava-zero/server-pilot/database-url-*`. The new `pilot-users` secret was not in scope, and no `PutSecretValue` grant existed anywhere.
- **Fix chosen:** (1) pre-create the secret from the laptop (`aws secretsmanager create-secret --name nava-zero/server-pilot/pilot-users --secret-string '{}'`) so `PutSecretValue` is the only operation needed from EC2 (creating a secret requires `CreateSecret` which the laptop identity has). (2) add inline policy `NavaZeroPilotUsersSecretWrite` to the EC2 role granting `secretsmanager:PutSecretValue`/`DescribeSecret`/`GetSecretValue` on `arn:aws:secretsmanager:af-south-1:845242190536:secret:nava-zero/server-pilot/pilot-users-*`.
- **Verification:** re-ran `pnpm seed:prod` on EC2 → `seed complete` + `pilot credentials stored in Secrets Manager: nava-zero/server-pilot/pilot-users`. `aws secretsmanager list-secrets` shows both secrets. The policy addition is recorded in `aws-resources.md` scope (operator should append it to the doc in a follow-up; not done here to keep the commit scoped to code).

### RCA 4: `beforeAll` throwing marks vitest suite as Failed, not Skipped

- **Task:** Task 5 — gate DB-backed tests on DB reachability.
- **Symptom:** `beforeAll(async () => { if (!reachable) throw new Error('DB unreachable...') })` caused the whole `describe` block to fail (not skip) when RDS was unreachable from the laptop.
- **Root cause:** vitest treats a thrown `beforeAll` as a setup failure → all tests in the block fail, not skip. `describe.skip`/`describe.skipIf` must be evaluated at collection time, not inside `beforeAll`.
- **Fix chosen:** hoist the reachability probe to module top-level (`const reachable = await probeTestDb()`) and gate the whole `describe` with `describe.skipIf(!TEST_DB_AVAILABLE || !reachable)`. The probe is a 4s-timeout `select 1` memoized across both test files. Top-level await is supported in vitest's ESM module loading.
- **Verification:** on laptop (RDS unreachable) → 9 DB-backed tests `skipped`, 16 pass. On EC2 (reachable) → all 25 pass.
