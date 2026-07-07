---
title: EC2 pilot post-audit Tier 5 execution and verification
date: 2026-07-04
category: workflow-issues
module: EC2-pilot tier5
problem_type: workflow_issue
component: development_workflow
severity: medium
applies_when:
  - Executing the post-audit Tier 5 plan on branch EC2-pilot
  - Autonomous overnight deploy to i-008f737974a9ba9b3 with RDS gates
  - Interpreting EC2 full-suite vitest results vs production health
tags:
  - tier5
  - ec2-pilot
  - bundle-sync
  - gate-report
  - test-triage
---

# EC2 pilot post-audit Tier 5 execution and verification

## Context

Plan `docs/superpowers/plans/2026-07-03-ec2-pilot-post-audit-tier5-plan.md` defined seven waves (U1–U7) after the July 2026 fix-verification audit: live regressions, mail semantics, settings/schema, S3/ingest, HTML XSS gate, query-cache scope, and deploy-script hardening. Work ran autonomously on `EC2-pilot` with bundle sync + SSM deploy to `i-008f737974a9ba9b3` (`af-south-1`).

## Guidance

### Wave commits (final SHAs)

| Wave | Commit | Focus |
|------|--------|--------|
| U1 | `7ab251a3` | Cookie cache 1h, draft body, FORBIDDEN/NO_MAILBOX, bulk delete idempotency |
| U2 | `347eb2cf` | Thread visibility, toggleStar, NULLS LAST sort, labels CONFLICT |
| U3 | `d23f1fd0` | Settings upsert, migration 0004, connections delete promotes default |
| U4 | `fb345a8f` | S3 buffer-once, ingest poison counts, PM2 bounded restart |
| U5 | `79eb6a8a` | Server-side HTML sanitize, demo test mock |
| U6 | `64a6496d` | Stable QueryClient, bootstrap hash prefix, exports-derived vitest aliases |
| U7 | `e58ac16f` | NVM sort -V, health retry loop, SSM poll caps, postgres rds-smoke fallback |
| Triage | `a8ca9675` | Pagination cursor `::timestamptz` + RDS test drift fixes |
| Triage | `5515befe` | Last-mailbox delete test uses owner role |

**Live deploy after pagination fix:** `5515befe` — health `{"ok":true,"service":"server-pilot"}`; `list-pagination.test.ts` 3/3 on EC2.

### Locked product decisions (do not regress)

- DB session `expiresIn` **400d**; cookie cache max age **1h** (`SESSION_COOKIE_CACHE_MAX_AGE_SEC`).
- Query cache `PERSIST_MAX_AGE` / `QUERY_GC_TIME` = Infinity; list `staleTime` 60s.
- `MAIL_TRANSPORT_MODE=fixture` on EC2 until IT real-mail handoff.

### EC2 gate commands

```bash
# Local workstation
bash apps/server-pilot/deploy/sync-ec2-git-bundle.sh

# On EC2 (via SSM) — env before migrate is mandatory
set -a; source apps/server-pilot/.env.production; set +a
pnpm db:migrate
bash apps/server-pilot/deploy/deploy-ec2.sh
curl -fsS http://127.0.0.1:8788/health

# Full server tests on EC2
export NODE_ENV=test
pnpm test   # expect 177/177 after a8ca9675+
```

### RCA patterns discovered during execution

1. **Migrate without env** — `drizzle-kit migrate` without sourcing `.env.production` → invalid `DATABASE_URL` (`?sslmode=require` only). Always `set -a; source ...; set +a` first.
2. **git fetch origin on EC2** — fails (no GitHub creds). Use `sync-ec2-git-bundle.sh` only.
3. **SSM multiline scripts** — embedding newlines in JSON parameters corrupts commands; use single-line `bash -lc` or base64-wrap.
4. **SSM_MAX_EMPTY_POLLS=30** — too aggressive; raised to **120** in U7.
5. **169/177 “red” is not prod broken** — eight failures were test drift (wrong error shape, missing `mailbox_access.id`, stale pop3 mocks, member vs owner delete case). One was real pagination — see `docs/solutions/logic-errors/mail-list-keyset-pagination-cursor.md`.

### U1–U7 scope map (audit IDs)

| Audit bucket | Waves |
|--------------|-------|
| Live regressions, attachments | U1, U2 |
| Settings, connections, D6 | U3 |
| S3, ingest, A16 | U4 |
| HTML XSS | U5 |
| E3–E8 query cache | U6 |
| D10–D13 deploy scripts | U7 |

### Remaining human-loop (not Tier 5 blockers)

- Real POP3/SMTP + IT relay proof (header strip/stamp).
- Browser HTML XSS smoke (server gate shipped; manual/Playwright not run).
- Dependabot noise on default branch (unrelated to pilot deploy).

## Why This Matters

Tier 5 closed the post-audit backlog on a single EC2/RDS pilot. Without bundle sync + env-sourced migrate + health retry, autonomous overnight runs false-fail or ship code that never reloads. Without test triage, a green health check plus red vitest looks like production is broken when most failures are assertion drift.

## When to Apply

- Before declaring Tier 5 “done” — verify SHAs on EC2 match expected HEAD, health OK, mail 165/165, server 177/177 with `NODE_ENV=test`.
- When adding a U8 wave — same loop: local gate → commit → bundle sync → migrate (with env) → deploy → EC2 tests.
- When inbox pagination breaks again — run `list-pagination.test.ts` on EC2 first.

## Examples

**Pagination deploy verification (Jul 4 2026):**

```
Bundle sync → 5515befe
deploy-ec2.sh → Success (~82s)
health → {"ok":true,"service":"server-pilot"}
list-pagination.test.ts → 3 passed
```

## Related

- Plan: `docs/superpowers/plans/2026-07-03-ec2-pilot-post-audit-tier5-plan.md`
- Gate report (Jul 3): `docs/superpowers/plans/handoff-reports/2026-07-03-post-audit-tier5-gate-report.md`
- Pagination bug: `docs/solutions/logic-errors/mail-list-keyset-pagination-cursor.md`
- Deploy gotchas: `docs/solutions/workflow-issues/ec2-pilot-autonomous-deploy-and-ssm-gotchas.md`
- Security gate: `docs/solutions/security-issues/ec2-pilot-pre-real-ingest-security-gate.md`
