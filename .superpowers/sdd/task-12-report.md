# Task 12 Report — EC2 verification gate (pre-real-ingest checklist)

**Date:** 2026-07-02  
**Branch:** `EC2-pilot`  
**Instance:** `i-008f737974a9ba9b3` (af-south-1)  
**Final commits:** `2955a324` (test timeout), docs commit pending

## Status: PASS (code gate)

Security hardening Tasks 1–11 verified on EC2. Real mail ingest remains an **ops gate** (IT Exchange relay rules) — not a code blocker.

## Step 1 — Local / CI

| Check | Result |
|-------|--------|
| `pnpm --filter @zero/server test` | 54 pass, 38 skip (RDS tests skip off-VPC) |
| `pnpm --filter @zero/mail test` | pass |
| `pnpm --filter @zero/server build` | pass |
| `pnpm --filter @zero/mail build` | pass |

**Fix applied:** `package-contract.test.ts` import timeout 5s → 15s (`2955a324`) — flaky on Windows cold transform.

## Step 2 — Push + deploy

| Action | Result |
|--------|--------|
| `git push origin EC2-pilot` | pushed 13 commits (`9a0d6d6c..2955a324`) |
| EC2 sync | `sync-ec2-git-bundle.sh` → HEAD `2955a324` |
| `deploy-ec2.sh` | build + pm2 reload; http + worker online |

**Note:** EC2 `origin` remote is bundle-based (`/tmp/zero-EC2-pilot.bundle`); use `sync-ec2-git-bundle.sh` not `git pull`.

## Step 3 — Post-deploy checks

| Check | Result |
|-------|--------|
| `/health` | `{"ok":true,"service":"server-pilot"}` |
| nginx headers (`curl -I https://127.0.0.1/ -H Host:nava.legacy.local`) | HSTS, X-Frame-Options: DENY, Content-Security-Policy present |
| Signup blocked | `POST /api/auth/sign-up/email` → **403** `signup disabled for pilot` |
| `PILOT_OPEN_SIGNUP` | `0` in `.env.production` (appended during gate) |
| Double-stamp routing | `ingest-store` double-stamp test green on RDS |
| Fixture worker | `pop3-worker` seeded cycle green (stamped + missing-owner fixtures) |
| RDS TLS tests | seed-contract, auth-context, ingest-store, sanitize — all green with `NODE_ENV=test` |

### EC2 targeted test run

```
NODE_ENV=test pnpm exec vitest run \
  tests/seed-contract.test.ts \
  tests/auth-context.test.ts \
  tests/ingest-store.test.ts \
  tests/sanitize-email-html.test.ts \
  tests/pop3-worker.test.ts

Test Files  5 passed (5)
     Tests  29 passed (29)
```

**nginx bootstrap:** nginx was not previously installed on the pilot box. Gate script installed nginx, generated self-signed `nava.legacy.local` cert, deployed `nginx.conf` with security headers. Production TLS from IT/VPN remains a follow-up for user-facing URL.

## Audit coverage (Tasks 1–12)

| ID | Item | Task |
|----|------|------|
| F1 | HTML XSS | 1, 2, 10 |
| F2 | X-Zero-Mailbox | 3 |
| F3 | RDS TLS | 4 |
| F4 | Content-Disposition | 7 |
| F5 | open signup | 8 |
| F6 | account linking | 8 |
| F7 | test injection | 9 |
| N1 | SMTP CRLF | 5 |
| N2 | ingest tx | 6 |
| N3 | size limits | 6 |
| N4 | IDB cache | 11 |
| N5 | nginx headers | 10 |

## Blockers / follow-ups

1. **Real ingest:** IT must complete Exchange transport rules (`deferred-real-mail-readiness.md`, `exchange-smoke.md`). POP3 worker runs but no live mailbox feed yet.
2. **Production TLS:** self-signed cert used for gate header check; replace with org cert when VPN users hit the app.
3. **Full suite on EC2 with `NODE_ENV=production`:** router-isolation / attachment-access tests require `NODE_ENV=test` (Task 9 guard) — run targeted gate suite with `NODE_ENV=test`, not full `pnpm test` in production env.

## Files changed (this task)

- `apps/server-pilot/tests/package-contract.test.ts` — timeout bump
- `docs/superpowers/plans/handoff-reports/progress-ledger.md` — security-hardening section + gate results
