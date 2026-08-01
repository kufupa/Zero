# Centurion day-one operations

## Internal HTTPS contract

- Canonical URL: `https://nava.legacyhotels.co.za`.
- Hotel internal DNS resolves the canonical hostname to the Nava EC2 OpenVPN address.
- Authorized Centurion LAN and approved staff-VPN devices may reach TCP 443.
- Public DNS remains absent. EC2 security groups retain zero ingress. UFW allows TCP 443 only on `tun0`.
- Staff must close the old tab, finish pending draft/send work, open the canonical bookmark, and log in again. Browser-origin state does not migrate.
- Direct attachments use five-minute presigned S3 URLs. S3 Block Public Access remains fully enabled.

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
