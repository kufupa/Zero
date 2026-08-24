---
title: Legacy-only nginx deploy wiped remote :8443 and 502'd nava-admin ALB
date: 2026-08-20
last_updated: 2026-08-20
category: workflow-issues
module: server-pilot deploy / remote admin
problem_type: workflow_issue
component: development_workflow
severity: critical
applies_when:
  - "Deploying or reloading apps/server-pilot/deploy/nginx.conf on EC2 pilot while ALB host rule for nava-admin.trynava.io is active"
  - "Candidate nginx site must keep both LAN (legacy :80/:443→8788) and remote (:8443→8789) planes"
  - "Recovering remote-admin ALB 502 when LAN hostname still serves and target fails health on :8443"
  - "Cutover restore after deleting ALB host-forward rule leaves target unused (not healthy) and classifier unknown"
symptoms:
  - "nava-admin.trynava.io returned ALB HTTP 502 (DNS→nava-remote-admin-alb→TG nava-remote-admin:8443)"
  - "Target unhealthy with Target.FailedHealthChecks; no listener on instance private IP:8443"
  - "remote-http stayed healthy on 127.0.0.1:8789 while public remote plane was down"
  - "LAN nava.legacyhotels.co.za stayed up after legacy-only nginx install wiped remote vhosts"
root_cause: missing_workflow_step
resolution_type: workflow_improvement
related_components:
  - tooling
tags:
  - remote-admin
  - nginx
  - dual-plane
  - alb-502
  - deploy-ec2
  - nava-admin
  - assert-dual-plane
  - cutover-lifecycle
---

# Legacy-only nginx deploy wiped remote :8443 and 502'd nava-admin ALB

## Context

Pilot EC2 hosts **two** ingress planes in one Nginx site:

| Plane | Public edge | Nginx listen | Upstream |
| --- | --- | --- | --- |
| Legacy hotel | VPN / `nava.legacyhotels.co.za` | `443 ssl` | `127.0.0.1:8788` |
| Remote admin | ALB → `nava-admin.trynava.io` | `172.31.12.112:8443` | `127.0.0.1:8789` |

Architecture boundary lives in [nava-remote-admin-alb-companion.md](../architecture-patterns/nava-remote-admin-alb-companion.md): remote TLS terminates at the ALB; EC2 `:8443` is ALB-only.

**Incident (observed 2026-08-20 ops session):** a deploy installed a **legacy-only** Nginx candidate. That wiped the remote `listen 172.31.12.112:8443` / `server_name nava-admin.trynava.io` plane. ALB health checks against the fixed private target failed → target unhealthy → public `nava-admin.trynava.io` **502**. Meanwhile `remote-http` on `127.0.0.1:8789` and legacy LAN/VPN traffic stayed healthy — so a naive "is the box up?" check greenwashed the outage.

**Root cause:** one-sided deploy source. `deploy-ec2.sh` copied whatever `apps/server-pilot/deploy/nginx.conf` the tree had, with no semantic gate that both planes still existed in the candidate.

**Prior investigation (session history):** before the refuse gate landed on the deployed tip, a read-only session confirmed the current checkout's Nginx config was legacy-only, that static tests only asserted hotel listeners on ports 80 and 443, and that dual-plane proofs lived on `feat/remote-admin-alb` rather than the branch that had been deployed — so the wipe was an expected failure mode of that tree, not an ALB mystery. That session also noted not to require `REMOTE_TARGET_HEALTH_REQUIRED=1` as a hard *pre-deploy* blocker when recovering an already-broken private 8443 plane.

**Fix (on main as of tip `15039919`, includes `85c1c739` — refuse one-sided Nginx candidates):** dual-plane `nginx.conf`, plus `assert_dual_plane_nginx_candidate` before install/reload.

## Guidance

### 1. Never ship one-sided Nginx on this host

Candidate must contain **both** planes. Canonical remote listens bind the fixed ALB target private IP (not bare `8443`):

```56:82:apps/server-pilot/deploy/nginx.conf
  listen 172.31.12.112:8443 default_server;
  server_name _;
  return 444;
}

server {
  listen 172.31.12.112:8443;
  server_name 172.31.12.112;
  // ...
}

server {
  listen 172.31.12.112:8443;
  server_name nava-admin.trynava.io;
```

Legacy plane keeps `listen 443 ssl` + `proxy_pass http://127.0.0.1:8788/api/`. Remote app plane proxies `/api/` (and the IP-scoped `/health`) to `8789`.

### 2. Semantic refuse gate before install

`deploy-ec2.sh` greps required substrings on the candidate file **before** copying over the live site. Missing any contract → exit 1, prior site untouched:

```246:273:apps/server-pilot/deploy/deploy-ec2.sh
# Refuse one-sided Nginx candidates before install/reload so neither plane
# can be wiped by a bad deploy. Independent of live ALB rule state.
assert_dual_plane_nginx_candidate() {
  local candidate="${1:-$NGINX_SRC}"
  local missing=0
  // ...
  for required in \
    'server_name nava.legacyhotels.co.za' \
    'listen 443 ssl' \
    'proxy_pass http://127.0.0.1:8788/api/' \
    "listen ${REMOTE_ALB_TARGET_PRIVATE_IP}:8443" \
    'server_name nava-admin.trynava.io' \
    'proxy_pass http://127.0.0.1:8789/api/' \
    'proxy_pass http://127.0.0.1:8789/health'
  do
    if ! grep -Fq "$required" "$candidate"; then
      echo "nginx dual-plane candidate missing: ${required}" >&2
      missing=1
    fi
  done
  [ "$missing" -eq 0 ]
}
```

Call site aborts before activation:

```435:438:apps/server-pilot/deploy/deploy-ec2.sh
  if ! assert_dual_plane_nginx_candidate "$NGINX_SRC"; then
    echo "nginx candidate missing dual-plane contracts; prior site left untouched" >&2
    exit 1
  fi
```

Contract tests: `deploy-config.test.ts` scenarios `legacy-only` / `remote-only` must exit 1 with `nginx dual-plane candidate missing` and leave the prior site string unchanged.

### 3. Recovery when remote plane already wiped (R0 + deploy + host rule)

1. **R0 fail-closed** — delete only the priority-10 host-forward rule so public becomes honest ALB fixed **404** instead of **502**. LAN untouched.
2. **Deploy dual-plane tip** — normal `ops-deploy` / `deploy-ec2` from a tree whose `nginx.conf` passes the refuse gate (on main as of tip `15039919`). Do not deploy a legacy-only workspace while remote is live.
3. **Prove private planes** — `curl` `127.0.0.1:8788/health`, `127.0.0.1:8789/health`, and Host `nava-admin.trynava.io` against private `:8443` while the public rule is still off.
4. **Restore host rule** — recreate exact priority-10 host-header forward to TG `nava-remote-admin`; wait target healthy; public root **200**.

Merge live box tip into the dual-plane branch before deploy if the box is ahead on unrelated mail work — otherwise a full bundle reset can roll back those commits.

### 4. Gotcha — `unused` target ≠ `rollback`; cutover restore refuses

`classifyRemoteAdminLifecycle` only treats these shapes as safe (`apps/server-pilot/deploy/remote-admin-lifecycle.mjs`):

| Shape | State |
| --- | --- |
| No non-default rules + zero targets | `pre-registration` |
| Exact host-forward + exactly one **healthy** target | `active` |
| No non-default rules + exactly one **healthy** target | `rollback` |
| Anything else (including `unused` target) | `unknown` |

`hasExactHealthyTarget` requires `TargetHealth.State === 'healthy'`. After an operator **deletes** the host-forward rule, AWS often marks the registered target **`unused`** (`Target.NotInUse`) rather than leave it `healthy`. That is **not** `rollback` — classifier returns **`unknown`**, and `remote-admin-cutover.sh restore` refuses.

**Manual unblock:** recreate the exact priority-10 host-header forward (`Field=host-header,Values=nava-admin.trynava.io` → remote TG), wait healthy, verify public **200**. Soften: exact AWS timing for `unused` vs `healthy` after rule delete is environment-dependent; re-read target health before assuming `rollback`.

`ops-deploy` with `REMOTE_ADMIN_LIFECYCLE_MODE=auto` after R0 can exit non-zero on `remoteLifecycleStateKnown` even when dual-plane health curls passed — expected while the host rule is absent.

## Why This Matters

- **Split-brain health:** process up on `:8789` does not prove ALB→`:8443` Nginx plane exists. Public 502 with green loopback is the signature of a wiped remote vhost.
- **One site file, two products:** a hotel-only Nginx edit is a remote-admin outage. The refuse gate makes that a deploy failure instead of a silent plane deletion.
- **Lifecycle fail-closed:** cutover scripts must not mutate ALB when shape is ambiguous. Operators who delete the host rule for isolation can strand themselves in `unknown` until they recreate the exact rule by hand.

## When to Apply

- Editing `apps/server-pilot/deploy/nginx.conf` or any deploy path that installs it.
- Diagnosing `nava-admin.trynava.io` 502 while legacy VPN access still works.
- Running `remote-admin-cutover.sh` `{cutover,rollback,restore}` — classify first; never force transitions from `unknown`.
- Writing fixtures or temporary Nginx candidates in tests — use dual-plane stubs unless the test is specifically asserting refuse behavior.

## Examples

### Before (unsafe)

Legacy-only candidate: `listen 443 ssl` + `8788` proxies only. Deploy installs → remote `:8443` servers gone → ALB target fails health → public 502. Loopback `:8789` still answers.

### After (guarded)

Same deploy with dual-plane candidate: gate greps both `listen ${REMOTE_ALB_TARGET_PRIVATE_IP}:8443` and `server_name nava-admin.trynava.io` plus both upstreams. Legacy-only / remote-only candidates exit before reload; prior site left untouched.

### Restore trap

1. Operator deletes host-forward rule (R0 or isolation).
2. Target health becomes `unused` rather than staying `healthy`.
3. Classifier → `unknown` (not `rollback`).
4. `CONFIRM_REMOTE_ADMIN_CUTOVER=1 …/remote-admin-cutover.sh restore` fails.
5. Fix: recreate exact host rule via `aws elbv2 create-rule`, wait healthy, verify public 200.

## Related

- [nava-remote-admin-alb-companion.md](../architecture-patterns/nava-remote-admin-alb-companion.md) — plane split, readiness modes, Gate A/B
- [nava-internal-https-hostname-cutover.md](../architecture-patterns/nava-internal-https-hostname-cutover.md) — legacy hotel `:443` plane
- [ec2-pilot-ops-deploy-restart-reboot.md](./ec2-pilot-ops-deploy-restart-reboot.md) — ops front door (`ops-deploy` → `deploy-ec2`)
- [ec2-pilot-autonomous-deploy-and-ssm-gotchas.md](./ec2-pilot-autonomous-deploy-and-ssm-gotchas.md) — nginx copy/reload surface
- Source: `apps/server-pilot/deploy/deploy-ec2.sh` (`assert_dual_plane_nginx_candidate`), `nginx.conf`, `remote-admin-lifecycle.mjs`, `remote-admin-cutover.sh`
- Tests: `apps/server-pilot/tests/deploy-config.test.ts` (legacy-only / remote-only refuse)
- Merge state: dual-plane refuse gate on main as of tip `15039919`
