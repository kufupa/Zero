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
