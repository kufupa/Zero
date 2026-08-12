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
Remediation commit: `edf7b680`

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

## Gate A attempt — 2026-08-12

Status: `BLOCKED`

Sanitized reason: required `IAM_POLICY_SOURCE_ARN` was unavailable, so the documented IAM policy simulation could not run. No AWS API call or ACM request was made. A mode-`0700` external evidence directory contains only a mode-`0600` sanitized blocker record.

## Gate A retry — 2026-08-12

Status: `GATE_A_READY`

The earlier IAM-policy-source block was resolved by user-provided read-only STS identity evidence, not an authentication failure. Preflight used `arn:aws:iam::845242190536:user/ansh-cursor` exactly as `IAM_POLICY_SOURCE_ARN`.

Sanitized preflight passed: expected account, principal, region, VPC, EC2 instance, private target IP, public ALB subnets/routes, and one attached SG with no TCP/8443 or all-protocol ingress; IAM simulation allowed all `55/55` documented actions. Mode-`0700` external evidence directories retain only mode-`0600` sanitized records.

ACM certificate requested: `arn:aws:acm:af-south-1:845242190536:certificate/61956798-05ef-40ea-a003-55a0e8873fea`

Validation CNAME:

```text
_cf5449169fe7418f020f5c0de210d3f0.nava-admin.trynava.io. CNAME _476c6f6537d7d4313c5f9a102d942fd4.jkddzztszm.acm-validations.aws.
```

Stopped after ACM list/request/describe. No other AWS mutation, secret/database/SSM/Docker/deploy action occurred.

## Task 4 continuation — 2026-08-12

ACM became `ISSUED` within the allowed polling window. Sanitized issuance evidence is retained outside the repository.

Created and semantically read back the dedicated remote-auth secret, its exact instance read policy, and the two dedicated security groups. The initial secret-policy attempt failed before policy mutation because AWS CLI on Windows could not resolve an MSYS temporary-file path; the secret was never read, and the policy was then applied using a native temporary path and verified.

Status: `BLOCKED`

The edge is now a partial deterministic state after these authorized writes. The reviewed fail-closed procedure prohibits continuing a partial edge automatically; stop before target attachment, UFW, target group, ALB, listener, WAF, log bucket, or CORS changes. No target registration, host-forward rule, port-80 listener, or `nava-admin` DNS record was created.

## Task 4 resumability correction — 2026-08-12

Status: `DONE` for local procedure/test correction. No AWS, SSM, ACM, secret, database, Docker, environment-source, deployment, or runtime mutation ran during this correction.

### Root cause

The old classifier had only three outcomes: all six deterministic resources absent (`fresh`), all present (`complete`), or any other vector (`partial`). Its own safe SG sequence creates and validates both named SGs before target attachment, producing:

```text
[ALB=0,TG=0,ALB-SG=1,target-SG=1,WAF=0,bucket=0]
```

That exact `SG_FINAL_UNATTACHED` state was therefore rejected as partial even though it was the normal output of the preceding approved mutations.

Fresh external read-only evidence, not this report, remains the authority for the next operator action: ACM is issued; remote-auth secret metadata and exact narrow instance policy exist without reading the secret value; both named SGs are in the expected VPC, unattached, and have the exact final ALB/target rules; named ALB, target group, WAF, and log bucket are absent.

### Correction

- Replaced binary fresh/complete/partial guard with exclusive known-safe prefix classification.
- Added all staged prefixes from `FRESH` through `TASK4_PRE_GATE_B_READY`, including current `SG_FINAL_UNATTACHED`.
- Each prefix has one allowed AWS/EC2/SSM state mutation followed by fresh semantic readback of the exact next prefix.
- Live facts reject malformed/read-error output, duplicate deterministic names, unexpected named-SG attachment, broad/unexpected permissions, non-exact resource controls, target registration, listener rules, public HTTP, and DNS mutation.
- Preserved legacy zero ingress and `tun0:443`; Task 4 listener remains HTTPS fixed-404 only. Target registration and exact host-forward remain Task 5 only.

### TDD evidence

RED before procedure implementation:

```bash
unset DATABASE_URL TEST_DATABASE_URL VITEST_ALLOW_PILOT_RDS CONFIRM_DISPOSABLE_TEST_DB HMS_DB_TEST_REQUIRED
pnpm exec vitest run tests/deploy-config.test.ts -t "live-readback resume|unknown and malformed|one mutation and semantic|no early public exposure" --testTimeout=60000
```

Result: exit `1`; `4 failed | 118 skipped (122)`. Expected failures were missing live prefix classification, malformed/unknown-state rejection, ordered one-mutation transitions, and explicit early-exposure prohibition.

Focused GREEN:

```bash
unset DATABASE_URL TEST_DATABASE_URL VITEST_ALLOW_PILOT_RDS CONFIRM_DISPOSABLE_TEST_DB HMS_DB_TEST_REQUIRED
pnpm exec vitest run tests/deploy-config.test.ts -t "live-readback resume|unknown and malformed|one mutation and semantic|no early public exposure" --testTimeout=60000
```

Result: `4 passed | 118 skipped (122)`.

The first full-suite attempt exposed a removed existing static phrase (`reject divergence`) and a separate 30-second Playwright-config timeout. Restoring the fail-closed phrase made the remote-admin documentation contract pass; the isolated Playwright test passed in `3.2s`. The repeat full run was clean:

```bash
unset DATABASE_URL TEST_DATABASE_URL VITEST_ALLOW_PILOT_RDS CONFIRM_DISPOSABLE_TEST_DB HMS_DB_TEST_REQUIRED
pnpm exec vitest run tests/deploy-config.test.ts --testTimeout=60000
bash -n deploy/launch-readiness.sh deploy/post-boot-smoke.sh deploy/ops-deploy.sh deploy/ops-restart.sh deploy/ops-reboot.sh deploy/pm2-boot.sh
git diff --check
```

Result: `122 passed`; shell syntax and whitespace checks passed.

### Remaining concern

No live transition was attempted for this correction. On next authorized operator run, regenerate the live facts and resume only from the freshly derived `SG_FINAL_UNATTACHED` prefix with one target-SG attachment mutation followed by semantic readback. Do not treat this report or prior evidence as state authority.

## Task 4 executable edge provisioner — 2026-08-12

Status: `DONE` for local implementation and DB-free verification. No live AWS, SSM, ACM, Secrets Manager, Docker, database, environment-source, deployment, or runtime mutation ran. Tests used only explicit fake AWS/SSM binary overrides.

### Delivered

- Added `deploy/remote-edge-provisioner.sh` with only `inspect [--evidence-root DIR]` and `apply-one --action ACTION [--evidence-root DIR]`.
- Added pure `deploy/remote-edge-state.mjs` for strict fact-schema validation, deterministic prefix classification, closed action mapping, and exact successor mapping.
- Each inspection regenerates fixed AWS/EC2/host projections. `apply-one` repeats collection before and after exactly one mapped mutation; SSM readback is evidence only and raw SSM output stays private scratch data.
- The classifier rejects stale/manual facts, missing/malformed/extra schema keys, duplicate names, unsafe perimeter controls, public target addresses, unexpected attachment, and successor divergence. External evidence contains only atomic sanitized stage/action JSON in mode-`0700` / mode-`0600` paths.
- Replaced prose mutation bodies in `aws-resources.md` with invocation-only guidance. `launch-readiness.sh` remains the separate read-only final gate.

### TDD evidence

Initial RED before production files existed:

```bash
unset DATABASE_URL TEST_DATABASE_URL VITEST_ALLOW_PILOT_RDS CONFIRM_DISPOSABLE_TEST_DB HMS_DB_TEST_REQUIRED
pnpm exec vitest run tests/remote-edge-provisioner.test.ts --testTimeout=30000
```

Result: exit `1`; expected failure because `remote-edge-provisioner.sh` and `remote-edge-state.mjs` were absent.

Follow-up RED checks:

```bash
unset DATABASE_URL TEST_DATABASE_URL VITEST_ALLOW_PILOT_RDS CONFIRM_DISPOSABLE_TEST_DB HMS_DB_TEST_REQUIRED
pnpm exec vitest run tests/remote-edge-provisioner.test.ts -t "classifies only strict" --testTimeout=30000
pnpm exec vitest run tests/deploy-config.test.ts -t "documents gated|documents live-readback|documents rejection|documents one mutation|documents no early" --testTimeout=60000
```

Observed expected failures: strict schema initially lacked no-public-target-address coverage; old documentation tests still expected the removed pseudo-code source of truth.

GREEN:

```bash
unset DATABASE_URL TEST_DATABASE_URL VITEST_ALLOW_PILOT_RDS CONFIRM_DISPOSABLE_TEST_DB HMS_DB_TEST_REQUIRED
pnpm exec vitest run tests/deploy-config.test.ts --testTimeout=60000 --maxWorkers=1 --fileParallelism=false --reporter=dot
pnpm exec vitest run tests/remote-edge-provisioner.test.ts --testTimeout=60000 --maxWorkers=1 --fileParallelism=false --reporter=dot
node --check deploy/remote-edge-state.mjs
bash -n deploy/remote-edge-provisioner.sh deploy/launch-readiness.sh deploy/post-boot-smoke.sh deploy/ops-deploy.sh deploy/ops-restart.sh deploy/ops-reboot.sh deploy/pm2-boot.sh
git diff --check
```

Result: `122` deploy-config tests and `11` provisioner tests passed; Node syntax, shell syntax, and whitespace checks passed.

### Divergence and fail-closed coverage

- Fake state proves fresh pre- and post-mutation collection around one target-SG attachment; only `ec2 modify-instance-attribute` may mutate in that path.
- Wrong action, supplied historical-fact flag, absent/read-error facts, malformed facts, duplicate names, unsafe ingress, and post-mutation divergence all block. Prohibited Task 5/public operations never execute.
- A combined parallel Vitest run passed all `133` assertions but surfaced a Vitest `onTaskUpdate` RPC timeout. Serial re-runs above were clean; this was runner reporting contention, not an application test failure.

### Remaining concern

No live provisioner invocation was attempted. On next authorized operator run, use fresh `inspect`, then invoke exactly its returned action. Current historical status does not authorize attachment or any later transition.

## Executable provisioner security remediation — 2026-08-12

Status: `DONE`

This remediation ran only local fixture binaries. It did not invoke live AWS, SSM, ACM, Docker, database, runtime, DNS, HTTP endpoint, or deployment mutation; it did not source environment files or access secrets.

### RED

New fake-AWS/SSM/curl coverage first exposed the following unsafe acceptance paths:

1. An empty `ufw status numbered` rule section could classify from `ufw show added` alone.
2. An ALB log object timestamp equal to proof start could satisfy the proof.
3. Public ingress on a legacy security group attached through a secondary EC2 ENI was not examined.

Each new negative fixture initially returned successful `inspect`/`apply-one` classification. Existing all-stage fixture coverage also began RED while the bounded SSM, ALB lifecycle, evidence-root, policy, and proof behavior was absent.

### Fixes

1. All SSM `send-command` and `get-command-invocation` calls pin `af-south-1`, poll a bounded terminal state, and reject pending, failed, malformed, or inconsistent responses before another classification or mutation.
2. UFW parsing now requires exact `ufw show added` and `ufw status numbered` rule sets. Shorthand, broad, missing, duplicate, or unexpected rules block.
3. Security-group inspection now derives every EC2-attached ENI group, requires primary-ENI/top-level agreement, rejects legacy ingress on every attached group, and rejects the ALB group on any EC2 ENI or non-exact ALB ENI.
4. ALB creation has bounded active-state polling; successor facts require an active IPv4 application ALB with exact named ALB ENIs.
5. Bucket-policy validation accepts exactly two statements: constrained ELB log-delivery `PutObject` and TLS deny. Extra statements, principals, actions, resources, or conditions block.
6. `UFW_READY` has only `PROVE_ALB_LOG_DELIVERY`. It sends one body-discarded remote-Host request through `--connect-to`, then requires a bounded log object strictly newer than proof start. Only `{"accessLogDelivered":true}` enters successor facts.
7. Evidence roots reject `/`, symlinks, unsafe parents, ownership, modes, and unsafe `latest.json` links before an AWS/SSM binary can run.
8. State action, successor, and shape data now live in one ordered table. Removed unused private error and state-only constants.
9. Fixture subprocesses now run asynchronously, preventing Vitest worker-heartbeat timeouts while preserving serial fake-AWS/SSM execution.

### GREEN

Focused RED-to-GREEN checks included:

```bash
unset DATABASE_URL TEST_DATABASE_URL VITEST_ALLOW_PILOT_RDS CONFIRM_DISPOSABLE_TEST_DB HMS_DB_TEST_REQUIRED
pnpm exec vitest run tests/remote-edge-provisioner-security.test.ts -t "rejects missing UFW status before mutation" --testTimeout=60000 --maxWorkers=1 --fileParallelism=false --pool=forks --reporter=dot
pnpm exec vitest run tests/remote-edge-provisioner-security.test.ts -t "requires an ALB log object newer than proof start" --testTimeout=60000 --maxWorkers=1 --fileParallelism=false --pool=forks --reporter=dot
pnpm exec vitest run tests/remote-edge-provisioner-security.test.ts -t "rejects legacy secondary-ENI public ingress before mutation" --testTimeout=60000 --maxWorkers=1 --fileParallelism=false --pool=forks --reporter=dot
```

Each passed after its minimal correction.

Final serial DB-free verification:

```bash
unset DATABASE_URL TEST_DATABASE_URL VITEST_ALLOW_PILOT_RDS CONFIRM_DISPOSABLE_TEST_DB HMS_DB_TEST_REQUIRED
pnpm exec vitest run tests/remote-edge-provisioner-security.test.ts --testTimeout=60000 --maxWorkers=1 --fileParallelism=false --pool=forks --reporter=dot
pnpm exec vitest run tests/remote-edge-provisioner.test.ts --testTimeout=60000 --maxWorkers=1 --fileParallelism=false --pool=forks --reporter=dot
pnpm exec vitest run tests/deploy-config.test.ts --testTimeout=60000 --maxWorkers=1 --fileParallelism=false --reporter=dot
pnpm exec tsc -p tsconfig.json --noEmit
bash -n deploy/remote-edge-provisioner.sh deploy/launch-readiness.sh deploy/post-boot-smoke.sh deploy/ops-deploy.sh deploy/ops-restart.sh deploy/ops-reboot.sh deploy/pm2-boot.sh
node --check deploy/remote-edge-state.mjs
git diff --check
```

Results: `38` security fixtures passed, `11` existing provisioner fixtures passed, and `122` deploy-config tests passed. TypeScript, Node syntax, shell syntax, and whitespace checks passed.

The deploy-config suite's fork-pool run hit its unrelated existing Playwright-config timeout after `121` passing tests; isolated reproduction passed, and the same serial suite passed `122/122` using the default worker pool. No production behavior changed for that runner artifact.

### Remaining concern

No live `inspect` or `apply-one` execution was authorized or attempted. Future operator execution still requires re-review approval, a fresh local evidence root, and an `inspect` result that authorizes exactly one returned action.

## Log proof and mutation-fixture re-review remediation — 2026-08-12

Status: `DONE`

Only local fixture binaries ran. No AWS, SSM, secrets, database, Docker, environment sourcing, deployment, DNS, or runtime mutation occurred.

### RED

Added a fresh S3 object fixture at `AWSLogs/845242190536/test-fixture.txt`. Before correction, `PROVE_ALB_LOG_DELIVERY` accepted it solely because its `LastModified` timestamp was newer than proof start:

```bash
pnpm exec vitest run tests/remote-edge-provisioner-security.test.ts -t "rejects a fresh object outside the exact ALB access-log hierarchy" --testTimeout=60000 --maxWorkers=1 --fileParallelism=false --pool=forks --reporter=dot
```

Result: expected failure; provisioner exited `0`.

### Fixes

1. Log proof now derives `app.nava-remote-admin-alb.<resource-id>` from exact named ALB ARN, then accepts only fresh keys with official account, region, valid `YYYY/MM/DD` hierarchy, access-log timestamp/IP/random suffix, and `.log.gz` extension. Missing or malformed keys, test objects, wrong account/region/ALB IDs, connection/health logs, and invalid calendar paths fail closed.
2. Every fake AWS mutation now validates its critical CLI contract before advancing state: SG identities/source/ports, target-group protocol/port/health path, target attributes, ALB topology, bucket controls/policy, ALB logging attributes, WAF scope/default/rule actions, ACL association, listener protocol/port/certificate/fixed-404 action, and UFW SSM command/document/instance/CIDR.
3. Fixture contract exposed Git Bash conversion of `/health`; provisioner now disables MSYS argument conversion for that exact AWS call so AWS CLI receives literal `/health`.

### GREEN

```bash
unset DATABASE_URL TEST_DATABASE_URL VITEST_ALLOW_PILOT_RDS CONFIRM_DISPOSABLE_TEST_DB HMS_DB_TEST_REQUIRED
pnpm exec vitest run tests/remote-edge-provisioner-security.test.ts --testTimeout=60000 --maxWorkers=1 --fileParallelism=false --pool=forks --reporter=dot
pnpm exec vitest run tests/remote-edge-provisioner.test.ts --testTimeout=60000 --maxWorkers=1 --fileParallelism=false --pool=forks --reporter=dot
pnpm exec vitest run tests/deploy-config.test.ts --testTimeout=60000 --maxWorkers=1 --fileParallelism=false --pool=forks --reporter=dot
pnpm exec tsc -p tsconfig.json --noEmit
bash -n deploy/remote-edge-provisioner.sh deploy/launch-readiness.sh deploy/post-boot-smoke.sh deploy/ops-deploy.sh deploy/ops-restart.sh deploy/ops-reboot.sh deploy/pm2-boot.sh
node --check deploy/remote-edge-state.mjs
git diff --check
```

Results: `39` hardened security fixtures, `11` provisioner fixtures, and `122` deploy-config fixtures passed. TypeScript, shell syntax, Node syntax, and whitespace checks passed.

### Remaining concern

No live `inspect` or `apply-one` execution was authorized or attempted. `apply-one` remains blocked pending re-review approval and fresh local `inspect`.

## Official access-log random-suffix correction — 2026-08-12

Status: `DONE`

Only local fixture binaries ran. No AWS, SSM, secrets, database, Docker, environment sourcing, deployment, DNS, or runtime mutation occurred.

### RED

The prior exact-key matcher rejected official-example-style random suffix `20sg8hgm` because it incorrectly required an eight-character lowercase-hex token.

### Fix

The random suffix now accepts only a non-empty opaque alphanumeric token. All security-relevant fields remain exact: account, region, access-log hierarchy, slash-normalized named ALB resource ID, valid UTC timestamp matching the valid directory date, valid IPv4 ALB-node address, and `.log.gz`. Malformed and lookalike fixture keys remain rejected.

### GREEN

```bash
unset DATABASE_URL TEST_DATABASE_URL VITEST_ALLOW_PILOT_RDS CONFIRM_DISPOSABLE_TEST_DB HMS_DB_TEST_REQUIRED
pnpm exec vitest run tests/remote-edge-provisioner-security.test.ts -t "(accepts official-style alphanumeric|rejects malformed official ALB access-log key)" --testTimeout=60000 --maxWorkers=1 --fileParallelism=false --pool=forks --reporter=dot
pnpm exec vitest run tests/remote-edge-provisioner-security.test.ts --testTimeout=60000 --maxWorkers=1 --fileParallelism=false --pool=forks --reporter=dot
pnpm exec vitest run tests/remote-edge-provisioner.test.ts --testTimeout=60000 --maxWorkers=1 --fileParallelism=false --pool=forks --reporter=dot
pnpm exec vitest run tests/deploy-config.test.ts --testTimeout=60000 --maxWorkers=1 --fileParallelism=false --reporter=dot
pnpm exec tsc -p tsconfig.json --noEmit
bash -n deploy/remote-edge-provisioner.sh deploy/launch-readiness.sh deploy/post-boot-smoke.sh deploy/ops-deploy.sh deploy/ops-restart.sh deploy/ops-reboot.sh deploy/pm2-boot.sh
node --check deploy/remote-edge-state.mjs
git diff --check
```

Results: targeted official/negative key contract passed; `47` hardened security fixtures, `11` provisioner fixtures, and `122` deploy-config fixtures passed. TypeScript, shell syntax, Node syntax, and whitespace checks passed.

### Remaining concern

No live `inspect` or `apply-one` execution was authorized or attempted. `apply-one` remains blocked pending re-review approval and fresh local `inspect`.

## Exact-key and regional-mutation re-review remediation — 2026-08-12

Status: `DONE`

Only local fixture binaries ran. No AWS, SSM, secrets, database, Docker, environment sourcing, deployment, DNS, or runtime mutation occurred.

### RED

Fresh but malformed access-log objects initially advanced proof when their timestamp was newer than proof start:

- invalid UTC time (`T2460Z`)
- invalid ALB-node IPv4 (`999.31.0.1`)
- directory date differing from filename timestamp date
- `test`, `health`, and `connection` placeholder tokens

The fake EC2 create-security-group mutation also accepted `--region us-east-1`.

### Fixes

1. Log proof now requires complete official filename semantics: exact account/region/named-ALB hierarchy, valid UTC timestamp, valid and matching directory date, valid IPv4 ALB-node address, exact eight-character lowercase-hex random token, and `.log.gz`.
2. The fake mutation transition boundary now requires `--region af-south-1` for every AWS regional mutation. Production mutation commands already pin this region; all stage fixtures now enforce it.

### GREEN

```bash
unset DATABASE_URL TEST_DATABASE_URL VITEST_ALLOW_PILOT_RDS CONFIRM_DISPOSABLE_TEST_DB HMS_DB_TEST_REQUIRED
pnpm exec vitest run tests/remote-edge-provisioner-security.test.ts --testTimeout=60000 --maxWorkers=1 --fileParallelism=false --pool=forks --reporter=dot
pnpm exec vitest run tests/remote-edge-provisioner.test.ts --testTimeout=60000 --maxWorkers=1 --fileParallelism=false --pool=forks --reporter=dot
pnpm exec vitest run tests/deploy-config.test.ts --testTimeout=60000 --maxWorkers=1 --fileParallelism=false --pool=forks --reporter=dot
pnpm exec tsc -p tsconfig.json --noEmit
bash -n deploy/remote-edge-provisioner.sh deploy/launch-readiness.sh deploy/post-boot-smoke.sh deploy/ops-deploy.sh deploy/ops-restart.sh deploy/ops-reboot.sh deploy/pm2-boot.sh
node --check deploy/remote-edge-state.mjs
git diff --check
```

Results: `46` hardened security fixtures, `11` provisioner fixtures, and `122` deploy-config fixtures passed. TypeScript, shell syntax, Node syntax, and whitespace checks passed.

### Remaining concern

No live `inspect` or `apply-one` execution was authorized or attempted. `apply-one` remains blocked pending re-review approval and fresh local `inspect`.
