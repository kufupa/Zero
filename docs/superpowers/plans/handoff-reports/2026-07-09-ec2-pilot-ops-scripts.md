# Handoff: EC2 pilot ops scripts (2026-07-09)

**Commit:** `afc75360` — `feat: EC2 pilot ops-deploy/restart/reboot + PM2 boot survival`  
**Branch:** `EC2-pilot`  
**Plan:** `docs/superpowers/plans/2026-07-09-ec2-pilot-ops-scripts.md`

## Done criteria

| Criterion | Status |
|-----------|--------|
| `ops-deploy.sh` / `ops-restart.sh` / `ops-reboot.sh` + deploy-config contracts | PASS (18 tests) |
| `pm2-ubuntu.service` installable via deploy; `http` bounded autorestart; fixture deletes `worker` | PASS on EC2 |
| `post-boot-smoke.sh` + systemd oneshot | PASS on EC2 |
| Living docs teach three scripts as primary | PASS |
| Local `deploy-config.test.ts` green | PASS |
| Handoff | this file |

## EC2 verify (post `ops-deploy.sh`)

```
pm2-ubuntu: enabled
units: /etc/systemd/system/pm2-ubuntu.service + nava-post-boot-smoke.service
pm2: http:online ai-worker:online (no worker — fixture guard)
post-boot-smoke: PASS nginx + :8788 + :443
```

## Day-to-day (operators)

| Need | Command |
|------|---------|
| Ship code | `bash apps/server-pilot/deploy/ops-deploy.sh` |
| Ship + migrate | `bash apps/server-pilot/deploy/ops-deploy.sh --migrate` |
| Bounce apps | `bash apps/server-pilot/deploy/ops-restart.sh` |
| Soft reboot + smoke | `bash apps/server-pilot/deploy/ops-reboot.sh` |

## Deferred

- Full `ops-reboot.sh` drill — announce to staff first (same URL, ~2–5 min gap). PM2 startup + smoke already proven via deploy path; reboot drill is operational confirmation only.
- `mailpit` still online on box from prior gate work — not in fixture prod dump from this deploy; clean with `pm2 delete mailpit` if undesired.

## Crash recovery note

- **Process crash** while box up: PM2 autorestart (`http` now bounded like workers).
- **OS reboot:** systemd `pm2-ubuntu` resurrects dump — no manual `pm2 resurrect`.
