# V4 Schema Audit

## Current Tables

16 `createTable` exports in `apps/server/src/db/schema.ts` (prefix `mail0_`). See **Export Count vs Plan** below for the plan-time "17 tables" mismatch.

- user
- session
- account
- userHotkeys
- verification
- earlyAccess
- connection
- summary
- note
- userSettings
- writingStyleMatrix
- jwks
- oauthApplication
- oauthAccessToken
- oauthConsent
- emailTemplate

## Export Count vs Plan

| Source | Count | Notes |
|--------|-------|-------|
| `schema.ts` exports (this audit) | **16** | `rg "export const .* = createTable" apps/server/src/db/schema.ts` |
| V4 plan global constraint (line 21) | **17** | Plan-time prose; omits `userHotkeys`, `verification`, `earlyAccess`, `jwks` from named list |

**No phantom 17th table.** Actual code exports 16 tables. Plan likely miscounted or drafted before `jwks` landed (migration `0028`). Future workers: trust `schema.ts` export count, not plan prose.

## Migration Baseline

- Tree: `apps/server/src/db/migrations/**` — 79 SQL files, latest `0036_petite_mole_man.sql`.
- Latest snapshot `0036` reflects the same 16-table set as `schema.ts`.
- No partial mail-core migration in flight; migrations are connection-era only.

## Frontend Integration (Connection-Era)

Read 2026-07-01 for Task 0 baseline:

- `apps/mail/components/ui/nav-user.tsx` — `useActiveConnection` / `useConnections`.
- `apps/mail/hooks/use-threads.ts` — `IGetThreadResponse` from server driver types; TRPC mail routes.
- `apps/mail/providers/query-provider.tsx` — `AppRouter` from `@zero/server/trpc`.

Supports pilot decision: build `apps/server-pilot/`, allow mailbox-native route rewrites. `@zero/server/trpc` alias must resolve to pilot early (Task 1+). `isFrontendOnlyDemo()` paths may mask missing backend during local dev.

## Per-Table Action Matrix

| Table | Action | Rationale |
|-------|--------|-----------|
| user | **keep** | Auth + frontend compatibility |
| session | **keep** | Auth + frontend compatibility |
| account | **keep** | Auth + frontend compatibility |
| verification | **keep** | Auth + frontend compatibility |
| note | **keep** | Frontend compatibility |
| userSettings | **keep** | Frontend compatibility |
| emailTemplate | **keep** | Frontend compatibility |
| jwks | **keep** | Better Auth JWT key store; auth/security infra, not mail-core |
| connection | **replace** | Legacy connection-era mailbox binding; superseded by `mailboxTransport` + `mailboxAccess` in pilot runtime |
| summary | **de-scope** | Connection-scoped AI summary; not mail-core pilot |
| writingStyleMatrix | **de-scope** | Connection-scoped; not mail-core pilot |
| oauthApplication | **de-scope** | OAuth provider tables; not mail-core pilot |
| oauthAccessToken | **de-scope** | OAuth provider tables; not mail-core pilot |
| oauthConsent | **de-scope** | OAuth provider tables; not mail-core pilot |
| earlyAccess | **de-scope** | Product gating; not mail-core pilot |
| userHotkeys | **de-scope** | UX prefs; not mail-core pilot |
| mailIngestMailbox | **add** | Target mail-core |
| mailIngestQuarantine | **add** | Target mail-core |
| mailboxTransport | **add** | Target mail-core |
| mailboxAccess | **add** | Target mail-core |
| mailLabel | **add** | Target mail-core |
| mailThread | **add** | Target mail-core |
| message | **add** | Target mail-core |
| attachment | **add** | Target mail-core |
| mailDraft | **add** | Target mail-core |

`connection` **replace** means: do not carry forward as mail-core runtime table. Pilot schema uses mailbox-native tables; old `connection` rows are not migrated unless a later compatibility bridge explicitly requires it.

## Target Mail Tables To Add

- mailIngestMailbox
- mailIngestQuarantine
- mailboxTransport
- mailboxAccess
- mailLabel
- mailThread
- message
- attachment
- mailDraft

## Tables To Keep For Frontend Compatibility

- user
- session
- account
- verification
- note
- userSettings
- emailTemplate

## Auth / Security Infra (Keep, Not Mail-Core)

- jwks — Better Auth local JWK set persistence (`public_key` / `private_key`). Keep in pilot auth layer; no mail-domain role.

## Legacy Connection-Era (Replace / De-Scope for Mail-Core)

- connection — Legacy per-user email provider binding (`userId`, `email`, OAuth tokens). **Replaced** by `mailboxTransport` + `mailboxAccess` for pilot runtime. Listed under Current Tables only as baseline reference.

## Tables Not Part Of Mail-Core Pilot

- summary
- writingStyleMatrix
- oauthApplication
- oauthAccessToken
- oauthConsent
- earlyAccess
- userHotkeys

## Decision

Build `apps/server-pilot/` as the runtime backend for this branch. Keep `apps/server/` on disk only as reference unless package/workspace resolution conflicts, in which case de-scope or rename the old backend package so `apps/mail` resolves to `apps/server-pilot`. Frontend callers may be rewritten to mailbox-native routes instead of preserving old backend API shapes.
