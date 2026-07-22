# Handoff: EC2 hotel VPN boot/deploy durability

**Date:** 2026-07-22  
**Plan:** [`docs/superpowers/plans/2026-07-22-ec2-vpn-boot-deploy-durability.md`](../2026-07-22-ec2-vpn-boot-deploy-durability.md)  
**Instance:** `i-008f737974a9ba9b3` (`af-south-1`)  
**Unit:** `openvpn-client@nava`  
**Result:** **DONE** — Restart + keepalive live; HARD notice at boot/deploy; soft reboot proven; docs updated.

## Scope delivered (Tasks 1–5)

| Task | Commit | Proof |
|------|--------|-------|
| 1 Restart + keepalive | `e7ab745d` | `Restart=on-failure`; SIGKILL recover |
| 2 `vpn-health-assert.sh` HARD/SOFT | `712c2d9e` | `VPN_HARD_OK` / fail tokens |
| 3 post-boot VPN assert | `99fda11a` | smoke PASS includes `VPN_HARD_OK` |
| 4 ops-deploy HARD + pkill guard | `70b79dc4` | refuse `exit 20`; assert wired |
| 5 docs + soft reboot + handoff | (this commit) | `ops-reboot ok` |

## Live evidence

### Restart drop-in + keepalive (Task 1 + post-reboot confirm)

```
Restart=on-failure
RestartUSec=5s
StartLimitIntervalUSec=2min
StartLimitBurst=5
keepalive 10 60
pull-filter ignore "redirect-gateway"
/etc/systemd/system/openvpn-client@nava.service.d/restart.conf
```

Drop-in path (repo): `apps/server-pilot/deploy/systemd/openvpn-client@nava.service.d/restart.conf`

### Kill-recover (Task 1)

- SIGTERM (`kill`) → unit **inactive** (`Restart=on-failure` skips SIGTERM).
- **SIGKILL (`kill -9`)** → MainPID `480596` → `480609`; `active` within 15s; HOST_ROUTE still `via 172.31.0.1`.
- Docs state recover proof uses SIGKILL for this reason.

### Refuse exit 20 (Task 4)

```
SMOKE_REFUSE_ALWAYS_ON
REFUSE_RC=20
active / enabled
default via 172.31.0.1 dev ens5
172.24.0.0/16 via 192.168.138.1 dev tun0
```

### Soft reboot (Task 5)

Pre-reboot: `sync-ec2-git-bundle.sh` → EC2 HEAD `70b79dc4`.

```
== ops-reboot: reboot-instances i-008f737974a9ba9b3 ==
== ops-reboot: post-boot-smoke ==
VPN_HARD_OK
HOTEL_PROBE_OK 172.24.0.10:25
VPN_HOTEL_OK
PASS: nginx + :8788 + :443 + pm2 http online + VPN_HARD_OK
ops-reboot ok
```

Post-reboot SSM:

```
active
enabled
Restart=on-failure
default via 172.31.0.1 dev ens5 ...
172.24.0.0/16 via 192.168.138.1 dev tun0
VPN_HARD_OK
VPN_HOTEL_OK
```

**HOST_ROUTE still ens5** — never via `tun`. Split tunnel intact.

### Optional post-reboot assert (mimics ops-deploy)

Same SSM call as above ran `vpn-health-assert.sh` → `VPN_HARD_OK`. Full `ops-deploy` not required this wave.

## HARD vs SOFT (locked)

| Class | Checks | Fail |
|-------|--------|------|
| HARD | unit active; default via `172.31.0.1` (not tun); STS | `VPN_HARD_FAIL_*`; exit 1 |
| SOFT | hotel TCP | `VPN_SOFT_WARN_HOTEL`; exit 0 |

Callers: `post-boot-smoke.sh`, `ops-deploy.sh`, `vpn-route-check.sh`.

## Operator pointers

- Runbook: [`apps/server-pilot/deploy/vpn-always-on.md`](../../../../apps/server-pilot/deploy/vpn-always-on.md) (Durability section)
- Access: [`docs/superpowers/EC2-ACCESS.MD`](../../EC2-ACCESS.MD) §9
- Abort: `vpn-disable.sh` (optional `WIPE_CLIENT=1`)
- New instance: still stage → confidence → install **once**; deploy never restages

## Out of scope (unchanged)

- CloudWatch alarm on inactive unit
- Secrets Manager migration
- Worker wait-for-172.24 before first POP3

## Concerns

- SIGTERM does not trigger restart under `Restart=on-failure` (by design; plan locked).
- Full end-to-end `ops-deploy` not re-run this wave (assert wired + refuse proven + post-reboot assert OK).
