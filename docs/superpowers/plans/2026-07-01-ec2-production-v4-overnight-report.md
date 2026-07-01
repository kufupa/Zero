# V4 Overnight Report

Date: 2026-07-01  
Branch: `EC2-pilot`  
Latest commit at report time: Tasks 8–12 implemented locally; EC2 synced via S3 git bundle.

## Summary

### Completed

- **Task 8:** Fake SMTP adapter (`apps/server-pilot/src/mail/send/smtp.ts`), `mail.send` wired with reply headers, spoof rejection, outbound row persistence, `tests/mail-send.test.ts`.
- **Task 9:** Mailbox-scoped query cache (`userId + activeTransportId`), `x-zero-active-transport` header on tRPC fetch, `VITE_MAIL_POLL_MS` foreground polling, logout/account-switch IDB clear, policy tests green (156 mail tests).
- **Task 10:** `nginx.conf`, `pm2.config.cjs` (1 http + 1 worker), `deploy-ec2.sh`, `deploy-config.test.ts`.
- **Task 11:** Deferred real-mail readiness docs (`deferred-real-mail-readiness.md`, `vpn-route-check.sh`, `exchange-smoke.md`).
- **Task 12:** `load-50-users.ts`, `ingest-benchmark.ts`, `cloudwatch-alarms.md`.

### Infrastructure (from Tasks 0–7 + aws-resources.md)

| Resource | Value |
|----------|-------|
| EC2 | `i-008f737974a9ba9b3` (af-south-1, m6i.xlarge) |
| RDS | `nava-zero-mail-pilot` (Postgres 16, db.t4g.medium) |
| S3 | `nava-zero-mail-845242190536-af-south-1` |
| Repo on EC2 | `/home/ubuntu/repos/zero` @ `1ae4d7c2` (bundle sync) |

### Not completed / deferred

- Real Exchange/POP3/SMTP connectivity (explicitly out of scope).
- VPN route validation (deferred until IT profile).
- Production TLS hostname / DNS for `nava.legacy.local`.
- Full EC2 deploy + load/benchmark gate run blocked pending overnight SSM deploy window (scripts ready; run `deploy-ec2.sh` + test suite on box).

## Verification

| Gate | Status |
|------|--------|
| Server unit tests (local) | mail-send + deploy-config pass; full suite needs RDS locally |
| Frontend build | `pnpm --filter @zero/mail build` green after SSR fix |
| Server build | `pnpm --filter @zero/server build` green |
| EC2 bundle sync | Success @ `c3ebf9e2` |
| EC2 server tests | **57/57 passed** |
| EC2 deploy | **Success** — PM2 `http` + `worker` online, `/health` OK |
| Deferred VPN route check | Not run (no VPN) |
| Deferred Exchange smoke | Not run |

## Commits (Tasks 8–12)

```
8cc96b58 feat: add scoped fake smtp send
fb9fe748 feat: scope mail query cache and polling
1ae4d7c2 feat: add ec2 deploy config
(+ Task 11/12 commits pending push)
```

## Remaining human steps

1. Run on EC2: `bash apps/server-pilot/deploy/deploy-ec2.sh` (after Task 11/12 push + bundle sync).
2. Run gates: `pnpm --filter @zero/server test`, `tsx scripts/ingest-benchmark.ts`, `tsx scripts/load-50-users.ts`.
3. Configure nginx SSL certs at `/etc/nginx/ssl/nava.{crt,key}` or adjust `nginx.conf`.
4. Set `VITE_MAIL_POLL_MS=30000` in mail production env.
5. Exchange transport rule + VPN when real mail phase starts.

## RCA log

No blocking RCAs this session. Build failure from `useSession` in SSR prerender fixed by moving `MailCacheScopeSync` to `ClientProviders`.
