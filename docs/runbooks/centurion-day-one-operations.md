# Centurion day-one operations

## Launch contract

- Safe rollback SHA: `b6dddca299a28ed06282cc0fadfab7cd169c3f9c`.
- Centurion sorting is assisted sorting. AI may classify queues; human operator validates priority and owns every reply/send decision.
- Production gates: `MAIL_TRANSPORT_MODE=real`, `BETTER_AUTH_URL=https://nava.legacy.local`, `UNDO_SEND_SECONDS=30`, `AI_WRITE_GATE_ENABLED=true`, `AI_DRAFTS_ENABLED=false`.
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

Zero-ingress security group plus loopback hostname supports on-box proof only. Hotel workstation access needs separately approved network topology; do not improvise ingress.

## Queue sweeps

At each watch point:

1. Sweep **At Risk** first. Escalate time-boxed, cancellation, payment, and delivery-risk items to human owner.
2. Sweep **New Bookings**. Confirm new enquiries have correct ownership and no stale unanswered item.
3. Sweep **Groups & Events**. Confirm group/event requests have human follow-up.
4. Sweep **Ops**. Confirm operational notices and automation mail are not hiding revenue work.
5. Recheck uncategorized/new arrivals. Assisted sorting can be wrong; queue placement is not proof of completion.
6. Check readiness backlog counts and latest inbound timestamp. Any nonterminal or dead-letter backlog blocks green status.

Do not send from monitoring session unless human operator intentionally enters normal mailbox workflow.

## Incident and rollback

1. Stop customer action. Preserve evidence; do not wipe, reseed, migrate, or run tests against production RDS.
2. Capture redacted readiness JSON and PM2 status. Never copy environment values or private mail into tickets.
3. Exact rollback entrypoint:

```bash
GIT_BRANCH=EC2-pilot bash apps/server-pilot/deploy/ops-deploy.sh
```

4. Confirm deployed SHA equals `b6dddca299a28ed06282cc0fadfab7cd169c3f9c`.
5. Rerun launch readiness and read-only UI gate before resuming.

## Accepted residuals requiring owner action

- RDS is Single-AZ (`multiAZ=false`). Instance/AZ failure remains launch risk.
- Alerting is absent. Manual watch cadence is mandatory until CloudWatch alarms plus SNS routing are approved and tested.
- S3 lifecycle currently expires raw MIME after 30 days and attachments after 90 days. Customer must approve or replace this 30/90-day retention policy.
- S3 versioning state is reported by readiness and is not changed automatically.
- RDS deletion protection prevents resource deletion; it does not prevent SQL mutation. Production-RDS Vitest ban remains primary wipe control.
- Launch readiness fails on dead-letter rows finished in the last 24 hours. Older terminal dead-letter rows are reported in observations and still need operator review, but do not alone block READY.
