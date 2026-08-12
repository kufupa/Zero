---
title: Nava Remote Admin ALB Companion Plane
date: 2026-08-12
category: architecture-patterns
module: server-pilot deploy / remote admin
problem_type: architecture_pattern
component: tooling
severity: high
tags:
  - nava
  - remote-admin
  - alb
  - waf
  - gated-cutover
---

# Nava Remote Admin ALB Companion Plane

## Boundary

Remote administration is separate from hotel access:

- Legacy `nava.legacyhotels.co.za:443 -> 127.0.0.1:8788` remains hotel-internal. Its DNS stays internal, UFW keeps only `tun0:443`, and legacy EC2 security groups gain no ingress.
- Remote `nava-admin.trynava.io:443` terminates TLS at a dedicated public ALB. Only that ALB may reach EC2 `ens5:8443`.
- Nginx keeps remote app traffic on `127.0.0.1:8789`; `:8443` accepts only the fixed target-health Host or exact remote host. It never adds TLS or public access to legacy `:443`.

## Gate sequence

1. Read-only preflight must match account, region, VPC, instance, target private IP, ALB subnets, existing target ingress, and required IAM actions. Lovable DNS edit authority is already confirmed.
2. Request ACM certificate for `nava-admin.trynava.io`; stop at Gate A and give operator exact validation CNAME. Do not create edge resources before Gate A approval.
3. After certificate becomes `ISSUED`, create guarded ALB, target group, security groups, logs, WAF, and UFW controls. Listener default stays fixed `404`.
4. Do not register target or create host-forward rule until Task 5 remote readiness is green.
5. After operator saves public CNAME, complete Gate B DNS observation and additive S3 CORS change. Then remote active readiness requires a healthy target and exact host-forward rule.

## Readiness modes

`launch-readiness.sh` supports:

- Default: legacy-only recovery diagnostics. It preserves zero EC2 ingress and exact `tun0:443`.
- `REMOTE_ADMIN_MODE=1 REMOTE_TARGET_HEALTH_REQUIRED=0`: pre-registration checks. It requires remote ALB, target group, WAF, target security group, log bucket, default fixed-404 listener, exact UFW `ens5:8443` ALB-subnet rules, and no target registration or host-forward rule.
- `REMOTE_ADMIN_MODE=1 REMOTE_TARGET_HEALTH_REQUIRED=1`: active remote checks. It additionally requires exactly one healthy target and priority-10 exact `nava-admin.trynava.io` host-forward rule.

Both remote modes still run `vpn-health-assert.sh`; default route through `tun0` fails readiness.

## Why separate planes matter

An ALB target SG is not permission to widen hotel access. Splitting hostnames, listeners, processes, security groups, and firewall interfaces lets public remote access be audited without turning legacy hotel traffic into public ingress.
