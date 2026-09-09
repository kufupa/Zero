# Concepts

> Shared domain vocabulary for this project — entities, named processes, and status concepts with project-specific meaning. Seeded with core domain vocabulary from EC2-pilot work, then accretes via ce-compound; direct edits are fine. Glossary only, not a spec or catch-all.

## Mail pilot domain

### Server-pilot

The production-shaped per-mailbox email backend running on EC2 (`apps/server-pilot`). Replaces the legacy Cloudflare Workers `@zero/server` for the Centurion hotel pilot. Exposes tRPC routes the `apps/mail` SPA calls over HTTP.

### Mailbox transport

A logical mail account boundary (e.g. Centurion front-desk inboxes). Staff users gain access through mailbox access rows; the active transport ID scopes queries and cache keys in the SPA.

### Mailbox access

RDS `mailbox_access` row granting a user a role (`owner` / `admin` / `member`) on one transport, plus `is_default` for which inbox loads after login. `connections.list` returns only granted transports; missing row → FORBIDDEN on that mailbox.

### Mailbox switcher

SPA chrome that calls `connections.setDefault` to flip `is_default` and rescope the mail cache to another granted transport. Shown only when the user has 2+ connections; hidden for single-inbox personas (e.g. Centurion-only login).

### Mail shell

Desktop reading chrome for the mail SPA: fixed app sidebar beside list and thread columns. Layout bands differ: Wide split mounts both columns; Mid-width exclusive panes mounts only one at a time. Wide thread content (Reply composer, long HTML, banner-heavy mail) must stay width-contained inside the thread column; it must not inflate that column’s content width or shove the inbox list sideways off the viewport. Distinct from Mailbox switcher (transport identity chrome) and from folder/category filters inside the list.

### Wide split

Mail-shell layout band where list and thread columns both mount and share a percentage split. The list may collapse to zero width; the thread column must be allowed to grow to fill the group when that happens. Distinct from Mid-width exclusive panes (selection-driven single column).

### Mid-width exclusive panes

Mail-shell layout band on desktop below Wide split where only the list or only the thread mounts, keyed off thread selection. Avoids leaving an empty reading pane when selection clears. Distinct from Wide split (both columns mounted).

### Close-to-inbox

Staff-facing Close/X contract on Mid-width exclusive panes: clearing thread selection returns a list-only shell, never an empty reading pane. Distinct from Compose-close honesty (draft leave prompts) and from Wide split list collapse (Hide inbox / Show inbox).

### Newest-on-top thread display

Reading-pane message order that shows the chronologically newest message first. Wire/`mail.get` order stays oldest → newest; the pane reverses only at the list boundary. `latest` remains the chronological last message (not the first visual row). Reply composer mounts above the target message. Distinct from Mail shell (column chrome) and from inbox list sort.

Thread-level chrome that must stay above the whole message list (notably Thread Attachments) cannot hang on the chronologically oldest message — under newest-on-top that row paints mid-list or last, not at the top.

### Thread Attachments

Reading-pane strip that aggregates downloadable attachments across every message in the open thread and sits above the message list. Distinct from per-message attachment chips under a single message body. When many filenames are present, chips scroll horizontally inside a shrinkable row rather than widening the thread column.

### One-click EML download

Message-header reading action (`.eml` button and three-dots menu item) that exports a single email as an RFC 822 `.eml` file into Chrome/Edge's native download shelf in ~150ms. Bypasses cross-origin browser drag-and-drop restrictions by enabling staff to drag the file directly out of the browser's download shelf into external web enterprise applications like Infor HMS Web (recreating Outlook 2016 desktop drag-and-drop parity). Backed by direct presigned S3 URLs when raw MIME exists and on-the-fly RFC 822 synthesis fallback. Distinct from Thread Attachments (which exports files enclosed within an email).

### Reply action scope

Mail-view distinction between an action attached to a rendered message, which targets that message, and a toolbar, context-menu, or hotkey action, which targets the thread's chronological latest message. This remains true when the reading pane presents messages newest-first; visual position does not redefine the thread-level target.

### Ingest mailbox

The single POP3 sink account (`navaai@legacyhotels.co.za` on the hotel Zimbra pilot) that the EC2 worker drains. Hotel BCC / header-routing waves may still stamp `X-Zero-Mailbox` so messages land in the correct logical mailbox transport. Older docs may say `nava@legacyhotel.com` — that identity was replaced for the real-mail cutover.

*Avoid: treating Centurion as a second POP3 account; Centurion remains a mailbox transport only.*

### Unstamped Centurion routing

When `INGEST_REQUIRE_OWNER_HEADER=false`, sink mail without `X-Zero-Mailbox` still routes: direct-To an active transport email (e.g. `navaai@`) wins first; else To/Cc/Bcc/From matching the Centurion transport email or its `send_from_config.aliases` lands on Centurion. Unknown unstamped mail still quarantines. Stamp present → header/alias lookup unchanged. Pilot deferral until IT stamps; not a replacement for relay stamp/strip.

### Quarantine promote

Ops one-shot (`promote-quarantine.ts`) that re-runs S3-stored quarantine MIME through `persistInboundMessage` (atomic quarantine delete) so backlog leaves quarantine into the correct transport and inbound triage enqueues normally.

### Raw MIME rehydrate

Ops one-shot that rebuilds wiped message rows from durable S3 `raw-mime/` objects (same ingest persist path). Skips keys already present as messages or quarantine; default skips AI triage enqueue so bulk restore does not flood the worker. Distinct from Quarantine promote (which drains quarantine rows) and from intentional pilot DB wipe + seed (which restores transports/auth, not historical mail bodies). Prefer **Pilot RDS PITR rename recovery** when a clean pre-wipe restore window exists and thread/label continuity matters.

### Pilot RDS PITR rename recovery

Ops recovery that restores the live pilot Postgres instance from a **pre-wipe** point-in-time into a temporary identifier, verifies Centurion/inbound counts, then renames the wiped instance aside and renames the restore into the original identifier so the app endpoint hostname stays stable. Distinct from Raw MIME rehydrate (new message IDs from S3) and from DeletionProtection (which only blocks deleting the instance, not SQL/fixture wipes).

*Avoid: restoring from automated snapshots taken after the wipe clock — they capture empty/fixture state.*

### Wipe-safe pilot verify

How to prove seed / mailbox-access / switcher changes on the live EC2 pilot without pointing Vitest at pilot RDS: local unit/guard tests with `DATABASE_URL` unset; live proof via deploy + `CONFIRM_PILOT_SEED` seed (no password rotate unless required) + SQL or `connections.list` semantics. Distinct from intentional RDS gate scripts that set an explicit vitest opt-in.

*Avoid: treating “EC2 vitest green” as the acceptance path for grant or switcher proof after the Jul 2026 wipe.*

### Pilot RDS vitest refuse

Fail-closed Vitest bootstrap that aborts when `DATABASE_URL` points at the live pilot Postgres host unless an explicit opt-in env is set. Catches suites that never use the transactional test-DB helper. Distinct from the intentional pilot wipe confirm gate (operator truncate scripts) and from disposable/local DB test runs. Necessary but not sufficient alone — opt-in shells and non-Vitest mutators can still wipe; see Pilot RDS PITR rename recovery.

### VITEST_ALLOW_PILOT_RDS

Escape-hatch env historically used by intentional RDS-backed deploy gate scripts when they source production env and run Vitest. After the dual-key mutation guard lands, hazard-context connects to pilot also require a second confirm (`CONFIRM_PILOT_MUTATE` or script-specific seed/wipe confirm as defined in the mutation-guard plan). Must not be set in casual overnight agent shells. Prefer DB-free gates that unset `DATABASE_URL` so neither key is needed.

### Pilot DB hazard context

Runtime signal that Vitest/`NODE_ENV=test`/explicit guard mode is active — under which opening a connection to the live pilot Postgres host is refused unless dual confirms are present. Distinct from production PM2 runtime, which must keep connecting to pilot without those confirms.

### Rocketseed banner server

Hotel SMTP branding relay (`172.24.0.8` / `branding.legacyhotels.co.za`) that injects signature and top/footer banners before mail reaches Zimbra. **Mandatory sole real-mail SMTP hop** for Zero (`MAIL_TRANSPORT_MODE=real` connects only to `.8:587` STARTTLS, IP-trust, never AUTH); POP3 stays Zimbra `.10`. Banner selection remains **From/sender tenant provisioning**, not SMTP AUTH and not “did the message touch Rocketseed.” Traversal stamps (`X-ExSBR-Direction`, `X-BypassBranding`) appear on branded and unbranded copies alike. Fixture/wire do not use hotel SMTP.

*Avoid: treating relay success or BypassBranding headers as proof banners were injected; treating Nava unbranded mail as a broken relay when Nava is an unprovisioned test/BCC sink; pointing real SMTP at Zimbra `.10`.*

### Audit self-BCC

Outbound practice of BCC'ing the active mailbox transport address on every `mail.send` so Zimbra/Outlook can file a Sent copy and the POP3 sink can ingest a return for reconciliation. Orthogonal to Rocketseed branding. Working-tree killswitch `MAIL_SELF_BCC=false|0|off` may disable it for testing once that gate is committed/deployed; until then, omit BCC on direct probe sends.

*Avoid: assuming the Centurion BCC causes Centurion banners; banners require a provisioned From on the Rocketseed path.*

### MAIL_TRANSPORT_MODE

Environment switch controlling whether POP3/SMTP use fixture adapters (in-memory / fixture files, no TCP to hotel mail), wire adapters (real TCP to localhost Mailpit), or real adapters (hotel path: SMTP → Rocketseed `.8`, POP3 → Zimbra `.10`). Live EC2 pilot runs `real`; fixture remains the autonomous/local default and wire is the pre-IT Mailpit gate. Flip modes without code changes.

### Wire transport

`MAIL_TRANSPORT_MODE=wire` — `RealPop3Client` + `RealSmtpTransport` against Mailpit on `127.0.0.1` (ports 11025/11110/18025). Pre-IT confidence for protocol path. Distinct from fixture loopback (in-process) and real (Rocketseed SMTP + Zimbra POP3). Run via `wire-gate.sh`, not every deploy.

### Fixture loopback

In-process bridge (fixture mode only) that enqueues outbound RFC822 to `nava@` into a queue drained by `FakePop3Client` on connect. Closes send→ingest→inbox without a TCP mail server mock. Distinct from Mailpit/real relay — extension path for cross-mailbox wire testing.

### Fixture transport

Fake POP3/SMTP implementations that mirror real adapter interfaces and run the same S3 → Postgres ingest path. Used for autonomous deploy gates on prod RDS before IT enables Exchange connectivity.

### Wire contract

The HTTP/tRPC payload shapes the `apps/mail` frontend actually sends and expects — distinct from TypeScript types imported from legacy `@zero/server`. Pilot backend must accept FE shapes at the router boundary.

### Keyset cursor

Opaque pagination token encoding `(latestMessageAt|id)` used by `mail.listThreads` and `drafts.list`. Page 2+ depends on SQL row comparison — cursor timestamp must bind as `timestamptz`, not raw JS `Date` in tuple literals.

### Inbox folder (listThreads)

Pilot inbox listing includes only non-trashed, non-archived, non-spam threads (`spam_at` null) with at least one **inbound** message. Spam membership is the spam timestamp, not a user label named SPAM. Outbound-only compose threads belong in **sent**, not inbox. Test fixtures must seed inbound messages when asserting inbox visibility.

*Avoid: treating a legacy SPAM user-label chip as folder truth; inbox eligibility is `spam_at IS NULL`.*

### hasReplied

Shared-inbox list signal meaning “this thread already has at least one outbound message from the mailbox” (ever replied or forwarded). Orthogonal to unread/grey: a guest follow-up can make the row bold again while the replied marker stays. Distinct from Ball-in-court auto-read (which clears unread when we last answered).

*Avoid: treating opened/grey as “already replied.”*

### Ball-in-court auto-read

Shared-inbox product rule that greying means “ball not with us”: when the mailbox’s outbound is the latest answer transition (Nava send or Hotel-sent ingest), mark the whole thread and its messages read so bold/unread tracks work still needing hotel eyes. Distinct from hasReplied (ever answered) and from open-to-mark-read (someone looked).

### Hotel-sent

Inbound POP3/MIME copy whose From matches the active mailbox transport (or its send-from aliases)—typically an Outlook/Zimbra Sent copy filed back through the ingest sink. Persisted as outbound direction for the logical mailbox so shared-inbox reply state and Ball-in-court auto-read can treat it like a Nava send. Excludes self-recipient loopback copies that are not hotel-sent.

*Avoid: treating hotel-sent as a second POP3 account; the sink remains the Ingest mailbox.*

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

EC2/RDS verification step for the AI mail pipeline: runs server-pilot AI contract tests against production Postgres plus spike eval and server build. Includes mocked `bedrock-adapter-contract.test.ts` (fake adapter — `NODE_ENV=test`). Live Bedrock Converse proof is the separate on-demand Bedrock live gate. Requires VITEST_ALLOW_PILOT_RDS when sourcing production env. Distinct from local vitest, which skips RDS-only cases when `DATABASE_URL` is unset and refuses the pilot host without the opt-in.

### Always-on OpenVPN

The systemd-managed hotel OpenVPN client on the pilot EC2 that stays connected across reboots and process crashes without restaging credentials on every deploy. Unit name in ops is `openvpn-client@nava`. Install is one-shot (stage → confidence → enable); day-to-day deploy only asserts health.

### Split tunnel

Routing posture where only the hotel LAN prefix goes over the VPN tunnel, while the instance default route stays on the AWS ENI. Required so SSM, STS, RDS, and S3 remain reachable while hotel mail/Infor are reachable. Name resolution stays on the AWS resolvers — VPN-pushed DNS is ignored — so hotel-internal hostnames that lack public A records need a local hosts override on the pilot.

### Infor HMS

Hotel property-management web application on the hotel LAN, opened in a browser over always-on OpenVPN. Staff and pilot automation use a hostname that must match the server TLS certificate; when that name is not in public DNS, the EC2 pilot maps it locally rather than adopting hotel DNS. Pilot automation also drives Guest Stay reads through a Chromium worker (not only interactive login).

### OSRESS

Infor Guest Stay list/search system function used for exact reservation lookups on the live property. Soft-captured dataspy filters pin confirmation or external-reference values; empty unused OR slots behave as wildcards over the date window.

### Exact reservation candidate

A fail-closed lookup key derived from authorized mail: either a confirmation number or an external reference, never a fuzzy guest-name search. Bound opaquely for `hms_find_reservation`; live DoD may walk several mail-derived exact candidates until one matches in HMS.

### Live reservation shadow

EC2 proof path that runs real Guest Stay search through the HMS worker and agent tool surface in shadow mode: queue/claim/audit digests only, no business persistence of live values, evidence, or drafts. Operator success is a fixed token chain ending in rollback.

### Live-negative verification gate

Discipline that forbids accepting a live PMS/HMS read's zero/empty/not_found as business truth until six layers are independently proven: request chrome, response transport shape, parser (fail-closed on unknown), filter scope (no accidental wildcard), date/paging window, and a green **known-positive control** through the same code path. A negative is treated as *unproven*, not *false*, until the gate passes. Distinct from False green gate (which is about unpersisted verification claims on our own tree); this gate is about false negatives manufactured by stacked wrong assumptions against a live third-party surface. Sits over OSRESS and Exact reservation candidate reads and is the checkable form of the empirical build-debug loop.

*Avoid: reading fixture-green as live-green; concluding "PMS has no record" from a single candidate over a narrow window with no positive control.*

### HOST_ROUTE

The instance default IPv4 route via the VPC gateway on the ENI (not via `tun`). Used as the live proof that split tunnel has not hijacked AWS egress.

### VPN HARD assert

Fail-closed health checks for always-on OpenVPN: unit active, expected tunnel interface and exact address/CIDR, HOST_ROUTE intact, hotel prefix route present, and AWS STS reachable. A HARD failure aborts post-boot smoke and ops-deploy. Success output uses fixed status tokens only — no routes, hosts, or ports — so SSM command history stays redacted.

### VPN SOFT assert

Best-effort hotel TCP probe that warns without failing deploy when the hotel side is briefly unreachable. Can be flipped to fail-closed with an explicit probe-required flag for real-mail activation paths. Probe success likewise emits fixed tokens only.

### Post-boot smoke

Systemd oneshot (`nava-post-boot-smoke.service`) that runs after PM2 (and wants always-on OpenVPN) to verify nginx, `:8788`, `:443`, PM2 `http`, and VPN HARD health before declaring reboot recovery green.

### Canonical origin

The single staff-facing HTTPS origin for the Centurion pilot (`https://nava.legacyhotels.co.za`). Auth `baseURL` / trusted origins, SPA `VITE_PUBLIC_APP_URL`, Nginx `server_name` + TLS paths, S3 CORS, and production browser gates must all agree on this origin. Hotel internal DNS points it at the EC2 OpenVPN address; public DNS stays absent.

### Dual-plane Nginx

One Nginx site on the pilot that must always carry both the hotel Legacy plane (`:80/:443` → loopback `http`) and the Remote admin plane (private `:8443` → loopback `remote-http`). A candidate that omits either plane is refused before install/reload so a hotel-only edit cannot wipe public admin ingress.

### Remote admin plane

Public operator access to the pilot mail UI via `nava-admin.trynava.io`: TLS terminates at a dedicated ALB; the ALB forwards only that host to the instance private `:8443` target. Distinct from Canonical origin, which stays hotel-VPN-only and must not gain public ingress through this path.

### Remote admin lifecycle state

Fail-closed classification of ALB listener rules plus target health into a small set of safe shapes (`pre-registration`, `active`, `rollback`). Any mixed, broad, or non-healthy arrangement is `unknown` and must not be mutated by cutover scripts. After the host-forward rule is deleted, AWS often reports the target as unused rather than healthy — that is `unknown`, not `rollback`.

*Avoid: treating `nava.legacy.local` as the live staff URL after the hotel-HTTPS cutover; that name is legacy overlap only.*

### Closed deploy then open

Cutover sequencing where the app and Nginx TLS site are deployed and proven on-box while UFW still denies hotel TCP 443, then exactly one `tun0` TCP/443 allow is added before launch-readiness must report READY. Initial rollback removes the tunnel allow first and restores the pinned pre-cutover runtime, leaving staff access closed.

## AI mail pipeline

### AI workflow run

Durable queue row in `ai_workflow_run` representing one async AI job (triage, candidate draft, or feedback extraction). Claimed by `ai-worker`, idempotent by `idempotency_key`, with retry/dead-letter state.

### Claim fencing

Terminal update invariant on AI workflow runs: `markAiRunSucceeded`, retry, and dead-letter helpers only mutate a row when `claimOwner` and `expectedStates` still match the worker that holds the claim. A stale or reclaimed worker's terminal write returns no row instead of overwriting a newer owner's result.

### Shadow triage

Classifier/eval path that records triage output and metrics without mutating mailbox category, spam, or urgent state until the spike gate enables durable writes.

### Centurion triage retag

Ops cutover that back-applies production triage classifications onto an approved Centurion thread cohort: quiesce workers, snapshot (RDS + app), bind twice-stable approvals under a fresh ledger key prefix, dry-run, apply, scoped drain, then audit-or-restore. Distinct from Shadow triage (no durable writes) and from ordinary inbound classify of new mail. A spent key prefix must not be reused; red audit restores pre-retag durable labels while code may stay on the new prompt version.

The v6 cutover treats the manifest as a provenance chain (snapshot, source,
canonical approval, rehearsal, and apply bindings), validates restore drift and
mutation in one serialization boundary, and enqueues retag work without clearing
prior state. Worker success performs the explicit full rewrite; retry/dead-letter
rows may resume under the same key while succeeded runs remain terminal. The
workflow navigation surface is enabled only after the complete eligible cohort
has drained and audited.

### Triage asOf

The ISO instant folded into the triage input hash for a workflow run — the causal window of messages the classifier saw. Workers hash at run create time; finish time is bookkeeping only. Audits that recompute production `inputHash` must use the same instant or every target falsely mismatches.

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

### Spam placement (`spam_at`)

Folder-first spam membership: a thread is in Spam when its spam timestamp is set and it is not trashed. Soft user labels named SPAM are not folder truth. Leaving spam (bin, archive, soft-delete, empty-spam) must clear the spam timestamp so list predicates never orphan the thread. Durable AI triage and Centurion triage retag audits treat approved `spam` the same way: expect the spam timestamp set, not an AI-managed category slug named spam.

*Avoid: keeping spam set while also trashing or archiving; dual state matches neither folder.*
*Avoid: expecting a `spam` hotel-category join as durable spam proof — membership is the spam timestamp.*

### Never-spam (auto-triage)

Allowlist of domains/addresses that durable AI triage must not mark spam. Manual mark-spam and explicit sender block at ingest still win. Distinct from heuristic refine (short personal notes, agency mail, etc.), which demotes false-positive spam categories without a hard allowlist. The same hotel domain allowlist also seeds default **Image trust** in the mail reader so staff see first-party banners/GIFs without trusting every address by hand.

### User spam lock

Per-thread freeze after staff mark-spam or not-spam so later AI apply cannot flip spam membership on that thread. Paired with sender block/allow preference for future ingest.

### Empty spam

Bulk soft-trash of the current Spam folder that clears spam membership as it trashes, so threads appear in Bin and nowhere else as orphans.

### Sender preference (block/allow)

Per-transport preference on a normalized sender address: block stamps new mail into spam at ingest; allow (and never-spam) blocks auto-triage from writing spam. Mark-spam / not-spam upsert the preference for the latest inbound Effective from address on the thread.

### Effective from address

The address stored as the message’s sender after MIME parse: when RFC `Sender` is present and differs from `From` (case-insensitive), the transmitter in `Sender` wins; otherwise `From`. Outlook calendar forwards keep the organizer in `From` and the forwarder in `Sender`, so this rule attributes the forwarder. Downstream triage, never-spam, reply-to, sender preferences, and Image trust all key off this value.

*Avoid: assuming MIME `From` always names who transmitted the message into the sink.*

### CID (Content-ID) inline image

A MIME-embedded image part referenced from HTML as a `cid:` URI rather than an `http(s)` URL. The browser cannot fetch `cid:` directly; the mail reader must rewrite matched references to an authenticated same-origin inline attachment URL before display. Distinct from downloadable attachments (chip/download path) and from remote marketing images.

### Image trust

Whether the mail reader may load remote `http(s)` images for a message. Defaults from the Never-spam hotel domain allowlist plus user trusted-sender settings (exact address or domain). First-party CID parts are projected for mailbox owners regardless; remote URLs stay gated. Trust is a render-time policy — storage sanitize must not permanently erase remote image URLs.

*Avoid: treating Trust Sender as exact-email-only; hotel operational mail is multi-address on shared domains.*

## Hotel taxonomy UI

### Hotel category

An AI-managed mailbox classification stored as durable memberships on threads:
the canonical workflow work queues cover booking, servicing, reconciliation,
money, delivery, recovery, guest experience, partner, automated-channel, and
unknown-review concerns, with Urgent as a cross-queue overlay. Legacy
new-bookings, groups-events, at-risk, and ops slugs remain readable during the
dual-read transition but are not the canonical workflow taxonomy. Distinct from
system folders (inbox/sent/spam/trash via thread flags) and from My folders /
user labels (filing tags). Staff see them in the sidebar as **Folders**, and on
`/mail` Inbox as segmented sections (same taxonomy). Legacy invent-WHO slugs
(internal, individual, group, travel-agents) are remapped away.

### categoryIds filter

List/query wire that filters threads by hotel category UUIDs — never by Label ids. Presentation titles and pastels are render-time only; selection and URL state stay on UUIDs.

### Hotel folder presentation

Frontend overlay that maps managed category slugs to demo-grade titles, subtitles, Centurion pastel nav/pill themes, and urgent stripe. Managed-slug display ignores seed DB hex; unknown/custom categories may still use stored color.

### Centurion pastel theme

The pastel background/text pair used for primary hotel category chrome (nav rows and pills). Preferred over solid seed hex for managed slugs so live pilot matches the FE demo scanability.

### My folders

Sidebar user-filing surface for custom folders built on mailLabel rows (slash names for nesting). Staff drag finished mail here so inbox stays unactioned work. Distinct from hotel AI Folders (category queues) and from system places (inbox/archive/spam/bin flags). Schema and API names stay mailLabel / labelIds / labels.*.

### File threads

Exclusive user-label filing mutation: set the target user label on threads, archive them out of inbox, clear trash/spam placement, leave AI categoryIds untouched. Unfile is Move to Inbox (clear archive), which drops the thread from the folder list that filters archive+labelIds.

### Labels demotion

Historical sidebar posture that kept the Labels tree secondary to hotel Folders. Superseded for FO chrome: that tree is now titled My folders (still backed by labels). Hotel Folders must never re-use the My folders title.

### Honesty UI

Pilot practice of removing or replacing dead/fake affordances (unavailable AI surfaces, demo-only chrome, stub dialogs) with a real staff workflow — or hiding them — rather than leaving an interaction that only announces the feature is off.

*Avoid: keeping a disabled modal as the primary click target; flipping the whole SPA into frontend-only demo mode to recover demo chrome; conflating this with Compose-close honesty (draft Save/Discard/Keep editing).*

## Connected mailbox commercial analysis

Ops corpus analysis over connected-mailbox exports (not product mail UI). Used for client-facing daily charts and WINDOW commercial KPIs.

### Actionable reservation thread

A reservation-work thread in the analysis denominator: Luna intents for new booking, quote, group/event, or modify, after excluding pure channel confirmation digests and OTA system notices that carry no guest/agent request language. Distinct from the full mailbox thread count and from hotel-category Automated-channel filing in the SPA.

### Trigger inbound

The message chosen as the enquiry anchor for unanswered detection and EPV demand parse. Responders and room-night demand are scored relative to this message, not merely the chronologically first inbound. Distinct from first inbound (received-day axis / early pax-night scripts) and from cross-thread PMS confirm matching.

### Channel-automated inbound

Inbound mail whose sender/obligation is channel or system notice (SynXis confirms/modifications/cancellations, OTA digests, confirmation-letter style automation) rather than a guest, agent, or company request. Must not win Trigger inbound selection for EPV-eligible unanswered scoring.

*Avoid: treating SynXis/OTA confirms as external guest enquiries for uEPV.*

### EPV (Estimated Pipeline Value)

Tiered ZAR proxy for commercial demand on an actionable thread when audited revenue is unavailable: explicit quote totals, currency-context parsed amounts, room-nights × corpus-calibrated ADR, then conservative floors. An estimate for client charts, not booked revenue.

### uEPV

Sum of EPV on unanswered external-enquiry threads (at-risk pipeline). Distinct from rEPV (responded) and from raw unanswered thread counts.

### rEPV

Sum of EPV on responded actionable threads. Distinct from uEPV.

## Agent workflow (Cursor skills)

### Nava plan

Canonical multi-step planning front door for Zero. Per the installed nava-plan skill, produces one final executable TDD plan and does not implement product code. Repo rule requires a Paired plan gate and `writing-plans` on the path to a final executable plan.

### Nava run

Canonical implementation front door for a final executable plan. Runs TDD/SDD with per-task review, final CE code review, and fresh verification. Per the installed nava-run skill, does not by itself authorize commits, pushes, PRs, or production mutations unless the user explicitly requested them.

### Autonomous plan

Mandate-stamping front door that embeds overnight autonomy into an existing implementation plan **in place**. Not a planner and not a substitute for Nava plan. Compatibility alias: overnight-autonomous-execution; Zero overlay: overnight-autonomous-zero.

*Avoid: treating Autonomous plan as CE→review→writing-plans; creating a sibling “plan to modify the plan.”*

### Continue autonomously

Queued fail-safe that resumes stalled autonomous work after the agent paused, asked a routine question, or ended early. Inspect state first; auto-decide reversible choices; stop only on true blockers. Compatibility alias documented on the installed continue-autonomously skill: overnight-continue-working.

### Paired plan gate

Mandatory dual review on every implementation plan: `gstack-plan-eng-review` as the completeness floor and `ponytail-review` as the simplicity ceiling. Neither substitutes for the other. Persistent ponytail mode stays off unless explicitly invoked; ponytail-review remains the review-only half of this gate.

### Pilot RDS test safety

Hard override that forbids Vitest (and similar runners) against pilot/production Postgres, including under overnight autonomy and “make tests green” pressure. Prefer disposable non-production databases for DB-required tests; prove pilot with read-only SQL/API, health checks, or purpose-built non-test scripts. Related: Pilot RDS vitest refuse, VITEST_ALLOW_PILOT_RDS, Wipe-safe pilot verify.

## Flagged ambiguities

- **"read" / grey list styling** had been treated as “already replied” in shared Centurion triage — unread/grey is Ball-in-court auto-read; ever answered is hasReplied.
- **"Rocketseed branding"** had been conflated with “mail traversed 172.24.0.8” — branding is From/sender tenant provisioning; traversal alone is insufficient.
- **"autonomous-plan"** had been used as if it were the full planning pipeline — Autonomous plan only stamps a mandate; Nava plan owns CE→paired review→writing-plans.
- **"ponytail"** had been conflated with ponytail-review — persistent ponytail mode is OFF by default; the Paired plan gate uses ponytail-review only.
- **"Folders" on mailbox provider** used to mean the Labels tree; hotel AI categories now own the Folders section title — user filing chrome is **My folders**, never Folders.
- **category color** can mean seed DB hex or Centurion pastel presentation — for managed slugs, presentation wins in UI chrome.
- **"honesty"** had been used for both Honesty UI (hide fake chrome) and Compose-close honesty (draft leave dialog) — these are distinct.
- **"spam"** can mean Zimbra/server folder routing, a legacy SPAM user label, or app `spam_at` folder membership — app folder truth is `spam_at` only.
- **"never-spam"** names the auto-triage allowlist (not a ban on manual mark-spam or ingest block); the same hotel domain list also seeds Image trust defaults — spam auto-path and image-loading are still distinct product surfaces.
- **"nava URL"** after the hotel-HTTPS cutover means the Canonical origin on hotel DNS/VPN — not `nava.legacy.local` (legacy CORS overlap only).
- **"SynXis exclusion"** had been applied only at actionable-thread filter — within-thread Trigger inbound can still be a Channel-automated inbound unless selection hard-excludes it; thread filter alone does not protect uEPV.
- **"first inbound"** is not the same as Trigger inbound — received-day / early demand scripts used first inbound; unanswered EPV must not silently fall back to it when no guest/agent trigger exists.

## Pilot measurement

### Coverage-qualified mail baseline

Observed mailbox service over an explicit arrival window and observation cutoff, qualified by reconciled incoming/sent source coverage and timestamp provenance. Missing sent mail, unknown source intervals and off-email work are not evidence of staff inactivity or lost revenue. Distinct from a complete baseline of all hotel operations and from Nava treatment-effect measurement.

### Private reply shadow

Background reply prediction sealed with its available-at-the-time inputs and later compared with observed staff replies and supporting facts. It stores private evaluation artifacts without exposing a draft, changing mailbox/work state or sending mail. Distinct from legacy Live reservation shadow, whose contract intentionally retains counters rather than business evidence or draft bodies.

### Embedded task measurement

Optional timing and quality comparison during visits already occurring in the one-person pilot. Assistance offered, actual exposure and complete task effort are separate observations; partial or abandoned timing cannot become a time-saving claim. Distinct from always-on passive mail-service metrics and from a hotel-wide revenue experiment.
