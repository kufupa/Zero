# Centurion day-one operations

## Internal HTTPS contract

- Canonical URL: `https://nava.legacyhotels.co.za`.
- Hotel internal DNS resolves the canonical hostname to the Nava EC2 OpenVPN address.
- Authorized Centurion LAN and approved staff-VPN devices may reach TCP 443.
- Public DNS remains absent. EC2 security groups retain zero ingress. UFW allows TCP 443 only on `tun0`.
- Staff must close the old tab, finish pending draft/send work, open the canonical bookmark, and log in again. Browser-origin state does not migrate.
- Direct attachments use five-minute presigned S3 URLs. S3 Block Public Access remains fully enabled.

## Remote admin ALB gates

Remote admin is companion plane only: `https://nava-admin.trynava.io` uses public ALB TLS `:443`, then target HTTP `:8443` to the isolated `remote-http` loopback process. It does not change legacy `https://nava.legacyhotels.co.za`, its internal DNS, zero legacy SG ingress, or exact `tun0:443` UFW rule.

1. Run read-only preflight in `apps/server-pilot/deploy/aws-resources.md`. Stop if account `845242190536`, `af-south-1`, VPC `vpc-0f078e17a5f0f8599`, instance `i-008f737974a9ba9b3`, fixed target private IP, ALB subnets, existing target ingress, or required permissions do not match. Lovable DNS edit authority is already confirmed.
2. Request only the ACM certificate for `nava-admin.trynava.io`; record certificate ARN and ACM validation CNAME in sanitized evidence. This is Gate A. Do not create secret, ALB, listener, target group, security group, WAF, bucket, CORS update, target registration, host rule, DNS record, or EC2/UFW change before approval.
3. Operator saves ACM CNAME, then replies **“ACM CNAME saved”**. Poll certificate issuance for no more than 45 minutes. If it does not become `ISSUED`, record evidence and stop.
4. After issuance, use idempotent provision steps in `aws-resources.md`. ALB listener must default to fixed `404`; do not register target or add priority-10 host-forward rule before Task 5 remote readiness is green.
5. Gate B starts only after ALB DNS exists. Operator saves `nava-admin.trynava.io` CNAME, then replies **“nava-admin CNAME saved”**. Poll DNS no more than 45 minutes. Only after it settles may operator apply additive S3 GET/HEAD CORS through documented read-before-write, semantic-readback, and compare-before-rollback procedure.

Normal deploy runs remote pre-registration readiness after loopback and Nginx health:

```bash
bash apps/server-pilot/deploy/ops-deploy.sh
```

It invokes:

```bash
cd /home/ubuntu/repos/zero && \
  REMOTE_ADMIN_MODE=1 REMOTE_TARGET_HEALTH_REQUIRED=0 REMOTE_ADMIN_LIFECYCLE_MODE=auto \
  bash apps/server-pilot/deploy/launch-readiness.sh
```

Treat any remote readiness failure as a stop. Both remote modes retain `vpn-health-assert.sh`; a default route through `tun0` is a hard failure.

## Cutover gates

1. Ronny's completion email is accepted as the network configuration handoff; runtime address and LAN/VPN checks still must pass.
2. Focused DB-free Vitest, both builds, and shell syntax pass.
3. Certificate hostname, key match, chain, and 30-day life checks pass.
4. Pre-cutover SHA plus env/hosts/Nginx/cert/CORS/UFW snapshots exist.
5. `/api/public/providers` reports Google disabled. If Google is enabled, register `https://nava.legacyhotels.co.za/api/auth/callback/google` before continuing.
6. Deploy with `DO_MIGRATE=0` while UFW 443 remains closed.
7. Trusted on-box TLS, headers, wrong-host rejection, login, and hard reload pass.
8. Open only `tun0` TCP 443, then require launch-readiness `READY`.
9. Prove one Centurion LAN workstation, one VPN-only workstation, and one non-hotel negative path.
10. Keep legacy CORS for 24 hours, then remove only that origin after a clean readback comparison.

## Rollback contracts

- Initial hostname-cutover rollback: delete the UFW tunnel rule first, restore the pinned pre-cutover SHA and runtime backups, and intentionally leave staff access closed. No emergency DNS change is required.
- Future application rollback: deploy the first stable post-cutover SHA while retaining the canonical hostname, trusted certificate, CORS, and UFW perimeter.
- Never wipe, reseed, migrate, or run Vitest against production RDS during rollback.

## Certificate ownership

- Hotel IT owns host-specific replacement issuance through DNS-01.
- Nava operator owns installation, Nginx validation, and trusted browser proof.
- Install replacement by `2026-11-28`; current certificate expiry is `2026-12-28`.
- Launch readiness fails when fewer than 30 days remain.

## Operating guardrails

- Centurion sorting is assisted sorting. AI may classify queues; human operator validates priority and owns every reply/send decision.
- Production gates: `MAIL_TRANSPORT_MODE=real`, `BETTER_AUTH_URL=https://nava.legacyhotels.co.za`, `UNDO_SEND_SECONDS=30`, `AI_WRITE_GATE_ENABLED=true`, `AI_DRAFTS_ENABLED=false`.
- Never run Vitest with production `DATABASE_URL`. Never set `VITEST_ALLOW_PILOT_RDS=1` during day-one operations.
- Never use Force Sync, compose, reply, draft, or send as part of health proof. Use read-only gate.

## Database compatibility and mail recovery

Deploy, restart and boot verify the committed migration ledger and required ORM schema before activating workers. Deploy refuses pending migrations; use `ops-deploy.sh --migrate` only after reviewing the additive SQL. An unknown newer ledger also refuses activation: use a reviewed compatible release rather than bypassing the gate.

A database/schema failure retains POP3 mail without spending malformed-MIME retries. A genuine malformed message still reaches bounded quarantine. An empty POP3 inbox alone does not prove intake health; compare recent persisted messages, quarantine reasons and worker failures.

Recover `parse_failure` raw mail using `scripts/recover-parse-failure.ts --dry-run`, then a small `--limit 10` batch and reconciliation before larger batches. Recovery defaults to no AI enqueue, preserves source dates/direction/attachments, and reports opaque row IDs with safe residual codes. Historical recovered mail requires a separate bounded AI catch-up decision. Never run the test suite against production.

The required `pnpm --dir apps/server-pilot test:ingestion` gate needs explicit `TEST_DATABASE_URL` and `CONFIRM_DISPOSABLE_TEST_DB=1` against disposable PostgreSQL 16. It creates owned temporary databases, applies the committed migrations, and fails if the DB is missing or unreachable.

## Mandatory watch cadence

Run readiness:

1. Before customer session.
2. After every deploy or restart.
3. Midday.
4. End of day.

```bash
bash apps/server-pilot/deploy/launch-readiness.sh
```

Expected JSON status: `READY`. Stop launch on any critical failure. Current monitoring mode is manual: no CloudWatch alarm or SNS notification path exists.

Run customer-visible proof on EC2 through SSM:

```bash
bash apps/server-pilot/deploy/ssm-run-command.sh \
  'cd /home/ubuntu/repos/zero && bash apps/server-pilot/deploy/playwright-real-mail-ui-gate.sh --read-only'
```

Ronny's completion email satisfies the network configuration handoff. Runtime address, Centurion LAN, staff-VPN, and non-hotel negative checks remain mandatory. Do not add EC2 security-group ingress.

## Queue sweeps

At each watch point:

1. Sweep **At Risk** first. Escalate time-boxed, cancellation, payment, and delivery-risk items to human owner.
2. Sweep **New Bookings**. Confirm new enquiries have correct ownership and no stale unanswered item.
3. Sweep **Groups & Events**. Confirm group/event requests have human follow-up.
4. Sweep **Ops**. Confirm operational notices and automation mail are not hiding revenue work.
5. Recheck uncategorized/new arrivals. Assisted sorting can be wrong; queue placement is not proof of completion.
6. Check readiness backlog counts and latest inbound timestamp. Nonterminal backlog, or dead-letter rows finished in the last 24 hours, blocks green status. Older (historical) terminal dead-letter count is an observation for operator review and does not alone block READY.

Do not send from monitoring session unless human operator intentionally enters normal mailbox workflow.

## Incident response

1. Stop customer action. Preserve evidence; do not wipe, reseed, migrate, or run tests against production RDS.
2. Capture redacted readiness JSON and PM2 status. Never copy environment values or private mail into tickets.
3. Apply the matching rollback contract above. For initial hostname cutover, remove the UFW `tun0` TCP 443 allow before restoring the pinned SHA and snapshots.
4. Confirm deployed SHA and restored runtime files match the pre-cutover evidence.
5. Keep staff access closed until launch readiness and the read-only UI gate pass again.

## Accepted residuals requiring owner action

- RDS is Single-AZ (`multiAZ=false`). Instance/AZ failure remains launch risk.
- Alerting is absent. Manual watch cadence is mandatory until CloudWatch alarms plus SNS routing are approved and tested.
- S3 lifecycle currently expires raw MIME after 30 days and attachments after 90 days. Customer must approve or replace this 30/90-day retention policy.
- S3 versioning state is reported by readiness and is not changed automatically.
- RDS deletion protection prevents resource deletion; it does not prevent SQL mutation. Production-RDS Vitest ban remains primary wipe control.
- Launch readiness fails on dead-letter rows finished in the last 24 hours. Older terminal dead-letter rows are reported in observations and still need operator review, but do not alone block READY.
