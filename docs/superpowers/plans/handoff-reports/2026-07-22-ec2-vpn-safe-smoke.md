# Handoff: EC2 hotel VPN safe smoke

**Date:** 2026-07-22  
**Plan:** `docs/plans/2026-07-22-001-feat-ec2-vpn-safe-smoke-plan.md`  
**Instance:** `i-008f737974a9ba9b3` (`af-south-1`)  
**Result:** **SMOKE_PASS**

## Proof (SSM smoke)

- `HOST_ROUTE_OK` — default stayed `via 172.31.0.1 dev ens5`
- `STS_OK` — instance role identity returned
- `ROUTE_17224_OK` — `172.24.0.0/16` + host routes via `tun0`
- Hotel TCP:
  - Zimbra `172.24.0.10`: 25, 587, 993, 443
  - Rocketseed `172.24.0.8`: 25, 587, 443, 80
  - Infor `172.24.240.41`: 443, 80
- `CLEANUP_OK` — OpenVPN killed; `/run/nava-vpn` wiped
- Tunnel IP: `192.168.138.2/29`; VPN server already pushed **host routes only** (no `redirect-gateway`); client pull-filter still on

## Preflight

- OpenVPN `2.6.19` — **no** native `--netns`
- Installed `namespaced-openvpn` helper (unused this smoke; host+pull-filter)
- apt: `dnsutils` + `iproute2` upgrade

## RCA during overnight

| Fail | Root cause | Fix |
|------|------------|-----|
| `AccessDenied` ListBucket `vpn-nava/` | IAM `NavaZeroBootstrapBundleRead` only `git-bundles/*` | Extended GetObject/ListBucket to `vpn-nava/*` |
| `chmod … /run/nava-vpn/*` no such file | Dir `700` root; ubuntu cannot glob | `sudo bash -c 'chmod …'` + per-file `aws s3 cp` |
| `Failed retrieving username or password` | (1) CRLF in `nava-auth.txt` (2) OpenSSL3 hang on legacy RC2 PKCS#12 | `tr -d '\r'`; extract PEM via `openssl pkcs12 -legacy`; ovpn uses `ca`/`cert`/`key` |

## Divergence

- Smoke always **host + pull-filter** (not netns) so host `nc` probes see `172.24` routes.
- Permanent `openvpn-client@` **still disabled**.

## Operator replay

See `apps/server-pilot/deploy/vpn-smoke.md`.
