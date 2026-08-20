# Task 4 Report: Production Mail Schema

**Date:** 2026-07-01
**Branch:** EC2-pilot
**Commits:**
- `cd2ed2ea` — `feat: add production mailbox schema`
- `7156f885` — `fix: enable RDS SSL and harden SSM command quoting`

## Status

DONE

## What was implemented

Production mail-core Drizzle schema for `apps/server-pilot` plus DB client, drizzle config, contract test, and migration applied to RDS Postgres 16.

### Schema files created

- `apps/server-pilot/src/db/schema/auth.ts` — `user`, `session`, `account`, `verification` (Better Auth shapes; `user.id` PK text, `email` unique, `emailVerified`, `phoneNumber` unique, `customPrompt`; session token unique + user FK cascade; account provider/user indexes).
- `apps/server-pilot/src/db/schema/app.ts` — `note` (userId+threadId, isPinned, order), `userSettings` (jsonb settings default `defaultUserSettings`, userId unique), `emailTemplate` (userId+name unique), `jwks` (publicKey/privateKey). Imports `user` from `./auth.js`.
- `apps/server-pilot/src/db/schema/mail.ts` — 9 mail-core tables + 3 enums:
  - `mailboxAccessRoleEnum = pgEnum('mailbox_access_role', ['owner','member','admin'])` (verbatim per brief)
  - `mailboxTypeEnum` = `['personal','shared']`
  - `messageDirectionEnum` = `['inbound','outbound']`
  - `mailIngestMailbox` (aggregate POP3 source, email unique, isActive)
  - `mailIngestQuarantine` (ingestMailboxId FK, pop3Uidl, rawMimeS3Key, reason, ownerHeaderValue, parsedHeaders)
  - `mailboxTransport` (email unique, ownerHeaderValue, mailboxType, sendFromConfig jsonb) + `uniqueIndex('mailbox_transport_owner_header_uidx').on(ownerHeaderValue)`
  - `mailboxAccess` (userId, transportId, role) + `uniqueIndex('mailbox_access_user_transport_uidx').on(userId,transportId)` + `index('mailbox_access_user_role_idx').on(userId,role)`
  - `mailLabel` (transportId, name) + `uniqueIndex('mail_label_transport_name_uidx').on(transportId,name)`
  - `mailThread` (transportId, threadRootId, snoozedUntil, latestMessageAt, isArchived/isStarred/isRead, labelIds) + `uniqueIndex('mail_thread_transport_root_uidx').on(transportId,threadRootId)` + `index('mail_thread_transport_list_idx').on(transportId,isArchived,latestMessageAt)` + `index('mail_thread_snooze_wake_idx').on(snoozedUntil).where(snoozedUntil IS NOT NULL)`
  - `message` (transportId, threadId, ingestMailboxId, direction, pop3Uidl, ownerHeaderValue, messageIdHeader, inReplyTo, references, fromAddress, to/cc/bcc, subject, text/html body, rawMimeS3Key, receivedAt, sentAt) + `uniqueIndex('message_ingest_uidl_uidx').on(ingestMailboxId,pop3Uidl).where(direction='inbound')` + `index('message_transport_thread_idx').on(transportId,threadId)`
  - `attachment` (messageId FK, filename, mimeType, sizeBytes, s3Key, contentId, isInline)
  - `mailDraft` (transportId, threadId, createdByUserId, to/cc/bcc, subject, text/html, attachments jsonb, isSent, sentMessageId)
- `apps/server-pilot/src/db/schema/index.ts` — barrel `export * from './auth.js'/'app.js'/'mail.js'`.
- `apps/server-pilot/src/db/client.ts` — postgresjs + drizzle client. `createDb(url)` returns `{db, conn}`; `getDb()`/`getConn()` lazy cached singletons reading `DATABASE_URL` via `parseEnv(process.env)`; `closeDb()` ends conn. `ssl: { rejectUnauthorized: false }` to satisfy RDS `rds.force_ssl=1`.
- `apps/server-pilot/drizzle.config.ts` — `schema: ./src/db/schema/index.ts`, `dialect: postgresql`, `out: ./drizzle`, appends `?sslmode=require` to `DATABASE_URL` if not present.
- `apps/server-pilot/tests/schema-contract.test.ts` — 6 contract tests (brief's 3 + 3 extra: required context columns present; kept auth/compat tables present; dropped connection-era + de-scoped tables absent).

### Files modified

- `apps/server-pilot/package.json` — added `postgres: 3.4.5` dep; switched `db:generate`/`db:migrate` to `node --import tsx ./node_modules/drizzle-kit/bin.cjs ...` (fixes drizzle-kit 0.31.4 NodeNext `.js`-extension resolution failure).
- `apps/server-pilot/deploy/ssm-run-command.sh` — base64-encode remote command, pipe through `base64 -d | bash -s` so the outer SSM sh no longer pre-expands `$VAR`/`${VAR}` before bash runs.
- `pnpm-lock.yaml` — regenerated for `postgres` dep.

## Table list (17 total, all on RDS)

Auth: `user`, `session`, `account`, `verification`
App: `note`, `user_settings`, `email_template`, `jwks`
Mail-core: `mail_ingest_mailbox`, `mail_ingest_quarantine`, `mailbox_transport`, `mailbox_access`, `mail_label`, `mail_thread`, `message`, `attachment`, `mail_draft`

De-scoped/dropped (absent): `connection`, `summary`, `writing_style_matrix`, `oauth_application`, `oauth_access_token`, `oauth_consent`, `early_access`, `user_hotkeys`. No `staffMember`, `mailSnooze`, `mailPrompt`, `messageRecipient`.

## Indexes

All 7 critical indexes from plan present on RDS (verified via `pg_indexes`):
- `mailbox_transport_owner_header_uidx` (unique, ownerHeaderValue)
- `mailbox_access_user_transport_uidx` (unique, userId+transportId)
- `mailbox_access_user_role_idx` (userId+role)
- `message_ingest_uidl_uidx` (unique, ingestMailboxId+pop3Uidl, WHERE direction='inbound'::message_direction)
- `mail_thread_transport_root_uidx` (unique, transportId+threadRootId)
- `mail_thread_transport_list_idx` (transportId+isArchived+latestMessageAt)
- `message_transport_thread_idx` (transportId+threadId)
- `mail_label_transport_name_uidx` (unique, transportId+name)
- `mail_thread_snooze_wake_idx` (snoozedUntil, WHERE snoozedUntil IS NOT NULL)

Plus supporting indexes: account/session/user/verification/note/email_template/jwks indexes from legacy shapes, and mail_draft_transport/thread/created_by, attachment_message/s3_key, mail_ingest_quarantine_ingest/reason/created_at, mailbox_access_transport, mailbox_transport_email, mail_label_transport, message_transport_received, mail_ingest_mailbox_email.

## Migration filename

`apps/server-pilot/drizzle/0000_omniscient_siren.sql` (+ `meta/0000_snapshot.json`, `meta/_journal.json`). Fresh baseline (no prior pilot migrations).

## Verification

### Local

- `pnpm --filter @zero/server db:generate` → exit 0; output `17 tables` + `[✓] Your SQL migration file ➜ drizzle\0000_omniscient_siren.sql`.
- `pnpm --filter @zero/server test tests/schema-contract.test.ts` → **6/6 pass**.
- `pnpm --filter @zero/server test` (full) → **15/15 pass** (env 4, schema-contract 6, package-contract 5).
- `pnpm --filter @zero/server build` → exit 0, tsc clean (`dist/` populated).

### RDS via EC2 SSM

EC2 `i-008f737974a9ba9b3` Online. Synced `EC2-pilot` to `7156f8855` via `apps/server-pilot/deploy/sync-ec2-git-bundle.sh` (S3 git bundle).

- `pnpm install --frozen-lockfile --filter @zero/server...` on EC2 → `postgres` dep present (`apps/server-pilot/node_modules/postgres/package.json` verified).
- `node --import tsx ./node_modules/drizzle-kit/bin.cjs migrate` on EC2 (sourced `.env.production`, `DATABASE_URL` exported) → `MIGRATE_EXIT=0`, `migrations applied successfully!`. One NOTICE: `mail_ingest_quarantine_ingest_mailbox_id_mail_ingest_mailbox_id_fk` identifier truncated to 63 chars by Postgres (cosmetic; FK created).
- `psql "$DATABASE_URL" -c "\dt"` → **17 rows**, all target tables present (account, attachment, email_template, jwks, mail_draft, mail_ingest_mailbox, mail_ingest_quarantine, mail_label, mail_thread, mailbox_access, mailbox_transport, message, note, session, user, user_settings, verification). Owner `zero_admin`.
- `pg_indexes` query → 30 indexes, all critical indexes present with correct partial-index predicates.
- `drizzle.__drizzle_migrations` → 1 row (id=1, hash=177a9667..., created_at=1782879008018).

## Files changed summary

```
apps/server-pilot/drizzle.config.ts               | new
apps/server-pilot/drizzle/0000_omniscient_siren.sql| new
apps/server-pilot/drizzle/meta/0000_snapshot.json  | new
apps/server-pilot/drizzle/meta/_journal.json       | new
apps/server-pilot/src/db/client.ts                 | new
apps/server-pilot/src/db/schema/app.ts             | new
apps/server-pilot/src/db/schema/auth.ts            | new
apps/server-pilot/src/db/schema/index.ts           | new
apps/server-pilot/src/db/schema/mail.ts            | new
apps/server-pilot/tests/schema-contract.test.ts    | new
apps/server-pilot/package.json                     | modified (postgres dep, db scripts)
apps/server-pilot/deploy/ssm-run-command.sh        | modified (base64 quoting)
pnpm-lock.yaml                                     | modified
```

## Self-review findings

- **Schema split matches brief:** `auth.ts` (user/session/account/verification), `app.ts` (note/userSettings/emailTemplate/jwks), `mail.ts` (9 mail tables + 3 enums), `index.ts` barrel. No Drizzle schema in `src/lib/schemas.ts` (that file stays zod-only for FE typecheck, per brief).
- **Better Auth shapes preserved:** user/session/account/verification column shapes mirror legacy `apps/server/src/db/schema.ts` so Task 5's Better Auth drizzle adapter can use them. Dropped legacy `defaultConnectionId` (replaced by mailbox model) and `customPrompt` kept on user (not de-scoped). `userHotkeys` de-scoped per audit.
- **mailboxAccessRoleEnum verbatim:** `pgEnum('mailbox_access_role', ['owner','member','admin'])` exactly as brief specifies.
- **All required context columns present and contract-tested:** mailboxAccess.{userId,transportId,role}, mailboxTransport.{email,ownerHeaderValue,mailboxType}, mailThread.{transportId,snoozedUntil}, message.{transportId,ingestMailboxId,pop3Uidl,ownerHeaderValue}, mailDraft.createdByUserId.
- **Snooze on thread, not separate table:** `mailThread.snoozedUntil` + partial `mail_thread_snooze_wake_idx`. No `mailSnooze` table.
- **No message_recipient fan-out:** one `message` row per delivered copy (per plan global constraint).
- **No staffMember/mailPrompt:** absent, contract-tested.
- **FKs cascade appropriately:** session/account/note/userSettings/emailTemplate/mailboxAccess/mailboxTransport children cascade on user/transport delete; message→mailThread cascade; attachment→message cascade; mailIngestQuarantine→mailIngestMailbox cascade; message.ingestMailboxId set null on ingest mailbox delete (preserves message if ingest source removed).
- **Table names unprefixed:** pilot uses bare `user`, `session`, etc. (no `mail0_` prefix from legacy). Fresh DB, no collision.

## Concerns

1. **`rejectUnauthorized: false` on SSL:** pilot accepts RDS cert without CA pinning for expedience. Production hardening should pin the AWS RDS CA bundle (`rds-ca-rsa2048-g1`) and set `rejectUnauthorized: true`. Acceptable for pilot per plan's "build now, harden later" stance.
2. **Long FK identifier truncated:** `mail_ingest_quarantine_ingest_mailbox_id_mail_ingest_mailbox_id_fk` truncated to 63 chars by Postgres (NOTICE 42622). Cosmetic; the FK constraint is created and functional. No action needed.
3. **`db:migrate` not run locally:** no local Postgres/Docker available on the Windows laptop; migration was generated locally (drizzle-kit generate needs no DB) and applied directly to RDS via EC2 SSM. Plan permitted this fallback ("if no local pg available, generate migration and run against RDS directly via psql"). The `db:migrate` script is verified working on EC2.
4. **SSM stdout encoding:** the SSM agent's Python crashes on unicode box-drawing chars (drizzle-kit uses ⏟/✓/─), marking commands Failed and losing stdout. Worked around by writing output to a logfile and piping through `LC_ALL=C tr -dc "\040-\176\012\015"` to strip non-ASCII before SSM ships it. Future tasks should keep this pattern for any command emitting unicode.
5. **`postgres@3.4.5` pinned inline (not in catalog):** matches legacy `apps/server` pin. Could be moved to pnpm catalog later for consistency, but inline pin is safe and matches existing convention.

## RCA notes for failures encountered

### RCA 1: drizzle-kit 0.31.4 cannot resolve NodeNext `.js`-extension relative imports

- **Task:** Task 4 Step 3 — `pnpm --filter @zero/server db:generate`.
- **Symptom:** `Error: Cannot find module './auth.js'` when drizzle-kit loaded `src/db/schema/index.ts`.
- **Command:** `pnpm --filter @zero/server db:generate` (original `drizzle-kit generate`).
- **Root cause:** drizzle-kit 0.31.4 bundles a subset of tsx that hooks `Module._extensions` to compile `.js`/`.ts` files, but its `registerTsconfigPaths` only patches `Module._resolveFilename` for tsconfig `paths`/`baseUrl` matching — it does NOT redirect a literal `./auth.js` request to `./auth.ts`. Node's `_resolveFilename` runs before `_extensions`, so the require fails on the non-existent `auth.js` file. Confirmed via bin.cjs source inspection (`register2` only does `matchPath` for paths; the esbuild `register` only adds pirates hooks). Known upstream issues: drizzle-team/drizzle-orm#849, #1561, #2705, #4441.
- **Options considered:** (a) drop `.js` extensions — breaks tsc NodeNext (TS2835) and runtime Node ESM; (b) tsconfig `paths` mapping — `paths` don't do extension substitution and joycon doesn't follow `extends`; (c) single-file schema — loses the brief's required `auth.ts`/`app.ts`/`mail.ts` split; (d) run drizzle-kit through full `tsx` which DOES resolve `.js`→`.ts`.
- **Fix chosen:** update `db:generate`/`db:migrate` scripts to `node --import tsx ./node_modules/drizzle-kit/bin.cjs ...`. Full tsx registers a loader that resolves `.js`→`.ts` correctly. Cross-platform (no shell env var syntax issues). Verified: generate produced 17-table migration cleanly.
- **Verification:** `pnpm --filter @zero/server db:generate` → `17 tables` + migration file written. Build + tests still green.

### RCA 2: RDS rejects plaintext connections (rds.force_ssl=1)

- **Task:** Task 4 Step 4 — run migration on RDS via EC2 SSM.
- **Symptom:** `PostgresError: no pg_hba.conf entry for host "172.31.12.112", user "zero_admin", database "zero", no encryption`.
- **Command:** `node --import tsx ./node_modules/drizzle-kit/bin.cjs migrate` on EC2.
- **Root cause:** RDS `default.postgres16` parameter group has `rds.force_ssl=1` (verified via `describe-db-parameters`). Plaintext Postgres connections are rejected even from within the VPC. SG ingress was correct (RDS SG `sg-0fbe865a67165678c` allows 5432 from EC2 SG `sg-00190151691bd66fa`); the failure was at the pg_hba SSL requirement, not the SG.
- **Options considered:** (a) disable force_ssl — weakens security, requires param group change + reboot; (b) append `?sslmode=require` to DATABASE_URL — postgres-js honors it; (c) pass `ssl` option to postgres() in client.ts.
- **Fix chosen:** both (b) and (c). `drizzle.config.ts` appends `?sslmode=require` to the URL for drizzle-kit migrate; `db/client.ts` passes `ssl: { rejectUnauthorized: false }` to `postgres()` for runtime. Committed as `7156f885`.
- **Verification:** re-ran migrate on EC2 → `MIGRATE_EXIT=0`, `migrations applied successfully!`. `\dt` shows 17 tables.

### RCA 3: SSM wrapper let outer sh expand `$VAR` before bash ran

- **Task:** Task 4 Step 4 — sourcing `.env.production` and running migrate via SSM.
- **Symptom:** `DB_URL_LEN=0` after `source .env.production`; `bash: line 1: : No such file or directory` on `$LOG` paths.
- **Command:** `bash apps/server-pilot/deploy/ssm-run-command.sh 'set -a; . .env.production; echo ${#DATABASE_URL}'`.
- **Root cause:** the wrapper built `sudo -u ubuntu bash -lc "<cmd with $vars>"` with DOUBLE quotes. SSM `awsrunShellScript` runs the command under `/bin/sh` (dash), which expanded `$DATABASE_URL`, `${#DATABASE_URL}`, `$LOG` to empty BEFORE `bash -lc` executed. Confirmed: `$BASH_VERSION` was empty in the SSM shell. The earlier task-3 sync commands worked only because they used no shell variables.
- **Options considered:** (a) single-quote the bash -lc arg and escape embedded single quotes — fragile; (b) base64-encode the command and decode inside bash — bulletproof, no quoting concerns.
- **Fix chosen:** (b). Updated `ssm-run-command.sh` to `Buffer.from(cmd).toString('base64')` and send `sudo -u ubuntu bash -lc "echo <b64> | base64 -d | bash -s"`. The outer sh only sees `echo <b64> | base64 -d | bash -s` (no `$` to expand); bash receives the decoded script and expands vars itself. Committed as `7156f885`.
- **Verification:** re-ran `DB_LEN=${#DATABASE_URL}` → `DB_LEN=127`, `DB_PREFIX=postgres://zero_admin:`. Migrate then succeeded.

### RCA 4: SSM stdout charmap crash on unicode box-drawing chars

- **Task:** Task 4 Step 4 — capturing drizzle-kit migrate output via SSM.
- **Symptom:** SSM command Status `Failed` with Stdout `'charmap' codec can't encode character '\u28f7' in position 192` even though the underlying script may have run.
- **Command:** any SSM command whose stdout contains drizzle-kit box-drawing chars (⏟ \u28f7, ✓, ─).
- **Root cause:** the SSM agent on EC2 uses Python with a non-UTF8 locale (Windows-legacy codec) to encode command stdout for the GetCommandInvocation response. drizzle-kit's progress UI uses unicode box-drawing characters; the Python encoder crashes, marking the command Failed and discarding stdout. Pre-existing issue noted in task-3 report.
- **Options considered:** (a) set `PYTHONIOENCODING=utf-8`/`LANG=C.UTF-8` in the remote env — didn't fix (the SSM agent's own Python, not the command's); (b) strip non-ASCII from stdout before SSM ships it.
- **Fix chosen:** (b). Redirect command output to a logfile, then pipe the logfile through `LC_ALL=C tr -dc "\040-\176\012\015"` (keep only printable ASCII + newlines) before printing to stdout. SSM ships clean ASCII.
- **Verification:** migrate command returned `Status: Success` with full ASCII-filtered output including `MIGRATE_EXIT=0` and `migrations applied successfully!`.

## Remote-admin ALB edge inspection — 2026-08-13

- The operator wrapper initially returned `INSPECTION_REFUSED`; direct read-only
  inspection proved this was not an AWS resource failure.
- Root cause: the `DescribeInstances` embedded ENI shape omits
  `Attachment.InstanceId`, while the global `DescribeNetworkInterfaces` shape
  includes it. The strict correlator incorrectly required the field in both
  shapes and failed before host inspection.
- Fix: permit the omitted owner only when reading the embedded instance
  reference; preserve the exact owner requirement for global ENIs. Regression
  coverage verifies the real embedded shape succeeds and a global owner
  omission still fails closed before mutation.
- Latest read-only inspection now reaches host-facts validation. No edge
  resource mutation occurred during this diagnosis. The next safe step is to
  bootstrap the already-reviewed remote process and private `:8443` Nginx
  target before resuming staged edge provisioning.

### Bootstrap sync recovery — 2026-08-13

- First feature-branch sync downloaded a bundle advertising only `main`, then
  failed before checkout. A local bundle inspection advertised
  `refs/heads/feat/remote-admin-alb`; use of the shared S3 bundle key was
  therefore unsafe under concurrent operator activity.
- A unique transfer key isolated the retry. It exposed two real script gaps:
  feature branches did not yet exist on EC2, and `git clone` from a
  single-ref bundle has no checkoutable remote `HEAD`.
- Fixes (`d6c13770` through `35d4a906`) create or reset the selected branch
  from an exact per-branch bundle ref, reject stale/ambiguous references, and
  verify the SHA advertised by the created bundle before EC2 checkout.
- Evidence: focused deployment contract passed; local Git fixtures proved
  fresh and stale checkout paths select the intended branch. The full DB-free
  edge suite passed 198/199 checks; its sole failure is the pre-existing
  `mailbox_access` cold-import timeout, which passes in isolation. Server
  TypeScript build passed.
- Next: retry bootstrap with a one-off unique `BUNDLE_KEY`, then use fresh
  read-only edge inspection before any staged AWS mutation.

### ALB access-log compatibility — 2026-08-13

- Final policy shape is exact modern service-principal `SourceArn` allow, Cape
  Town legacy account `arn:aws:iam::098369216593:root` `PutObject` allow, and
  TLS-only deny. Modern allow must not include `aws:SourceAccount`: live
  delivery succeeded without it, while prior live use returned `AccessDenied`.
- Strict state detection accepts former `SourceAccount` only as bounded stale
  policy repair input; final writer and readiness reject it. DB-free security
  contract passed 72/72. No live AWS mutation ran.
