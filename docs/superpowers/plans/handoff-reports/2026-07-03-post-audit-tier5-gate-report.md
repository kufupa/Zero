# Post-Audit Tier 5 Gate Report (2026-07-03)

Branch: `EC2-pilot`  
EC2 instance: `i-008f737974a9ba9b3` (`af-south-1`)  
Deployed SHA: `e58ac16f` (`fix: harden deploy scripts and ssm polling`)

## Wave commits (U1–U7)

| Wave | Commit | Message |
|------|--------|---------|
| U1 | `7ab251a3` | fix: close post-audit live regressions |
| U2 | `347eb2cf` | fix: finish tier5 mail and label semantics |
| U3 | `d23f1fd0` | fix: harden settings connections and schema |
| U4 | `fb345a8f` | fix: harden s3 and ingest durability |
| U5 | `79eb6a8a` | fix: gate inbound html rendering before real mail |
| U6 | `64a6496d` | fix: stabilize mailbox query cache scope |
| U7 | `e58ac16f` | fix: harden deploy scripts and ssm polling |

## Local gates (pre-push)

| Check | Result |
|-------|--------|
| `@zero/server` tests | 106+ pass (DB tests skip off-VPC) |
| `@zero/mail` tests | 165 pass |
| Server build | green |
| Mail build | green |

## EC2 / RDS gates

| Check | Result |
|-------|--------|
| Bundle sync | `sync-ec2-git-bundle.sh` → `e58ac16f` |
| RDS migrate | `pnpm db:migrate` with sourced `.env.production` — includes `0004_drop_user_settings_settings_idx` |
| Deploy | `deploy-ec2.sh` — health retry loop green |
| Health | `{"ok":true,"service":"server-pilot"}` |
| PM2 | `http` + `worker` online (deploy script) |
| Mail tests on EC2 | **165/165 pass** |
| Server tests on EC2 | **169/177 pass** with `NODE_ENV=test` + `.env.production` sourced (8 failures in DB/integration suites — same class as prior targeted gates; not introduced by U7) |
| Signup guard | unchanged — pilot closed |
| Transport | `MAIL_TRANSPORT_MODE=fixture` on EC2 |

## RCA notes

1. **Migrate without env** — `drizzle-kit migrate` without sourcing `.env.production` yields invalid `DATABASE_URL`. Fix: `set -a; source apps/server-pilot/.env.production; set +a` before migrate.
2. **EC2 sync** — `git fetch origin` fails on EC2 (no GitHub creds). Use `sync-ec2-git-bundle.sh` (S3 bundle).
3. **SSM empty poll** — `SSM_MAX_EMPTY_POLLS=30` too aggressive for slow command registration; raised to `120`.

## Accepted tradeoffs (unchanged)

- DB session `expiresIn` 400d; cookie cache max age **1h** (`SESSION_COOKIE_CACHE_MAX_AGE_SEC`).
- Query cache `PERSIST_MAX_AGE` / `QUERY_GC_TIME` = Infinity; list `staleTime` 60s.
- Real POP3/SMTP ingest blocked until IT relay handoff.

## Remaining human-loop blockers

- Real Exchange POP3/SMTP activation (IT secrets, VPN, header strip/stamp proof).
- Browser HTML XSS smoke (manual or Playwright) — server sanitize + `CACHE_BURST_KEY` bump shipped in U5/U6.
- 8 EC2 server test failures under full suite — triage in follow-up (targeted suites green).

## Verification commands

```bash
bash apps/server-pilot/deploy/sync-ec2-git-bundle.sh
# on EC2:
set -a; source apps/server-pilot/.env.production; set +a
pnpm db:migrate
bash apps/server-pilot/deploy/deploy-ec2.sh
curl -fsS http://127.0.0.1:8788/health
```
