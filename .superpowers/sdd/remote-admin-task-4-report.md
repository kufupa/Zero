# Task 4 pre-Gate-A report

## Status

`BLOCKED`

Branch: `feat/remote-admin-alb`  
Implementation commit: `3ef26a70f242a328d2f131f35358829d10cb5838`

No AWS mutation occurred. In particular: no ACM certificate request, secret, ALB, target group, listener, security group, WAF, bucket, CORS change, target registration, host-forward rule, DNS record, or EC2/UFW change.

## Delivered local contracts

- Added isolated remote-admin readiness modes:
  - legacy recovery (`REMOTE_ADMIN_MODE=0`);
  - pre-registration (`REMOTE_ADMIN_MODE=1 REMOTE_TARGET_HEALTH_REQUIRED=0`);
  - active target (`REMOTE_ADMIN_MODE=1 REMOTE_TARGET_HEALTH_REQUIRED=1`).
- Preserved legacy `nava.legacyhotels.co.za:443 -> 127.0.0.1:8788`, zero legacy SG ingress, and exact `tun0:443`.
- Added remote perimeter validation: named ALB/target group/WAF/SG/log bucket, fixed-404 listener, exact ALB-only `ens5:8443` UFW rules, target-SG-only ingress, no direct public target path, log-bucket controls, WAF rate rules, and remote CORS.
- Added gated/idempotent operator procedure, companion architecture documentation, and ops-deploy pre-registration readiness call.

Changed paths:

- `.superpowers/sdd/progress.md`
- `apps/server-pilot/deploy/aws-resources.md`
- `apps/server-pilot/deploy/launch-readiness.sh`
- `apps/server-pilot/deploy/ops-deploy.sh`
- `apps/server-pilot/tests/deploy-config.test.ts`
- `docs/runbooks/centurion-day-one-operations.md`
- `docs/solutions/architecture-patterns/nava-internal-https-hostname-cutover.md`
- `docs/solutions/architecture-patterns/nava-remote-admin-alb-companion.md`

## TDD and validation

Initial RED before implementation:

```bash
unset DATABASE_URL TEST_DATABASE_URL VITEST_ALLOW_PILOT_RDS CONFIRM_DISPOSABLE_TEST_DB HMS_DB_TEST_REQUIRED
pnpm exec vitest run tests/deploy-config.test.ts
```

Result: new remote-admin readiness/resource assertions failed before the edge contract existed.

Follow-up RED checks exposed and fixed two contract defects:

1. Pre-registration mode incorrectly emitted skipped active-target checks instead of requiring an empty target/rule state.
2. Preflight looked only for explicit subnet route-table associations and missed a valid VPC main route table.

Focused GREEN checks:

```bash
unset DATABASE_URL TEST_DATABASE_URL VITEST_ALLOW_PILOT_RDS CONFIRM_DISPOSABLE_TEST_DB HMS_DB_TEST_REQUIRED
pnpm exec vitest run tests/deploy-config.test.ts -t "defines remote-admin readiness contracts"
pnpm exec vitest run tests/deploy-config.test.ts -t "documents gated, idempotent remote-admin"
```

Final GREEN:

```bash
unset DATABASE_URL TEST_DATABASE_URL VITEST_ALLOW_PILOT_RDS CONFIRM_DISPOSABLE_TEST_DB HMS_DB_TEST_REQUIRED
pnpm exec vitest run tests/deploy-config.test.ts --testTimeout=20000
```

Result: `117 passed`.

Static validation:

```bash
bash -n deploy/launch-readiness.sh deploy/post-boot-smoke.sh deploy/ops-deploy.sh deploy/ops-restart.sh deploy/ops-reboot.sh deploy/pm2-boot.sh
git diff --check
```

Result: passed. No DB, Docker, or production-RDS test command ran.

## Read-only AWS preflight

Completed with explicit `af-south-1` calls and sanitized boolean-only evidence:

- account matches expected account;
- expected EC2 instance, VPC, target private IP, and primary ENI present;
- one attached EC2 security group found;
- both named ALB subnets match expected VPC;
- both subnets resolve through their effective route tables to an Internet gateway (via the VPC main route table);
- no existing TCP/8443 ingress on attached EC2 security groups;
- IAM simulation confirmed all `54/54` required actions as allowed.

Preflight cannot complete because no Lovable DNS operator attestation was supplied for both required CNAME records. `LOVABLE_DNS_CONTROL_CONFIRMED=1` remains unset. Task policy requires this confirmation before the ACM request.

## Gate A

No certificate was requested. No ACM validation CNAME or certificate ARN exists for this task run.

Required next input: explicit Lovable DNS-control confirmation. After that, rerun read-only preflight and request only `nava-admin.trynava.io` ACM certificate, then stop at Gate A.

## Self-review

- Corrected mode-specific readiness semantics so pre-registration requires no target/host-forward state and active mode requires exact healthy target/host-forward state.
- Corrected route preflight to honor both explicit subnet associations and the VPC main route table.
- Confirmed all mutations remain documentation-only behind Gate A/Gate B boundaries.
