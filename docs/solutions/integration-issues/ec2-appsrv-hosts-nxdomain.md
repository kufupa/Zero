---
title: EC2 Pilot Hosts Entry for Infor HMS VPN-Only Hostname
date: 2026-07-24
category: integration-issues
module: server-pilot
problem_type: integration_issue
component: development_workflow
symptoms:
  - "Chromium on EC2 pilot returns DNS_PROBE_FINISHED_NXDOMAIN for https://appsrv-1.legacyhotels.co.za/web/base/logindisp?tenant=HMS_LEGACY"
  - "Public DNS returns NXDOMAIN for appsrv-1.legacyhotels.co.za; hotel internal DNS also does not resolve the name from EC2"
  - "VPN tunnel is up and 172.24.240.41:443 serves Infor HMS, but hostname-based access fails"
  - "Raw IP URL loads the login page with Not Secure TLS (wildcard cert SAN mismatch)"
root_cause: incomplete_setup
resolution_type: config_change
severity: high
tags:
  - ec2-pilot
  - hosts-file
  - dns-nxdomain
  - infor-hms
  - openvpn
  - split-tunnel
  - legacyhotels
  - appsrv-1
---

# EC2 Pilot Hosts Entry for Infor HMS VPN-Only Hostname

## Problem

On the EC2 pilot (`i-008f737974a9ba9b3`, `af-south-1`), Chromium could not load Infor HMS at `https://appsrv-1.legacyhotels.co.za`. The browser showed `DNS_PROBE_FINISHED_NXDOMAIN`. Hotel OpenVPN was connected and split-tunnel routing to `172.24.0.0/16` worked for other internal targets (Zimbra at `172.24.0.10`, VPN health probes), but the Infor application hostname `appsrv-1.legacyhotels.co.za` has no public DNS A record. EC2 deliberately does not use VPN-pushed DNS — split-tunnel design keeps the default route on the host ENI and ignores `redirect-gateway` and related DNS pull-filters, as documented in `docs/solutions/workflow-issues/ec2-pilot-nava-openvpn-always-on-health.md`. Without a resolvable name, Chromium never reached the Infor app server even though the server was reachable at `172.24.240.41:443` over the tunnel with a valid TLS certificate for `*.legacyhotels.co.za`.

## Symptoms

- Chromium on the EC2 xRDP session (`DISPLAY=:10`) navigating to `https://appsrv-1.legacyhotels.co.za` failed immediately with `DNS_PROBE_FINISHED_NXDOMAIN`.
- Public DNS lookup for `appsrv-1.legacyhotels.co.za` returned no A record (`dig` / `nslookup` from the internet or from EC2 without hosts override).
- VPN tunnel was up (`openvpn-client@nava` active, routes to `172.24.0.0/16` present), but hostname resolution still failed because EC2 resolver does not consult hotel internal DNS.
- Direct navigation to `https://172.24.240.41` could reach the server over the tunnel, but Chromium showed **Not Secure** — the certificate's Subject Alternative Names list DNS hostnames only (`*.legacyhotels.co.za`), not the raw IP address.
- Playwright and manual browser tests against the hostname URL failed before any TLS or HTTP exchange could occur.

## What Didn't Work

- **Relying on VPN DNS.** Enabling VPN-pushed DNS on EC2 would break the AWS split-tunnel design: default route must stay on the host ENI, and `pull-filter ignore "redirect-gateway"` plus DNS/DOMAIN pull-filters must not be weakened. Hotel IT DNS is not available to the EC2 resolver by design. (session history: VPN bring-up locked "ignore DHCP DNS on host" and confidence gates assert `resolv.conf` unchanged.)
- **Treating VPN TCP reachability as proof HMS works in Chromium.** (session history) `nc` to `172.24.240.41:443` only proved L3/L4; browser still failed at `getaddrinfo` → NXDOMAIN.
- **Using the IP URL directly.** `https://172.24.240.41` connects over the tunnel, but the browser treats the connection as insecure because the cert SAN does not include the IP. Infor HMS and any automation expecting a trusted HTTPS context need the hostname.
- **Waiting for public DNS.** `appsrv-1.legacyhotels.co.za` is an internal hotel hostname with no public A record; it will not resolve via Route 53, Google DNS, or the EC2 default resolver without a deliberate mapping.
- **Assuming VPN connectivity alone fixes HMS.** Zimbra and other `172.24.x.x` targets worked because they were addressed by IP in env config (`POP3_HOST=172.24.0.10`). Infor HMS is accessed by hostname in the browser, so routing without resolution is insufficient. (session history: early checklist already flagged "Infor test URL / hostname" and "DNS — needed for Infor?" as open items after hotel IT supplied only the IP.)

## Solution

### 1. Live fix on EC2 (immediate)

Add a static hosts entry mapping the Infor hostname to the VPN-reachable app-server IP:

```
172.24.240.41 appsrv-1.legacyhotels.co.za
```

Append to `/etc/hosts` idempotently (only if the hostname is not already present):

```bash
if ! grep -qE '(^|[[:space:]])appsrv-1\.legacyhotels\.co\.za([[:space:]]|$)' /etc/hosts; then
  echo '172.24.240.41 appsrv-1.legacyhotels.co.za' | sudo tee -a /etc/hosts >/dev/null
fi
```

From a developer workstation, run on the pilot via SSM:

```bash
bash apps/server-pilot/deploy/ssm-run-command.sh '
if ! grep -qE "(^|[[:space:]])appsrv-1\.legacyhotels\.co\.za([[:space:]]|$)" /etc/hosts; then
  echo "172.24.240.41 appsrv-1.legacyhotels.co.za" | sudo tee -a /etc/hosts >/dev/null
fi
grep appsrv-1 /etc/hosts
getent hosts appsrv-1.legacyhotels.co.za
'
```

### 2. Persist in deploy script

The same idempotent block is wired into `apps/server-pilot/deploy/deploy-ec2.sh` immediately after the existing `nava.legacy.local` hosts block. Every `ops-deploy` / `deploy-ec2.sh` run re-asserts the mapping on a fresh or rebuilt instance without duplicating the line.

```bash
echo "== hosts: appsrv-1.legacyhotels.co.za (Infor HMS via VPN) =="
# Hotel internal hostname has no public A record; EC2 split-tunnel ignores VPN DNS.
# Map to Infor app-server so Chromium hostname matches *.legacyhotels.co.za cert.
if ! grep -qE '(^|[[:space:]])appsrv-1\.legacyhotels\.co\.za([[:space:]]|$)' /etc/hosts; then
  echo '172.24.240.41 appsrv-1.legacyhotels.co.za' | sudo tee -a /etc/hosts >/dev/null
fi
```

### 3. Verification commands

**Resolution:**

```bash
getent hosts appsrv-1.legacyhotels.co.za
# Expected: 172.24.240.41   appsrv-1.legacyhotels.co.za
```

**TLS cert SAN (confirms hostname-based HTTPS is valid):**

```bash
echo | openssl s_client -connect 172.24.240.41:443 -servername appsrv-1.legacyhotels.co.za 2>/dev/null \
  | openssl x509 -noout -subject -dates -ext subjectAltName
# Expected: subjectAltName includes DNS:*.legacyhotels.co.za
# notAfter: Dec 28 2026 (hotel IT renews; not our responsibility)
```

**HTTP reachability (VPN must be up):**

```bash
curl -fsS -o /dev/null -w '%{http_code}\n' -k https://appsrv-1.legacyhotels.co.za/
# Expected: 200 (Infor login page)
```

**Playwright (strict TLS, no ignore_https_errors):**

```bash
# On EC2 after hosts entry present — ignore_https_errors=False
# Expected: HTTP 200, page title "Infor HMS"
```

**Chromium on xRDP:**

```bash
DISPLAY=:10 XAUTHORITY=/home/ubuntu/.Xauthority \
  /opt/nava/playwright-browsers/chromium-1169/chrome-linux/chrome \
  --user-data-dir=/home/ubuntu/.nava-chrome-profile \
  --new-window 'https://appsrv-1.legacyhotels.co.za/web/base/logindisp?tenant=HMS_LEGACY'
# Expected: "Opening in existing browser session." and Infor HMS login in a secure context
```

All checks passed after the hosts entry was applied: `getent` resolved to `172.24.240.41`, HTTPS returned the Infor login page, Playwright with `ignore_https_errors=False` returned 200 with title "Infor HMS", and Chromium on `DISPLAY=:10` opened the URL successfully.

## Why This Works

The failure was a **name-resolution gap**, not a routing or TLS problem. Split-tunnel VPN on EC2 routes `172.24.0.0/16` over `tun0` but deliberately does not adopt hotel DNS servers. Public resolvers have no A record for `appsrv-1.legacyhotels.co.za`, so `getaddrinfo` fails before any TCP connection is attempted — hence `DNS_PROBE_FINISHED_NXDOMAIN`.

A static `/etc/hosts` entry is the minimal, reversible fix: it teaches the EC2 resolver the correct IP (`172.24.240.41`, discovered via hotel IT email and VPN health probes against the `172.24.240.0/24` subnet) without changing VPN DNS policy or split-tunnel routing. Once the hostname resolves locally, Chromium connects to `172.24.240.41` over the existing tunnel route, presents `ServerName appsrv-1.legacyhotels.co.za` during TLS handshake, and the server returns its `*.legacyhotels.co.za` certificate — matching SAN, so the browser shows a secure connection instead of the "Not Secure" warning you get when browsing by raw IP.

The mapping is machine-wide: every Chromium instance and automation on the EC2 host shares it. It mirrors the existing pattern for `nava.legacy.local` (`127.0.0.1` in the same deploy script) — local names that the pilot depends on but that public DNS does not serve. (session history: pilot browser gates already depended on that hosts pattern for `nava.legacy.local`.)

## Prevention

- **Keep the hosts block in `deploy-ec2.sh`.** Any new AMI, instance rebuild, or manual `/etc/hosts` wipe is recovered on the next deploy. Do not remove the idempotent grep/tee block after the `nava.legacy.local` section.
- **Do not enable VPN DNS on EC2.** That breaks split-tunnel safety documented in `ec2-pilot-nava-openvpn-always-on-health.md`. Hosts mapping is the correct layer for internal-only hostnames on this pilot.
- **Re-apply if the Infor app-server IP moves.** `172.24.240.41` was smoke-discovered via VPN health probes; the stable anchor is subnet `172.24.240.0/24`. If hotel IT renumbers the app server, update the IP in `/etc/hosts` and in `deploy-ec2.sh`, then redeploy.
- **Verify after VPN or hosts changes.** Quick SSM smoke:

  ```bash
  bash apps/server-pilot/deploy/ssm-run-command.sh '
  getent hosts appsrv-1.legacyhotels.co.za
  curl -fsS -o /dev/null -w "http=%{http_code}\n" -k https://appsrv-1.legacyhotels.co.za/
  '
  ```

- **Cert renewal is hotel IT's job.** The Infor TLS cert expires Dec 28 2026. We do not manage renewal; hosts mapping does not affect cert lifecycle.
- **Long-term optional improvement.** Ask hotel IT (e.g. Ruan) to publish an internal DNS A record or provide a resolvable name via their DNS infrastructure. That would remove the hosts dependency but is not required for the pilot — static hosts is minimal, reversible, and already persisted in deploy.
- **Do not use IP URLs in docs or automation for HMS.** IP URLs work for TCP but fail browser trust (cert SAN is DNS-only). Always use `https://appsrv-1.legacyhotels.co.za` with the hosts entry in place.

## Related Issues

- [EC2 pilot always-on OpenVPN health](../workflow-issues/ec2-pilot-nava-openvpn-always-on-health.md) — split-tunnel, DNS pull-filters, `172.24.240.41` TCP probes (explains why routing works while hostname does not)
- [EC2 autonomous deploy and SSM gotchas](../workflow-issues/ec2-pilot-autonomous-deploy-and-ssm-gotchas.md) — deploy-ec2 path where hosts blocks live
- [EC2 ops-deploy / restart / reboot](../workflow-issues/ec2-pilot-ops-deploy-restart-reboot.md) — ops-deploy reapplies hosts via deploy-ec2.sh
