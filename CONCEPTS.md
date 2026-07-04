# Concepts

> Shared domain vocabulary for this project — entities, named processes, and status concepts with project-specific meaning. Seeded with core domain vocabulary from EC2-pilot work, then accretes via ce-compound; direct edits are fine. Glossary only, not a spec or catch-all.

## Mail pilot domain

### Server-pilot

The production-shaped per-mailbox email backend running on EC2 (`apps/server-pilot`). Replaces the legacy Cloudflare Workers `@zero/server` for the Centurion hotel pilot. Exposes tRPC routes the `apps/mail` SPA calls over HTTP.

### Mailbox transport

A logical mail account boundary (e.g. Centurion front-desk inboxes). Staff users gain access through mailbox access rows; the active transport ID scopes queries and cache keys in the SPA.

### Ingest mailbox

The single POP3 sink account (`nava@`) that receives BCC copies from on-prem Exchange. Messages are routed to the correct mailbox transport using the relay-stamped `X-Zero-Mailbox` header.

### MAIL_TRANSPORT_MODE

Environment switch controlling whether POP3/SMTP use fixture adapters (in-memory / fixture files, no TCP to Exchange), wire adapters (real TCP to localhost Mailpit), or real adapters (Exchange). Pilot default is `fixture`; pre-IT wire gate uses `wire`; IT handoff flips to `real` without code changes.

### Wire transport

`MAIL_TRANSPORT_MODE=wire` — `RealPop3Client` + `RealSmtpTransport` against Mailpit on `127.0.0.1` (ports 11025/11110/18025). Pre-IT confidence for protocol path. Distinct from fixture loopback (in-process) and real (Exchange). Run via `wire-gate.sh`, not every deploy.

### Fixture loopback

In-process bridge (fixture mode only) that enqueues outbound RFC822 to `nava@` into a queue drained by `FakePop3Client` on connect. Closes send→ingest→inbox without a TCP mail server mock. Distinct from Mailpit/real relay — extension path for cross-mailbox wire testing.

### Fixture transport

Fake POP3/SMTP implementations that mirror real adapter interfaces and run the same S3 → Postgres ingest path. Used for autonomous deploy gates on prod RDS before IT enables Exchange connectivity.

### Wire contract

The HTTP/tRPC payload shapes the `apps/mail` frontend actually sends and expects — distinct from TypeScript types imported from legacy `@zero/server`. Pilot backend must accept FE shapes at the router boundary.

### Keyset cursor

Opaque pagination token encoding `(latestMessageAt|id)` used by `mail.listThreads` and `drafts.list`. Page 2+ depends on SQL row comparison — cursor timestamp must bind as `timestamptz`, not raw JS `Date` in tuple literals.

## Deploy and ops

### Bundle sync

Git-bundle-over-S3 workflow (`sync-ec2-git-bundle.sh`) that updates EC2 code via in-place `git fetch` + `reset --hard` without destroying `node_modules`. Complements normal `git push` to remote.

### Pre-real-ingest gate

The security hardening wave (sanitize HTML, mailbox header trust, RDS TLS, signup guard, etc.) that must pass on EC2 before enabling real POP3/SMTP ingest.
