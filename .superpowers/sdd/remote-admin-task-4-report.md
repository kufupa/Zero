# Task 4 pre-Gate-A report

## Status

`DONE`

Branch: `feat/remote-admin-alb`  
Initial implementation commit: `3ef26a70f242a328d2f131f35358829d10cb5838`  
Review-remediation commit: `595c5230a1a5ce9bf40378f73ece2486ae451a48`

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

## Review-remediation addendum

This addendum supersedes the earlier DNS-attestation blocker. User-confirmed Lovable authority is sufficient; `LOVABLE_DNS_CONTROL_CONFIRMED` is removed. Gate A remains the ACM request followed by presentation of its exact CNAME.

Fixed every P1/P2 finding:

1. Remote collector rejects all-protocol, public-`443`, and every non-exact attached-SG ingress; only the single ALB-SG `tcp/8443` target permission is allowed.
2. Active target requires exact instance `i-008f737974a9ba9b3`, port `8443`, and `healthy`.
3. Remote CORS requires an exact `GET`/`HEAD` method set; the procedure rejects a pre-existing remote origin with `PUT` or another method.
4. WAF requires exactly two rate rules, both `Block`: exact `POST /api/auth/sign-in/email` 25/300-second source-IP scope and whole-plane 1000/300-second source-IP scope.
5. Provisioning now classifies deterministic named resources as fresh, complete, or partial. Complete edges use semantic readiness readback; partial/divergent state exits before mutation. Bucket access errors cannot be mistaken for absence.
6. Added real collector/parser coverage using stubbed AWS JSON responses, including all-protocol SG, public-`443`, wrong target ID/port, WAF `Count`, and broadened sign-in scope negatives.

### Remediation TDD evidence

RED:

```bash
unset DATABASE_URL TEST_DATABASE_URL VITEST_ALLOW_PILOT_RDS CONFIRM_DISPOSABLE_TEST_DB HMS_DB_TEST_REQUIRED
pnpm exec vitest run tests/deploy-config.test.ts -t "defines remote-admin readiness|remote collector|documents gated"
pnpm exec vitest run tests/deploy-config.test.ts -t "remote collector rejects"
```

Observed failures: remote CORS accepted `PUT`; the real collector accepted all-traffic ingress; documentation retained the unplanned DNS variable and lacked fail-closed re-run semantics.

GREEN:

```bash
unset DATABASE_URL TEST_DATABASE_URL VITEST_ALLOW_PILOT_RDS CONFIRM_DISPOSABLE_TEST_DB HMS_DB_TEST_REQUIRED
pnpm exec vitest run tests/deploy-config.test.ts --testTimeout=30000
bash -n deploy/launch-readiness.sh deploy/post-boot-smoke.sh deploy/ops-deploy.sh deploy/ops-restart.sh deploy/ops-reboot.sh deploy/pm2-boot.sh
git diff --check
```

Result: `118 passed`; shell syntax and whitespace checks passed. No Docker, database, runtime environment, AWS/SSM, ACM, or other external mutation ran during remediation.

Remaining concern: ACM remains intentionally unrequested. Next authorized mutation is ACM-only Gate A, which must stop after returning its exact validation CNAME and certificate ARN.

## Second re-review remediation

Status: `DONE`

No AWS, SSM, ACM, Docker, database, or runtime-environment command ran during this remediation.

### RED

Added pure/static contract coverage before changing production scripts or runbook procedures:

```bash
unset DATABASE_URL TEST_DATABASE_URL VITEST_ALLOW_PILOT_RDS CONFIRM_DISPOSABLE_TEST_DB HMS_DB_TEST_REQUIRED
pnpm exec vitest run tests/deploy-config.test.ts -t "remote collector rejects|documents gated" --testTimeout=60000
```

Observed expected failures: the live collector accepted a `LOWERCASE` method transformation; the resource procedure lacked the all-protocol (`IpProtocol: "-1"`) preflight rejection. The same new static contract covered exact IPv4 ALB readback, exact CORS intended/applied comparison, and executable bounded log-delivery proof.

### Fixes

1. Preflight now treats `IpProtocol: "-1"` as exposing TCP/8443 and blocks it.
2. WAF byte-match validation requires exactly one transformation: `Priority: 0`, `Type: NONE`; collector coverage rejects `LOWERCASE`.
3. Remote collector now reads the ALB SG and requires: internet-facing IPv4 application ALB; exactly public IPv4 TCP/443 ingress; exactly TCP/8443 egress to the target SG; and target-only TCP/8443 ingress. Fresh provisioning has stage-specific semantic SG readback after every mutation.
4. CORS readback canonicalizes and compares the full intended/applied rule sets, failing on concurrent additions, broadening, removal, or field changes.
5. Runbook now includes a harmless body-discarding remote-host request and 15-minute bounded poll for an ALB log object newer than the proof start. It emits only `{"accessLogDelivered":true}` and never prints headers, bodies, object keys, secrets, or PII.

### GREEN

Focused GREEN:

```bash
unset DATABASE_URL TEST_DATABASE_URL VITEST_ALLOW_PILOT_RDS CONFIRM_DISPOSABLE_TEST_DB HMS_DB_TEST_REQUIRED
pnpm exec vitest run tests/deploy-config.test.ts -t "documents gated" --testTimeout=60000
```

Result: `1 passed`.

Full DB-free GREEN:

```bash
unset DATABASE_URL TEST_DATABASE_URL VITEST_ALLOW_PILOT_RDS CONFIRM_DISPOSABLE_TEST_DB HMS_DB_TEST_REQUIRED
pnpm exec vitest run tests/deploy-config.test.ts --testTimeout=60000
bash -n deploy/launch-readiness.sh deploy/post-boot-smoke.sh deploy/ops-deploy.sh deploy/ops-restart.sh deploy/ops-reboot.sh deploy/pm2-boot.sh
git diff --check
```

Result: `118 passed`; shell syntax and diff-whitespace checks passed.

Remaining concern: no edge exists yet, so semantic readback and bounded log proof are contract-tested local procedures only. ACM remains intentionally unrequested; no AWS mutation is authorized until re-review approval.
