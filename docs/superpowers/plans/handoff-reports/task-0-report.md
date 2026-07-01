# Task 0 Report: Schema And Plan Reconciliation Audit

## Status

DONE

## What Implemented

1. Read current schema baseline from `apps/server/src/db/schema.ts` and migration tree (`apps/server/src/db/migrations/**`, 79 files, latest `0036_petite_mole_man.sql`).
2. Read frontend integration points: `apps/mail/providers/query-provider.tsx`, `apps/mail/hooks/use-threads.ts`, `apps/mail/components/ui/nav-user.tsx`.
3. Ran brief-mandated verification searches.
4. Created schema audit doc at `docs/superpowers/plans/2026-07-01-ec2-production-v4-schema-audit.md` with verbatim content from task brief.
5. Committed audit doc only; left unrelated untracked files unstaged.

## Verification Commands And Results

### Step 1: Schema exports

```bash
rg "export const .* = createTable|export const .* = pgTable" apps/server/src/db/schema.ts
```

Result: 16 table exports found — `user`, `session`, `account`, `userHotkeys`, `verification`, `earlyAccess`, `connection`, `summary`, `note`, `userSettings`, `writingStyleMatrix`, `jwks`, `oauthApplication`, `oauthAccessToken`, `oauthConsent`, `emailTemplate`. All use `createTable` via `pgTableCreator` prefix `mail0_`.

### Step 1: Target mail table search

```bash
rg "mailboxAccess|mailboxTransport|mailThread|mailIngestMailbox|mailIngestQuarantine|mailSnooze|mailPrompt|staffMember" apps/server apps/mail
```

Result: exit code 1, zero matches. Confirms:

- Current schema has connection-era tables (`connection`, `summary`, `writingStyleMatrix`).
- Target mail-core tables are absent.

### Commit verification

```bash
git add docs/superpowers/plans/2026-07-01-ec2-production-v4-schema-audit.md
git commit -m "docs: audit v4 schema baseline"
```

Result: commit `c717de16` on branch `EC2-pilot`, 1 file changed, 56 insertions. Pre-commit hook passed (0 warnings, 0 errors). Unrelated untracked files remain unstaged.

## Files Changed

| File | Action |
|------|--------|
| `docs/superpowers/plans/2026-07-01-ec2-production-v4-schema-audit.md` | Created |

No other files modified or staged.

## Self-Review Findings

1. **Schema matches audit current-table list.** All 16 exported tables align with audit doc. `connection` and `jwks` exist in schema; audit doc lists both under Current Tables.
2. **Gap tables confirmed absent.** None of the 9 target mail tables exist in schema or migrations.
3. **Frontend still connection-centric.** `nav-user.tsx` uses `useActiveConnection` / `useConnections`; `use-threads.ts` imports `IGetThreadResponse` from server driver types and calls TRPC mail routes; `query-provider.tsx` imports `AppRouter` from `@zero/server/trpc`. Supports audit decision to build `apps/server-pilot/` and allow mailbox-native route rewrites.
4. **Audit doc omits `connection` and `jwks` from keep/pilot-excluded sections.** Intentional per brief template. `connection` is legacy core to replace; `jwks` is auth infra — downstream tasks should decide fate explicitly.
5. **Migrations are connection-era only.** Latest snapshot `0036` reflects same 16-table set; no partial mail-core migration in flight.

## Concerns

1. **Workspace resolution risk.** `@zero/server/trpc` import in mail app will conflict once `apps/server-pilot/` exists unless package/workspace aliases updated early (Task 1+ scope).
2. **`jwks` table unclassified.** Not in keep or exclude lists; likely stays with auth layer in pilot but not documented yet.
3. **Frontend demo mode.** `isFrontendOnlyDemo()` paths in query-provider and use-threads may mask missing backend during local dev; pilot integration tests should cover live-backend path.

## Commits Created

- `c717de16` — docs: audit v4 schema baseline

---

## Task 0 Review Fix Pass (2026-07-01)

### Change Summary

1. Classified `jwks` — **keep** under new "Auth / Security Infra" section; Better Auth JWK store, not mail-core.
2. Classified `connection` — **replace** under "Legacy Connection-Era"; superseded by `mailboxTransport` + `mailboxAccess`.
3. Added **Export Count vs Plan** note: 16 `schema.ts` exports vs plan prose "17 tables"; no phantom table.
4. Added **Per-Table Action Matrix** (keep / replace / de-scope / add) for all 16 current + 9 target tables.
5. Moved migration baseline (79 files, `0036`) and frontend connection-centric findings from report into audit doc.

### Verification Commands And Results

```bash
rg "export const .* = createTable" apps/server/src/db/schema.ts | wc -l
# → 16

rg "jwks|connection|Per-Table Action Matrix|Export Count vs Plan" docs/superpowers/plans/2026-07-01-ec2-production-v4-schema-audit.md
# → all review-fix sections present (jwks keep, connection replace, matrix, count note)
```

Pre-commit hook passed. Only `docs/superpowers/plans/2026-07-01-ec2-production-v4-schema-audit.md` staged/committed.

### Commit

- `75f11df6` — docs: classify jwks/connection and add table action matrix
