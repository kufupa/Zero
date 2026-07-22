# Hotel VPN safe smoke (SSM-proof)

Ephemeral OpenVPN client test on EC2. **≤300s** hard stop. Split tunnel enforced client-side. **Do not** enable `openvpn-client@` until this passes.

## Prerequisites

- Local folder `live real data connection/` with:
  - `Nava.ovpn`, `Nava.p12`, `Nava-tls.key`, `nava-auth.txt` (filled)
  - `nava-p12-pass.txt` placeholder → smoke strips `askpass` (empty P12 pass attempt)
- AWS creds that can S3-write bootstrap bucket + SSM to `i-008f737974a9ba9b3`
- Branch scripts on EC2 (`sync-ec2-git-bundle.sh` or deploy)

## Ordered run

```bash
# 0) Optional: push scripts to EC2
bash apps/server-pilot/deploy/sync-ec2-git-bundle.sh

# 1) Inventory + apt
bash apps/server-pilot/deploy/ssm-run-command.sh \
  'bash /home/ubuntu/repos/zero/apps/server-pilot/deploy/vpn-ec2-preflight.sh'

# 2) Stage secrets laptop → S3 → /run/nava-vpn (never git)
bash apps/server-pilot/deploy/vpn-stage-to-ec2.sh

# 3) Smoke (root via script sudo)
bash apps/server-pilot/deploy/ssm-run-command.sh \
  'bash /home/ubuntu/repos/zero/apps/server-pilot/deploy/vpn-safe-smoke.sh'
```

## Abort

```bash
bash apps/server-pilot/deploy/ssm-run-command.sh \
  'sudo pkill -9 openvpn; sudo rm -rf /run/nava-vpn; echo ABORT_OK'
```

## Interpret results

| Line | Meaning |
|------|---------|
| `HOST_ROUTE_OK` | Host default route unchanged — SSM path alive |
| `STS_OK` | Instance role still reaches AWS |
| `PROBE_OK host:port` | Hotel TCP open |
| `ROUTE_17224_OK` | `172.24.0.0/16` via tun (ICMP/TCP may still be filtered) |
| `SMOKE_PASS` | Host safe + (probe or route) |
| `SMOKE_FAIL_CONNECT` / `NO_TUN` | Auth, P12, UDP block, or **IT allowlist** of `13.247.138.62` |
| `SMOKE_FAIL_HOST_ROUTE` | Full-tunnel leak — pull-filter failed; do not retry without fix |
| `CLEANUP_OK` | OpenVPN killed; `/run/nava-vpn` wiped |

## Safety stack

1. `pull-filter ignore "redirect-gateway"`
2. Explicit `route 172.24.0.0 255.255.0.0`
3. Host default-route assert
4. `timeout 300`
5. Ignore DHCP DNS push
6. No systemd enable

## Secrets

Never commit `nava-auth.txt`, `*.p12`, `*-tls.key`. Stage only via S3 → tmpfs `/run/nava-vpn`.
