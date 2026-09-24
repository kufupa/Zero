---
title: EC2 Pilot ops-deploy, ops-restart, and ops-reboot Entry Points
date: 2026-07-10
last_updated: 2026-08-26
category: workflow-issues
module: server-pilot deploy
problem_type: workflow_issue
component: development_workflow
severity: medium
applies_when:
  - Deploying or syncing code to the EC2 pilot from a laptop
  - Bouncing PM2 apps without an OS reboot
  - Soft-rebooting the pilot instance and verifying post-boot health
  - "MAIL_TRANSPORT_MODE=fixture and a saved PM2 dump still lists worker"
  - Teaching operators which script is primary vs legacy deploy-ec2 paths
  - Asserting always-on hotel OpenVPN health on deploy/reboot without restaging secrets
symptoms:
  - No single laptop entrypoint for sync+migrate+deploy+health
  - PM2 processes missing after reboot until manual resurrect
  - Fixture mode reboot dump resurrects errored POP3 worker
  - http PM2 process lacked autorestart parity with workers
  - Docs still pointed at ad-hoc deploy-ec2/SSM instead of ops-*
root_cause: missing_tooling
resolution_type: tooling_addition
related_components:
  - tooling
  - email_processing
  - background_job
  - documentation
tags:
  - ec2-pilot
  - ops-deploy
  - ops-restart
  - ops-reboot
  - pm2-startup
  - post-boot-smoke
  - fixture-mail
  - server-pilot
---

# EC2 Pilot ops-deploy, ops-restart, and ops-reboot Entry Points

## Context

EC2-pilot day-to-day ops were a multi-step, easy-to-get-wrong chain. Shipping code meant remembering `sync-ec2-git-bundle.sh` then `ssm-run-command.sh` then `deploy-ec2.sh`, then hoping health checks passed. Soft reboot was worse: `aws ec2 reboot-instances`, wait for SSM, manually `pm2 resurrect`, curl a few ports, and hope nginx and `:8788` came back. That loop left real gaps after the 2026-07-09 soft reboot session:

- PM2 did not reliably survive reboot. Nothing installed `pm2 startup` / `pm2-ubuntu.service`, so recovery depended on a human running `pm2 resurrect` over SSM.
- No post-boot smoke. Operators probed ad hoc (`:3000` vs staff path `:443`, missing nginx checks). Failures were silent until someone noticed.
- Fixture POP3 `worker` errored in the saved dump. With `MAIL_TRANSPORT_MODE=fixture` (or real/wire without POP3 env), `worker` sat errored and polluted `pm2 status` / restart loops.
- `http` lacked bounded autorestart. Workers had `autorestart` / `min_uptime` / `max_restarts`; the API process did not.

Related prior compounds cover adjacent angles: soft-reboot *safety* (EIP, RDS untouched, which AWS action to use) in [ec2-pilot-safe-reboot-and-prod-restart.md](./ec2-pilot-safe-reboot-and-prod-restart.md), and deploy/SSM gotchas in [ec2-pilot-autonomous-deploy-and-ssm-gotchas.md](./ec2-pilot-autonomous-deploy-and-ssm-gotchas.md). This learning is the **operator front door + unattended recovery** layer: three laptop scripts, systemd PM2 boot, post-boot smoke, fixture worker guard, and `http` parity.

Plans and handoff: `docs/plans/2026-07-09-001-feat-ec2-pilot-reboot-resilience-plan.md`, `docs/superpowers/plans/2026-07-09-ec2-pilot-ops-scripts.md`, `docs/superpowers/plans/handoff-reports/2026-07-09-ec2-pilot-ops-scripts.md`. Verified on EC2 after `ops-deploy.sh`: `pm2-ubuntu` enabled, smoke PASS, `http` + `ai-worker` online, `worker` absent in fixture.

(session history) Older sessions covered EC2/PM2 deploy loops but not `ops-*` as primary - those entrypoints originated in this arc after the soft-reboot compound.

## Guidance

### Primary operator interface - three laptop scripts

Teach and use these as the default loop. Run from repo root on a laptop with AWS credentials that can SSM the pilot instance (`AWS_REGION` / `INSTANCE_ID` default in scripts; override if needed).

```bash
# Ship new code (sync bundle then on-box deploy then health)
bash apps/server-pilot/deploy/ops-deploy.sh

# Ship + run db migrate before deploy
bash apps/server-pilot/deploy/ops-deploy.sh --migrate

# Assets only — rebuild/sync without bouncing PM2 (online http OK)
bash apps/server-pilot/deploy/ops-deploy.sh --quiesced

# Bounce PM2 apps without OS reboot or rebuild
bash apps/server-pilot/deploy/ops-restart.sh

# Soft reboot EC2 then wait SSM Online then post-boot smoke
bash apps/server-pilot/deploy/ops-reboot.sh
```

| Need | Command |
|------|---------|
| Ship code | `ops-deploy.sh` |
| Ship + migrate | `ops-deploy.sh --migrate` |
| Assets only (http stays up) | `ops-deploy.sh --quiesced` |
| Bounce apps only | `ops-restart.sh` |
| Soft reboot + verify | `ops-reboot.sh` |

**Guts stay for debug only** - do not teach as the default day-to-day loop:

- `sync-ec2-git-bundle.sh`
- `deploy-ec2.sh`
- `ssm-run-command.sh`

Wrappers orchestrate those guts (thin wrappers, thick guts). Migrate is opt-in (`--migrate`); never implied by a plain deploy.

**Migration window semantics (`--migrate`):**

- `ops-deploy.sh --migrate` order is: sync bundle → **migrate against the still-running old PM2 processes** (SSM: source `.env.production`, `pnpm db:migrate` from `apps/server-pilot`) → on-box deploy (rebuild + PM2 reload) → health. Migrations run from `apps/server-pilot/`, so the journal is `apps/server-pilot/drizzle/meta/_journal.json`.
- This is a **rolling window, not a stop-the-world quiesce**: old code keeps serving between migrate and PM2 restart. It is safe for additive/backward-compatible schema changes only.
- Safe under this flow: additive columns/tables, nullable columns, backfills that leave old-code invariants intact (e.g. `0019_outbound_smtp_attempt_fence.sql` adds two nullable timestamp columns and backfills them; old rows keep working).
- NOT safe: renames/drops, tightening NOT NULL on existing columns without default+backfill, or anything where old code writing old-shaped rows corrupts new expectations. For those, plan a stop-the-world window (announce gap, deploy with PM2 stopped around migrate) and get explicit sign-off first.
- `--quiesced` is unrelated to migrations: it means assets-only (install/build/sync, no PM2 mutation, no HTTP health) while current processes stay online. Do not use it as a "maintenance mode" for breaking migrations.
- Fence-specific note: after deploying a fence-style change, stale `sending` queue rows are fenced by `smtp_attempted_at` and will NOT auto-retry; verify/requeue deliberately if any existed pre-deploy.

**VPN on every ship:**

### Auto recovery after crash / reboot

Distinguish three failure modes:

1. **Process crash while the box is up** - PM2 autorestart brings the process back (bounded).
2. **OpenVPN process crash** - systemd drop-in `Restart=on-failure` on `openvpn-client@nava` (SIGKILL/crash recovers; plain SIGTERM does not — see VPN durability doc).
3. **OS reboot** - systemd `pm2-ubuntu` resurrects the saved dump; `openvpn-client@nava` comes back via WantedBy; no manual `pm2 resurrect` / VPN reinstall.

Install and keep that path healthy:

- **`pm2-startup.sh`** - idempotent: installs systemd `pm2-ubuntu` (via `pm2 startup` sudo line if missing), `pm2 save`, enables `nava-post-boot-smoke.service`.
- **`pm2-boot.sh`** - NVM-safe PATH; `pm2 resurrect`, with `startOrReload` + `pm2 save` fallback if resurrect fails.
- **`nava-post-boot-smoke.service`** - `After=`/`Wants=` `openvpn-client@nava.service` (not `Requires=`).
- **`post-boot-smoke.sh`** - retries checks for nginx active, `http://127.0.0.1:8788/health`, `:443` (`/health` or `/`), PM2 `http` online, then waits briefly for VPN and runs **HARD** `vpn-health-assert.sh`. PASS line includes `VPN_HARD_OK`. Logs under `/var/log/nava-post-boot-smoke.log`.
- **`deploy-ec2.sh`** - after PM2 save, calls `pm2-startup`; in fixture mode deletes `worker` before save so the dump stays clean.
- **`pm2.config.cjs`** - `http` matches workers: `autorestart: true`, `min_uptime: 10_000`, `max_restarts: 10`.

Staff URL remains nginx on `:443` (EIP), not bare Node on `:3000`. Smoke and health checks must prefer `:8788` and `:443`.

### Docs contract

Living docs (ec2-bootstrap Day-to-day ops table, EC2-ACCESS, CONCEPTS Pilot ops entrypoints, overnight-autonomous-zero skill, etc.) point operators at the three `ops-*.sh` scripts first. Multi-step sync/SSM/deploy chains are demoted to internals.

### Verification contract

- Local: `deploy-config.test.ts` asserts script contracts (entrypoints exist, wiring expectations).
- On EC2 after deploy: `pm2-ubuntu` enabled; units present; smoke PASS including `VPN_HARD_OK`; `http` + `ai-worker` online; `worker` absent when fixture; `openvpn-client@nava` active with HOST_ROUTE still via VPC gateway.

## Why This Matters

Without a single front door, every overnight or handoff agent reinvents the sync then SSM then deploy then hope sequence. Mistakes cost real downtime: forgotten migrate, skipped health, or a soft reboot that leaves `:8788` dead until someone SSMs in and resurrects by hand.

Without systemd PM2 startup + post-boot smoke, soft reboot is a hope-based operation. The 2026-07-09 session proved EIP and RDS survive; it also proved apps do not come back alone. Unattended recovery is the difference between "reboot and walk away" and "reboot and page yourself."

Without the fixture `worker` guard, every save/resurrect reintroduces an errored process that looks like a reboot failure. Without `http` autorestart parity, API crashes behave worse than worker crashes and confuse triage.

Teaching guts as the default also fights documentation: runbooks grow long, skills copy fragile chains, and the next compound documents the same confusion again. Three scripts + boot survival + smoke close that loop.

## When to Apply

- Day-to-day EC2-pilot ship, bounce, or soft-reboot from a laptop.
- After any change that touches `deploy-ec2.sh`, PM2 dump, or systemd units - re-run `ops-deploy.sh` so `pm2-startup` stays installed and the dump is saved clean.
- Before planned maintenance soft reboot - prefer `ops-reboot.sh` (announce ~2-5 min staff gap; same EIP URL).
- When writing or updating living docs, skills, or overnight agents that touch pilot ops - cite the three scripts, not the guts chain.
- When diagnosing "box up but apps dead" after reboot - check `systemctl status pm2-ubuntu`, smoke log, then `pm2 status`; do not start with ad-hoc resurrect unless startup units are missing.
- When `worker` / `ai-worker` show `errored` or `online` with **empty** out logs after a real-mail or deploy flip - treat as possible ESM entry / unref-sleep exit, not only env/dump issues ([pm2-esm-is-cli-entry-and-unref-sleep.md](../runtime-errors/pm2-esm-is-cli-entry-and-unref-sleep.md)); confirm poll lines in out logs, not just `pm2 status`.
- When fixture mode is active - expect no `worker` in PM2; do not "fix" by starting POP3 worker without activate/wire paths.
- Before/after Playwright U9 real-mail gate - use `ops-restart.sh` to bounce `UNDO_SEND_SECONDS` between `0` (gate) and `30` (product); see env bounce section above.
- Not for: RDS stop/start, EIP changes, terminate-instance, ALB/multi-instance (out of scope; see [safe-reboot compound](./ec2-pilot-safe-reboot-and-prod-restart.md) for AWS action semantics).

## Examples

### Example 1 - Ship code (before / after)

**Before (fragile multi-step):**

```bash
bash apps/server-pilot/deploy/sync-ec2-git-bundle.sh
bash apps/server-pilot/deploy/ssm-run-command.sh \
  'export NVM_DIR=...; cd /home/ubuntu/repos/zero && bash apps/server-pilot/deploy/deploy-ec2.sh'
bash apps/server-pilot/deploy/ssm-run-command.sh 'curl -fsS http://127.0.0.1:8788/health'
# Optional migrate remembered separately - often forgotten
```

**After (primary interface):**

```bash
bash apps/server-pilot/deploy/ops-deploy.sh
# or with schema changes:
bash apps/server-pilot/deploy/ops-deploy.sh --migrate
```

Outcome on verified EC2 run: deploy installs/enables `pm2-ubuntu` + smoke unit; health curl succeeds; VPN HARD assert prints `VPN_HARD_OK`; fixture dump has `http` + `ai-worker` only.

### Example 2 - Soft reboot (before / after)

**Before:**

```bash
aws ec2 reboot-instances --region af-south-1 --instance-ids "$INSTANCE_ID"
# wait... poll SSM manually...
bash apps/server-pilot/deploy/ssm-run-command.sh 'pm2 resurrect'
bash apps/server-pilot/deploy/ssm-run-command.sh 'curl -fsS http://127.0.0.1:8788/health'
# nginx / :443 often unchecked; :3000 false-negative common
```

**After:**

```bash
bash apps/server-pilot/deploy/ops-reboot.sh
# reboot-instances then wait SSM Online then post-boot-smoke.sh
```

Expected: systemd resurrects dump; smoke asserts nginx + `:8788` + `:443` + `http` online + `VPN_HARD_OK`. No manual resurrect / VPN reinstall in the happy path.

### Example 3 - Bounce apps without reboot (before / after)

**Before:** Hand-built SSM one-liner with NVM, env source, `pm2 startOrReload`, maybe forgetting fixture `worker` delete or `pm2 save`.

**After:**

```bash
bash apps/server-pilot/deploy/ops-restart.sh
```

Fixture path reloads `http` + `ai-worker` only, deletes `worker`, saves, curls health. Real/wire path reloads full config.

### Env bounce for real-mail parity and U9 gate

On live pilot (`MAIL_TRANSPORT_MODE=real`), `ops-restart.sh` is the safe way to pick up `.env.production` changes without a full rebuild. Two keys operators flip around the Playwright U9 gate:

| Key | Product steady-state | U9 gate only |
|-----|---------------------|--------------|
| `UNDO_SEND_SECONDS` | `30` | `0` (gate script refuses non-zero) |
| `BETTER_AUTH_URL` | `https://nava.legacy.local` | same (must match SPA / `PLAYWRIGHT_BASE_URL`) |

Cycle: set `UNDO_SEND_SECONDS=0` → `ops-restart.sh` → run `playwright-real-mail-ui-gate.sh` → restore `UNDO_SEND_SECONDS=30` → `ops-restart.sh` again. Confirm PM2 process env matches the file (`pm2 env` / gate health), not just the on-disk file.

`write-ec2-env.sh` and `activate-real-mail.sh` can rewrite `.env.production` — re-assert `BETTER_AUTH_URL` and `UNDO_SEND_SECONDS` after any full env regen. Prefer surgical SSM sed when only gate keys need fixing and POP3/SMTP secrets must stay.

Full parity context: [live-pilot-production-parity-real-mail.md](../architecture-patterns/live-pilot-production-parity-real-mail.md).

### Example 4 - Process crash vs OS reboot

**Before mental model:** "Something died - reboot the box" or "run resurrect for everything."

**After:**

| Failure | Recovery |
|---------|----------|
| `http` / worker process crash, box still up | PM2 autorestart (`min_uptime` 10s, `max_restarts` 10) - no OS reboot |
| OpenVPN crash (SIGKILL / unclean exit) | `openvpn-client@nava` `Restart=on-failure` drop-in; prove with `kill -9`, not SIGTERM |
| Soft OS reboot | `pm2-ubuntu` + `pm2-boot` resurrect; OpenVPN unit restarts; `nava-post-boot-smoke` oneshot reports PASS/FAIL including `VPN_HARD_OK` |

### Example 5 - Fixture worker in dump (before / after)

**Before:** Saved dump included `worker` then post-resurrect `errored` (POP3 env unset in fixture) then looked like reboot regression.

**After:** `deploy-ec2.sh` / `ops-restart.sh` in fixture mode `pm2 delete worker` before save. Verified: `pm2` shows `http:online` `ai-worker:online`, no `worker`.

## Related

- [live-pilot-production-parity-real-mail.md](../architecture-patterns/live-pilot-production-parity-real-mail.md) — U9 gate env cycle (`UNDO_SEND_SECONDS` 0↔30) via `ops-restart.sh`
- [pm2-esm-is-cli-entry-and-unref-sleep.md](../runtime-errors/pm2-esm-is-cli-entry-and-unref-sleep.md) - PM2 `online`/`errored` + empty logs: ProcessContainerFork `isCliEntry` + ref'd poll sleep (not dump/ops alone)
- [ec2-pilot-nava-openvpn-always-on-health.md](./ec2-pilot-nava-openvpn-always-on-health.md) - always-on OpenVPN Restart drop-in, HARD/SOFT assert, assert-don't-restage
- [ec2-pilot-safe-reboot-and-prod-restart.md](./ec2-pilot-safe-reboot-and-prod-restart.md) - soft-reboot safety (EIP, RDS, same URL); complementary angle
- [ec2-pilot-autonomous-deploy-and-ssm-gotchas.md](./ec2-pilot-autonomous-deploy-and-ssm-gotchas.md) - deploy/SSM/bundle guts; Examples already prefer `ops-*`
- [CONCEPTS.md](../../../CONCEPTS.md) - Bundle sync, Post-boot smoke, Always-on OpenVPN, VPN HARD/SOFT assert, HOST_ROUTE
- [EC2-ACCESS.MD](../../superpowers/EC2-ACCESS.MD) - living day-to-day ops table
- Plans: `docs/plans/2026-07-09-001-feat-ec2-pilot-reboot-resilience-plan.md`, `docs/superpowers/plans/2026-07-09-ec2-pilot-ops-scripts.md`
- Handoff: `docs/superpowers/plans/handoff-reports/2026-07-09-ec2-pilot-ops-scripts.md`
- Refresh candidates (still teach multi-step as primary in places): `ec2-pilot-post-audit-tier5-execution.md`, `docs/server-pilot-ai.md`
