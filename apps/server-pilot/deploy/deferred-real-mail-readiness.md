# Deferred Real-Mail Readiness

Current scope:

- Backend runs on EC2.
- Frontend connects to backend.
- RDS/S3-backed schema works.
- Fixture ingest works.
- Fake SMTP send works.
- Isolation/load/build tests pass.

Explicitly out of scope for this implementation pass:

- Connecting VPN.
- Connecting to Exchange/on-prem POP3/SMTP.
- Sending real email.
- Receiving/deleting real email from `nava@`.
- AI chatbot assistant work.
- workflow-use Chromium/API integration.

Later real-ingest phase gates:

- Start VPN profile provided by IT.
- Verify SSM, RDS, S3 still work after VPN.
- Verify POP3/SMTP reachability.
- **IT transport rule (required):** BCC `nava@legacyhotel.com` and set `X-Zero-Mailbox: centurion@legacyhotel.com` on Centurion-bound copies.
- **Strip rule (required before prod multi-user):** Exchange must remove any inbound external `X-Zero-Mailbox` before applying the internal relay stamp.
- **`nava@` must not be internet-reachable** — only internal BCC copies land there; direct external mail to `nava@` must quarantine (negative test).
- Send test email to Centurion.
- Confirm copied raw mail includes `X-Zero-Mailbox: centurion@legacyhotel.com` as the **last** occurrence (forged earlier values stripped or overridden by relay).
- Run worker against real `nava@` only after fixture/fake tests are green.

## Current no-VPN expectation

```text
AWS STS OK
RDS OK
S3 OK
POP3/SMTP skipped or may fail because real mail connection is deferred
```

## Future after-VPN expectation

```text
AWS STS still OK
SSM still Online from laptop
RDS still OK
S3 OK
POP3/SMTP OK
```

## If VPN breaks AWS/SSM/RDS

- Check `ip route` default route before/after.
- Prefer split tunnel from IT.
- If no split tunnel, add VPC endpoints for `ssm`, `ssmmessages`, `ec2messages`, S3 gateway endpoint, CloudWatch Logs, Secrets Manager where needed.
- Keep RDS in local VPC path; never make RDS public to solve VPN routing.
