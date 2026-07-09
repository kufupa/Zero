# EC2 Pilot Ops Scripts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **REQUIRED SUB-SKILL:** overnight-autonomous-execution (mandate below is binding).
>
> **Execution posture:** Overnight autonomous — user unavailable; implement-fix-loop until done criteria green.

**Goal:** Three laptop ops scripts (`ops-deploy`, `ops-restart`, `ops-reboot`) plus PM2 boot survival, post-boot smoke, fixture worker guard, http restart parity, and living docs that teach the three scripts first.

**Architecture:** Thin laptop wrappers orchestrate existing sync/SSM/on-box deploy guts. `deploy-ec2.sh` gains pm2-startup + fixture worker delete. Systemd oneshot runs post-boot smoke after `pm2-ubuntu.service`.

**Tech Stack:** bash, PM2, systemd, AWS SSM/EC2 CLI, vitest string-contract tests

## Global Constraints

- No force-push main, no `--no-verify`, no destructive git
- No ALB/EIP/RDS resource changes; no app `src/` changes except deploy config
- Migrate only via `ops-deploy.sh --migrate` (default off)
- Historical dated plans/handoffs are archive — do not rewrite
- Caveman ultra for orchestrator + subagents

## Overnight Autonomous Execution Mandate

**User granted full autonomy.** No blocking questions overnight. No manual login. No "which approach?" pause.

### Communication

- Orchestrator + every subagent: **Respond `/caveman ultra`. Technical terms exact.**

### AWS / infra (use freely)

| Resource | ID / path |
|----------|-----------|
| EC2 | `i-008f737974a9ba9b3` (`af-south-1`) |
| RDS | `nava-zero-mail-pilot` (Postgres 16) |
| S3 | `nava-zero-mail-845242190536-af-south-1` |
| Repo on EC2 | `/home/ubuntu/repos/zero` |
| **Primary deploy** | `apps/server-pilot/deploy/ops-deploy.sh` (`--migrate` when schema) |
| **Primary app bounce** | `apps/server-pilot/deploy/ops-restart.sh` |
| **Primary box reboot** | `apps/server-pilot/deploy/ops-reboot.sh` |
| Guts (fallback/debug) | `sync-ec2-git-bundle.sh`, `deploy-ec2.sh`, `ssm-run-command.sh` |

**Allowed:** ops wrappers, bundle sync, deploy, migrate (via `ops-deploy --migrate` or explicit SSM), seed (no `--rotate` unless fix requires), SSM remote tests, PM2 logs, health curl, RDS vitest on EC2, one staff-aware `ops-reboot.sh` drill after PM2 startup lands.

**Forbidden:** force-push main, `--no-verify`, destructive git, IT Exchange/VPN/real mail creds, stop/start/terminate EC2 when soft reboot suffices, RDS stop/reboot/delete.

### RCA loop (mandatory on any red)

FAIL → reproduce → root cause (file:line) → fix → test → commit → resume. Do not stop at first failure.

### Divergence authority

Better path to done criteria → take it. Log in handoff report.

### Done criteria

- [ ] `ops-deploy.sh`, `ops-restart.sh`, `ops-reboot.sh` exist and pass `deploy-config.test.ts` contracts
- [ ] `pm2-ubuntu.service` installable via deploy; `http` has bounded autorestart; fixture mode deletes `worker` before save
- [ ] `post-boot-smoke.sh` + systemd oneshot in place
- [ ] Living docs/skills teach three ops scripts as primary (R11 checklist)
- [ ] Local `deploy-config.test.ts` green
- [ ] Handoff under `docs/superpowers/plans/handoff-reports/` if overnight run ships to EC2

## Execution Mode

Autonomous overnight — no user checkpoint. REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Do not ask "which approach?"

## File map

| File | Role |
|------|------|
| `apps/server-pilot/deploy/pm2-startup.sh` | Idempotent pm2 startup + smoke unit install |
| `apps/server-pilot/deploy/pm2-boot.sh` | NVM + env + resurrect/startOrReload fallback |
| `apps/server-pilot/deploy/post-boot-smoke.sh` | nginx + :8788 + :443 + pm2 http online |
| `apps/server-pilot/deploy/nava-post-boot-smoke.service` | systemd oneshot After=pm2-ubuntu |
| `apps/server-pilot/deploy/ops-deploy.sh` | laptop: sync → optional migrate → deploy → health |
| `apps/server-pilot/deploy/ops-restart.sh` | laptop: pm2 startOrReload + health |
| `apps/server-pilot/deploy/ops-reboot.sh` | laptop: reboot-instances → wait SSM → smoke |
| `apps/server-pilot/deploy/deploy-ec2.sh` | call startup; fixture worker delete |
| `apps/server-pilot/deploy/pm2.config.cjs` | http restart bounds |
| `apps/server-pilot/tests/deploy-config.test.ts` | string contracts |

---

### Task 1: Tests first (ops + boot contracts)

**Files:**
- Modify: `apps/server-pilot/tests/deploy-config.test.ts`
- Modify: `apps/server-pilot/deploy/pm2.config.cjs`

- [ ] **Step 1: Extend deploy-config tests** for http max_restarts, deploy-ec2 pm2-startup + fixture worker delete, smoke :8788/:443, ops scripts calling sync/ssm/deploy/reboot
- [ ] **Step 2: Run tests — expect FAIL** (scripts missing)
- [ ] **Step 3: Add http autorestart bounds to pm2.config.cjs**
- [ ] **Step 4: Commit** `test: deploy-config contracts for ops scripts and http restart`

### Task 2: PM2 startup + boot + smoke + deploy hooks

**Files:**
- Create: `pm2-startup.sh`, `pm2-boot.sh`, `post-boot-smoke.sh`, `nava-post-boot-smoke.service`
- Modify: `deploy-ec2.sh`

- [ ] **Step 1: Write scripts** (idempotent startup, boot fallback, smoke with 3x retry, systemd unit)
- [ ] **Step 2: Wire deploy-ec2.sh** — after env source, if fixture delete worker; after pm2 save call pm2-startup.sh
- [ ] **Step 3: Run deploy-config tests — expect more green**
- [ ] **Step 4: Commit** `feat: pm2 startup, boot smoke, fixture worker guard`

### Task 3: Laptop ops wrappers

**Files:**
- Create: `ops-deploy.sh`, `ops-restart.sh`, `ops-reboot.sh`

- [ ] **Step 1: Write three wrappers**
- [ ] **Step 2: Run full deploy-config.test.ts — PASS**
- [ ] **Step 3: Commit** `feat: ops-deploy, ops-restart, ops-reboot entrypoints`

### Task 4: Living docs sweep

**Files:** ec2-bootstrap.md, EC2-ACCESS.MD, ec2-pilot-autonomous-deploy-and-ssm-gotchas.md, ec2-pilot-safe-reboot-and-prod-restart.md, deferred-real-mail-readiness.md, it-handoff-runbook.md, CONCEPTS.md, overnight-autonomous-zero/SKILL.md, docs/solutions/README.md

- [ ] **Step 1: Add Day-to-day ops table** to each living doc; demote multi-step loops
- [ ] **Step 2: Commit** `docs: teach ops-deploy/restart/reboot as primary EC2 ops`

### Task 5: Ship to EC2 + handoff

- [ ] **Step 1:** `ops-deploy.sh` (or sync+SSM deploy if wrappers not yet on box — chicken/egg: sync first then remote deploy)
- [ ] **Step 2:** Verify `systemctl is-enabled pm2-ubuntu`; run post-boot-smoke via SSM
- [ ] **Step 3:** Optional `ops-reboot.sh` drill if safe
- [ ] **Step 4:** Write `docs/superpowers/plans/handoff-reports/2026-07-09-ec2-pilot-ops-scripts.md`
