---
title: Remote Admin 502 from Legacy-Only Nginx Deploy Wipe
date: 2026-08-20
category: workflow-issues
module: server-pilot deploy / remote admin
problem_type: workflow_issue
component: development_workflow
severity: high
applies_when:
  - Deploying EC2 pilot while remote-admin ALB host rule is active
  - nginx.conf on the deploy branch lacks the private :8443 remote plane
  - ops-deploy / deploy-ec2 installs sites-available from repo nginx.conf
symptoms:
  - https://nava-admin.trynava.io returns ALB 502
  - Target group nava-remote-admin shows Target.FailedHealthChecks on :8443
  - remote-http :8789 still healthy; LAN nava.legacyhotels.co.za still up
  - ss shows no listener on 172.31.12.112:8443 after deploy
root_cause: one_sided_deploy_source
resolution_type: fail_closed_gate_plus_recovery
related_components:
  - tooling
  - nginx
  - alb
  - remote-admin
tags:
  - nava-admin
  - dual-plane
  - nginx
  - alb
  - ops-deploy
  - 502
---

# Remote Admin 502 from Legacy-Only Nginx Deploy Wipe

## Context

`nava-admin.trynava.io` terminates TLS at `nava-remote-admin-alb` and forwards host-matched HTTPS to EC2 private `172.31.12.112:8443`. Nginx on that socket proxies to `remote-http` on `127.0.0.1:8789`. Hotel LAN stays on `:80/:443` → `http` `:8788`.

On 2026-08-20 ~10:51 UTC a normal deploy installed a **legacy-only** `apps/server-pilot/deploy/nginx.conf` (LAN listeners only). That wiped the remote `:8443` vhosts. `remote-http` kept running, so the outage looked like “ALB broken” while the real break was **missing Nginx plane**.

## Root cause

One deploy source, two planes. Candidate without remote contracts still passed install/reload. ALB host-forward stayed active → health checks to dead `:8443` → `Target.FailedHealthChecks` → public 502. Not PM2 death, not RDS, not WAF.

## Permanent fix

1. Keep **one** `nginx.conf` with both planes (no companion site).
2. `deploy-ec2.sh` calls `assert_dual_plane_nginx_candidate` **before** transactional install/reload. Missing LAN or remote markers → refuse; prior site untouched.
3. Post-reload dual probes already required by feature tip (`:8788`, `:8789`, legacy `:443`, private `:8443`).
4. Ship from a branch that merges live mail tip + `feat/remote-admin-alb` + the refuse gate (`fix/dual-plane-deploy`). Do not deploy main-workspace legacy-only `ops-deploy` while remote is live.

Contract tests: `tests/deploy-config.test.ts` scenarios `legacy-only` / `remote-only`.

## One-time recovery (verified 2026-08-20)

1. **R0 fail-closed:** delete only the priority-10 host-forward rule on the remote ALB HTTPS listener. Default stays fixed 404. Public becomes honest 404 instead of 502. LAN untouched.
2. Deploy dual-plane tip via worktree:
   - `GIT_BRANCH=fix/dual-plane-deploy bash apps/server-pilot/deploy/ops-deploy.sh`
3. Prove private planes while rule is off: loopback `:8788`/`:8789`, private `:8443` Host `nava-admin`, LAN health.
4. Recreate exact host-forward (priority 10, host `nava-admin.trynava.io` → TG `nava-remote-admin`). Wait `target-in-service`. Public root → 200 nginx.

Verified tip on box: `15039919` (My folders tip merged so deploy did not roll back mail). Gate present in on-box `deploy-ec2.sh`. Public + LAN + `:8443` all 200 after restore.

## Gotchas

- **Do not** full-bundle-deploy a tip that is behind live box HEAD. Merge box tip into the dual-plane branch first (this recovery merged `b127fdcd`).
- After R0, ALB reports target `unused` (`Target.NotInUse`), not `healthy`. `classifyRemoteAdminLifecycle` then returns `unknown`, so `remote-admin-cutover.sh restore` (expects `rollback`) will refuse. Recreate the exact host rule with `aws elbv2 create-rule` (same shape as cutover), then wait healthy. Cutover `restore` is fine only when the classifier already sees `rollback` (healthy target + no non-default rules)—AWS often will not stay in that shape after rule delete.
- `ops-deploy` with `REMOTE_ADMIN_LIFECYCLE_MODE=auto` after R0 can exit non-zero on `remoteLifecycleStateKnown` even when dual-plane health curls passed. Treat that as expected during the window with no host rule; confirm planes via SSM curls, then restore the rule.
- Reloading Nginx can blip. Guarantee is **never leave a plane missing**, not zero-downtime forever.

## Related

- Architecture boundary: [nava-remote-admin-alb-companion.md](../architecture-patterns/nava-remote-admin-alb-companion.md)
- Ops front door: [ec2-pilot-ops-deploy-restart-reboot.md](./ec2-pilot-ops-deploy-restart-reboot.md)
