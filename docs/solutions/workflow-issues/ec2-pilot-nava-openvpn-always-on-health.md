---
title: EC2 Pilot Always-On Nava OpenVPN Restart and Health Asserts
date: 2026-07-22
category: workflow-issues
module: server-pilot openvpn
problem_type: workflow_issue
component: development_workflow
severity: high
applies_when:
  - Enabling always-on hotel OpenVPN (openvpn-client@nava) on the EC2 pilot
  - Wiring post-boot or ops-deploy health checks that must assert VPN without restaging
  - Writing ephemeral smoke or debug steps that might pkill OpenVPN processes
  - Verifying split-tunnel HOST_ROUTE via the VPC gateway (172.31.0.1)
symptoms:
  - After openvpn-client@nava process death, tunnel stayed down (stock unit Restart=no)
  - Boot and ops-deploy scripts ignored VPN health while apps came up
  - Ephemeral smoke pkill could kill the production hotel tunnel
root_cause: config_error
resolution_type: workflow_improvement
related_components:
  - tooling
  - email_processing
  - documentation
tags:
  - ec2-pilot
  - openvpn
  - nava
  - systemd
  - vpn-health
  - ops-deploy
  - keepalive
  - split-tunnel
---

# EC2 Pilot Always-On Nava OpenVPN Restart and Health Asserts

## Context

Hotel VPN on pilot EC2 (`i-008f737974a9ba9b3`, `af-south-1`) must stay up across process crashes, soft reboots, and routine deploys. Without a Restart override, the stock `openvpn-client@.service` does not recover from unclean exits (typical systemd default `Restart=no`, live-verified on the pilot before the drop-in): when OpenVPN exits unexpectedly, the unit stays dead until reboot or a manual `systemctl start`. That left hotel mail/API paths unreachable after a crash even though the instance itself was healthy.

The durability fix has three layers:

1. **systemd drop-in** so the unit recovers from non-clean exits.
2. **OpenVPN keepalive** so dead peers are detected and the session renegotiated.
3. **Shared HARD/SOFT health assert** wired into post-boot smoke and ops deploy — assert only, never restage secrets or re-run always-on install on every deploy.

Always-on install remains a one-time (or new-AMI) path: stage → confidence → `vpn-install-always-on.sh`. After that, deploy and smoke only notice. Ephemeral smoke/confidence scripts refuse to kill an always-on unit unless explicitly overridden.

Split-tunnel safety is non-negotiable: default route must stay host ENI (`via 172.31.0.1`), never `tun`; `pull-filter ignore "redirect-gateway"` (and related DNS/DOMAIN filters) must never be weakened. Only `172.24.0.0/16` is routed over the tunnel.

Handoff for this wave: [docs/superpowers/plans/handoff-reports/2026-07-22-ec2-vpn-boot-durability.md](../../superpowers/plans/handoff-reports/2026-07-22-ec2-vpn-boot-durability.md). Runbook durability section: [apps/server-pilot/deploy/vpn-always-on.md](../../../apps/server-pilot/deploy/vpn-always-on.md).

## Guidance

### Restart drop-in (crash recover)

Repo drop-in: `apps/server-pilot/deploy/systemd/openvpn-client@nava.service.d/restart.conf`. On box it lands under `/etc/systemd/system/openvpn-client@nava.service.d/restart.conf` via the install script.

```ini
[Unit]
StartLimitIntervalSec=120
StartLimitBurst=5

[Service]
Restart=on-failure
RestartSec=5
```

- `Restart=on-failure` — restart when the main process exits uncleanly.
- `RestartSec=5` — brief backoff between attempts.
- `StartLimitIntervalSec=120` / `StartLimitBurst=5` — avoid restart storms; after five failures in two minutes, systemd stops trying until the limit window clears or an operator intervenes.

Also set `keepalive 10 60` in `/etc/openvpn/client/nava.conf` so OpenVPN itself detects silent peer death.

**SIGTERM does not recover under this policy.** `Restart=on-failure` does not restart after SIGTERM/SIGINT/SIGHUP/SIGPIPE. Plain `kill` (SIGTERM) leaves the unit **inactive**. Crash-recover proof and operator drills must use `kill -9` / SIGKILL. Documented in `vpn-always-on.md` Durability (Crash recover).

### HARD vs SOFT assert (`vpn-health-assert.sh`)

Shared script: `apps/server-pilot/deploy/vpn-health-assert.sh`. Env knobs: `UNIT` (default `openvpn-client@nava`), `AWS_REGION` (default `af-south-1`), `REQUIRE_HOTEL_PROBE` (default `0`).

**HARD** (any fail → print `VPN_HARD_FAIL_*`, `exit 1`):

| Check | Fail token |
|-------|------------|
| `systemctl is-active` for unit | `VPN_HARD_FAIL_UNIT` |
| Default IPv4 route present and `via 172.31.0.1` (not empty, not `tun*`) | `VPN_HARD_FAIL_HOST_ROUTE` |
| `172.24.0.0/16` present in `ip -4 route` | `VPN_HARD_FAIL_ROUTE_17224` |
| `aws sts get-caller-identity` succeeds | `VPN_HARD_FAIL_STS` |

On success of all HARD checks: print `VPN_HARD_OK`.

**SOFT** (hotel TCP probe over `172.24.*`):

- Probe hosts `172.24.0.10`, `172.24.0.8`, `172.24.240.41` on ports `25 587 993 443 8080 80` via `nc -z -w 2`.
- Any success → `VPN_HOTEL_OK`.
- All fail → `VPN_SOFT_WARN_HOTEL` and **exit 0** unless `REQUIRE_HOTEL_PROBE=1`, which hard-fails as `VPN_HARD_FAIL_HOTEL`.

Token vocabulary for grepping logs / SSM output: `VPN_HARD_OK`, `VPN_HARD_FAIL_*`, `VPN_HOTEL_OK`, `VPN_SOFT_WARN_HOTEL`.

### Who calls assert (assert only — never restage)

1. **`post-boot-smoke.sh`** — after nginx / `:8788` / `:443` / pm2 http checks, wait up to `VPN_WAIT_SECS` (default 30) for unit active + `172.24.0.0/16`, then run `vpn-health-assert.sh`. HARD fail marks the smoke attempt failed. PASS line includes `VPN_HARD_OK`.
2. **`ops-deploy.sh`** — after `curl` `:8788/health`, run assert over SSM. HARD fail aborts deploy; hotel soft warn does not.
3. **`vpn-route-check.sh`** — HARD assert first, then identity/routes/STS/RDS/S3/(POP3/SMTP) diagnostics.

**Never** from routine `ops-deploy` / `deploy-ec2` / PM2: restage secrets, re-run `vpn-stage-to-ec2.sh`, or call `vpn-install-always-on.sh`. Deploy notices; install is one-shot.

### Ephemeral smoke / confidence guards

When durable conf exists (`/etc/openvpn/client/nava.conf`) and the unit is **enabled**, ephemeral `vpn-safe-smoke.sh` / `vpn-confidence.sh` refuse with **exit 20** (`SMOKE_REFUSE_ALWAYS_ON` / `CONFIDENCE_REFUSE_ALWAYS_ON`) unless `ALLOW_KILL_ALWAYS_ON=1`. Gate is conf + enabled (not `is-active`). Protects live tunnel from kill/restart drills.

### Split tunnel — never weaken

Keep:

1. `pull-filter ignore "redirect-gateway"` (+ DNS/DOMAIN pull-filters as installed).
2. Explicit `route 172.24.0.0/16`.
3. HARD host-route check: default must be `via 172.31.0.1`, must not match `tun[0-9]+`.

Weakening pull-filters or accepting default-via-tun is a production incident class, not a tuning knob.

### Instance assumption for future chats

Future sessions **MAY assume** always-on VPN is live on `i-008f737974a9ba9b3` (`ALWAYS_ON_OK` / unit active+enabled, durability drop-in + keepalive present) unless evidence shows otherwise. New AMI / new instance still needs the full stage → confidence → install path once.

## Why This Matters

Without restart + keepalive, a single OpenVPN crash silently killed hotel connectivity until a human noticed or the box rebooted. Without HARD assert in smoke and deploy, a broken tunnel (wrong default route, missing `172.24` route, dead unit, STS broken) could ship as a “green” deploy while mail workers failed. Soft hotel probe avoids flaking deploys on hotel-side TCP blips while still surfacing `VPN_SOFT_WARN_HOTEL` for operators.

Restaging secrets or re-running always-on install on every deploy is the opposite failure mode: unnecessary secret churn, risk of disabling a good tunnel, and conflict with ephemeral smoke that would kill always-on. Assert-only + refuse-exit-20 separates **notice** from **install**.

SIGTERM vs SIGKILL matters for anyone proving recover: a “kill and wait for restart” drill with plain `kill` will falsely conclude restart is broken.

## When to Apply

- **Crash recover expected** — OpenVPN main process dies uncleanly; drop-in should bring unit back within ~5s (subject to start limit).
- **Post soft reboot / post-boot** — `post-boot-smoke.sh` (via `ops-reboot` or manual) must see `VPN_HARD_OK` before declaring PASS.
- **Every `ops-deploy`** — after `:8788/health`, run HARD assert; abort on `VPN_HARD_FAIL_*`.
- **Route / mail diagnosis** — start with `vpn-health-assert.sh` (or `vpn-route-check.sh`) before digging POP3/SMTP.
- **New instance / new AMI** — once: `vpn-stage-to-ec2.sh` → `vpn-confidence.sh` (`CONFIDENCE_PASS`) → `vpn-install-always-on.sh` (`ALWAYS_ON_OK`). Then durability drop-in + keepalive are in place.
- **Recover proof / confidence reconnect** — use SIGKILL (`kill -9`), not SIGTERM.
- **Ephemeral smoke while always-on is live** — expect exit 20 unless `ALLOW_KILL_ALWAYS_ON=1` is intentional.
- **Do not apply** — restaging VPN secrets or reinstalling always-on on every code deploy; weakening split-tunnel pull-filters; treating hotel soft warn as deploy abort (unless `REQUIRE_HOTEL_PROBE=1` is set on purpose).

## Examples

### Drop-in + keepalive (what “durable” looks like)

```
Restart=on-failure
RestartSec=5
StartLimitIntervalSec=120
StartLimitBurst=5
keepalive 10 60
```

Repo: `apps/server-pilot/deploy/systemd/openvpn-client@nava.service.d/restart.conf`. Conf on box: `/etc/openvpn/client/nava.conf`.

### Crash-recover proof (correct vs wrong signal)

```bash
# Wrong: SIGTERM — Restart=on-failure does NOT restart; unit ends inactive
sudo kill "$(systemctl show -p MainPID --value openvpn-client@nava)"

# Right: SIGKILL — unit should return active; host default still via 172.31.0.1
sudo kill -9 "$(systemctl show -p MainPID --value openvpn-client@nava)"
systemctl is-active openvpn-client@nava
ip -4 route show default
```

### HARD assert success tokens

```
== vpn-health-assert ==
DEFAULT_ROUTE=default via 172.31.0.1 dev ens5 ...
VPN_HARD_OK
HOTEL_PROBE_OK 172.24.0.10:25
VPN_HOTEL_OK
```

Or hotel soft-only:

```
VPN_HARD_OK
VPN_SOFT_WARN_HOTEL
```

(exit 0 — deploy/smoke continue unless `REQUIRE_HOTEL_PROBE=1`)

### Call sites

`ops-deploy.sh` after health:

```bash
echo "== ops-deploy: VPN HARD assert =="
bash "${SCRIPT_DIR}/ssm-run-command.sh" \
  'bash /home/ubuntu/repos/zero/apps/server-pilot/deploy/vpn-health-assert.sh'
```

`post-boot-smoke.sh` waits for unit + `172.24.0.0/16`, then:

```bash
bash "${SCRIPT_DIR}/vpn-health-assert.sh"
```

### Refuse ephemeral kill of always-on

With always-on conf present and unit enabled, ephemeral smoke/confidence should print refuse and exit **20** unless `ALLOW_KILL_ALWAYS_ON=1`.

### Soft reboot expectation

After `ops-reboot` on `i-008f737974a9ba9b3`, post-boot smoke should include `VPN_HARD_OK` (and ideally `VPN_HOTEL_OK`), with default still `via 172.31.0.1` and `172.24.0.0/16` via tun — split tunnel intact. See handoff report for observed PASS lines.

## Related

- Runbook: [apps/server-pilot/deploy/vpn-always-on.md](../../../apps/server-pilot/deploy/vpn-always-on.md)
- Handoff: [docs/superpowers/plans/handoff-reports/2026-07-22-ec2-vpn-boot-durability.md](../../superpowers/plans/handoff-reports/2026-07-22-ec2-vpn-boot-durability.md)
- Plan: [docs/superpowers/plans/2026-07-22-ec2-vpn-boot-deploy-durability.md](../../superpowers/plans/2026-07-22-ec2-vpn-boot-deploy-durability.md)
- Sibling ops durability: [ec2-pilot-ops-deploy-restart-reboot.md](./ec2-pilot-ops-deploy-restart-reboot.md), [ec2-pilot-safe-reboot-and-prod-restart.md](./ec2-pilot-safe-reboot-and-prod-restart.md), [ec2-pilot-autonomous-deploy-and-ssm-gotchas.md](./ec2-pilot-autonomous-deploy-and-ssm-gotchas.md)
- Real-mail consumer: [mail-transport-mode-fixture-vs-real.md](../architecture-patterns/mail-transport-mode-fixture-vs-real.md)
- Scripts: `vpn-health-assert.sh`, `post-boot-smoke.sh`, `ops-deploy.sh`, `vpn-route-check.sh`, `vpn-install-always-on.sh`, `vpn-disable.sh`
- Drop-in: `apps/server-pilot/deploy/systemd/openvpn-client@nava.service.d/restart.conf`

Note: handoff records soft reboot + assert wiring proven; full end-to-end `ops-deploy` was not required for that wave beyond assert being wired and post-reboot assert OK — do not over-claim a full deploy re-proof unless re-run.
