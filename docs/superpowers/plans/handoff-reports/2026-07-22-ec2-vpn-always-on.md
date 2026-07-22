# Handoff: EC2 hotel VPN always-on

**Date:** 2026-07-22  
**Plan:** `docs/plans/2026-07-22-002-feat-ec2-vpn-always-on-confidence-plan.md`  
**Instance:** `i-008f737974a9ba9b3` (`af-south-1`)  
**Result:** **ALWAYS_ON_OK**

## Proof

### Confidence (`vpn-confidence.sh`)

- `HOST_ROUTE_OK` — default stayed `via 172.31.0.1 dev ens5`
- `RESOLV_OK` — `/etc/resolv.conf` hash unchanged
- `STS_OK`
- `ROUTE_17224_OK` + hotel TCP (Zimbra / Rocketseed / Infor)
- `RECONNECT_OK` (kill + restart OpenVPN)
- `CONFIDENCE_PASS` — `/run/nava-vpn` kept for promote

### Install (`vpn-install-always-on.sh`)

- Durable: `/etc/openvpn/client/nava.conf` + `/etc/openvpn/client/nava/`
- Unit: `openvpn-client@nava` → **active** + **enabled**
- Post-enable: `HOST_ROUTE_OK`, `RESOLV_OK`, `STS_OK`, hotel `PROBE_OK`, `RECONNECT_OK`
- Ephemeral `/run/nava-vpn` wiped after promote

### Post-enable SSM (second invocation)

- `systemctl is-active` = `active`
- `systemctl is-enabled` = `enabled`
- default still `via 172.31.0.1 dev ens5`
- STS account `845242190536`
- `SSM_POST_ENABLE_OK`

## Operator

- Runbook: `apps/server-pilot/deploy/vpn-always-on.md`
- Abort: `vpn-disable.sh` (optional `WIPE_CLIENT=1`)

## Notes

- Server still pushes host routes only (no `redirect-gateway`); client `pull-filter` ignores DOMAIN push.
- Secrets Manager migration still deferred (root-owned files under `/etc/openvpn/client/nava/`).
