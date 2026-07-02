Task 0: complete (commits d6a0fd0..75f11df, review clean)
Task 1: complete (commits 75f11df..64695db, review clean)
Task 2: complete (commit 7fa42ab1, RDS available, EC2 psql select version() ok, S3 ls ok, secret stored)
Task 2: complete (commits 64695db..afdd5e4, review clean after fixes)
Task 3: complete (commits afdd5e4..2ffa3d5, review clean)
Task 4: complete (commits 2ffa3d5..7156f88, review clean; note: mailboxType default shared, draft thread cascade - flag in Task 5/7)
Task 5: complete (commit b92ee32f, 25/25 tests green on EC2, seed:prod ran, psql verified: centurion@legacyhotel.com transport + 3 mailbox_access rows + 3 pilot users + nava ingest; /health + /api/public/providers live; IAM NavaZeroPilotUsersSecretWrite added)
Task 5: complete (commits 7156f88..b92ee32, review clean; note: resolveMailboxContext 3-arg db DI - Task 7 wraps 2-arg facade)
Task 6: complete (commits b92ee32..bfc06a7, review clean after UUID-threading + rename fix; EC2 36/36 with env sourced)
Task 7: complete (commits bfc06a7..6a8fbf9, review clean after facade + report fix)
Task 8: complete (commit 8cc96b58, fake SMTP adapter + mail-send tests)
Task 9: complete (commit fb9fe748, mailbox query cache + polling + logout IDB clear, mail build green)
Task 10: complete (commit 1ae4d7c2, nginx/pm2/deploy-ec2.sh + deploy-config tests)
Task 11: complete (commit 91045818, deferred real-mail readiness docs + vpn-route-check.sh)
Task 12: complete (commit 91045818, load-50-users.ts + ingest-benchmark.ts + cloudwatch-alarms.md + overnight report)

---

## Security hardening (2026-07-01 plan)

Pre-real-ingest gate. Branch `EC2-pilot`. Real POP3 ingest still blocked until IT completes Exchange relay rules (Task 3 ops gate).

| Task | Finding | Commit | Status |
|------|---------|--------|--------|
| 1 | F1 HTML XSS — server sanitize | e917df5a | complete |
| 2 | F1 HTML XSS — UI no raw fallback | 94c674de | complete |
| 3 | F2 X-Zero-Mailbox trust (last header) | ac100dd5 | complete |
| 4 | F3 RDS TLS verify | e8ccba50 | complete |
| 5 | N1 SMTP CRLF / outbound validate | 075cedfd | complete |
| 6 | N2/N3 ingest transaction + size limits | e5bda6b0 | complete |
| 7 | F4 Content-Disposition filenames | f3e60acd | complete |
| 8 | F5/F6 signup guard + account linking | 4b031e7e | complete |
| 9 | F7 tRPC test injection guard | 727833f9 | complete |
| 10 | N5 nginx security headers | ff1c315f | complete |
| 11 | N4 IDB cache on account switch | 88180fd7 | complete |
| 12 | EC2 verification gate | 2955a324 + docs | complete |

### Task 12 EC2 gate results (2026-07-02)

- **Local:** `@zero/server` 54 pass / 38 skip; `@zero/mail` test green; both builds green. `package-contract` timeout bumped to 15s (2955a324).
- **Push:** `EC2-pilot` pushed to origin (13 commits incl. hardening wave).
- **Deploy:** bundle sync to `i-008f737974a9ba9b3`; `deploy-ec2.sh` build + pm2 reload; nginx installed with self-signed `nava.legacy.local` cert for header verification.
- **Health:** `curl http://127.0.0.1:8788/health` → `{"ok":true,"service":"server-pilot"}`
- **Nginx headers:** HSTS, X-Frame-Options DENY, CSP present on `https://nava.legacy.local/`
- **Signup:** `POST /api/auth/sign-up/email` → **403** `signup disabled for pilot`
- **Env:** `PILOT_OPEN_SIGNUP=0` appended to `.env.production`
- **RDS tests (NODE_ENV=test):** 29/29 on targeted suite — seed-contract (5), auth-context (5), ingest-store (12 incl. double-stamp), sanitize-email-html (4), pop3-worker (3)
- **Ops blocker (unchanged):** real Exchange/POP3 ingest off until IT relay rules per `deferred-real-mail-readiness.md`

---

## Bug fix wave (2026-07-02 plan)

Branch `EC2-pilot`. Seven commits `4b173f5e..1a3e0d98`. Full report: [`2026-07-02-bug-fix-gate-report.md`](2026-07-02-bug-fix-gate-report.md).

| Wave | Commit | Scope |
|------|--------|-------|
| 1 | 4b173f5e | tRPC POST + FE wire contract |
| 2 | 1df697b5 | soft delete + seed/benchmark guards |
| 3 | 79d1793b | threading, dates, pagination |
| 4 | d35acfb0 | IDB leak + session TTL + NO_MAILBOX |
| 5 | 6a99ba3c | thread actions + ops bundle |
| 6 | 98aad701 | RealPop3Client + ingest durability |
| 7 | 1a3e0d98 | MAIL_TRANSPORT_MODE + IT handoff |

### Task 18 EC2 gate (2026-07-03)

- **Local:** server 101 pass; mail 163 pass; builds green
- **EC2:** sync + migrate (0001–0003) + deploy OK @ `1a3e0d98`
- **EC2 tests:** 101 pass / 53 skip
- **Signup:** 403 unchanged
- **Transport:** `MAIL_TRANSPORT_MODE=fixture`; `INGEST_FIXTURE_DIR` set on EC2 for fixture cycles
