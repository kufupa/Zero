---
title: "Nava Pilot Hotel-Internal HTTPS Hostname Cutover (No Public Ingress)"
date: "2026-07-31"
category: "architecture-patterns"
module: "server-pilot deploy / internal HTTPS"
problem_type: architecture_pattern
component: tooling
severity: high
applies_when:
  - "Cutting over Nava pilot hostname from .local to hotel-issued HTTPS name"
  - "Installing hotel-issued TLS on server-pilot without public ingress"
  - "Pointing internal DNS at OpenVPN-reachable address for hotel staff access"
  - "Deploying TLS listener changes with closed-deploy-then-open-tun0-443 sequencing"
  - "Skipping DB migration when app schema is unchanged across the cutover"
related_components:
  - authentication
  - development_workflow
tags:
  - nava
  - hostname-cutover
  - internal-https
  - hotel-issued-tls
  - openvpn
  - tun0-443
  - no-public-ingress
  - server-pilot
  - legacyhotels
---

# Nava Pilot Hotel-Internal HTTPS Hostname Cutover (No Public Ingress)

## Context

Centurion hotel pilot needed a staff-reachable HTTPS origin that is **not** on the public internet. The prior origin `https://nava.legacy.local` used local naming that forced TLS bypasses in gates and did not match hotel-issued certificates. Cutover target is the hotel-internal canonical origin `https://nava.legacyhotels.co.za`.

Hotel IT supplied a hotel-issued `*.legacyhotels.co.za` TLS certificate (operator handoff; issuer brand not encoded in repo runbook) and added internal DNS for the canonical hostname to the EC2 OpenVPN client address. Repo runbook treats certificate issuance as hotel IT ownership (DNS-01) and Nava ownership of install, Nginx validation, and trusted browser proof (`docs/runbooks/centurion-day-one-operations.md`).

Access model:

- Hotel **internal DNS** resolves the canonical hostname to the EC2 tunnel address on `tun0`, not a public A/AAAA.
- EC2 security groups keep **zero ingress**.
- Host firewall (UFW) allows TCP 443 **only** on `tun0`, and only after closed-deploy proofs pass.
- Public paths stay blocked; staff reach the SPA/API from Centurion LAN or approved staff VPN.

Work lives on local branch `nava-hostname-cutover-20260731` (not merged to `main` as of this writing; remote/PR not confirmed from this checkout). Operator attestation for the live cutover (not a checked-in artifact): deploy without migration, launch-readiness **READY**, and tunnel-only staff HTTPS open. Off-network clients cannot resolve or reach the URL by design.

## Guidance

### One canonical HTTPS origin everywhere

Keep auth, SPA, Nginx, CORS, and gates on the same origin string: `https://nava.legacyhotels.co.za`.

Better Auth `baseURL` comes from `BETTER_AUTH_URL`. Trusted origins are derived from that URL’s origin plus local loopback defaults, then merged with optional CSV `BETTER_AUTH_TRUSTED_ORIGINS`:

```42:57:apps/server-pilot/src/lib/auth.ts
/** Pure helper for Better Auth trustedOrigins (unit-testable without DB). */
export function resolvePilotTrustedOrigins(
  env: Record<string, string | undefined> = process.env,
): string[] {
  const authURL = env.BETTER_AUTH_URL?.trim();
  const base = [
    authURL ? new URL(authURL).origin : undefined,
    'https://127.0.0.1',
    'http://127.0.0.1:3000',
    'http://localhost:3000',
  ].filter((origin): origin is string => Boolean(origin));
  const extra = (env.BETTER_AUTH_TRUSTED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  return [...new Set([...base, ...extra])];
}
```

Deploy defaults `BETTER_AUTH_URL` to the canonical HTTPS origin (`apps/server-pilot/deploy/write-ec2-env.sh`). SPA build pins `VITE_PUBLIC_APP_URL` to `BETTER_AUTH_URL` when unset so redirects do not become `undefined/login`:

```51:54:apps/server-pilot/deploy/deploy-ec2.sh
# Empty string = same-origin /api via nginx. Unset becomes literal "undefined" in the bundle.
export VITE_PUBLIC_BACKEND_URL="${VITE_PUBLIC_BACKEND_URL-}"
# Absolute app origin for RR redirects / metadata. Unset → literal "undefined/login" 404s.
export VITE_PUBLIC_APP_URL="${VITE_PUBLIC_APP_URL:-$BETTER_AUTH_URL}"
```

Nginx `server_name` is the canonical host only; wrong Host closes with 444; HTTP redirects to HTTPS; TLS files live under `/etc/nginx/ssl/nava.legacyhotels.co.za.*`:

```1:19:apps/server-pilot/deploy/nginx.conf
server {
  listen 80 default_server;
  server_name nava.legacyhotels.co.za;
  if ($host != nava.legacyhotels.co.za) {
    return 444;
  }
  return 301 https://nava.legacyhotels.co.za$request_uri;
}

server {
  listen 443 ssl default_server;
  server_name nava.legacyhotels.co.za;

  if ($host != nava.legacyhotels.co.za) {
    return 444;
  }

  ssl_certificate     /etc/nginx/ssl/nava.legacyhotels.co.za.fullchain.pem;
  ssl_certificate_key /etc/nginx/ssl/nava.legacyhotels.co.za.key;
```

Launch readiness **refuses** non-canonical `BETTER_AUTH_URL` and requires system-trusted HTTPS health (no `-k`).

### Closed deploy, then open tunnel 443 only

Sequence from `docs/runbooks/centurion-day-one-operations.md` cutover gates:

1. Prove builds / cert / snapshots with UFW 443 still closed.
2. Deploy app + Nginx while perimeter stays closed (`DO_MIGRATE=0` when schema unchanged).
3. On-box trusted TLS, headers, wrong-host rejection, read-only Playwright.
4. Add **exactly** `ufw allow in on tun0 to any port 443 proto tcp` (avoid comment metadata if the readiness parser matches exact `ufw show added` text).
5. Require `launch-readiness.sh` status `READY`.
6. Keep legacy CORS origin for ~24h, then remove after clean readback comparison.

UFW contract in readiness: active, default deny incoming, exactly one tunnel TCP/443 allow, broad 443 absent. SG ingress empty and no public IPv6 are separate READY checks.

Default laptop deploy path does **not** migrate unless `--migrate` is passed:

```9:36:apps/server-pilot/deploy/ops-deploy.sh
DO_MIGRATE=0
QUIESCED=0
for arg in "$@"; do
  case "$arg" in
    --migrate) DO_MIGRATE=1 ;;
    --quiesced) QUIESCED=1 ;;
```

### Transactional Nginx install with rollback

`deploy-ec2.sh` backs up the existing site, installs candidate, runs `nginx -t`, reloads; on failure or interrupt an EXIT trap restores previous site/symlink and reloads. Do not half-apply a hostname TLS site without that rollback path.

### S3 CORS: additive cutover, then prune legacy

Attachments use short-lived presigned GETs. During overlap, allow canonical + legacy (`https://nava.legacy.local`) + localhost GET/HEAD; after ~24h remove only the legacy origin after compare-before-rollback readback (`apps/server-pilot/deploy/aws-resources.md`). Readiness requires canonical CORS present and no wildcard origins. S3 Block Public Access stays fully enabled.

### Remove TLS bypasses from production gates

Real-mail / EC2 Playwright gates refuse `PLAYWRIGHT_IGNORE_HTTPS_ERRORS=1`. Playwright config throws if real-mail gate and ignore-HTTPS are both set. Health curls use trusted verify + `--resolve` to loopback or the tunnel address — never `curl -k`.

### VPN health must emit fixed tokens only (SSM-safe)

`vpn-health-assert.sh` asserts unit active, exact `tun0` address/CIDR, HOST_ROUTE intact, hotel prefix route, and STS. Successful hotel TCP probes discard `nc` stdout/stderr and print only fixed tokens (`VPN_HARD_OK`, `HOTEL_PROBE_OK`, `VPN_HOTEL_OK`) — never routes, hosts, or ports — so SSM logs stay redacted:

```50:64:apps/server-pilot/deploy/vpn-health-assert.sh
echo "VPN_HARD_OK"
# ...
    if nc -z -w 2 "$h" "$p" >/dev/null 2>&1; then
      # ...
      echo "HOTEL_PROBE_OK"
```

## Why This Matters

- Wrong sequencing (open 443 before trusted TLS proof) risks exposing a broken or untrusted listener.
- Leaving `.local` in auth/SPA/CORS while Nginx serves the hotel name breaks login, cookies, and attachments.
- TLS bypasses in gates hide padlock failures staff will hit on Centurion LAN.
- Migrating production RDS “for safety” on a hostname-only change adds wipe/mutation risk with zero schema benefit.
- Printing private routes/endpoints into SSM history violates the pilot redaction contract.

## When to Apply

- Any move of the pilot staff URL between hostnames or certificate issuers.
- Any change that opens or closes hotel-facing TCP 443 on the pilot EC2.
- Auth / SPA / Nginx / S3 CORS origin updates that must stay synchronized.
- Production gate work that might reintroduce `ignoreHTTPSErrors` or `curl -k`.
- Deploy prep when asking “do we need `db:migrate`?” — only if schema actually changed.

## Examples

**Closed cutover deploy (no migration):**

`ops-deploy.sh` defaults to no migrate; pass `--migrate` only when schema changed.

```bash
GIT_BRANCH=nava-hostname-cutover-20260731 \
BUNDLE_KEY=git-bundles/zero-nava-hostname-cutover-20260731.bundle \
bash apps/server-pilot/deploy/ops-deploy.sh
```

**On-box trusted proof (then open UFW):**

```bash
curl --disable --noproxy '*' -fsS \
  --resolve nava.legacyhotels.co.za:443:127.0.0.1 \
  https://nava.legacyhotels.co.za/health

bash apps/server-pilot/deploy/playwright-real-mail-ui-gate.sh --read-only
# only then:
sudo ufw allow in on tun0 to any port 443 proto tcp
bash apps/server-pilot/deploy/launch-readiness.sh
```

**Rollback (initial cutover):** delete the UFW tunnel 443 rule first, restore pinned pre-cutover SHA + runtime backups, keep staff access closed until readiness and read-only UI gate pass again. No emergency public DNS change required.

## Related

- [EC2 Pilot Always-On Nava OpenVPN Restart and Health Asserts](../workflow-issues/ec2-pilot-nava-openvpn-always-on-health.md) — tunnel durability prerequisite
- [EC2 Pilot Ops Deploy / Restart / Reboot](../workflow-issues/ec2-pilot-ops-deploy-restart-reboot.md) — deploy surface (refresh: still documents old `.local` auth URL)
- [Live Pilot Production Parity (Real Mail)](./live-pilot-production-parity-real-mail.md) — auth host parity pattern (refresh: still pins `.local`)
- Operator runbook: `docs/runbooks/centurion-day-one-operations.md`
