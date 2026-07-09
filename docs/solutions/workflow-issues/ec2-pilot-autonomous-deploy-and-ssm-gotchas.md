---
title: EC2 Pilot Autonomous Deploy and SSM Gotchas
last_updated: 2026-07-07
category: workflow-issues
module: server-pilot deploy
problem_type: workflow_issue
component: development_workflow
severity: medium
applies_when:
  - Autonomous EC2 deploy from Windows dev machine via SSM
  - Git bundle sync to EC2 when direct git pull is insufficient
  - Long pnpm install or build steps run through ssm-run-command.sh
  - Running RDS drizzle migrations on EC2 before or after deploy
tags:
  - ec2
  - ssm
  - bundle-sync
  - deploy
---

# EC2 Pilot Autonomous Deploy and SSM Gotchas

## Context

The EC2-pilot branch targets a single production EC2 instance (`i-008f737974a9ba9b3`) in `af-south-1` paired with RDS (`nava-zero-mail-pilot`). For a solo developer, this machine is both production and the integration test rig: verified commits land on `EC2-pilot`, sync to the instance, build in place, and reload services. Two scripts form the core loop — `sync-ec2-git-bundle.sh` to move code without relying solely on `git push`, and `deploy-ec2.sh` to install, build, publish the SPA, configure nginx, and reload PM2. Several non-obvious SSM and shell pitfalls were discovered and fixed during autonomous deploy work (notably commit `64695dbf`).

## Guidance

### Deploy flow (`deploy-ec2.sh`)

Run on EC2 as `ubuntu` after the repo is present at `/home/ubuntu/repos/zero` (or `$REPO_ROOT`). The script:

1. **Sources production env** — reads `apps/server-pilot/.env.production` (or `/home/ubuntu/.env.production` fallback) so build and runtime see DB/S3/auth secrets.
2. **Prepends NVM and pnpm to PATH** — non-interactive SSM shells do not load `.bashrc`; the script explicitly exports PATH with nvm node bin and pnpm.
3. **`pnpm install --frozen-lockfile`** at repo root.
4. **Builds server-pilot** — `pnpm --filter @zero/server build`.
5. **Builds mail SPA** — `pnpm --filter @zero/mail build`.
6. **Rsyncs SPA** — `sudo rsync -a --delete apps/mail/build/client/ /var/www/nava-mail/`.
7. **nginx** — copies `apps/server-pilot/deploy/nginx.conf`, `nginx -t && systemctl reload nginx`.
8. **PM2** — `pm2 startOrReload apps/server-pilot/deploy/pm2.config.cjs --update-env`, then `pm2 save`.
9. **Health check** — retries up to 10 times with linear backoff (`health attempt N/10`); `curl -fsS http://127.0.0.1:8788/health` on success. On failure dumps `pm2 logs http --lines 20` and exits non-zero. (U7 tier5 — replaced single 2s sleep + one probe.)

### Bundle sync (`sync-ec2-git-bundle.sh`)

Local workstation script. Creates a git bundle for `EC2-pilot`, uploads to private S3 bucket `nava-zero-bootstrap-845242190536`, then triggers EC2 to pull and reset via SSM.

**Instance-profile S3 access, not presigned URLs.** Commit `64695dbf` replaced presigned URL generation because presigned URLs were persisted in SSM command history — a credential leak vector. EC2 uses `aws s3 cp` with the instance IAM role. No time-limited URL appears in SSM audit logs.

**In-place fetch+reset preserves `node_modules`.** When `.git` exists, remote script does `git fetch` from bundle + `git reset --hard bundle/EC2-pilot`. Only a fresh clone runs when the repo directory is absent.

**Inline paths in SSM remote script.** `ssm-run-command.sh` wraps commands in `sudo -u ubuntu bash -lc "..."`. Shell variables like `${EC2_REPO_PATH}` expand on the *local* workstation before the remote assignment runs — inline literal paths into `REMOTE_SCRIPT`.

### SSM gotchas

**Windows AWS CLI charmap crash on unicode stdout.** `aws ssm get-command-invocation` on Windows crashes when EC2 stdout contains vitest box-drawing, pm2 table checkmarks (`✓`), or other non-ASCII. **Severity: observability only** — remote `Status: Success` is trustworthy; local poll may show empty stdout or exit 1 even when EC2 passed.

**Definitive fix (commits `4f38697d`, `8a603fb2`):** `ssm-format-invocation.cjs` fetches `Status`, `StandardOutputContent`, and `StandardErrorContent` as separate `--output json` queries with `PYTHONUTF8=1` / `PYTHONIOENCODING=utf-8`, then ASCII-sanitizes before emit. `ssm-run-command.sh` calls `print_invocation` on terminal states instead of raw combined JSON.

```bash
node apps/server-pilot/deploy/ssm-format-invocation.cjs <command-id>
# → {"Status":"Success","Stdout":"... Test Files 6 passed ... fixture-loopback-gate: PASS","Stderr":""}
```

**Earlier workarounds** (still valid on EC2 if needed): vitest `--reporter=dot`, strip on EC2 (`LC_ALL=C tr -dc "\040-\176\012\015"`), base64-encode remote output.

**NVM/PATH in non-interactive shells.** Any remote command invoking `node`, `pnpm`, or `npm` must source nvm or prepend the node bin directory. U7 uses `sort -V | tail -1` to pick the latest nvm node (lexicographic sort wrongly prefers `v9` over `v22`).

### RDS migrate (manual gate — intentional)

`deploy-ec2.sh` sources `.env.production` for build and PM2 but **does not** run `db:migrate`. That is deliberate: breaking schema changes should not auto-apply on every deploy. Operator reviews SQL, then runs migrate as an explicit step.

**Symptoms when migrate is invoked wrong:**

- `TypeError: Invalid URL` from drizzle-kit
- Connection URL resolves to `?sslmode=require` only (no host, user, or database)
- A combined SSM gate may also report health curl failure — usually collateral from the same bad env, not a separate RDS outage

**Root cause chain:**

1. **`source` without export** — `source apps/server-pilot/.env.production` sets shell variables but does not export them to child processes unless you `set -a` first. `drizzle-kit` then sees an empty `DATABASE_URL`.
2. **`drizzle.config.ts` sslmode append** — when `DATABASE_URL` is empty, config builds `${rawUrl}?sslmode=require` → literal `?sslmode=require`, which is not a valid Postgres URL.
3. **SSM / dash quoting** — `ssm-run-command.sh` wraps remote commands in double-quoted `bash -lc`. If `$DATABASE_URL` or `${#DATABASE_URL}` appear unquoted in the outer `/bin/sh` layer, dash expands them to empty before ubuntu bash runs. Use inline literals or keep variable expansion inside single-quoted remote script bodies.

**Working command (on EC2):**

```bash
cd /home/ubuntu/repos/zero/apps/server-pilot
set -a
source .env.production
set +a
pnpm db:migrate
# equivalent: pnpm --filter @zero/server db:migrate from repo root
```

**From local workstation via SSM:**

```bash
bash apps/server-pilot/deploy/ssm-run-command.sh \
  'cd /home/ubuntu/repos/zero/apps/server-pilot && set -a && source .env.production && set +a && pnpm db:migrate'
```

**What did not work (session history):**

- Raw `pnpm exec drizzle-kit migrate` without sourcing env
- `source .env.production` without `set -a` before migrate
- Chaining migrate + health in one SSM line that sources env but never exports it

**Verified:** Contract convergence Wave 7 (2026-07-07) — migrations applied with exported env; PM2 http/worker online; `curl -fsS http://127.0.0.1:8788/health` OK. RDS and Secrets Manager `DATABASE_URL` were never corrupt.

**EC2 server tests need `NODE_ENV=test`.** Full vitest on EC2 with only `.env.production` sourced yields auth mock failures. Export `NODE_ENV=test` before `pnpm test` for the integration suite.

**SSM poll cap.** `ssm-run-command.sh` sets `SSM_MAX_POLL_SECONDS=1800` and `SSM_MAX_EMPTY_POLLS=120` so empty-status spins do not hang forever (30 was too aggressive for slow command registration).

### Test timeout under parallel load

`package-contract.test.ts` timed out at 5s under parallel vitest load; bumped to 15s (commit `2955a324`).

## Why This Matters

Without the bundle-sync fix, every deploy paid a full clone + cold `pnpm install` tax. Without instance-profile S3, presigned URLs leaked into SSM history. Without charmap workarounds, Windows-side polling falsely reported SSM commands as Failed even when tests passed on EC2. Without the health curl gate, green PM2 status could mask a crashed HTTP listener. Without manual migrate + `set -a` export, a green deploy can ship code that expects schema the database never received — or a false-red migrate gate can look like RDS is broken when only the shell export was wrong.

## When to Apply

- After any verified commit on `EC2-pilot` you want on prod EC2.
- When debugging "SSM says Failed but EC2 looks fine" — check for unicode in stdout first.
- When adding new remote SSM commands that reference repo paths — inline literals or base64-wrap scripts.

## Examples

**Day-to-day (prefer these):**

```bash
bash apps/server-pilot/deploy/ops-deploy.sh
bash apps/server-pilot/deploy/ops-deploy.sh --migrate   # when schema changed
bash apps/server-pilot/deploy/ops-restart.sh            # bounce apps, no OS reboot
bash apps/server-pilot/deploy/ops-reboot.sh             # soft box reboot + smoke
```

**Advanced guts (debug only) — old multi-step loop:**

```bash
bash apps/server-pilot/deploy/sync-ec2-git-bundle.sh
bash apps/server-pilot/deploy/ssm-run-command.sh \
  'export NVM_DIR=/home/ubuntu/.nvm; . /home/ubuntu/.nvm/nvm.sh; cd /home/ubuntu/repos/zero && bash apps/server-pilot/deploy/deploy-ec2.sh'
bash apps/server-pilot/deploy/ssm-run-command.sh 'curl -fsS http://127.0.0.1:8788/health'
```

**RDS tests on EC2 after deploy:**

```bash
bash apps/server-pilot/deploy/ssm-run-command.sh \
  'set -a; source /home/ubuntu/repos/zero/apps/server-pilot/.env.production; set +a; export NODE_ENV=test; cd /home/ubuntu/repos/zero && pnpm --filter @zero/server test tests/ingest-store.test.ts 2>&1 | LC_ALL=C tr -dc "\040-\176\012\015"'
```

## Related

- [nava-fixture-loopback-e2e-harness.md](../architecture-patterns/nava-fixture-loopback-e2e-harness.md) — fixture loopback gate uses `ssm-run-command.sh`
- [ec2-pilot-post-audit-tier5-execution.md](./ec2-pilot-post-audit-tier5-execution.md) — Tier 5 wave SHAs, gates, test triage
- [mail-list-keyset-pagination-cursor.md](../logic-errors/mail-list-keyset-pagination-cursor.md) — page-2 cursor bind fix
- [task-1-report.md](../../superpowers/plans/handoff-reports/task-1-report.md) (presign RCA, `64695dbf`)
- [progress-ledger.md](../../superpowers/plans/handoff-reports/progress-ledger.md) (Task 12 EC2 gate)
- [HANDOFF-TO-CLAUDECODE.md](../../superpowers/plans/2026-07-01-ec2-production-v4-HANDOFF-TO-CLAUDECODE.md) (SSM charmap RCA)
