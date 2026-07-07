---
title: Nava Fixture Loopback E2E Harness
date: 2026-07-04
category: architecture-patterns
module: server-pilot mail
problem_type: architecture_pattern
component: email_processing
severity: medium
applies_when:
  - Proving send-to-ingest-to-inbox on prod RDS before IT enables real Exchange
  - MAIL_TRANSPORT_MODE=fixture and FakePop3/FakeSmtp are disconnected without a bridge
  - Autonomous EC2 gate must run vitest E2E without Mailpit or manual playbook
tags:
  - nava
  - fixture-loopback
  - e2e
  - fake-pop3
  - ingest
  - ec2-gate
---

# Nava Fixture Loopback E2E Harness

## Context

In fixture mode, `mail.send` and POP3 ingest were two disconnected paths: outbound compose wrote to `FakeSmtp` (sent folder only) while `FakePop3Client` read static `.eml` files. Nothing proved that a user compose would appear in inbox after ingest — a gap before IT hands over real Exchange POP3/SMTP.

Mailpit or a real SMTP/POP3 mock would exercise wire fidelity but adds ops overhead. For pre-IT confidence on **business logic** (routing, isolation, spam, sent vs inbox), a fixture-only in-process bridge closes the loop without TCP.

## Guidance

### Problem shape (before)

```text
mail.send → FakeSmtp (RAM) → sent folder ✅
                ✗ no path to ingest

FakePop3 → static .eml → ingest → inbox ✅
                ✗ never sees compose
```

### Fixture loopback bridge (after)

On `mail.send` in fixture mode, when any recipient normalizes to `INGEST_EMAIL` (`nava@legacyhotel.com`):

1. `FakeSmtpTransport` records the send (sent folder unchanged).
2. `maybeEnqueueLoopback()` builds RFC822 from the outbound payload (including `X-Zero-Mailbox` via `extraHeaders`).
3. `fixtureLoopbackStore` holds the message in an in-memory queue.
4. `FakePop3Client.connect()` drains the queue into the POP3 UIDL list before static fixtures.

```text
compose → mail.send → FakeSmtp + loopback queue
                              ↓
                    FakePop3.connect() drains queue
                              ↓
                    ingestOnce → S3/Postgres
                              ↓
                    listThreads(inbox|sent|spam)
```

**Fixture-only:** `maybeEnqueueLoopback` returns immediately when `MAIL_TRANSPORT_MODE === 'real'`.

**Store starts empty:** existing FakePop3 unit tests unchanged unless a send to `nava@` triggers enqueue.

### Key files

| File | Role |
|------|------|
| `apps/server-pilot/src/mail/fixture-loopback.ts` | Queue, RFC822 builder, `maybeEnqueueLoopback` |
| `apps/server-pilot/src/mail/ingest/pop3-client.ts` | `FakePop3Client` drains loopback on connect |
| `apps/server-pilot/src/trpc/routes/mail.ts` | Calls `maybeEnqueueLoopback` after send |
| `apps/server-pilot/tests/fixture-loopback-e2e.test.ts` | Four integration scenarios |
| `apps/server-pilot/deploy/fixture-loopback-gate.sh` | EC2 autonomous gate (vitest + mail build) |

### E2E scenarios (`fixture-loopback-e2e.test.ts`)

Uses `withSeededTestDb`, `callerFor`, `ingestOnce` — no Playwright, no manual login.

| ID | Scenario | Assert |
|----|----------|--------|
| E2E-1 | Nava sends to `nava@` | Thread in **inbox** after ingest |
| E2E-2 | Ingest `missing-owner.eml` | Thread in **spam** (direct-To routing) |
| E2E-3 | Nava sends to `external@example.com` | **sent** only; not inbox |
| E2E-4 | Nava self-loop + Centurion list | Centurion cannot see Nava thread |

### EC2 gate

```bash
bash apps/server-pilot/deploy/sync-ec2-git-bundle.sh
bash apps/server-pilot/deploy/ssm-run-command.sh \
  'cd /home/ubuntu/repos/zero && bash apps/server-pilot/deploy/fixture-loopback-gate.sh'
```

Gate stops PM2 worker during vitest, runs six test files (40 tests), builds `@zero/mail`, restarts worker. Verified green at `4f38697d` on `i-008f737974a9ba9b3`.

### Limitations (intentional)

- **Not a mail server mock** — no SMTP listener, no POP3 TCP, no cross-mailbox wire relay.
- **Single trigger address** — loopback fires only when recipient matches `INGEST_EMAIL`.
- **Extension path** — replace or augment with Mailpit/real relay for cross-mailbox wire testing when IT creds land.

## Why This Matters

Deploy gates on prod RDS can now prove send→ingest→folder semantics without Exchange. The same ingest/store code path runs in fixture and real modes; only the transport adapter differs. A failed E2E blocks ship before silent regressions in routing or isolation.

## When to Apply

- **Now:** `MAIL_TRANSPORT_MODE=fixture` on EC2; run `fixture-loopback-gate.sh` after Nava-related mail changes.
- **After IT handoff:** keep loopback disabled in `real` mode; use real POP3 for ingest validation separately.
- **When adding cross-mailbox tests:** either extend loopback triggers or introduce a TCP mail mock — loopback alone does not simulate multi-mailbox SMTP relay.

## Examples

Loopback enqueue guard:

```typescript
// fixture-loopback.ts — real mode and non-nava recipients skip
if (mode === 'real') return;
const recipients = [...payload.to, ...payload.cc, ...payload.bcc];
if (!recipientMatchesIngestEmail(recipients)) return;
fixtureLoopbackStore.enqueue(buildLoopbackEml({ ... }));
```

E2E-1 core flow:

```typescript
await nava.mail.send({ to: ['nava@legacyhotel.com'], subject: 'self-loop', ... });
await ingestOnce({ pop3: new FakePop3Client(), db, ingestMailboxId: 'ingest-nava-legacy' });
const inbox = await nava.mail.listThreads({ folder: 'inbox' });
expect(inbox.threads.some((t) => t.subject === 'self-loop')).toBe(true);
```

## Related

- [mail-transport-mode-fixture-vs-real.md](./mail-transport-mode-fixture-vs-real.md) — fixture vs real adapter matrix
- [ec2-pilot-autonomous-deploy-and-ssm-gotchas.md](../workflow-issues/ec2-pilot-autonomous-deploy-and-ssm-gotchas.md) — SSM stdout unicode fix for gate observability
- [2026-07-04-nava-fixture-loopback-autonomous-e2e.md](../../superpowers/plans/2026-07-04-nava-fixture-loopback-autonomous-e2e.md) — implementation plan
- [2026-07-04-nava-loopback-gate-report.md](../../superpowers/plans/handoff-reports/2026-07-04-nava-loopback-gate-report.md) — gate report
