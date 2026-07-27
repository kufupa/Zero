# Concepts

> Shared domain vocabulary for this project — entities, named processes, and status concepts with project-specific meaning. Seeded with core domain vocabulary from EC2-pilot work, then accretes via ce-compound; direct edits are fine. Glossary only, not a spec or catch-all.

## Mail pilot domain

### Server-pilot

The production-shaped per-mailbox email backend running on EC2 (`apps/server-pilot`). Replaces the legacy Cloudflare Workers `@zero/server` for the Centurion hotel pilot. Exposes tRPC routes the `apps/mail` SPA calls over HTTP.

### Mailbox transport

A logical mail account boundary (e.g. Centurion front-desk inboxes). Staff users gain access through mailbox access rows; the active transport ID scopes queries and cache keys in the SPA.

### Ingest mailbox

The single POP3 sink account (`navaai@legacyhotels.co.za` on the hotel Zimbra pilot) that the EC2 worker drains. Hotel BCC / header-routing waves may still stamp `X-Zero-Mailbox` so messages land in the correct logical mailbox transport. Older docs may say `nava@legacyhotel.com` — that identity was replaced for the real-mail cutover.

*Avoid: treating Centurion as a second POP3 account; Centurion remains a mailbox transport only.*

### Unstamped Centurion routing

When `INGEST_REQUIRE_OWNER_HEADER=false`, sink mail without `X-Zero-Mailbox` still routes: direct-To an active transport email (e.g. `navaai@`) wins first; else To/Cc/Bcc/From matching the Centurion transport email or its `send_from_config.aliases` lands on Centurion. Unknown unstamped mail still quarantines. Stamp present → header/alias lookup unchanged. Pilot deferral until IT stamps; not a replacement for relay stamp/strip.

### Quarantine promote

Ops one-shot (`promote-quarantine.ts`) that re-runs S3-stored quarantine MIME through `persistInboundMessage` (atomic quarantine delete) so backlog leaves quarantine into the correct transport and inbound triage enqueues normally.


### MAIL_TRANSPORT_MODE

Environment switch controlling whether POP3/SMTP use fixture adapters (in-memory / fixture files, no TCP to hotel mail), wire adapters (real TCP to localhost Mailpit), or real adapters (hotel Zimbra/Exchange). Live EC2 pilot runs `real`; fixture remains the autonomous/local default and wire is the pre-IT Mailpit gate. Flip modes without code changes.

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

Draft compose behavior where a body-first draft is persisted server-side early (via `shouldPersistDraft`, keyed on meaningful change not on complete recipients/subject) and a late server refetch never overwrites unsaved local edits (via `chooseDraftEditorState` dirty-state tiebreaker). Covers what to save and how not to clobber on refresh/refetch; for when leave/navigation must flush first, see Compose leave flush.

### Stale draft (STALE_DRAFT)

A reply draft whose `replyToMessageId` predates a newer inbound message on the same thread. Server `mail.send` raises `TRPCError({ code: 'CONFLICT', message: 'STALE_DRAFT' })`; the SPA asks the user and retries only with `confirmStaleDraft: true`. Detection is server-owned; the client just surfaces the conflict.

### Draft promotion (ensureEditableForReply)

Atomic server mutation that returns an editable `active` draft for a reply: existing active wins, else the newest `candidate` for the same parent promotes in place and older sibling candidates become `discarded`. One transaction so double-click / two-tab editor opens are idempotent and cannot create duplicate active drafts.

### One active draft per thread

Invariant that a mailbox transport may have at most one `active` draft on a given thread. Creates that omit an existing draft id must update that row rather than insert a second active draft. Distinct from Draft promotion, which also collapses candidates into a single editable active.

### Compose leave flush

Named leave path that persists the mounted reply/compose editor before navigation clears compose URL state or switches the selected thread. Thread-switch leave flushes silently; explicit close may prompt instead. Complements Refresh-safe draft persistence (what to save / how not to clobber) with when to run that save relative to navigation.

### Compose-close honesty

Staff-facing close contract for reply compose: empty close is silent; dirty explicit close offers Keep editing / Save draft / Discard; dirty thread switch flushes without a lying "changes will be lost" Stay/Leave. Distinct from Honesty UI (removing fake chrome) — this is draft lifecycle truthfulness on leave.

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

Autonomous Playwright gate step that logs in a pilot user non-interactively — POST `/api/auth/sign-in/email` with a password from Secrets Manager — then exports `PLAYWRIGHT_SESSION_TOKEN`/`PLAYWRIGHT_SESSION_DATA` (+ `PLAYWRIGHT_COOKIE_PREFIX`) so `auth.setup.ts` injects a real Better Auth session. Cookie domain/secure derive from `PLAYWRIGHT_BASE_URL`, not hardcoded `localhost`. For the real-mail U9 gate, browser form login is the proof path; mint remains assist-only and does not replace AE1.

### U9 gate

Ephemeral Playwright real-mail UI proof on EC2 (`playwright-real-mail-ui-gate.sh`) against the live SPA host and hotel mailbox. Covers browser login, compose self-loopback, Force Sync loopback, and reply loopback. Requires real transport, host-matched auth URL, and a zero undo window for deterministic flush — then product undo must be restored.

### Force Sync

Operator-triggered one-shot ingest from the SPA debug menu: calls `forceSync` → `ingestOnce` under a mailbox lock and invalidates thread queries so new mail appears without a full page reload. Complements the default thread poll interval; does not replace always-on POP3 draining.

### Open-thread poll

Foreground React Query refresh of the mounted thread-detail fetch (`mail.get` via `useThread`), using the same interval policy as the thread list. List poll alone can bump a conversation to the top while an already-open pane stays on a stale message snapshot until navigation or hard refresh.

### Recipient You-collapse

Display rule that rewrites a single **To** address as the friendly label **You** only when that address is the active mailbox. Must not fire for outbound messages merely because the route folder is inbox rather than sent.

### Undo send window

Seconds outbound mail sits in the undo/schedule queue before SMTP flush (`UNDO_SEND_SECONDS`). Product UX uses a human-scale window; automated U9 sets the window to zero so compose/reply assertions are not racing the queue, then restores the product value after the gate.

### AI gate

EC2/RDS verification step for the AI mail pipeline: runs server-pilot AI contract tests against production Postgres plus spike eval and server build. Includes mocked `bedrock-adapter-contract.test.ts` (fake adapter — `NODE_ENV=test`). Live Bedrock Converse proof is the separate on-demand Bedrock live gate. Distinct from local vitest, which skips RDS-only cases when `DATABASE_URL` is unset.

### Always-on OpenVPN

The systemd-managed hotel OpenVPN client on the pilot EC2 that stays connected across reboots and process crashes without restaging credentials on every deploy. Unit name in ops is `openvpn-client@nava`. Install is one-shot (stage → confidence → enable); day-to-day deploy only asserts health.

### Split tunnel

Routing posture where only the hotel LAN prefix goes over the VPN tunnel, while the instance default route stays on the AWS ENI. Required so SSM, STS, RDS, and S3 remain reachable while hotel mail/Infor are reachable. Name resolution stays on the AWS resolvers — VPN-pushed DNS is ignored — so hotel-internal hostnames that lack public A records need a local hosts override on the pilot.

### Infor HMS

Hotel property-management web application on the hotel LAN, opened in a browser over always-on OpenVPN. Staff and pilot automation use a hostname that must match the server TLS certificate; when that name is not in public DNS, the EC2 pilot maps it locally rather than adopting hotel DNS.

### HOST_ROUTE

The instance default IPv4 route via the VPC gateway on the ENI (not via `tun`). Used as the live proof that split tunnel has not hijacked AWS egress.

### VPN HARD assert

Fail-closed health checks for always-on OpenVPN: unit active, HOST_ROUTE intact, hotel prefix route present, and AWS STS reachable. A HARD failure aborts post-boot smoke and ops-deploy.

### VPN SOFT assert

Best-effort hotel TCP probe that warns without failing deploy when the hotel side is briefly unreachable. Can be flipped to fail-closed with an explicit probe-required flag for real-mail activation paths.

### Post-boot smoke

Systemd oneshot (`nava-post-boot-smoke.service`) that runs after PM2 (and wants always-on OpenVPN) to verify nginx, `:8788`, `:443`, PM2 `http`, and VPN HARD health before declaring reboot recovery green.

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

## Hotel taxonomy UI

### Hotel category

An AI-managed mailbox classification (primary: internal, individual, group, travel-agents; overlay: urgent) stored as durable memberships on threads. Distinct from system folders (inbox/sent/spam/trash via thread flags) and from user Labels (soft tags / quarantine). Staff see them in the sidebar as **Folders**.

### categoryIds filter

List/query wire that filters threads by hotel category UUIDs — never by Label ids. Presentation titles and pastels are render-time only; selection and URL state stay on UUIDs.

### Hotel folder presentation

Frontend overlay that maps managed category slugs to demo-grade titles, subtitles, Centurion pastel nav/pill themes, and urgent stripe. Managed-slug display ignores seed DB hex; unknown/custom categories may still use stored color.

### Centurion pastel theme

The pastel background/text pair used for primary hotel category chrome (nav rows and pills). Preferred over solid seed hex for managed slugs so live pilot matches the FE demo scanability.

### Labels demotion

Sidebar posture where the Labels tree stays available but secondary: always titled Labels (never Folders on mailbox), collapsed by default behind a real collapsible control, so hotel Folders remain the hero taxonomy.

### Honesty UI

Pilot practice of removing or replacing dead/fake affordances (unavailable AI surfaces, demo-only chrome, stub dialogs) with a real staff workflow — or hiding them — rather than leaving an interaction that only announces the feature is off.

*Avoid: keeping a disabled modal as the primary click target; flipping the whole SPA into frontend-only demo mode to recover demo chrome; conflating this with Compose-close honesty (draft Save/Discard/Keep editing).*

## Flagged ambiguities

- **"Folders" on mailbox provider** used to mean the Labels tree; hotel AI categories now own the Folders section title — Labels must never re-use Folders.
- **category color** can mean seed DB hex or Centurion pastel presentation — for managed slugs, presentation wins in UI chrome.
- **"honesty"** had been used for both Honesty UI (hide fake chrome) and Compose-close honesty (draft leave dialog) — these are distinct.
