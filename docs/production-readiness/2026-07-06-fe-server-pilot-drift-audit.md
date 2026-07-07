# FE <-> Server-Pilot Drift Audit

Date: 2026-07-06

Scope:
- Frontend `apps/mail`
- Backend `apps/server-pilot`
- Focus: labels/folders, tRPC surface, ingest routing/storage, drafts/threads, edge cases where frontend assumptions diverge from pilot backend behavior.

Confidence target: `/95` -- verify from code before claiming.

## Running Findings

Status: first pass complete.

## Current Confidence

- Overall: ~95% on existence and shape of drift after direct code read, typecheck, targeted tests, and independent crosscheck.
- High confidence:
  - `server-pilot` ingest does not auto-triage into hotel categories.
  - `server-pilot` stores messages/threads/drafts separately in Postgres and raw MIME/attachments in S3.
  - `apps/mail` still has live references to legacy routers not present in `server-pilot`.
- Remaining uncertainty:
  - Exact product priority for hidden/admin/AI/note/template features.
  - Which broken paths matter for first pilot vs can be intentionally cut/stubbed.

## Verification Commands

- Frontend typecheck:
  - `pnpm --filter=@zero/mail exec tsc --noEmit --pretty false`
  - Failed with server-pilot contract errors plus unrelated TS noise.
- Server-pilot tests:
  - `pnpm --filter=@zero/server test -- thread-join drafts-contract ingest-store`
  - Exit code 0.
  - 122 passed, 79 skipped.
  - Many DB-backed suites skipped, including `drafts-contract`, `mail-router-isolation`, `mail-thread-actions`, and e2e loopback/wire tests. Useful for non-DB contract sanity, not enough to prove draft/thread live behavior.

## High-Level Ingest Flow

- POP3 worker:
  - Entry: [`apps/server-pilot/src/mail/ingest/worker.ts`](../../apps/server-pilot/src/mail/ingest/worker.ts)
  - Lists POP3 UIDLs, retrieves raw MIME, uploads raw MIME to S3 first, parses MIME, persists rows, then `DELE`s POP3 message only after successful DB/S3 handling.
  - Safety behavior:
    - Duplicate inbound UIDL returns `duplicate`.
    - Oversized/poison messages get quarantined and then deleted from POP3 after quarantine record/archive succeeds.

- MIME parsing:
  - Parser: [`apps/server-pilot/src/mail/ingest/parse-message.ts`](../../apps/server-pilot/src/mail/ingest/parse-message.ts)
  - Uses `mailparser`.
  - Extracts:
    - `X-Zero-Mailbox` routing header.
    - `Message-ID`, `In-Reply-To`, `References`.
    - sender/recipients, subject, text/html bodies, received date.
    - attachment metadata.
  - Uploads attachments to S3 during parse.

- Routing:
  - Store layer: [`apps/server-pilot/src/mail/ingest/store.ts`](../../apps/server-pilot/src/mail/ingest/store.ts)
  - Decision tree:
    - If `X-Zero-Mailbox` exists:
      - Match it against `mailbox_transport.owner_header_value`.
      - If match: store on that mailbox/transport.
      - If no match: quarantine as `unknown_transport`.
    - If `X-Zero-Mailbox` missing:
      - Try direct `To:` match against active transport emails.
      - If match: store on that transport and add a real DB user label named `SPAM`.
      - If no match: quarantine as `missing_owner_header`.
  - This is routing, not content triage.
  - No current classifier/rules engine for `urgent`, `internal`, `individual`, `group`, `travel-agents`.

- Storage:
  - Postgres tables: [`apps/server-pilot/src/db/schema/mail.ts`](../../apps/server-pilot/src/db/schema/mail.ts)
  - S3 keys: [`apps/server-pilot/src/storage/s3.ts`](../../apps/server-pilot/src/storage/s3.ts)

| Thing | Stored In | Key Columns / Layout |
|---|---|---|
| Mailbox ingest source | Postgres `mail_ingest_mailbox` | `id`, `email`, `is_active` |
| Quarantine record | Postgres `mail_ingest_quarantine` | `ingest_mailbox_id`, `pop3_uidl`, `raw_mime_s3_key`, `reason`, `parsed_headers` |
| Mailbox/account | Postgres `mailbox_transport` | `email`, `owner_header_value`, `mailbox_type`, `send_from_config` |
| User mailbox access | Postgres `mailbox_access` | `user_id`, `transport_id`, `role`, `is_default` |
| User labels | Postgres `mail_label` | scoped by `transport_id` |
| Threads | Postgres `mail_thread` | `thread_root_id`, `subject`, `snippet`, `is_archived`, `is_starred`, `is_read`, `label_ids`, `snoozed_until`, `trashed_at`, `latest_message_at` |
| Messages | Postgres `message` | `direction`, `pop3_uidl`, `message_id_header`, `in_reply_to`, `references`, bodies, S3 raw key |
| Attachments | Postgres `attachment` + S3 | DB metadata + `attachments/{messageId}/{index}-{filename}` |
| Raw MIME | S3 | `raw-mime/{ingestMailboxId}/{uidl}.eml` |
| Quarantined raw MIME archive | S3 | `quarantine-archive/{ingestMailboxId}/{uidl}.eml` |
| Drafts | Postgres `mail_draft` | separate from `message`; optional `thread_id`; `is_sent`, `sent_message_id` |

## Folder / Label Taxonomy Drift

- Finding: frontend Centurion folders are demo-only today, not live server-pilot folders.
  - Frontend demo model:
    - [`apps/mail/lib/demo/folder-map.ts`](../../apps/mail/lib/demo/folder-map.ts)
    - `internal`, `individual`, `group`, `travel-agents`, `urgent`, `spam`
  - Frontend navigation only shows those folders when `isFrontendOnlyDemo()` is true:
    - [`apps/mail/config/navigation.ts`](../../apps/mail/config/navigation.ts)
  - Live backend accepted folders:
    - [`apps/server-pilot/src/trpc/routes/mail.ts`](../../apps/server-pilot/src/trpc/routes/mail.ts)
    - `inbox`, `sent`, `drafts`, `draft`, `archived`, `archive`, `bin`, `spam`, `starred`, `snoozed`, `all`
  - Impact:
    - Your suspicion is directionally right: Centurion folder taxonomy exists in FE/demo and legacy types, but server-pilot has not implemented live category routing.
    - In non-demo mode, the sidebar does not expose Centurion folders, but code/types still carry `centurionCategory` assumptions.

- Finding: `SYSTEM_LABELS` in `server-pilot` mirrors legacy/Gmail-ish labels, not Centurion hotel taxonomy.
  - Backend:
    - [`apps/server-pilot/src/trpc/routes/labels.ts`](../../apps/server-pilot/src/trpc/routes/labels.ts)
    - `IMPORTANT`, `UNREAD`, `STARRED`, `FORUMS`, `PROMOTIONS`, `SOCIAL`, `UPDATES`
  - Frontend `useLabels` expects exactly those classic labels:
    - [`apps/mail/hooks/use-labels.ts`](../../apps/mail/hooks/use-labels.ts)
  - Impact:
    - This `SYSTEM_LABELS` constant is compatible with current non-demo `useLabels`.
    - It is not source of Centurion category folders.
    - The bigger drift is that live server-pilot has no `urgent/internal/individual/group/travel-agents` categorization path.

- Finding: live inbox category filter is only partially compatible with server-pilot.
  - Frontend category UI:
    - [`apps/mail/components/mail/mail.tsx`](../../apps/mail/components/mail/mail.tsx)
    - [`apps/mail/hooks/use-categories.ts`](../../apps/mail/hooks/use-categories.ts)
  - Default categories from server-pilot settings schema:
    - [`apps/server-pilot/src/lib/schemas.ts`](../../apps/server-pilot/src/lib/schemas.ts)
    - `Important` -> `searchValue: 'IMPORTANT'`
    - `All Mail` -> `searchValue: ''`
    - `Unread` -> `searchValue: 'UNREAD'`
  - Frontend passes selected category `searchValue` through URL `labels` query param into `mail.listThreads({ labelIds })`:
    - [`apps/mail/hooks/use-labels-search.ts`](../../apps/mail/hooks/use-labels-search.ts)
    - [`apps/mail/hooks/use-threads.ts`](../../apps/mail/hooks/use-threads.ts)
  - Server-pilot `mail.listThreads` treats `labelIds` literally against `mail_thread.label_ids`.
  - `IMPORTANT` works only because `toggleImportant` stores literal `IMPORTANT` in `mail_thread.label_ids`.
  - `UNREAD` likely does not work because unread is represented as `mail_thread.is_read=false`, not label id `UNREAD`.
  - Impact:
    - Default `Unread` category may show empty results even when unread threads exist.
    - Custom categories based on label ids can work.
    - Search-expression style values from legacy (`is:important`, etc.) are not parsed by server-pilot.
  - Recommendation:
    - Either make category filter grammar explicit (`labelIds`, `unread`, `important`, `custom`) or teach `mail.listThreads` special system filters for `UNREAD`, `IMPORTANT`, `STARRED`, etc.

- Finding: live pilot hides the category dropdown.
  - Frontend:
    - [`apps/mail/components/mail/mail.tsx`](../../apps/mail/components/mail/mail.tsx)
    - Category dropdown renders only when `activeConnection?.providerId === 'google' && folder === 'inbox'`.
  - Server-pilot:
    - [`apps/server-pilot/src/trpc/routes/connections.ts`](../../apps/server-pilot/src/trpc/routes/connections.ts)
    - Connections return `providerId: 'mailbox'`.
  - Impact:
    - Even the default category settings stored by `server-pilot` may not be visible in live pilot UI.
    - This also hides category drift during normal manual testing.

## Threading Behavior

- Thread join logic:
  - Code: [`apps/server-pilot/src/mail/ingest/store.ts`](../../apps/server-pilot/src/mail/ingest/store.ts)
  - Uses `In-Reply-To` and `References` to find an existing `message.message_id_header`.
  - If found:
    - Reuses parent `mail_thread.id`.
    - Updates `latest_message_at`, `snippet`, `is_read=false`.
  - If not found:
    - Uses inbound `Message-ID` as `thread_root_id`.
    - Falls back to `no-message-id-{pop3Uidl}`.
    - Creates new `mail_thread`.
  - Test coverage:
    - [`apps/server-pilot/tests/thread-join.test.ts`](../../apps/server-pilot/tests/thread-join.test.ts)

- Folder result after ingest:
  - Normal routed inbound:
    - Appears in `inbox` if not archived, not trashed, not snoozed, has inbound message, and lacks DB `SPAM` label.
  - Missing `X-Zero-Mailbox` but direct `To:` match:
    - Stored as thread/message with DB label `SPAM`.
    - Appears in `spam`, excluded from `inbox`.
  - Unroutable:
    - Stored in quarantine table + S3 archive, not normal inbox/spam thread.
  - Sent:
    - Outbound messages inserted by `mail.send`; `sent` folder is threads with outbound messages.

## Draft Storage + Edge Case

- Draft model:
  - Code: [`apps/server-pilot/src/trpc/routes/drafts.ts`](../../apps/server-pilot/src/trpc/routes/drafts.ts)
  - DB: `mail_draft`, separate from `message`.
  - Drafts can optionally point at `mail_thread.id`.
  - `drafts.list` returns unsent drafts only.
  - `drafts.get` returns draft body/recipients by draft id.
  - `mail.listThreads({ folder: 'draft' | 'drafts' })` currently returns empty.
  - Frontend:
    - [`apps/mail/hooks/use-threads.ts`](../../apps/mail/hooks/use-threads.ts)
    - Demo draft folder uses local demo draft listing.
    - Live non-demo draft folder still calls `mail.listThreads({ folder: 'draft' })`.
  - Impact:
    - Live Drafts sidebar route likely shows empty even when `mail_draft` has unsent drafts.
    - `drafts.list` exists but is not wired into live `useThreads`.

- Send behavior:
  - Code: [`apps/server-pilot/src/trpc/routes/mail.ts`](../../apps/server-pilot/src/trpc/routes/mail.ts)
  - `mail.send` inserts an outbound `message` row.
  - If `draftId` is provided, it marks the draft `is_sent=true` and stores `sent_message_id`.
  - Attachments from FE send payload are accepted in schema but not visibly persisted in the audited send path yet.

- Edge case: existing draft on thread + new inbound message arrives.
  - What current code does:
    - Ingest only updates `mail_thread` and inserts inbound `message`.
    - It does not query/update `mail_draft`.
    - Existing draft remains unsent and still linked to same `thread_id`.
    - Thread read state flips to unread; latest message metadata moves to the inbound message.
  - What frontend expects:
    - `useThread` searches `threadData.messages` for `message.isDraft`.
    - Server-pilot `mail.get` returns only `message` rows; drafts are not merged into thread messages.
    - So in live server-pilot, `latestDraft` from `useThread` is probably always `undefined`.
  - Test coverage:
    - Draft CRUD covered.
    - Thread join covered.
    - I have not found a test for "new inbound reply arrives while unsent draft exists on that thread".
  - Risk:
    - User may keep editing stale draft after new inbound changes context.
    - UI may not surface "draft exists on this thread" unless opened via explicit `draftId`.
    - No conflict/rebase warning.

## API Surface Drift

- Verification:
  - Command run: `pnpm --filter=@zero/mail exec tsc --noEmit --pretty false`
  - Result: failed.
  - Direct contract drift errors included:
    - `Property 'ai' does not exist`
    - `Property 'brain' does not exist`
    - `Property 'templates' does not exist`
    - `Property 'notes' does not exist`
    - `Property 'bimi' does not exist`
    - `mail.verifyEmail` output mismatch: FE expects `isVerified`, backend returns `verified`.
    - `mail.getMessageAttachments` output mismatch: FE treats result as array, backend returns `{ attachments: [...] }`.
    - `mail.suggestRecipients` input mismatch: FE sends `{ query }`, backend expects `{ q }`.
    - `mail.send` input mismatch: FE sends `headers`, `scheduleAt`, `isForward`, `originalMessage`; backend schema ignores/rejects unknown fields under typed contract.
    - `mail.listThreads` folder mismatch: FE passes generic route string, backend type only accepts known folder union.

- Server-pilot root router:
  - [`apps/server-pilot/src/trpc/router.ts`](../../apps/server-pilot/src/trpc/router.ts)
  - Present routers:
    - `mail`
    - `drafts`
    - `labels`
    - `settings`
    - `connections`
    - `user`

- Frontend still calls routers missing from server-pilot:
  - `ai`
    - `trpc.ai.webSearch`
    - `trpc.ai.generateSearchQuery`
    - `trpc.ai.compose`
    - `trpc.ai.generateEmailSubject`
  - `brain`
    - `trpc.brain.generateSummary`
    - `trpc.brain.getState`
    - `trpc.brain.getPrompts`
    - `trpc.brain.updatePrompt`
  - `notes`
    - `trpc.notes.list/create/update/delete/reorder`
  - `templates`
    - `trpc.templates.list/create/delete`
  - `bimi`
    - `trpc.bimi.getByEmail`

- Frontend also calls `trpc.mail.forceSync`:
  - Found in [`apps/mail/components/ui/nav-user.tsx`](../../apps/mail/components/ui/nav-user.tsx)
  - Not present in `server-pilot` mail router from current scan.
  - The helper intentionally calls backend in non-demo mode.
  - Risk:
    - Since `useMutation(trpc.mail.forceSync.mutationOptions())` is evaluated during component render, this may break immediately if the proxy path is undefined, not only when user clicks.

- Search grammar drift:
  - Frontend command/search paths can emit legacy Gmail-like filters such as `from:`, `to:`, date filters, and category expressions.
  - Server-pilot `mail.listThreads({ q })` only searches lowercased `mail_thread.subject` and `mail_thread.snippet`.
  - Impact:
    - Search box may appear to work for plain subject/snippet search.
    - Advanced/AI-generated filter searches will silently underperform or return wrong results.

- Mail procedures present/stubbed in server-pilot:
  - Present:
    - `listThreads`, `get`, `markAsRead`, `markAsUnread`, `toggleStar`, `toggleImportant`, `modifyLabels`, `bulkArchive`, `bulkDelete`, `delete`, `snoozeThreads`, `unsnoozeThreads`, `send`, `unsend`, `processEmailContent`, `verifyEmail`, `suggestRecipients`, `getMessageAttachments`, `getAttachment`
  - Stub/limited:
    - `verifyEmail` always unverified.
    - `suggestRecipients` returns empty.
    - `unsend` deletes outbound row without undo-window semantics.
    - `user.delete` intentionally forbidden.

- Shape drift inside existing routes:
  - Labels:
    - FE label UI expects color object `{ backgroundColor, textColor }`.
    - Server-pilot labels use `color?: string | null`.
    - Errors seen in `settings/labels`, `nav-main`, `thread-context`, `mail-list`, `mail-display`.
  - Attachments:
    - FE often expects attachment list directly.
    - Server-pilot `getMessageAttachments` returns wrapper object `{ attachments }`.
  - Recipient autosuggest:
    - FE sends `{ query }`.
    - Server-pilot accepts `{ q }`.
  - Verification badge:
    - FE reads `isVerified`.
    - Server-pilot returns `verified`.
  - Direct tRPC client style:
    - Some FE utility modules call `.query` / `.mutate` on procedures from `trpcClient`.
    - Current typed client/proxy setup does not expose those shapes the way those utilities expect.
  - Connections:
    - Server-pilot returns `providerId: 'mailbox'`.
    - Some FE UI was built around legacy `google` / Microsoft provider ids for icons/gates.

- Move/action drift:
  - Frontend helper:
    - [`apps/mail/lib/thread-actions.ts`](../../apps/mail/lib/thread-actions.ts)
    - Move to archive/spam/snoozed/bin/inbox is expressed as label changes: add/remove `INBOX`, `SPAM`, `SNOOZED`, `TRASH`.
  - Server-pilot `modifyLabels`:
    - [`apps/server-pilot/src/trpc/routes/mail.ts`](../../apps/server-pilot/src/trpc/routes/mail.ts)
    - Drops `INBOX`, `SENT`, `SPAM`, `SNOOZED` from add/remove sets.
    - Only treats `TRASH` specially via `trashed_at`.
  - Server-pilot has dedicated mutations for some states:
    - `bulkArchive` sets `is_archived=true`.
    - `bulkDelete` / `delete` sets trash/permanent delete.
    - `snoozeThreads` sets `snoozed_until`.
  - Impact:
    - Thread-display move-to-spam/archive uses `moveThreadsTo` path, so some UI actions may show optimistic success while backend does not perform requested folder move.
    - Bulk/toolbar paths that call dedicated mutations may work better than context/thread move paths.

## Type Drift

- Frontend imports some types from legacy `apps/server`, not server-pilot:
  - [`apps/mail/hooks/use-threads.ts`](../../apps/mail/hooks/use-threads.ts)
  - [`apps/mail/lib/demo-data/adapter.ts`](../../apps/mail/lib/demo-data/adapter.ts)
  - [`apps/mail/lib/demo/folder-map.ts`](../../apps/mail/lib/demo/folder-map.ts)
  - [`apps/mail/components/mail/mail-list.tsx`](../../apps/mail/components/mail/mail-list.tsx)
  - [`apps/mail/types/index.ts`](../../apps/mail/types/index.ts)
  - [`apps/mail/components/ui/ai-sidebar.tsx`](../../apps/mail/components/ui/ai-sidebar.tsx)
  - [`apps/mail/components/ui/prompts-dialog.tsx`](../../apps/mail/components/ui/prompts-dialog.tsx)

- Server-pilot exported driver types are placeholder/incomplete:
  - [`apps/server-pilot/src/lib/driver/types.ts`](../../apps/server-pilot/src/lib/driver/types.ts)
  - Impact:
    - FE can compile against legacy shapes even when server-pilot returns a smaller/different shape.
    - This likely hides drift around `centurionCategory`, `ParsedDraft`, AI prompt types, and draft-in-thread behavior.

## Drift Hiders

- Local full-dev scripts still start legacy backend:
  - [`scripts/run-frontend-local.mjs`](../../scripts/run-frontend-local.mjs)
  - [`scripts/run-backend-local.mjs`](../../scripts/run-backend-local.mjs)
  - Both point at `apps/server`, while server-pilot listens on port `8788` by default.
  - Impact:
    - Local dev can appear healthy because it talks to legacy backend routes that server-pilot does not implement.

- Frontend-only demo mode bypasses server-pilot:
  - [`apps/mail/lib/demo/runtime.ts`](../../apps/mail/lib/demo/runtime.ts)
  - [`apps/mail/providers/query-provider.tsx`](../../apps/mail/providers/query-provider.tsx)
  - Impact:
    - Demo tests can pass while live server-pilot route surface fails.

- AI sidebar expects Cloudflare Agents-style backend:
  - [`apps/mail/components/ui/ai-sidebar.tsx`](../../apps/mail/components/ui/ai-sidebar.tsx)
  - Uses `useAgent({ agent: 'ZeroAgent', host: VITE_PUBLIC_BACKEND_URL })`.
  - Server-pilot only exposes `/health`, `/api/public/providers`, `/api/auth/*`, `/api/trpc/*`.
  - Impact:
    - AI sidebar socket/chat path is incompatible with server-pilot as-is.

## Recommendations Draft

- Recommendation 1: Decide live category model now.
  - If Centurion folders are real product requirement:
    - Add category fields to `mail_thread`, e.g. `category` and `is_urgent`, or normalized labels.
    - Route `internal`, `individual`, `group`, `travel-agents`, `urgent` in `mail.listThreads`.
    - Add deterministic classifier/rules first; LLM triage later.
  - If Centurion folders are demo-only:
    - Keep them gated under demo mode.
    - Remove/avoid live type assumptions from shared FE types.

- Recommendation 2: Add explicit draft-thread merge contract.
  - Backend should either:
    - Include unsent drafts in `mail.get` response as `drafts: []`, or
    - Add `latestDraft` / `hasDraft` metadata to `mail.get`, or
    - Make FE call `drafts.list({ threadId })`.
  - Best fit: add `drafts: ParsedDraft[]` or `latestDraft` to `mail.get`; avoids FE guessing.

- Recommendation 3: Add test for "inbound reply while draft exists".
  - Create draft on thread.
  - Ingest inbound reply with `In-Reply-To` matching same thread.
  - Assert:
    - draft remains unsent.
    - thread has new inbound latest.
    - API exposes draft state clearly.
    - UI can warn "new reply arrived since this draft".

- Recommendation 4: Kill type drift.
  - Move FE imports from `apps/server/src/...` to `@zero/server/...` or local FE-owned types.
  - Fill `apps/server-pilot/src/lib/driver/types.ts` with real pilot response types.

## Resolution Pass: Server-Pilot Contract Convergence

Resolved:
- Frontend live mail types now import from `@zero/server/driver/types`.
- Server-pilot exposes inert AI, brain, notes, templates, and BIMI routers for pilot-safe compatibility.
- Hotel categories are mailbox-scoped, configurable, and multi-select through `mail_category` and `mail_thread_category`.
- `mail.listThreads` supports structured filters for categories, labels, unread, important, and starred.
- `mail.listThreads` hydrates real `hasDraft` and `draftCount` from active/candidate draft rows.
- Live Drafts folder uses `drafts.list`.
- `mail.get` exposes plural `drafts[]` without injecting draft pseudo-messages into `messages`.
- AI draft candidates promote in-place through `drafts.ensureEditableForReply`, require a concrete same-thread `replyToMessageId`, preserve `origin='ai'` / `generationId`, discard older siblings for the same reply parent, recover from concurrent promotion races, and record `mail_draft_revision.kind='promoted'`.
- `mail.send` rejects stale draft sends until caller confirms.
- Folder moves use backend state mutation with `isArchived`, `trashedAt`, and `spamAt` instead of Gmail label emulation.
- Route shape mismatches for `verifyEmail`, `suggestRecipients`, and attachments are aligned.
- Local dev scripts default to `apps/server-pilot`.

Remaining:
- Category assignment/classification is still deferred.
- Gmail-style search grammar and AI-generated search remain disabled for pilot.
- AI sidebar, brain summaries, notes, templates, and BIMI feature parity remain outside pilot scope.

### Final verification (Task 16, 2026-07-06)

- Backend targeted suite (16 contract files): **PASS** — 40 passed, 25 skipped (DB suites skip without `DATABASE_URL`).
- Frontend targeted suite (8 contract files): **PASS** — 18 passed.
- `pnpm --filter=@zero/server build`: **PASS**.
- `pnpm --filter=@zero/mail exec tsc --noEmit --pretty false`: no FE/server-pilot contract errors (`ai`, `brain`, `notes`, `templates`, `bimi`, `verifyEmail`, `suggestRecipients`, attachment wrappers). Unrelated historical errors remain, e.g.:
  1. `app/(auth)/zero/login/page.tsx(17,27)` — Zod/react-hook-form version mismatch.
  2. `app/(auth)/zero/signup/page.tsx(17,27)` — Zod/react-hook-form version mismatch.
  3. `app/(routes)/settings/appearance/page.tsx(48,27)` — Zod/react-hook-form version mismatch.
  4. `app/(routes)/settings/appearance/page.tsx(85,33)` — `DemoSettings.categories` shape mismatch.
  5. `app/(routes)/settings/danger-zone/page.tsx(79,27)` — Zod/react-hook-form version mismatch.

## Full Test Layer (Wave 7, Task 17)

Commands:
- `pnpm --filter=@zero/server test`
- `pnpm --filter=@zero/mail test`
- `pnpm --filter=@zero/server build`
- `pnpm --filter=@zero/mail exec tsc --noEmit --pretty false`
- `pnpm --filter=@zero/mail build`
- `bash apps/server-pilot/deploy/fixture-loopback-gate.sh` (EC2 SSM)
- `bash apps/server-pilot/deploy/wire-gate.sh` (EC2 SSM)
- `pnpm --filter=@zero/testing test:e2e`

Result (final, EC2 @ `3307f6a8`, 2026-07-07):
- Server tests (local): **PASS** — 127 passed, 90 skipped (no local RDS).
- Server tests (EC2, `NODE_ENV=test`): **PASS** — 212 passed, 5 skipped (217 total).
- Mail tests: **PASS** — 182 passed.
- Server build: **PASS**
- Mail typecheck: **FAIL (historical)** — unrelated Zod/react-hook-form and settings type drift (first five unchanged from Task 16 list above).
- Mail build: **PASS**
- Fixture loopback E2E: **PASS** (EC2 SSM — `fixture-loopback-gate: PASS`)
- Mailpit wire E2E: **PASS** (EC2 SSM — 19/19 wire tests, `wire-gate: PASS`)
- Playwright E2E: **PASS** (EC2 SSM — `bash apps/server-pilot/deploy/playwright-ec2-gate.sh`, **6 passed** in 19.2s; session mint via Secrets Manager, FE dev on `localhost:3000`, `PLAYWRIGHT_BROWSERS_PATH=/opt/nava/playwright-browsers`, Playwright **1.52.0**)

RCA fixes made:
- `apps/server-pilot/drizzle/meta/_journal.json` — registered migrations `0005_mail_categories`, `0006_draft_lifecycle_eval`, `0007_mail_thread_spam_state` so RDS received `spam_at` and draft lifecycle schema.
- `apps/mail/tests/demo-backend-guards.test.ts` — command-palette test expects pilot NL-search passthrough (no backend `generateSearchQuery` when `canUseNaturalLanguageSearch()` is false).
- `packages/testing/e2e/ai-summary.spec.ts`, `bulk-search.spec.ts` — assert AI sidebar absent; inbox still usable in pilot.
- `packages/testing/e2e/auth.setup.ts` — cookie domain derived from `PLAYWRIGHT_BASE_URL`; `PLAYWRIGHT_COOKIE_PREFIX` for production cookie names on EC2.
- `packages/testing/e2e/helpers/mail-inbox.ts` — dismiss Nava onboarding tour; pilot inbox/command-palette helpers.
- `packages/testing/e2e/mail-actions.spec.ts`, `mail-inbox.spec.ts`, `search-bar.spec.ts` — pilot-safe assertions (context menu, thread reply, palette navigation).
- `packages/testing/package.json` — pin `@playwright/test` to **1.52.0** to match EC2 `/opt/nava/playwright-browsers` (chromium-1169).
- `apps/server-pilot/deploy/playwright-ec2-gate.sh` — EC2 gate: mint session, start FE dev if needed, run full Playwright suite.
- `apps/server-pilot/tests/categories-contract.test.ts` — unique transport emails per test (avoid parallel unique constraint on `mailbox_transport.email`).
- `apps/server-pilot/tests/drafts-contract.test.ts` — list assertion uses `content` not legacy `body`.
- `apps/server-pilot/src/trpc/routes/mail.ts` — stale draft send uses in-memory inbound timestamp compare (matches `mail.get` isStale); fixes drizzle SQL date binding INTERNAL_SERVER_ERROR.

Skipped with proof:
- None for Wave 7 browser E2E after EC2 gate green (`3307f6a8`).

