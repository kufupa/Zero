# Task 2 Report — Provision RDS, S3, Secrets, And Network

Date: 2026-07-01
Branch: EC2-pilot
Commit: 7fa42ab1

## Status

DONE_WITH_CONCERNS

## What Implemented

1. **Env parser + test** (`apps/server-pilot/src/env.ts`, `apps/server-pilot/tests/env.test.ts`): parses required backend/deploy env (PORT, DATABASE_URL, BETTER_AUTH_URL, BETTER_AUTH_SECRET, AWS_REGION, S3_BUCKET, POP3_POLL_INTERVAL_MS, POP3_MAX_MESSAGES_PER_CYCLE) plus deferred real-mail env (POP3_*, SMTP_*) when present. Throws on missing/invalid required keys, non-integer numerics, invalid NODE_ENV, malformed booleans. 4 tests pass locally via vitest.
2. **Minimal package shell** (`apps/server-pilot/package.json`, `tsconfig.json`, `vitest.config.ts`): created so the env test can run. Task 3 will expand the package (server entry, deps, etc.). Noted in concerns.
3. **AWS resources provisioned** via AWS CLI from laptop:
   - RDS Postgres 16 instance `nava-zero-mail-pilot` (db.t4g.medium, gp3 100GB, storage-encrypted, backup-retention 7, no-publicly-accessible).
   - RDS SG `sg-0fbe865a67165678c` with ingress from EC2 SG `sg-00190151691bd66fa` on tcp/5432.
   - RDS subnet group `nava-zero-mail` (subnets `subnet-0e6446aaaeaa8762e` af-south-1a + `subnet-094bf8643d98c22f6` af-south-1b — 2 AZs).
   - Secrets Manager secret `nava-zero/server-pilot/database-url` storing `{"DATABASE_URL":"postgres://zero_admin:<redacted>@nava-zero-mail-pilot.cpuaauo4kfyd.af-south-1.rds.amazonaws.com:5432/zero"}`.
   - S3 mail bucket `nava-zero-mail-845242190536-af-south-1` with SSE-AES256, public access block (all 4), lifecycle (raw-mime/* expire 30d, attachments/* expire 90d, incomplete multipart abort 1d).
4. **EC2 instance role inline policies** attached to `nava-prod-public-ipv4-WorkerRole-bPmrMEkmdwLU`:
   - `NavaZeroMailBucketAccess` (S3 list/get/put/delete on mail bucket).
   - `NavaZeroSecretsRead` (secretsmanager:GetSecretValue/DescribeSecret on database-url secret).
   - `NavaZeroRDSConnect` (rds-db:connect for future IAM DB auth; password auth used today via SG routing).
5. **Deploy scripts**:
   - `apps/server-pilot/deploy/aws-resources.md`: full resource inventory + re-runnable provisioning commands + resize/downgrade note + tear-down commands.
   - `apps/server-pilot/deploy/rds-smoke.sh`: sources `.env.production`, runs `psql "$DATABASE_URL" -c "select version();"` (falls back to node pg script if psql missing).
   - `apps/server-pilot/deploy/s3-smoke.sh`: sources `.env.production`, runs `aws s3 ls "s3://$S3_BUCKET"`.
   - `apps/server-pilot/deploy/write-ec2-env.sh`: pulls DATABASE_URL from Secrets Manager via instance profile, writes `.env.production` owned by ubuntu, mode 600.
6. **EC2 `.env.production`** written at `/home/ubuntu/repos/zero/apps/server-pilot/.env.production` via SSM, owned by ubuntu, mode 600, gitignored (untracked). Contains NODE_ENV, PORT, DATABASE_URL, BETTER_AUTH_URL, BETTER_AUTH_SECRET, AWS_REGION, S3_BUCKET, POP3_POLL_INTERVAL_MS, POP3_MAX_MESSAGES_PER_CYCLE.
7. **postgresql-client** installed on EC2 via apt (`psql 16.14`) so the RDS smoke could run.
8. **.gitignore** updated to exclude `apps/server-pilot/.env.production` and `apps/server-pilot/.env.*`.
9. **pnpm-lock.yaml** updated for the new `@zero/server-pilot` workspace member.

## AWS Resource IDs (non-secret)

| Resource | Value |
|----------|-------|
| RDS instance identifier | `nava-zero-mail-pilot` |
| RDS endpoint host | `nava-zero-mail-pilot.cpuaauo4kfyd.af-south-1.rds.amazonaws.com` |
| RDS port | `5432` |
| RDS SG | `sg-0fbe865a67165678c` |
| RDS subnet group | `nava-zero-mail` |
| RDS subnets | `subnet-0e6446aaaeaa8762e`, `subnet-094bf8643d98c22f6` |
| S3 mail bucket | `nava-zero-mail-845242190536-af-south-1` |
| Secret ARN | `arn:aws:secretsmanager:af-south-1:845242190536:secret:nava-zero/server-pilot/database-url-RsBcd2` |
| Secret name | `nava-zero/server-pilot/database-url` |
| EC2 instance profile role | `nava-prod-public-ipv4-WorkerRole-bPmrMEkmdwLU` |
| EC2 SG (RDS source) | `sg-00190151691bd66fa` |

`DB_ADMIN_PASSWORD` generated with `openssl rand -base64 36` (stripped of `+/=` and newlines to satisfy RDS password constraints). Never printed in committed docs or this report. Redacted as `<redacted>`.

## Verification Commands And Results

### Local env test

```bash
cd apps/server-pilot && pnpm exec vitest run tests
```

Result: `Test Files 1 passed (1)`, `Tests 4 passed (4)`, exit 0.

### EC2 .env.production

```bash
bash apps/server-pilot/deploy/ssm-run-command.sh 'ls -la /home/ubuntu/repos/zero/apps/server-pilot/.env.production'
```

Result: `-rw------- 1 ubuntu ubuntu 408 ... .env.production` (mode 600, owned ubuntu).

```bash
bash apps/server-pilot/deploy/ssm-run-command.sh 'sudo -u ubuntu bash -lc "test -r /home/ubuntu/repos/zero/apps/server-pilot/.env.production && grep -E \"^(NODE_ENV|PORT|BETTER_AUTH_URL|AWS_REGION|S3_BUCKET)=\" /home/ubuntu/repos/zero/apps/server-pilot/.env.production && grep -c \"^DATABASE_URL=\" /home/ubuntu/repos/zero/apps/server-pilot/.env.production"'
```

Result: ubuntu can read; non-secret keys print; `DATABASE_URL=` count = 1 (present, not printed).

### EC2 RDS smoke

```bash
bash apps/server-pilot/deploy/ssm-run-command.sh 'sudo -u ubuntu bash -lc "bash /home/ubuntu/repos/zero/apps/server-pilot/deploy/rds-smoke.sh"'
```

Result: `PostgreSQL 16.13 on aarch64-unknown-linux-gnu ... 64-bit (1 row)`. RDS reachable from EC2.

### EC2 S3 smoke

```bash
bash apps/server-pilot/deploy/ssm-run-command.sh 'sudo -u ubuntu bash -lc "bash /home/ubuntu/repos/zero/apps/server-pilot/deploy/s3-smoke.sh"'
```

Result: `Listing s3://nava-zero-mail-845242190536-af-south-1/ (region af-south-1)` + `s3-smoke OK`. Bucket listable from EC2 (empty bucket).

### EC2 secret access

```bash
bash apps/server-pilot/deploy/ssm-run-command.sh 'sudo -u ubuntu bash -lc "aws secretsmanager get-secret-value --region af-south-1 --secret-id nava-zero/server-pilot/database-url --query Name --output text"'
```

Result: `nava-zero/server-pilot/database-url` + `secret-access-ok`. Instance role policy grants read.

### .env.production untracked on EC2

```bash
bash apps/server-pilot/deploy/ssm-run-command.sh 'cd /home/ubuntu/repos/zero && git check-ignore apps/server-pilot/.env.production && git status --short apps/server-pilot/'
```

Result: `apps/server-pilot/.env.production` (ignored); `git status` clean for it; EC2 branch at `7fa42ab14`.

## Files Changed

| File | Action |
|------|--------|
| `apps/server-pilot/src/env.ts` | Created |
| `apps/server-pilot/tests/env.test.ts` | Created |
| `apps/server-pilot/package.json` | Created (minimal shell for env test) |
| `apps/server-pilot/tsconfig.json` | Created (minimal shell) |
| `apps/server-pilot/vitest.config.ts` | Created (minimal shell) |
| `apps/server-pilot/deploy/aws-resources.md` | Created |
| `apps/server-pilot/deploy/rds-smoke.sh` | Created |
| `apps/server-pilot/deploy/s3-smoke.sh` | Created |
| `apps/server-pilot/deploy/write-ec2-env.sh` | Created |
| `.gitignore` | Modified (added `apps/server-pilot/.env.production` + `.env.*`) |
| `pnpm-lock.yaml` | Modified (new workspace member) |

AWS-side (not committed; applied via AWS CLI from laptop): RDS instance, RDS SG, RDS subnet group, Secrets Manager secret, S3 mail bucket + encryption + public block + lifecycle, 3 EC2 instance role inline policies, postgresql-client apt install on EC2, EC2 `.env.production`.

## Commits Created

- `7fa42ab1` — feat: add aws resource env contract

## RCA Notes For Failures

1. **RDS create `InvalidParameterValue: control characters`**: first `openssl rand -base64 36` output contained `\n` and `+`/`/` chars that RDS rejected as control chars. Fix: `tr -d '\n+/='` then `head -c 32` to produce a clean 32-char alphanumeric password. Re-ran create-db-instance successfully.

2. **Password lost after first successful RDS create**: the password was set in a shell session env that did not persist across separate shell tool calls, so when RDS became available I could not construct DATABASE_URL. RCA: each shell tool call
 is a fresh env; env vars do not survive across calls. Fix: reset RDS master password via `modify-db-instance --master-user-password` with a fresh generated value, saved to a 600-mode temp file (`/tmp/nava-zero-db-pw.tmp`) in the same shell call, then constructed DATABASE_URL and stored in Secrets Manager. Temp file shredded after use. Note: this means the password was rotated once after initial create; the secret in Secrets Manager reflects the rotated value, which is the one EC2 uses.

3. **psql missing on EC2**: EC2 had no postgres client. RCA: base Ubuntu 24.04 image does not ship psql. Fix: `sudo apt-get install -y postgresql-client` via SSM. Installed `psql 16.14` (Ubuntu 16.14-0ubuntu0.24.04.1). RDS engine is postgres 16, client 16 — compatible.

4. **First RDS smoke via nested SSM quoting failed with local socket error**: `psql "$DATABASE_URL"` resolved to empty because the nested single/double quoting in the SSM command broke env expansion, so psql fell back to the local unix socket. RCA: quoting hell in `sudo -u ubuntu bash -lc '...' "..." '...'`. Fix: ran the smoke script directly (`bash /home/ubuntu/repos/zero/apps/server-pilot/deploy/rds-smoke.sh`) which sources `.env.production` internally with clean quoting. Succeeded.

5. **Heredoc file truncation**: writing `aws-resources.md` via a single heredoc produced a truncated file (109/110 lines, last line cut mid-word). RCA: the shell tool wrapper appears to cap heredoc body around ~8KB. Fix: split into a base heredoc + an append heredoc for the tail. Final file is 131 lines, complete.

6. **Write tool silently dropping files in `apps/server-pilot/`**: the Write tool reported success but files did not appear when invoked before `pnpm install` had registered `@zero/server-pilot` as a workspace member; pnpm install then cleaned the unregistered directory. RCA: pnpm's workspace pruning removed the orphaned package dir during install. Fix: created `package.json` first via heredoc, ran `pnpm install` to register the workspace member + populate lockfile + install vitest, then wrote remaining files via heredoc (Write tool still unreliable for paths with spaces, so heredoc used throughout).

## Self-Review Findings

1. **Env parser matches brief contract**: all 8 required keys parsed, deferred POP3/SMTP keys optional, types enforced (int/bool/nodeenv). Test covers happy path, missing key, deferred fields, and non-integer rejection.
2. **RDS config matches brief verbatim**: `db.t4g.medium`, postgres 16, gp3 100GB, storage-encrypted, backup-retention 7, no-publicly-accessible. Verified via `describe-db-instances`.
3. **Subnet group has 2 AZs**: af-south-1a + af-south-1b. VPC had 3 default subnets (a/b/c); used first 2 sorted by AZ.
4. **S3 bucket naming matches brief**: `nava-zero-mail-<account>-af-south-1` = `nava-zero-mail-845242190536-af-south-1`. SSE + private + lifecycle applied.
5. **Secret stored under correct name**: `nava-zero/server-pilot/database-url`. EC2 instance role can read it.
6. **`.env.production` on EC2**: correct path, owner, mode, gitignored, DATABASE_URL present but not printed by smoke.
7. **Verification from EC2**: `psql select version()` returns Postgres 16.13; `aws s3 ls` exits 0; secret access ok.
8. **No secrets committed**: password redacted in `aws-resources.md` and this report; `.env.production` gitignored; temp pw file shredded.
9. **Unrelated untracked files not staged**: only task-owned files + `.gitignore` + `pnpm-lock.yaml` committed.

## Concerns

1. **Minimal package shell**: `apps/server-pilot/package.json`/`tsconfig.json`/`vitest.config.ts` are minimal (only what the env test needs). Task 3 owns the package shell expansion (server entry, runtime deps, build config). If Task 3 expects a different package shape, these files may need adjustment.
2. **RDS password rotated once after create** (see RCA 2). The Secrets Manager value is the rotated one and is what EC2 uses; this is consistent. But the original create-time password is unrecoverable and was never stored — not a problem since rotation superseded it.
3. **IAM state not in git**: the 3 new EC2 instance role inline policies + postgresql-client apt install are AWS/EC2-side state not captured in git. If the EC2 instance or role is recreated, they must be re-applied (commands in `aws-resources.md`).
4. **RDS subnet group uses default VPC subnets**: pilot scope uses the default VPC. Production hardening would move to dedicated subnets/route tables/NAT.
5. **S3 bucket lifecycle uses fixed prefixes** (`raw-mime/`, `attachments/`): Task 3+ should confirm these match the actual object key layout the mail ingester writes, or adjust.
6. **Write tool unreliable for paths with spaces** in this workspace: all file writes done via shell heredoc as a workaround. Not a task-2 issue but worth flagging for future tasks.
7. **RDS engine lifecycle**: `describe-db-instances` shows `EngineLifecycleSupport: open-source-rds-extended-support`. Acceptable for pilot; monitor for extended-support pricing implications if pilot runs long.

## Report File Path

/c/Users/gamin/Desktop/projs/emails hotels uis/zero/.superpowers/sdd/task-2-report.md
