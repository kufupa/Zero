# EC2 Pilot Bug-Fix Gate Report

**Date:** 2026-07-03  
**Branch:** `EC2-pilot`  
**Final commit:** `1a3e0d98` — feat: MAIL_TRANSPORT_MODE fixture|real + IT handoff runbook

## Summary

All 7 bug-fix waves shipped, pushed, synced to EC2 `i-008f737974a9ba9b3`, migrated + deployed. Local and EC2 test suites green.

## Commits (7 waves)

| Wave | Commit | Message |
|------|--------|---------|
| 1 | `4b173f5e` | fix: tRPC POST queries + FE wire contract alignment |
| 2 | `1df697b5` | fix: soft delete bin + seed-prod and benchmark guards |
| 3 | `79d1793b` | fix: threading date headers and keyset pagination |
| 4 | `d35acfb0` | fix: IDB leak session TTL and NO_MAILBOX handling |
| 5 | `6a99ba3c` | fix: thread actions and ops traps bundle |
| 6 | `98aad701` | fix: RealPop3Client rewrite and ingest durability |
| 7 | `1a3e0d98` | feat: MAIL_TRANSPORT_MODE fixture|real + IT handoff runbook |

## Local gate

| Check | Result |
|-------|--------|
| `@zero/server test` | 101 passed, 53 skipped |
| `@zero/mail test` | 163 passed |
| `@zero/server build` | OK |
| `@zero/mail build` | OK |

## EC2 gate

| Check | Result |
|-------|--------|
| Bundle sync | OK @ `1a3e0d98` |
| `db:migrate` | OK (0001 trashed_at, 0002 is_default, 0003 quarantine uid) |
| `deploy-ec2.sh` | OK (~82s) |
| `/health` | `{"ok":true,"service":"server-pilot"}` |
| PM2 http + worker | online |
| `@zero/server test` on EC2 | **101 passed**, 53 skipped |
| Targeted wire/ingest tests | 32 passed, 12 skipped |
| Signup guard | POST sign-up → **403** (unchanged) |
| `MAIL_TRANSPORT_MODE` | **fixture** (default; no real POP3/SMTP TCP) |

## RDS migrations applied

- `0001_tired_blizzard.sql` — `mail_thread.trashed_at`
- `0002_mailbox_access_is_default.sql` — `mailbox_access.is_default`
- `0003_quarantine_ingest_uidl_uidx.sql` — quarantine idempotency index

## Known follow-ups (non-blocking)

- DB integration tests (`thread-join`, `trash-soft-delete`, `connections-default`) skip when `TEST_DB_AVAILABLE` false — run on EC2 with full env for integration pass
- `ingest-benchmark` requires `--allow-prod` (intentional prod guard)
- Real mail: IT handoff via `apps/server-pilot/scripts/activate-real-mail.sh` + `deploy/it-handoff-runbook.md`
- SSM stdout: strip non-ASCII (`tr -cd '\11\12\15\40-\176'`) on Windows-side JSON parse

## Ops blocker (unchanged)

Real Exchange/POP3 ingest off until IT completes relay rules per `deferred-real-mail-readiness.md`.
