# Audit C — Uncommitted Working Tree (security + correctness)

**Scope:** ONLY the uncommitted working tree vs `HEAD` on branch `EC2-pilot` (plus new untracked files). Committed history is covered by other agents.
**Status of everything below: UNCOMMITTED WIP.** Nothing is staged/committed by this audit; no code was modified.
**Calibration:** solo-dev pilot, fixtures/fakes only; real POP3/SMTP/VPN deferred (`[latent]`). Severity weighted for real exploitability.
**Method:** `git diff HEAD -- <file>` + full-file reads of security-critical paths + cross-file grep (labels, frontend NO_MAILBOX handling, worker loop shape).

Authoritative changed set audited (from `git status --porcelain`):
context.ts, connections.ts, mail.ts, smtp.ts, main.ts, auth.ts, trpc.ts, db/schema/mail.ts, load-pm2-config.ts, deploy/{nginx.conf,pm2.config.cjs,write-ec2-env.sh}, tests/{auth-context,deploy-config,auth-session-ttl}.test.ts, cache-ttl.ts(+test), mail/{constants.tsx,package.json}, .gitignore, .cursor/settings.json.
(auth.ts and trpc.ts were listed as modified at session start and STILL have uncommitted changes now — both audited below. They are index-staged but that's the pre-existing state; not touched here.)

---

## Headline

**P1 — `auth.ts:98` session `cookieCache.maxAge` REGRESSED to 400 days; C8 is not fixed, it is made worse and locked in by a test.** This is the exact knob prior bug-hunt C8 flagged. It went the WRONG direction. See F1.

---

## Per-file verdicts

### `apps/server-pilot/src/lib/auth.ts` — FINDING (P1)
Adds `SESSION_TTL_SEC = 400d`, `SESSION_UPDATE_AGE_SEC = 7d`. Session block now:
`cookieCache: { enabled: true, maxAge: SESSION_TTL_SEC /*400d*/ }`, `expiresIn: 400d`, `updateAge: 7d`.
`expiresIn`/`updateAge` are fine (long-lived login is a UX choice). **cookieCache.maxAge is the security knob and it is wrong** — see F1. `expiresIn` prior was 30d, now 400d (acceptable); the regression is specifically cookieCache.

### `apps/server-pilot/tests/auth-session-ttl.test.ts` (NEW) — FINDING (part of F1)
Asserts `SESSION_TTL_SEC === 400d`; test title literally reads "uses 400-day session **and cookie cache max age**". This **codifies the C8 regression** — a green test now guards the insecure value, so a future fixer must delete/rewrite this test. No assertion that cookieCache is short.

### `apps/server-pilot/src/trpc/context.ts` — OK
`resolveMailboxContext`: requestedTransportId path still scoped `userId AND transportId` (ln 54-59), throws `MailboxForbiddenError` on miss (ln 62-63) — no scope drop. Default path scoped `userId` only (ln 86), throws new `MailboxNoAccessError` on zero rows (ln 88-89), sorts `isDefault` first then role (ln 97-100). Correct; no cross-mailbox leak. New error class is behaviorally identical to Forbidden except HTTP surface (see F3).

### `apps/server-pilot/src/trpc/routes/connections.ts` — OK (fixes C2), minor F4
`setDefault` now (a) verifies access `userId AND transportId`, NOT_FOUND on miss (ln 108-120); (b) clears `isDefault=false WHERE userId` (ln 121-124); (c) sets `isDefault=true WHERE userId AND transportId` (ln 125-133). **C2 (setDefault was a no-op) is genuinely fixed** — default now persists. Both writes are `userId`-scoped; one-default-per-user invariant is correct. `list`/`getDefault`/`delete` all remain `userId`-scoped. Only nit: the two UPDATEs are not wrapped in a transaction (F4, P3).

### `apps/server-pilot/src/trpc/routes/mail.ts` — OK (net improvement)
- Lazy-clear expired snoozes (ln ~137): `UPDATE mailThread SET snoozedUntil=NULL WHERE transportId=? AND snoozedUntil IS NOT NULL AND snoozedUntil<=now()` — transport-scoped. OK.
- Inbox filter adds `OR(snoozedUntil IS NULL, snoozedUntil<=now())` on top of existing transport scope. OK.
- `markUnread` adds early-return on empty set + also flips `message.isRead=false WHERE threadId=? AND transportId=?` — scoped. OK.
- `toggleImportant` (ln 474-489): replaced dead UUID lookup with literal `'IMPORTANT'`, which **matches** the synthetic system-label id in `labels.ts:18` (`{ id: 'IMPORTANT' }`). The old code looked up `mailLabel.name='IMPORTANT'` (never present → `if(!importantId) return {updated:0}` = permanent no-op); **this fixes a latent no-op bug** and is consistent with `labels.list`. `requireThreadForTransport` keeps it transport-scoped. OK.
No tenant-scope drops anywhere in mail.ts.

### `apps/server-pilot/src/trpc/trpc.ts` — FINDING (P2)
Routes `MailboxNoAccessError` → `noMailboxTrpcError()` at 3 call sites (mailboxProcedure + 2 factory paths). The error is built as `new TRPCError({ code: 'NO_MAILBOX' as 'FORBIDDEN', message: 'NO_MAILBOX' })`. `'NO_MAILBOX'` is not a real tRPC code; the cast only silences TS. See F3.

### `apps/server-pilot/src/mail/send/smtp.ts` — OK
Adds `FAKE_SMTP_RING_MAX=100`; `FakeSmtpTransport.send` pushes then trims to 100 (fake-only memory bound). **No change to from-forcing, validation, or the real-vs-fake switch** — `createSmtpTransport` still returns real only when `host && SMTP_ENABLE_REAL==='true'`, else fake; `forceFake` short-circuits. No security surface change.

### `apps/server-pilot/src/main.ts` — OK
Adds SIGTERM/SIGINT graceful shutdown: `server.close(() => closeDb().then(exit0).catch(exit1))`. Route/auth mounting order UNCHANGED (auth at `/api/auth/*`, tRPC at `/api/trpc/*`, both after health/providers). No new exposure. Nit (P3): `server.close` has no forced-timeout fallback, so a hung in-flight request blocks exit until PM2's kill timer — acceptable.

### `apps/server-pilot/src/db/schema/mail.ts` — OK
(a) unique index `mail_ingest_quarantine_ingest_uidl_uidx` on `(ingestMailboxId, pop3Uidl)` — prevents duplicate quarantine rows. (b) `mailboxAccess.isDefault boolean NOT NULL DEFAULT false` — backs the connections/context default logic. Matches untracked migrations `0002_mailbox_access_is_default.sql`, `0003_quarantine_ingest_uidl_uidx.sql`. Coherent.

### `apps/server-pilot/deploy/write-ec2-env.sh` — OK (fixes D7)
Now single-quotes every value via `quote_val(){ printf "'%s'" "${1//\'/\'\\\'\'}"; }` — canonical `'\''` escaping. `DATABASE_URL`/`BETTER_AUTH_SECRET` containing `&`, spaces, `$` no longer truncate under bash `source`. File still `install`-created mode 600, owned ubuntu, untracked. **D7 resolved.** (Minor: if the DB secret JSON lacks `DATABASE_URL`, node prints `undefined` → `DATABASE_URL='undefined'`; benign, not security.)

### `apps/server-pilot/deploy/nginx.conf` — OK (fixes C5)
The +2 lines add `client_max_body_size 35m;` — **C5 (1MB cap breaking attachments) resolved**. N5 security headers (HSTS, X-Frame-Options DENY, X-Content-Type-Options, Referrer-Policy, CSP) are ALREADY present (ln 14-18, from prior work) — not touched by this diff, no regression.

### `apps/server-pilot/deploy/pm2.config.cjs` — FINDING (P3 `[latent]` → P2 when real POP3 lands)
Two apps: `http` (main.js) and `worker` (worker.js). `autorestart:false` added to **worker only**; `http` keeps PM2 default (autorestart true — auth/API server still auto-recovers, good). This stops D5 restart-churn, but it is a *masking* fix, not a real one — see F5.

### `apps/server-pilot/src/deploy/load-pm2-config.ts` — OK
Adds optional `autorestart?: boolean` to the `Pm2App` type so the config field type-checks. Type-only.

### `apps/mail/lib/mail/cache-ttl.ts` (NEW) + `cache-ttl.test.ts` (NEW) — OK / minor F6
`PERSIST_MAX_AGE = Infinity`, `QUERY_GC_TIME = Infinity` (TanStack: never age-evict persisted cache, disable in-memory gc). Coherent with `CACHE_BURST_KEY` bump (below) as the deliberate invalidation lever. Two low-severity smells in F6 (unbounded client memory; stale mail persists in browser storage after logout/offboard until a version bump). Not a server-side security issue.

### `apps/mail/lib/constants.tsx` — OK
`CACHE_BURST_KEY` v0.0.5 → v0.0.6. This is the ONLY way to invalidate the now-Infinity persisted cache on deploy; bumping it here is coherent with cache-ttl.ts.

### `apps/mail/package.json` — OK
Adds `"test": "vitest run tests"` next to existing `test:demo`. Harmless.

### `apps/server-pilot/tests/auth-context.test.ts` — OK
Updated to expect `MailboxNoAccessError` for the zero-access user + a unit assertion on the new error's message/name. Correct test follow-through (not the C8 test — that's the separate concern in F1).

### `apps/server-pilot/tests/deploy-config.test.ts` — OK
New assertions: worker `autorestart===false`, `client_max_body_size 35m`, `quote_val()`/quoted env keys, ring buffer 100, SIGTERM+closeDb in main.ts, `is_default` column. All match the code. (Note it green-locks `autorestart:false`, see F5.)

### `.gitignore` — OK
Adds ignore for `.compound-engineering/config.local.yaml`. Nothing un-ignored; no secret exposed. (Hygiene note: only that one file under `.compound-engineering/` is ignored — the rest of that untracked dir plus untracked `.claude/`, `.tmp-research/` would be swept up by a careless `git add .`. Not part of the tracked diff; flag F7 P3.)

### `.cursor/settings.json` — OK
Enables `compound-engineering`. No secret, no credential.

---

## Findings

### F1 — P1 (P0 in a real multi-user hotel deployment): session revocation defeated for up to 400 days
`apps/server-pilot/src/lib/auth.ts:98` — `cookieCache: { enabled: true, maxAge: SESSION_TTL_SEC }` where `SESSION_TTL_SEC = 60*60*24*400` (400 days).
Better Auth `cookieCache` stores the session in a **signed cookie that every `getSession`/`privateProcedure` trusts WITHOUT a DB lookup** for `maxAge` seconds. Better Auth's own guidance is to keep this short (default 300s) precisely so revocation propagates. Prior bug-hunt C8 said 30 days was already too long → the fix should have made it SHORT (~300s). Instead it was raised to 400 days and `auth-session-ttl.test.ts` now asserts that value.
**Failure scenario:** offboard/fire a hotel staff member (or a laptop is stolen) → you `revokeSession`/delete the DB session row → the victim's browser keeps presenting the still-valid cached cookie and the server keeps authorizing every request for **up to 400 days**, because the cache never re-validates against the DB within the session lifetime. Server-side revocation, ban, and role changes are all effectively inert.
**Fix:** `cookieCache: { enabled: true, maxAge: 300 }` (keep `expiresIn`/`updateAge` at 400d/7d if long login is desired), and change `auth-session-ttl.test.ts` to assert the SHORT cache max-age rather than 400d.

### F3 — P2: invalid tRPC error code `'NO_MAILBOX'` returns HTTP 500 for a benign "no mailbox" state
`apps/server-pilot/src/trpc/trpc.ts` (`noMailboxTrpcError`): `new TRPCError({ code: 'NO_MAILBOX' as 'FORBIDDEN', message: 'NO_MAILBOX' })`. `'NO_MAILBOX'` isn't a real tRPC code; tRPC's HTTP-status lookup fails it and defaults to **500**. The frontend toast works only because `query-provider.tsx:182` keys off `err.message === 'NO_MAILBOX'` (not the code) — so UX is fine, but:
**Failure scenario:** an authenticated user with zero mailbox_access rows hits any mailboxProcedure → gets HTTP **500**; `main.ts` `onError` logs `console.error('tRPC error: …')` on every such request (false alerting/noise), and TanStack treats 500 as a retryable server error (3× retry storms). Semantically a 403/404 condition surfaced as a 500.
**Fix:** use a real code (`code: 'FORBIDDEN'` or `'NOT_FOUND'`) and keep `message: 'NO_MAILBOX'` (FE already matches on message) → proper 4xx, no 500 log noise.

### F4 — P3: `setDefault` is two non-transactional UPDATEs
`connections.ts:121-133` — clear-all-then-set is not in a `db.transaction`. If the 2nd UPDATE fails after the 1st commits, the user is left with **no default** (getDefault falls back to highest-role transport, so non-fatal). Concurrent setDefault calls could also momentarily leave two/zero defaults. Solo-pilot: negligible. Wrap both in one transaction when convenient.

### F5 — P3 `[latent]` → P2 when real POP3 is enabled: worker never auto-restarts on crash
`pm2.config.cjs:20` — `autorestart:false` on the `worker` app. `worker.ts:302` is a persistent `while (!stop.stopping)` poll loop that `process.exit(1)`s on a fatal error (`main().catch`). With autorestart off, **any worker crash halts POP3 ingestion permanently until a human `pm2 restart`** — silent mail-ingest outage, no alert. Right now real POP3 is deferred and the worker mostly no-ops, so churn-suppression is a reasonable pilot stopgap; but the correct production fix for D5 churn is `min_uptime` + `max_restarts` (backoff) rather than disabling restart entirely. Revisit before real POP3 goes live.

### F6 — P3: `Infinity` client cache TTLs
`cache-ttl.ts` — `QUERY_GC_TIME=Infinity` keeps every inactive query in memory for the SPA's lifetime (slow unbounded growth on a long-lived tab). `PERSIST_MAX_AGE=Infinity` means cached mail in browser storage never self-expires — after logout/offboarding on a shared machine it lingers until the next `CACHE_BURST_KEY` bump. Client-side only, low severity for pilot; consider a finite persist max-age (e.g. 7d) for data-at-rest hygiene.

### F7 — P3 (hygiene, not in tracked diff): broad untracked dirs could be accidentally committed
`.gitignore` ignores only `.compound-engineering/config.local.yaml`; sibling files in untracked `.compound-engineering/`, `.claude/`, `.tmp-research/` are not ignored and a careless `git add .` would stage them. Verify none contain secrets before any blanket add. No secret is exposed by the current tracked diff.

---

## Verdict summary

| File | Verdict |
|---|---|
| auth.ts | **P1 — cookieCache 400d (C8 regressed, not fixed)** |
| auth-session-ttl.test.ts | **P1 — green-locks the 400d regression** |
| trpc.ts | **P2 — `NO_MAILBOX` invalid code → HTTP 500** |
| context.ts | OK — scoping intact, no leak |
| connections.ts | OK — C2 fixed; P3 non-transactional setDefault (F4) |
| mail.ts | OK — scoping intact; toggleImportant no-op fixed |
| smtp.ts | OK — fake-only ring buffer, no send-path change |
| main.ts | OK — graceful shutdown, no auth/exposure change |
| db/schema/mail.ts | OK — is_default + quarantine unique index |
| write-ec2-env.sh | OK — D7 fixed (values quoted) |
| nginx.conf | OK — C5 fixed (35m); headers already present |
| pm2.config.cjs | P3`[latent]`→P2 — worker autorestart:false (F5) |
| load-pm2-config.ts | OK — type-only |
| cache-ttl.ts (+test) | OK — P3 Infinity TTL smells (F6) |
| constants.tsx | OK — cache-burst bump, coherent |
| package.json (mail) | OK |
| auth-context / deploy-config tests | OK — match code |
| .gitignore / .cursor/settings.json | OK — no secret un-ignored (F7 hygiene note) |

**No cross-mailbox tenant-scope drop found in any changed query.** The single real security issue is the auth cookieCache regression (F1).
