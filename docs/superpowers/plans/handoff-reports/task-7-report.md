# Task 7 Report — Mail Router, Access Guards, Drafts, Labels, Attachments

Date: 2026-07-01
Branch: `EC2-pilot`
Runtime package: `@zero/server` (`apps/server-pilot`)

## 1. Routes Implemented

### `mail.*` (`src/trpc/routes/mail.ts`)
- `mail.listThreads` — paginated thread list, filters: folder (inbox/sent/drafts/archive/starred/snoozed), labelId, q (subject/from snippet ILIKE). Transport-scoped via `eq(mailThread.transportId, ctx.activeTransportId)`.
- `mail.get` — single thread + messages + labels + attachments, transport-scoped; throws `NOT_FOUND: thread not found` if missing or wrong transport.
- `mail.markAsRead` / `mail.markAsUnread` — bulk by threadIds, transport-scoped via `inArray` + transport filter.
- `mail.toggleStar` — star/unstar thread, transport-scoped.
- `mail.modifyLabels` — add/remove labelIds on threadIds, transport + label-ownership scoped.
- `mail.bulkArchive` — set `archivedAt`, transport-scoped.
- `mail.snoozeThreads` — set `snoozeUntil`, transport-scoped.
- `mail.send` — stub: validates `from` matches `ctx.transportEmail` (FORBIDDEN on spoof), inserts `mailMessage` (direction `outbound`) + `mailThread` update, returns `{ threadId, messageId }`. No SMTP transport (Task 8).
- `mail.listLabels` — labels for active transport.
- `mail.createLabel` / `mail.deleteLabel` — transport-scoped CRUD.
- `mail.listAttachments` — attachments for a message, transport-scoped via message→thread.
- `mail.getAttachment` — returns signed S3 URL (60s expiry) for an attachment, scoped to the message's transport. Throws `NOT_FOUND: attachment not found` if message not in caller's transport.

### `drafts.*` (`src/trpc/routes/drafts.ts`)
- `drafts.list`, `drafts.create`, `drafts.update`, `drafts.delete` — all scoped to `ctx.activeTransportId` and `ctx.userId`. Drafts are NOT preserved on thread delete: `mail.bulkDelete`/`mail.delete` hard-delete threads, and the FK `mailDraft.threadId` -> `mailThread.id` `ON DELETE CASCADE` wipes drafts on those threads (real behavior).

### `labels.*` (`src/trpc/routes/labels.ts`)
- `labels.list`, `labels.create`, `labels.delete` — transport-scoped.

### `settings.*` (`src/trpc/routes/settings.ts`)
- `settings.get`, `settings.update` — user-scoped (`userSettings`).

### `connections.*` (`src/trpc/routes/connections.ts`)
- Compatibility wrappers: `connections.list`, `connections.get`, `connections.create` (stub), `connections.delete` (owner-only, refuses last mailbox). Delegates to `mailboxTransport` + `mailboxAccess`.

### `user.*` (`src/trpc/routes/user.ts`)
- `user.getIntercomToken` (stub), `user.delete` (stub).

## 2. Access Guard Pattern

All mail/draft/label/attachment procedures use `mailboxProcedure`, which resolves `MailboxContext` (`{ userId, activeTransportId, transportEmail, accessRole }`) via `resolveMailboxContext`. Every query/mutation:

1. Calls through `mailboxProcedure` → `resolveMailboxContext` (FORBIDDEN if no access).
2. Filters thread/message lookups by `eq(mailThread.transportId, ctx.activeTransportId)` / `eq(message.transportId, ...)`.
3. Throws `NOT_FOUND: <resource> not found` when a row is missing OR exists on a different transport (no information leak about existence on other transports).

`mail-helpers.ts` provides `getThreadForMailbox(db, threadId, transportId)` and `getMessageForMailbox(db, messageId, transportId)` enforcing the transport filter in one place.

## 3. Isolation Test Strategy

`tests/mail-router-isolation.test.ts` (12 tests) + `tests/attachment-access.test.ts` (5 tests) use `withSeededTestDb` (transaction-rollback + seeded data). `callerFor(userId, { transportId?, accessRole? })` builds a tRPC caller with injected session + mailbox context, bypassing Better Auth.

Setup: a second transport `transport-frontdesk` (personal) + `user-frontdesk` access (owner) is seeded inside the test transaction, plus `thread-centurion-1` + `message-centurion-1` + `attachment-centurion-1` on `transport-centurion`.

Negative cases verified:
- `user-frontdesk` `mail.listThreads` → empty (own transport has no threads).
- `user-frontdesk` `mail.get` / `markAsRead` / `toggleStar` / `bulkArchive` / `snoozeThreads` / `modifyLabels` on centurion thread ids → `NOT_FOUND`.
- `user-frontdesk` `mail.send` with spoofed `from` (centurion address) → `FORBIDDEN`.
- `user-frontdesk` cannot list/fetch centurion attachments → `NOT_FOUND`.
- `user-frontdesk` `drafts` on centurion → `NOT_FOUND`.
- `user-frontdesk` `labels` on centurion → `NOT_FOUND`.
- `connections.list` returns only the caller's own transports.
- Positive: centurion owner can list + fetch their own threads/attachments.

## 4. Attachment Access

`mail.getAttachment`:
1. Loads attachment row → `messageId`.
2. Loads message row, filters `eq(message.transportId, ctx.activeTransportId)`.
3. If missing → `NOT_FOUND: attachment not found`.
4. Generates a 60-second presigned S3 GET URL scoped to the object key.
5. Returns `{ url, filename, mimeType, size }`.

`mail.listAttachments`: message must belong to caller's transport.

A user without mailbox access cannot reach this point (mailboxProcedure blocks first); a user with a *different* mailbox is blocked by the transport filter on the message.

## 5. Verification

### Local (Windows, no DATABASE_URL)
```
pnpm --filter @zero/server build          → clean (0 errors)
pnpm --filter @zero/server test           → 6 passed | 3 skipped (20 tests, 33 skipped) — graceful DB skip
```

### EC2 (RDS Postgres 16, env sourced from apps/server-pilot/.env.production)
```
pnpm build && set -a && . ./.env.production && set +a && pnpm test
→ Test Files  9 passed (9)
   Tests       53 passed (53)
   TEST_EXIT=0
```
DB-backed files run green: `seed-contract`, `auth-context`, `ingest-store`, `attachment-access`, `mail-router-isolation`, `pop3-worker`.

`/health` unaffected (no route changes to health endpoint).

## 6. Files Changed

Source:
- `apps/server-pilot/src/trpc/trpc.ts` — base procedures + short-circuit for injected test context
- `apps/server-pilot/src/trpc/context.ts` — (existing, unchanged) `resolveMailboxContext`
- `apps/server-pilot/src/trpc/router.ts` — root `appRouter` aggregation
- `apps/server-pilot/src/trpc/index.ts` — re-exports from router.ts, keeps `AppRouter` type
- `apps/server-pilot/src/trpc/types.ts` — `Inputs`/`Outputs` types
- `apps/server-pilot/src/trpc/routes/mail.ts`
- `apps/server-pilot/src/trpc/routes/mail-helpers.ts`
- `apps/server-pilot/src/trpc/routes/drafts.ts`
- `apps/server-pilot/src/trpc/routes/labels.ts`
- `apps/server-pilot/src/trpc/routes/settings.ts`
- `apps/server-pilot/src/trpc/routes/connections.ts`
- `apps/server-pilot/src/trpc/routes/user.ts`
- `apps/server-pilot/src/main.ts` — tRPC fetch adapter
- `apps/server-pilot/src/db/client.ts` — `__setDbForTests` test-only setter

Tests:
- `apps/server-pilot/tests/helpers/trpc-caller.ts`
- `apps/server-pilot/tests/mail-router-isolation.test.ts`
- `apps/server-pilot/tests/attachment-access.test.ts`

## 7. Self-Review

- Access guards applied uniformly; no mail/draft/label/attachment procedure bypasses `mailboxProcedure` + transport filter.
- No information leak: wrong-transport lookups return `NOT_FOUND`, not `FORBIDDEN`.
- `mail.send` is a stub — no SMTP, no real outbound delivery (Task 8).
- Draft preservation: routes do NOT avoid thread deletion. `mail.bulkDelete` and `mail.delete` hard-delete `mailThread` rows (transport-scoped via `requireThreadForTransport` first, so cross-mailbox deletes return NOT_FOUND and never execute). The FK `mailDraft.threadId` -> `mailThread.id` `ON DELETE CASCADE` is therefore a *real, exercised* behavior, not just a schema safety net: deleting a thread wipes its drafts along with its messages + attachments. Callers that need to preserve a draft must export it (e.g. copy body) before calling `bulkDelete`/`delete`, or unlink the draft (`drafts.update({ threadId: null }}`) first. The brief does not forbid thread delete, so the route behavior is unchanged here — only the report claim is corrected.
- `mailboxTransport.mailboxType` left as-is for the seeded centurion transport (already `personal` per Task 4).

## 8. Concerns

- `mail.send` stub stores an outbound row but does not deliver. Task 8 must wire SMTP transport.
- `connections.create` is a stub (no live IMAP/SMTP provisioning in pilot).
- Presigned S3 URL lifetime is 60s — frontend must fetch and redirect immediately; not cached.
- `__setDbForTests` is a test-only escape hatch in `db/client.ts`; guarded by usage convention (only `trpc-caller.ts` calls it).

## 9. RCA Notes

- **`@hono/trpc-server` type clash**: `BuiltRouter` not assignable to `AnyRouter` under `tsc` + `moduleResolution: NodeNext`. Fix: use `fetchRequestHandler` from `@trpc/server/adapters/fetch` directly.
- **ESM live-binding monkey-patch**: `getDb` export is getter-only; tests cannot reassign. Fix: added `__setDbForTests` setter to mutate internal `cached`.
- **`callerFor` returning root caller**: sub-routers were returning the root caller, causing `No procedure found on path "listThreads"`. Fix: return `caller.mail`, `caller.drafts`, etc.
- **Middleware re-resolution**: `privateProcedure`/`mailboxProcedure` re-ran resolution on injected context → `UNAUTHORIZED`. Fix: short-circuit when `sessionUser`/mailbox fields already present.
- **`/NOT_FOUND/` regex vs message**: tests match `.message`, but `TRPCError.message` is the custom string, not the code. Fix: prefix messages with the code token (`NOT_FOUND: ...`, `FORBIDDEN: ...`).
- **EC2 SSM Unicode/CRLF**: Windows→Linux script transfer corrupted by CRLF + non-ASCII test output. Fix: LF-only scripts via `tr -d '\r'`, base64 round-trip, strip non-ASCII in logs.

## 10. Reviewer-Finding Fixes (post-review pass)

Addressed two Important reviewer findings on Task 7.

### Finding 1 (Important): standalone 2-arg `requireMailboxAccess` facade

**Change:** Added a standalone 2-arg facade in the tRPC context module:

```typescript
export async function requireMailboxAccess(
  userId: string,
  transportId: string,
): Promise<MailboxContext>
```

- Wraps `resolveMailboxContext(userId, transportId, getDb())`.
- Maps `MailboxForbiddenError` -> `TRPCError({ code: 'FORBIDDEN', message: 'FORBIDDEN' })`.
- Exported from `@zero/server/trpc` (`src/trpc/index.ts`) so the literal API surface the spec describes — `await requireMailboxAccess(ctx.userId, ctx.activeTransportId)` — exists alongside the `mailboxProcedure` middleware.
- The existing `requireMailboxAccessFactory(db)` and `mailboxProcedure` are NOT removed; the facade is additive. Factory stays for code paths holding a transaction-scoped db handle (e.g. attachment re-verification). Both share `resolveMailboxContext` as the single source of truth.

Files: `apps/server-pilot/src/trpc/trpc.ts`, `apps/server-pilot/src/trpc/index.ts`.

### Finding 2 (Important): report §7 thread-delete claim corrected

**Change:** The report §7 previously claimed "routes never delete threads" and framed `mailDraft.threadId` cascade as "a schema safety net, not triggered here." That is wrong: `mail.bulkDelete` and `mail.delete` DO hard-delete `mailThread` rows (transport-scoped via `requireThreadForTransport` first, so cross-mailbox deletes return NOT_FOUND and never execute). The FK `mailDraft.threadId` -> `mailThread.id` `ON DELETE CASCADE` is therefore a *real, exercised* behavior — deleting a thread wipes its drafts along with its messages + attachments.

Route behavior is unchanged (the brief does not forbid thread delete); only the report claim is corrected to match the code. Updated both §1 (drafts blurb) and §7 (self-review). Documented the caller responsibility: to preserve a draft across a thread delete, export it or unlink it (`drafts.update({ threadId: null }}`) first.

File: `.superpowers/sdd/task-7-report.md` (local-only, gitignored under `.superpowers/sdd/`).

### Verification (re-run after fix)

Command:
```
pnpm --filter @zero/server test tests/mail-router-isolation.test.ts tests/attachment-access.test.ts
pnpm --filter @zero/server build
```

Test output (Windows host, no `DATABASE_URL` — DB-backed cases skip per `describe.skipIf(!TEST_DB_AVAILABLE || !reachable)`):
```
 ↓ tests/attachment-access.test.ts (5 tests | 5 skipped)
 ↓ tests/mail-router-isolation.test.ts (12 tests | 12 skipped)
 Test Files  2 skipped (2)
      Tests  17 skipped (17)
   Duration  11.07s
```
(Full DB-backed green run was already validated on EC2 in §5: 9 files / 53 tests passed; this fix only adds an additive export + a doc correction, no route logic change, so the DB-backed suite is unaffected.)

Build output:
```
> tsc -p tsconfig.json
(clean, 0 errors)
```
Verified the facade compiled into `dist/trpc/trpc.js` (`export async function requireMailboxAccess`) and re-exported from `dist/trpc/index.js`.

### Commit

`6a8fbf99294f73af867aa3b604dfbd7174bdeddd` — `feat(trpc): add requireMailboxAccess facade + correct task-7 report`
- 2 files changed, 41 insertions(+), 1 deletion(-)
- Pre-commit lint: 0 warnings, 0 errors.
- Only `apps/server-pilot/src/trpc/{trpc,index}.ts` staged; no unrelated untracked files added. Report file is gitignored under `.superpowers/sdd/`, so report edits stay on disk only.
