---
title: MAIL_TRANSPORT_MODE Fixture vs Real Transport Pattern
date: 2026-07-02
category: architecture-patterns
module: server-pilot mail ingest
problem_type: architecture_pattern
component: email_processing
severity: medium
applies_when:
  - EC2 deploy gates need prod RDS exercise without real Exchange POP3/SMTP
  - IT handoff flips MAIL_TRANSPORT_MODE from fixture to real with one env change plus redeploy
tags:
  - mail-transport-mode
  - fixture
  - pop3
  - smtp
---

# MAIL_TRANSPORT_MODE Fixture vs Real Transport Pattern

## Context

The EC2 pilot is production-scoped — three mailboxes, roughly 1k messages/day — but IT has not yet handed over Exchange POP3/SMTP credentials. The backend must run on real RDS and S3 while mail server TCP connections stay off. `MAIL_TRANSPORT_MODE` (`fixture` | `wire` | `real`) lets fake, Mailpit, and Exchange adapters share identical interfaces and the same downstream persistence path (S3 → Postgres transaction → message row).

## Guidance

### Mode matrix

| Setting | `fixture` (default) | `wire` | `real` |
|---------|---------------------|--------|--------|
| POP3 | `FakePop3Client` + fixture `.eml` dir | `RealPop3Client` → Mailpit | `RealPop3Client` |
| SMTP | `FakeSmtpTransport` ring buffer | `RealSmtpTransport` → Mailpit | `RealSmtpTransport` (nodemailer) |
| TCP to mail server | None | `127.0.0.1` Mailpit sidecar | VPN route to Exchange |
| Downstream path | Same store/ingest transaction | Identical | Identical |

### Factory pattern

`createPop3Client(env)` returns Fake when `MAIL_TRANSPORT_MODE` is `fixture` **even if** `POP3_HOST` is set — prevents accidental real connect during deploy gates.

`createPop3Client` / `createSmtpTransport` use real TCP clients when mode is `wire` or `real`.

`maybeEnqueueLoopback` is disabled for `wire` and `real` — wire path must not use `FixtureLoopbackStore`.

### Wire gate (Option B — pre-IT)

`wire-gate.sh` runs `MAIL_TRANSPORT_MODE=wire` vitest against Mailpit on prod RDS. **Not** part of every deploy — `fixture-loopback-gate.sh` stays the fast daily gate. PM2 `mailpit` binds `127.0.0.1` only.

### Autonomous deploy gate (fixture on prod RDS)

Post-deploy with `MAIL_TRANSPORT_MODE=fixture`:

1. Login → inbox 200
2. Worker runs one bounded FakePop3 cycle — idempotent UIDLs
3. PM2 logs show `transport.mode=fixture`; no TCP to mail ports

### IT handoff

`activate-real-mail.sh`: store secrets → VPN route check → POP3/SMTP smoke → set `MAIL_TRANSPORT_MODE=real` → redeploy → one real ingest cycle with `--max-messages 1`.

## Why This Matters

Without fixture mode, deploy gates either skip ingest (untested store path) or require live Exchange (blocked by IT). Fake adapters mirroring real interfaces mean code exercised on every deploy is the same code IT will activate.

## When to Apply

- **Now:** `MAIL_TRANSPORT_MODE=fixture` on EC2 (default if unset).
- **Pre-IT:** run `wire-gate.sh` via SSM for Mailpit TCP confidence.
- **After IT handoff:** flip to `real`, run handoff script, verify one ingest cycle.
- **Never:** set `real` before security Wave 1 gate passes and IT relay rules documented.

## Examples

```bash
# Pilot .env.production
MAIL_TRANSPORT_MODE=fixture
INGEST_FIXTURE_DIR=/home/ubuntu/repos/zero/apps/server-pilot/tests/fixtures
```

## Related

- [2026-07-02-ec2-pilot-bug-fixes.md](../../superpowers/plans/2026-07-02-ec2-pilot-bug-fixes.md) (Task 19)
- [deferred-real-mail-readiness.md](../../../apps/server-pilot/deploy/deferred-real-mail-readiness.md)
