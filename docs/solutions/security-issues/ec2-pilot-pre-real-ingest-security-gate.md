---
title: EC2 Pilot Pre-Real-Ingest Security Gate
date: 2026-07-02
category: security-issues
module: server-pilot security
problem_type: security_issue
component: authentication
severity: high
applies_when:
  - Enabling real POP3/SMTP ingest on EC2-pilot production backend
  - Pilot signup must stay closed until allowlist env is configured
  - RDS connections must use TLS with rejectUnauthorized before real mail
tags:
  - xss
  - rds-tls
  - pilot-signup
---

# EC2 Pilot Pre-Real-Ingest Security Gate

## Context

A security audit ([2026-07-01-ec2-pilot-security-audit.md](../../superpowers/plans/2026-07-01-ec2-pilot-security-audit.md)) reviewed the EC2-pilot branch. Mailbox isolation was sound, but several trust-boundary gaps would become P0 the moment real email ingest was enabled. A two-wave hardening plan closed these findings before IT provides Exchange POP3/SMTP credentials. Real ingest remains ops-blocked until IT completes Exchange relay rules.

## Guidance

### Wave 1 — Ingest trust (gate before real POP3)

| Finding | Control | Implementation |
|---------|---------|----------------|
| F1 Stored XSS | Server-side HTML sanitization | `sanitize-email-html.ts` in `processEmailContent` |
| F1 UI fallback | No raw HTML render path | `mail-content.tsx` blocks raw-html fallback |
| F2 Mailbox routing | Trust relay-stamped header | `lastHeader()` on `X-Zero-Mailbox` (last occurrence wins) |
| F3 RDS MITM | TLS with CA verification | `rds-ca-global.pem`; `rejectUnauthorized: true` |
| N1 Outbound injection | CRLF / email validation | `validate-outbound.ts` on `mail.send` |
| N2/N3 Ingest bounds | Transaction + size limits | `limits.ts` + `db.transaction` in `store.ts` |

**IT ops requirement:** Exchange must strip inbound `X-Zero-Mailbox` and re-stamp before delivery to `nava@` POP3.

### Wave 2 — Pilot access control

| Finding | Control | Implementation |
|---------|---------|----------------|
| F5 Open signup | Env-gated registration | `PILOT_OPEN_SIGNUP=0`; signup returns 403 |
| F6 Account linking | Restrict email mismatch | `allowDifferentEmails: false` |
| F7 Test injection | NODE_ENV guard | tRPC test short-circuits only when `NODE_ENV === 'test'` |
| F4 Attachment filenames | Safe Content-Disposition | `attachment-filename.ts` RFC 5987 |
| N5 App-shell headers | nginx hardening | HSTS, X-Frame-Options DENY, CSP |
| N4 Cross-account cache | IDB clear on switch | `account-switch-cache.ts` |

### EC2 gate verified 2026-07-02

| Check | Result |
|-------|--------|
| `POST /api/auth/sign-up/email` | **403** signup disabled |
| `curl http://127.0.0.1:8788/health` | `{"ok":true}` |
| nginx headers | HSTS, X-Frame-Options DENY, CSP |
| RDS tests (`NODE_ENV=test`) | **29/29** targeted suite |
| Local full suite | 54 pass / 38 skip |

## Why This Matters

Fixture-only ingest hid XSS and header-forgery seams. Enabling real ingest without this gate would have been immediate stored-XSS and cross-mailbox injection. RDS `rejectUnauthorized: false` encrypted traffic but accepted any certificate.

## When to Apply

- Before flipping `MAIL_TRANSPORT_MODE=real` or running `activate-real-mail.sh`.
- When adding new ingest parsers or mail body render paths.
- On any new pilot environment — set `PILOT_OPEN_SIGNUP=0`; verify 403 on signup.

## Examples

```bash
set -a && source apps/server-pilot/.env.production && set +a
export NODE_ENV=test
pnpm --filter @zero/server test tests/ingest-store.test.ts tests/sanitize-email-html.test.ts
```

## Related

- [2026-07-01-ec2-pilot-security-hardening.md](../../superpowers/plans/2026-07-01-ec2-pilot-security-hardening.md)
- [progress-ledger.md](../../superpowers/plans/handoff-reports/progress-ledger.md)
- [deferred-real-mail-readiness.md](../../../apps/server-pilot/deploy/deferred-real-mail-readiness.md)
