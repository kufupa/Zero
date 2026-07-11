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

### Inbox folder (listThreads)

Pilot inbox listing includes only non-trashed, non-archived threads with at least one **inbound** message and without the SPAM label. Outbound-only compose threads belong in **sent**, not inbox. Test fixtures must seed inbound messages when asserting inbox visibility.

### Draft lifecycle status

`mail_draft.status` state machine: `active` (the one editable draft), `candidate` (AI-generated, not yet promoted), `discarded` (superseded/abandoned), `sent`. Paired with `origin` (`manual | ai`), `replyToMessageId` (parent for stale checks), and `generationId` (AI provenance). Visible draft queries return `active` + `candidate` only.

### Refresh-safe draft persistence

Draft compose behavior where a body-first draft is persisted server-side early (via `shouldPersistDraft`, keyed on meaningful change not on complete recipients/subject) and a late server refetch never overwrites unsaved local edits (via `chooseDraftEditorState` dirty-state tiebreaker). Prevents losing a user-typed reply on refresh/navigation.

### Stale draft (STALE_DRAFT)

A reply draft whose `replyToMessageId` predates a newer inbound message on the same thread. Server `mail.send` raises `TRPCError({ code: 'CONFLICT', message: 'STALE_DRAFT' })`; the SPA asks the user and retries only with `confirmStaleDraft: true`. Detection is server-owned; the client just surfaces the conflict.

### Draft promotion (ensureEditableForReply)

Atomic server mutation that returns an editable `active` draft for a reply: existing active wins, else the newest `candidate` for the same parent promotes in place and older sibling candidates become `discarded`. One transaction so double-click / two-tab editor opens are idempotent and cannot create duplicate active drafts.

## Deploy and ops

### Bundle sync

Git-bundle-over-S3 workflow (`sync-ec2-git-bundle.sh`) that updates EC2 code via in-place `git fetch` + `reset --hard` without destroying `node_modules`. Complements normal `git push` to remote.

### Pre-real-ingest gate

The security hardening wave (sanitize HTML, mailbox header trust, RDS TLS, signup guard, etc.) that must pass on EC2 before enabling real POP3/SMTP ingest.

### Manual RDS migrate

Explicit operator step to apply Drizzle SQL migrations against pilot RDS. Not part of `deploy-ec2.sh` so breaking schema changes do not run automatically on every deploy. Requires exporting production env (`set -a` before sourcing `.env.production`) so child migrate processes inherit `DATABASE_URL`.

### Patch-fragment truncation

Autonomous-agent editing failure where a plan snippet is written as the entire file, leaving only the new hunk and dropping the file's head and tail. Structural (missing imports/exports), distinct from CRLF mangling or a bad logic change. Recovery is revert-to-clean-HEAD, not hand-repair.

### False green gate

A verification gate (typecheck, test, or build) reported as passing in a hand-off summary but never executed against the actual working tree — the described fixes were never persisted or committed, so re-running the check on disk reveals the true failures. Distinct from Patch-fragment truncation, where edits are corrupted rather than absent; here the state simply never matched the claim. Detection and prevention is to re-run the exact gate on disk (ideally in CI) rather than trusting the reported status.

### E2E session mint

Autonomous Playwright gate step that logs in a pilot user non-interactively — POST `/api/auth/sign-in/email` with a password from Secrets Manager — then exports `PLAYWRIGHT_SESSION_TOKEN`/`PLAYWRIGHT_SESSION_DATA` (+ `PLAYWRIGHT_COOKIE_PREFIX`) so `auth.setup.ts` injects a real Better Auth session. Cookie domain/secure derive from `PLAYWRIGHT_BASE_URL`, not hardcoded `localhost`.

### AI gate

EC2/RDS verification step for the AI mail pipeline: runs server-pilot AI contract tests against production Postgres plus spike eval and server build. Includes mocked `bedrock-adapter-contract.test.ts` (fake adapter — `NODE_ENV=test`). Live Bedrock Converse proof is the separate on-demand Bedrock live gate. Distinct from local vitest, which skips RDS-only cases when `DATABASE_URL` is unset.

## AI mail pipeline

### AI workflow run

Durable queue row in `ai_workflow_run` representing one async AI job (triage, candidate draft, or feedback extraction). Claimed by `ai-worker`, idempotent by `idempotency_key`, with retry/dead-letter state.

### Claim fencing

Terminal update invariant on AI workflow runs: `markAiRunSucceeded`, retry, and dead-letter helpers only mutate a row when `claimOwner` and `expectedStates` still match the worker that holds the claim. A stale or reclaimed worker's terminal write returns no row instead of overwriting a newer owner's result.

### Shadow triage

Classifier/eval path that records triage output and metrics without mutating mailbox category, spam, or urgent state until the spike gate enables durable writes.

### AI candidate draft

`mail_draft` with `status='candidate'` and `origin='ai'`, plus immutable `mail_draft_revision(kind='ai_generated')`. Never sends mail autonomously.

### HITL feedback label

Async label set comparing the first `ai_generated` revision to the final `sent` revision (tone, factual, recipient, subject, missing_info, no_edit). Stored as eval metrics, not active memory.

### AI workflow runner

The `ai-worker` PM2 process that claims `ai_workflow_run` rows and executes Mastra workflows against app-owned services. No SMTP/POP3 credentials and no send-capable imports.

### Model adapter

Abstraction boundary for LLM invocation in server-pilot (`ModelAdapter.invoke`). `FakeModelAdapter` returns deterministic JSON for tests and deploy gates; `BedrockModelAdapter` calls Bedrock Converse on `ai-worker`. Selection is env-driven via `createModelAdapter()` — mirrors the mail transport factory pattern (`NODE_ENV=test` always fake; `AI_ENABLED=true` in production uses Bedrock).

### Bedrock live gate

On-demand EC2 verification (`bedrock-live-gate.sh`) that runs one real Converse call via instance role credentials. Distinct from `ai-gate.sh`, which stays on the fake adapter for deterministic spike eval every deploy. Opt-in via `BEDROCK_LIVE_TEST=1`; proves IAM and cross-region Bedrock access without blocking daily deploys.

### AI mail pipeline live gate

Opt-in EC2 proof (`ai-mail-pipeline-live-gate.sh`) composing Mailpit ingest, `ai-worker` Bedrock triage, durable categories, candidate draft persistence, and Playwright browser proof. Requires `BEDROCK_PIPELINE_LIVE_TEST=1`. `AI_WRITE_GATE_ENABLED` and `AI_DRAFTS_ENABLED` default false in production; the live gate sets them explicitly for full proof.
