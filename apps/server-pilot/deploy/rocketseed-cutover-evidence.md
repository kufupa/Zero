# Rocketseed cutover evidence

Redacted operator template. Task 1 ships tooling only: no certificate check, SMTP
connection, credential lookup, or probe send was executed.

## Safety boundary

- Autonomous sender/auth identity: `n***@legacyhotels.co.za` only.
- Autonomous recipients: `n***@legacyhotels.co.za` and `a***@gmail.com` only.
- Nava self-send: exactly one generated synthetic PDF permitted.
- Gmail canary: attachment forbidden.
- Manual mode: reserved for a separately approved Centurion probe; never infer approval from this document.
- Never record credentials, secret ARNs, message bodies, raw MIME, full local parts,
  cookies, or session values.
- Store screenshots outside public artifacts. Check screenshot contents for bodies and
  full addresses before retention.

## Run metadata

- Evidence ID: `<unique-redacted-id>`
- UTC start/end: `<timestamp>` / `<timestamp>`
- Operator/orchestrator: `<redacted-role>`
- Source commit: `<sha>`
- Target host: `<hostname-or-private-ip>`
- Port: `<port>`
- Probe mode: `autonomous-nava`
- Outcome: `NOT_RUN | PASS | FAIL`

## STARTTLS and certificate

- STARTTLS offered: `<yes/no>`
- STARTTLS negotiated: `<protocol/cipher>`
- TLS server name: `<certificate-valid-hostname>`
- Chain verification: `<pass/fail>`
- Certificate SANs: `<redacted-or-public-hostnames>`
- Issuer: `<issuer>`
- Valid from / expires: `<timestamps>`
- EHLO capabilities: `<capability names only>`
- AUTH mechanism: `<mechanism name only>`

Hard fail: invalid hostname/chain, missing STARTTLS, `secure !== false`,
`requireTLS !== true`, or `rejectUnauthorized !== true`. Never use
`MAIL_TLS_REJECT_UNAUTHORIZED=false`.

## Probe 1 — Nava self-send

- Subject token: `<unique-token>`
- Header From: `n***@legacyhotels.co.za`
- MAIL FROM: `n***@legacyhotels.co.za`
- RCPT TO: `n***@legacyhotels.co.za`
- Synthetic PDF count: `1`
- SMTP response: `<redacted-response>`
- Message-ID: `<message-id>`
- Accepted: `<redacted-addresses>`
- Rejected: `<redacted-addresses>`
- `X-Zero-Mailbox`: `<present/absent; redacted value>`
- `X-Zero-Outbound-Id`: `<present/absent; redacted value>`

## Probe 2 — Gmail canary

- Subject token: `<unique-token>`
- Header From: `n***@legacyhotels.co.za`
- MAIL FROM: `n***@legacyhotels.co.za`
- RCPT TO: `a***@gmail.com`
- Attachment count: `0` (required)
- SMTP response: `<redacted-response>`
- Message-ID: `<message-id>`
- Accepted: `<redacted-addresses>`
- Rejected: `<redacted-addresses>`

SMTP acceptance proves relay acceptance only. Inbox delivery, banner appearance, and
trusted receiving-MTA authentication remain human checks.

## Rocketseed and MIME evidence

- Approved Nava Rocketseed marker: `<marker>`
- Banner count: `<must equal 1>`
- Banner SHA-256: `<sha256>`
- CID set: `<CID identifiers only>`
- Screenshot reference: `<redacted-path-or-ticket>`
- PDF preserved: `<yes/no>`
- PDF SHA-256 / bytes: `<sha256>` / `<size>`
- Correlation preserved: `<X-Zero-Outbound-Id | X-Zero-Mailbox | original Message-ID>`
- Self-BCC preserved: `<yes/no/not-applicable>`
- Thread headers preserved: `<In-Reply-To/References present; no values>`
- Relay loop observed: `<must be no>`

## Human final checks

- Nava UI shows correct banner exactly once: `<pending/pass/fail>`
- Gmail UI shows correct banner exactly once: `<pending/pass/fail>`
- Topmost trusted Gmail `Authentication-Results`: SPF aligned `<result>`, DKIM aligned
  `<result>`, DMARC `<result>`
- Separate Centurion banner mapping: `<pending approved canary or written Rocketseed configuration>`

## Gate decision

Autonomous Nava proof passes only when one authenticated endpoint/credential works,
STARTTLS hostname and chain validate, Nava banner appears exactly once, one correlation
field survives, no relay loop occurs, PDF/self-BCC/thread headers survive, and Gmail
accepts the canary over SMTP.

Production cutover stays blocked until human Nava/Gmail checks, aligned trusted Gmail
SPF/DKIM/DMARC, and separate Centurion mapping evidence all pass.

Decision: `BLOCKED | READY_FOR_HUMAN_CHECK | PASS`  
Blocker/RCA reference: `<redacted-reference>`
