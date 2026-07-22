# Hotel VPN always-on (confidence → enable)

After ephemeral smoke PASS, run confidence gate, then enable `openvpn-client@nava`.
**Never enable without `CONFIDENCE_PASS`.**

## Prerequisites

- Smoke already green (or stage fresh with `vpn-stage-to-ec2.sh`)
- Local `live real data connection/` with filled auth + P12
- Scripts on EC2 (`sync-ec2-git-bundle.sh`)

## Ordered run

```bash
# 0) Push scripts
bash apps/server-pilot/deploy/sync-ec2-git-bundle.sh

# 1) Stage secrets → /run/nava-vpn
bash apps/server-pilot/deploy/vpn-stage-to-ec2.sh

# 2) Confidence (route + resolv + STS + hotel + reconnect)
bash apps/server-pilot/deploy/ssm-run-command.sh \
  'bash /home/ubuntu/repos/zero/apps/server-pilot/deploy/vpn-confidence.sh'

# 3) Enable only after CONFIDENCE_PASS
bash apps/server-pilot/deploy/ssm-run-command.sh \
  'bash /home/ubuntu/repos/zero/apps/server-pilot/deploy/vpn-install-always-on.sh'
```

## Abort / disable

```bash
bash apps/server-pilot/deploy/ssm-run-command.sh \
  'bash /home/ubuntu/repos/zero/apps/server-pilot/deploy/vpn-disable.sh'

# Also wipe durable files:
bash apps/server-pilot/deploy/ssm-run-command.sh \
  'WIPE_CLIENT=1 bash /home/ubuntu/repos/zero/apps/server-pilot/deploy/vpn-disable.sh'
```

## Interpret results

| Line | Meaning |
|------|---------|
| `HOST_ROUTE_OK` / `RESOLV_OK` | SSM path + DNS untouched |
| `STS_OK` | Instance role reaches AWS |
| `PROBE_OK host:port` | Hotel TCP |
| `RECONNECT_OK` | Survive kill/restart or `systemctl restart` |
| `CONFIDENCE_PASS` | Safe to install |
| `ALWAYS_ON_OK` | Unit active + enabled; ephemeral `/run` wiped |
| `INSTALL_FAIL_HOST_ROUTE` | Auto-disabled — do not re-enable without fix |

## Layout on EC2

- Conf: `/etc/openvpn/client/nava.conf`
- Secrets: `/etc/openvpn/client/nava/` (mode 600 root)
- Unit: `openvpn-client@nava`

## Safety stack

1. `pull-filter ignore "redirect-gateway"` (+ DNS/DOMAIN)
2. Explicit `route 172.24.0.0/16`
3. Confidence before enable
4. Post-enable HOST_ROUTE/RESOLV assert → auto-disable on fail
5. No secrets in git

## Durability (boot / deploy / crash)

Always-on stays up across crashes and soft reboots. Deploy **never** restages VPN secrets or re-runs install.

### Crash recover

- Drop-in: `/etc/systemd/system/openvpn-client@nava.service.d/restart.conf` (repo: `apps/server-pilot/deploy/systemd/openvpn-client@nava.service.d/restart.conf`)
  - `Restart=on-failure` / `RestartSec=5`
  - `StartLimitIntervalSec=120` / `StartLimitBurst=5`
- Conf: `keepalive 10 60` in `/etc/openvpn/client/nava.conf`
- **Recover proof uses SIGKILL (`kill -9`)** — `Restart=on-failure` skips SIGTERM/SIGINT/SIGHUP/SIGPIPE. Plain `kill` leaves unit inactive.

### HARD vs SOFT (`vpn-health-assert.sh`)

| Class | Checks | Fail |
|-------|--------|------|
| **HARD** | unit active; default via `172.31.0.1` (not `tun`); STS | `VPN_HARD_FAIL_*`; exit **1** → abort caller |
| **SOFT** | hotel TCP on `172.24.0.0/16` | `VPN_SOFT_WARN_HOTEL`; exit **0** (warn only) |

Pass tokens: `VPN_HARD_OK`, `VPN_HOTEL_OK` (or soft warn).

### Who calls assert

- `post-boot-smoke.sh` — HARD fail → smoke FAIL
- `ops-deploy.sh` — HARD fail → deploy abort; hotel SOFT warn does not abort
- `vpn-route-check.sh` — HARD first, then identity/routes/STS/RDS/S3/(POP3/SMTP)

### Deploy / smoke guards

- `ops-deploy` / `deploy-ec2` / PM2: **never** restage VPN or call `vpn-install-always-on.sh`
- Ephemeral `vpn-safe-smoke.sh` / `vpn-confidence.sh`: refuse (`exit 20`, `*_REFUSE_ALWAYS_ON`) when always-on unit present unless `ALLOW_KILL_ALWAYS_ON=1`

### New AMI / new instance

Still run once: stage → confidence → install (`vpn-stage-to-ec2.sh` → `vpn-confidence.sh` → `vpn-install-always-on.sh`). Durability drop-in + keepalive land via install script.

### Abort

```bash
bash apps/server-pilot/deploy/ssm-run-command.sh \
  'bash /home/ubuntu/repos/zero/apps/server-pilot/deploy/vpn-disable.sh'
```

Plan: [`docs/superpowers/plans/2026-07-22-ec2-vpn-boot-deploy-durability.md`](../../../docs/superpowers/plans/2026-07-22-ec2-vpn-boot-deploy-durability.md)
