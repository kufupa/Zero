---
title: EC2 Pilot Safe Reboot and Production Restart Implications
date: 2026-07-09
category: workflow-issues
module: server-pilot deploy
problem_type: workflow_issue
component: development_workflow
severity: medium
applies_when:
  - Planned EC2 maintenance on the single pilot production instance
  - Deciding between reboot-instances vs stop/start vs terminate
  - Staff ask whether the same URL works after a box restart
  - Verifying RDS data safety before any instance action
tags:
  - ec2
  - reboot
  - elastic-ip
  - pm2
  - rds
  - nginx
  - production-restart
---

# EC2 Pilot Safe Reboot and Production Restart Implications

## Context

The EC2-pilot stack runs on one production-shaped EC2 instance (identifiers in [aws-resources.md](../../../apps/server-pilot/deploy/aws-resources.md), region `af-south-1`) with RDS Postgres on a separate managed service (`nava-zero-mail-pilot`). On 2026-07-09 we executed a **soft EC2 reboot only** (`aws ec2 reboot-instances`) after pre-checks, then verified post-boot health via SSM. Staff later asked: *same link after reboot?* and *what actually needs to change for real prod?*

This doc captures restart semantics, what changed (and did not), client impact, and minimal mitigations. Complements [ec2-pilot-autonomous-deploy-and-ssm-gotchas.md](./ec2-pilot-autonomous-deploy-and-ssm-gotchas.md), which covers deploy/bundle/SSM — not box restart.

**Implementation plan:** [docs/plans/2026-07-09-001-feat-ec2-pilot-reboot-resilience-plan.md](../../../docs/plans/2026-07-09-001-feat-ec2-pilot-reboot-resilience-plan.md)

## Guidance

### Three AWS actions — do not confuse them

| Action | RDS data | EBS disk | Public IP (with EIP) | Public IP (no EIP) | PM2 / nginx |
|--------|----------|----------|----------------------|--------------------|-------------|
| **`reboot-instances`** (what we did) | Untouched | Same volume attached | **Same** (`13.247.138.62`) | Usually same | Processes die; must come back via resurrect/startup |
| **`stop-instances` then `start-instances`** | Untouched | Same volume reattached | **Same** if EIP bound | **New ephemeral IP** - bookmarks/tunnels break | Same as reboot |
| **`terminate-instances`** | Untouched (RDS is separate) | Root EBS deleted if `DeleteOnTermination=true` | EIP detached | Instance gone | Everything gone |

**Rule:** For pilot maintenance, use **`reboot-instances` only** unless you explicitly need stop/start (e.g. instance type change). Never terminate the pilot box. Never run RDS stop/reboot/delete when the goal is only EC2 maintenance.

### What we verified on 2026-07-09

Pre-reboot checks (read-only):

```bash
# INSTANCE_ID and AWS_REGION: apps/server-pilot/deploy/ec2-bootstrap.md
export AWS_REGION=af-south-1
export INSTANCE_ID="$INSTANCE_ID"

aws ec2 describe-instances --region "$AWS_REGION" --instance-ids "$INSTANCE_ID" \
  --query 'Reservations[0].Instances[0].{State:State.Name,PublicIp:PublicIpAddress,PrivateIp:PrivateIpAddress}'

aws rds describe-db-instances --region "$AWS_REGION" \
  --db-instance-identifier nava-zero-mail-pilot \
  --query 'DBInstances[0].DBInstanceStatus'
```

Reboot (EC2 only):

```bash
aws ec2 reboot-instances --region "$AWS_REGION" --instance-ids "$INSTANCE_ID"
```

Post-reboot (2026-07-09 operational log): SSM `PingStatus=Online`, RDS still `available`, Elastic IP public address unchanged (documented in `docs/superpowers/EC2-ACCESS.MD`), private IP unchanged.

**Service recovery (2026-07-09 operational log):** PM2 processes were **not** listening immediately after boot (`curl` to `:8788` returned `000`). `pm2 resurrect` (from saved dump) brought core apps back:

| PM2 name | Post-resurrect |
|----------|----------------|
| `http` | online - BE `:8788/health` returns 200 |
| `ai-worker` | online |
| `mailpit` | online (optional sidecar from saved PM2 dump; not in main `pm2.config.cjs`) |
| `worker` | errored when `MAIL_TRANSPORT_MODE` is `real`/`wire` and POP3 env unset (pre-existing config gap, not reboot data loss) |

**Frontend path:** Staff reach the SPA through **nginx on `:443`**, not bare Node on `:3000`. nginx proxies `/api/` and `/health` to `127.0.0.1:8788` per `apps/server-pilot/deploy/nginx.conf`. A post-reboot check against `:3000` can falsely look broken even when prod URL is fine.

### Staff same URL after reboot?

**Yes, if they use the Elastic IP or a DNS name pointing at it** — the URL string does not change after a soft reboot.

**But not instant or guaranteed:**

- **~2–5 minutes downtime** while the OS reboots and services start
- **Hard refresh** may be needed if the browser cached a failed load
- **Re-login possible** if sessions depend on in-process state (Better Auth cookie may survive; verify against your session store)
- **`worker` mail ingest** may stay broken until POP3 env is fixed — FE/BE can look healthy while inbound POP3 worker is errored

**Staff comms template:** *Same URL. Wait ~5 minutes after reboot announcement, hard refresh, re-login if prompted. Report if mail ingest stops.*

### Minimal changes (shipped — use these)

1. **`pm2-startup.sh`** — called from `deploy-ec2.sh` after `pm2 save`; installs `pm2-ubuntu.service`.
2. **`post-boot-smoke.sh`** + systemd oneshot — nginx + `:8788` + `:443`.
3. **Fixture worker guard** — `deploy-ec2.sh` deletes `worker` when `MAIL_TRANSPORT_MODE=fixture`.
4. **Prefer `ops-restart.sh`** over box reboot for code/env refresh; use **`ops-reboot.sh`** for soft OS reboot + smoke.

### Do not need for plain reboot (already in place)

- New DNS or IP — Elastic IP holds `13.247.138.62`
- RDS migration or backup — separate service; reboot does not touch it
- ALB / second instance - valuable later for zero-downtime, not required for "same link works"

## Why This Matters

Single-EC2 pilot means **every reboot is full-stack downtime** for staff on the FE. Elastic IP removes the "new IP broke my bookmark" failure mode, but **does not remove downtime or PM2 boot fragility**. Confusing reboot with stop/start can accidentally change public IP (without EIP) or lead someone to touch RDS when only the app box needed restart.

The `:3000` vs `:443` distinction matters for operators: health checks and war-room tunnels often target dev ports; production staff use nginx TLS on 443.

## When to Apply

- Before any planned EC2 maintenance window
- When onboarding staff or IT on "will my link break?"
- When writing runbooks for autonomous agents rebooting the pilot box
- When post-reboot health looks failed — check PM2 resurrect path before assuming deploy corruption

## Examples

### Safe reboot runbook (operator)

```bash
# 1. Announce maintenance window to staff
# 2. Pre-check (read-only) — optional
aws ec2 describe-instances --region af-south-1 --instance-ids "$INSTANCE_ID" \
  --query 'Reservations[0].Instances[0].State.Name'
aws rds describe-db-instances --region af-south-1 \
  --db-instance-identifier nava-zero-mail-pilot \
  --query 'DBInstances[0].DBInstanceStatus'

# 3. Soft reboot + wait SSM + post-boot smoke (primary)
bash apps/server-pilot/deploy/ops-reboot.sh

# App bounce only (no OS reboot):
# bash apps/server-pilot/deploy/ops-restart.sh
```

### What did not work (session history)

- Long `ssm-run-command.sh` health polls **hung** on Windows before reboot — proceeded after simpler pre-checks
- Inline JSON for `aws ssm send-command --parameters` **broke on nested quotes** — use `file://` params written via Node (`session history`)
- Workspace path with spaces broke some `file://` paths — use temp path without spaces (e.g. `/c/Users/gamin/AppData/Local/Temp/`)

## Related

- [ec2-pilot-autonomous-deploy-and-ssm-gotchas.md](./ec2-pilot-autonomous-deploy-and-ssm-gotchas.md) — deploy loop, bundle sync, SSM UTF-8, `pm2 save` in deploy
- [2026-07-09-001-feat-ec2-pilot-reboot-resilience-plan.md](../../../docs/plans/2026-07-09-001-feat-ec2-pilot-reboot-resilience-plan.md) — implementation plan for PM2 boot + smoke + worker guard
- [apps/server-pilot/deploy/aws-resources.md](../../../apps/server-pilot/deploy/aws-resources.md) — instance/RDS identifiers
- [apps/server-pilot/deploy/ec2-bootstrap.md](../../../apps/server-pilot/deploy/ec2-bootstrap.md) — SSM access, NVM bootstrap
- [CONCEPTS.md](../../../CONCEPTS.md) — deploy/ops vocabulary
