# EC2-Pilot Bug Hunt — Fork Range `4b4a728c..EC2-pilot`

**Date:** 2026-07-02
**Scope:** All 26 commits since fork from `FE-demo-minimal` (~102 files, ~15.5k insertions). Backend `apps/server-pilot/**` + frontend cache/polling changes in `apps/mail/**`.
**Goal:** Correctness bugs only. NOT security — that pass is done (`2026-07-01-ec2-pilot-security-audit.md`). **NO code edits** — findings report only, for human review before fixing.
**Method:** 5 parallel reviewer agents by subsystem; every P1/P2 finding re-verified against source by the main thread before landing here. A handful of P3s are marked *(agent-verified)* — the agent re-checked them against the working tree but the main thread did not independently re-read those lines.

**Note on working tree:** the tree already contains the security fixes from the other LLM (`sanitizeEmailHtml`, `assertSafeOutboundFields`, `formatContentDispositionFilename`, `allowDifferentEmails:false`, pilot signup allowlist, `lastHeader` for `X-Zero-Mailbox`). All findings below were verified against this current tree.

## Constraints factored in
- Solo dev, pilot: 1 EC2 + 1 RDS, fixtures/fakes only this pass (real POP3/SMTP/VPN deferred).
- **[latent]** = only bites when real POP3/SMTP is enabled; doesn't block the fixtures-only pilot but must be fixed before real mail.

---

## TL;DR — the big picture

**Two systemic failures dominate everything else:**

1. **The real frontend cannot talk to the pilot backend at all.** Two independent proofs:
   - `apps/mail` sends every tRPC **query** as POST (`methodOverride: 'POST'`, query-provider.tsx:208) but `main.ts` uses `fetchRequestHandler` **without `allowMethodOverride`** → tRPC v11 returns 405 METHOD_NOT_SUPPORTED for every query. (Finding D1)
   - Even with that fixed, `apps/mail` is **typed against the old `@zero/server/trpc` AppRouter** (query-provider.tsx:10) — so TypeScript never sees the pilot router, and nearly every mutation payload/response shape drifted: `ids` vs `threadIds`, folder slugs, `mail.send` shape, `settings.save` shape, drafts shape, `mail.get` field names/order. (Findings B3–B8, C1–C2)
   - Conclusion: the pilot API was validated only by its own tests (which encode the drifted contract), never by the real UI. **Fixing this contract layer is the highest-value work item, and any E2E smoke through the real frontend would have caught all of it.**

2. **Inbound threading/dating is wrong at the core.** Replies never join threads (A1), thread metadata never updates on new inbound mail (A10), and every message displays ingest time instead of its Date header (A2). These break the product's main loop even in fixtures-only mode.

**Priority order for fixes** (suggested):
| # | Finding | Sev |
|---|---|---|
| 1 | D1 tRPC 405: no `allowMethodOverride` | P1 (app-breaking) |
| 2 | B3–B8/C1–C2 contract drift (ids/folders/send/settings/drafts/get) | P1 (app-breaking) |
| 3 | B1 hard-delete where UI promises "bin + undo" | P0-if-wired |
| 4 | B2 listThreads pagination: page 2 empty forever | P1 |
| 5 | A1+A10+A13 threading; A2 date | P1 |
| 6 | E1+E2+E5 IDB cache: anon-bucket cross-user leak + logout race + FORBIDDEN path skips cleanup | P1 (privacy) |
| 7 | C4 zero-mailbox user → force-sign-out loop | P1 |
| 8 | D4 seed-prod password rotation/lockout | P1 (ops) |
| 9 | D2 load-50 gate vacuous (405s counted as success) | P1 (false confidence) |
| 10 | E3 QueryClient recreated on re-render (cache wipe/flicker) | P1 (UX) |
| 11 | C5 nginx 1MB body cap vs base64 attachments | P1 |
| 12 | A3–A6 real-POP3 client non-functional | P1 [latent] |
| 13 | Everything P2/P3 below | — |

---

## Findings — Slice A: Ingest pipeline (verified ✅)

### A1 [P1] Replies never join threads — every reply creates a new thread
- file: `apps/server-pilot/src/mail/ingest/store.ts:328-329`
- bug: `threadRootId = parsed.messageId ?? …` keys the thread on the incoming message's **own** Message-ID; `inReplyTo`/`references` are stored but never consulted. Outbound threads use `threadRootId = 'outbound-${threadId}'` (mail.ts:560), which an inbound reply can never match.
- failure: Staff sends → guest replies (In-Reply-To correct) → reply becomes a new one-message thread. Every conversation fragments. (Also found independently by slice D.)
- fix sketch: resolve thread by `message.messageIdHeader IN (inReplyTo, …references)` on the transport; index `(transport_id, message_id_header)`; fall back to own Message-ID.

### A2 [P1] Date header silently ignored — `receivedAt` is always poll time
- file: `apps/server-pilot/src/mail/ingest/parse-message.ts:214-215` (+ `firstHeader` 235-243), `store.ts:235-236`
- bug: mailparser returns the `date` header as a **Date object**; `firstHeader()` returns `null` for non-strings. `receivedAt` is always null → store falls back to `new Date()`; `sentAt` stays null; `latestMessageAt` gets ingest time. `parseDate()` is unreachable.
- failure: Backlog of 500 old mails all display "now". No test asserts `receivedAt`/`sentAt`.
- fix sketch: handle `headers.get('date') instanceof Date` in `buildParsedMessage`.

### A3 [P1][latent] `RealPop3Client.readLine` loses buffered bytes — real POP3 hangs/corrupts
- file: `apps/server-pilot/src/mail/ingest/pop3-client.ts:200-226`
- bug: Each `readLine()` uses a promise-local `buf` and detaches after the first CRLF, discarding the rest of the chunk; between calls the flowing-mode socket has zero `'data'` listeners so chunks are dropped entirely.
- failure: multi-line UIDL/RETR responses → `.` terminator never seen → `multiline()` hangs forever; partial RETR bodies corrupted. Real client effectively non-functional. (Dot-de-stuffing/terminator logic itself is correct.)
- fix sketch: persistent `'data'` listener feeding an instance-level line queue.

### A4 [P2][latent] RETR reassembly decodes raw bytes as UTF-8 — corrupts non-UTF-8 mail
- file: `pop3-client.ts:85, 128, 207`
- bug: `TextDecoder('utf-8')` + `Buffer.from(join, 'utf-8')` → invalid sequences become U+FFFD, permanently corrupting the raw MIME archived to S3.
- fix sketch: accumulate raw Buffers, split CRLF at byte level.

### A5 [P2][latent] Real POP3 client can never authenticate — password never sourced
- file: `pop3-client.ts:104-107, 350-367`
- bug: `PASS` sent only when `opts.password` set; `createPop3Client` never sets it — no `POP3_PASSWORD` env, `secretArn` never resolved anywhere.
- fix sketch: resolve the secret in `connect()`; fail fast if absent.

### A6 [P2][latent] Socket lifecycle: no timeout, no `close` handling, unhandled-`'error'` window
- file: `pop3-client.ts:229-243, 200-226`
- bug: no socket timeout (stalled server = permanent hang); server FIN unhandled (same); the leftover `once('error')` from connect consumes the first post-connect error, a second error outside `readLine()` crashes the process.
- fix sketch: persistent error/close handlers + `sock.setTimeout()`.

### A7 [P2] Quarantine path has no idempotency — redelivery inserts duplicate quarantine rows
- file: `store.ts:144-152, 168-176, 184-201`
- bug: UIDL dup-check queries only `message`, and only **after** routing succeeds; quarantine inserts never check `mail_ingest_quarantine` and no unique index exists on `(ingest_mailbox_id, pop3_uidl)` there.
- failure: quarantine + DELE, QUIT fails → next cycle re-quarantines, every cycle until QUIT lands. Also: transport deactivated after store → redelivery quarantines an already-stored message.
- fix sketch: quarantine dup-check + unique index; move message dup-check before routing.

### A8 [P2][latent] Poison-message infinite retry + head-of-line starvation
- file: `worker.ts:133, 176-193`
- bug: any failure except `IngestTooLargeError` is never DELEd/quarantined → retried every cycle forever; loop takes `uidls.slice(0, maxMessages)` so ≥500 accumulated failures block all newer mail permanently.
- fix sketch: retry counter → quarantine `parse_failure` + DELE.

### A9 [P2] Messages without a Message-ID all collapse into one giant thread
- file: `store.ts:328-329`
- bug: fallback root `no-message-id-${inReplyTo ?? 'root'}` is a shared constant per transport; comment claims UIDL-derived but UIDL unused.
- fix sketch: use the UIDL in the fallback root.

### A10 [P2] Inbound message into an existing thread never updates thread metadata
- file: `store.ts:341-343`
- bug: thread reuse returns id without updating `latestMessageAt`/`snippet`/`isRead`/`updatedAt` (send path does update). Thread stays buried and marked read → users don't see new mail. Must ship together with the A1 fix.
- fix sketch: `UPDATE mail_thread SET latest_message_at, snippet, is_read=false, updated_at` on reuse.

### A11 [P2] Quarantined mail's only copy lives under a 30-day-expiry S3 prefix after DELE
- file: `worker.ts:164-174` + `s3.ts:117-135` (raw-mime 30-day lifecycle per code comment)
- bug: `quarantined` result flows into the unconditional `pop3.dele(uidl)`; quarantine row stores only header metadata; raw MIME sits under expiring `raw-mime/*`.
- confidence: medium (lifecycle verified via code comment only, not live bucket config).
- fix sketch: copy quarantined raw MIME to a non-expiring prefix before DELE.

### A12 [P3] Orphan S3 objects on every failure/duplicate path
- file: `worker.ts:140-152`, `parse-message.ts:139-156`, `s3.ts:124-135`
- bug: raw-mime key embeds `new Date()` + fresh UUID and `messageId` regenerates per attempt → every retry creates new orphans (~2,880/day for one 30s-cycle poison message).
- fix sketch: derive raw-mime key from `(ingestMailboxId, uidl)` so retries overwrite.

### A13 [P3] `references` stored with angle brackets while `messageIdHeader`/`inReplyTo` are stripped
- file: `parse-message.ts:257-266`
- bug: `normalizeReferences` skips `stripAngles` → two formats in the DB; any future references-based thread join (the A1 fix!) silently never matches.
- fix sketch: `stripAngles` each entry.

### A14 [P3] `isMain` heuristic fires on any import of the built worker module
- file: `worker.ts:332-343`
- bug: `import.meta.url.endsWith('worker.js')` is true whenever the dist module is loaded → future import of `ingestOnce` from dist starts a second poll loop in the API process. (Also found independently by slice D.)
- fix sketch: `import.meta.url === pathToFileURL(process.argv[1]).href`.

### A15 [P3] Shutdown plumbing: module-level `stopping`, non-abortable sleep
- file: `worker.ts:219, 251-252, 293-296`
- bug: second `runWorker` in one process can never run; SIGTERM waits out the full 30s sleep → PM2 SIGKILLs instead of graceful exit (harmless due to safety order).
- fix sketch: abortable sleep + per-invocation stop flag.

### A16 [P3] Unparseable From address stored as empty string
- file: `store.ts:227`
- bug: `fromAddress: parsed.fromAddress ?? ''` — blank sender indistinguishable from corruption.
- fix sketch: fall back to raw From header text.

### A17 [P3][latent] `retr`/`dele` re-issue a full UIDL listing per message
- file: `pop3-client.ts:124-135, 152-163`
- bug: `lookupMessageNumber` runs full `UIDL` per RETR **and** per DELE → O(n²) round-trips (500 msgs ≈ 1,000 full listings/cycle). Correctness fine; real-POP3 latency cliff.
- fix sketch: cache the UIDL→number map per cycle.

### A18 [P3] Test gaps that hide the P1s
- file: `tests/ingest-store.test.ts`, `tests/pop3-worker.test.ts`, `tests/fixtures/centurion-attachment.eml`
- bug: no `receivedAt`/`sentAt` assertion (hides A2); no reply-fixture thread-join test (hides A1); no quarantine-redelivery test (hides A7); zero `RealPop3Client` tests (hides A3–A6); `centurion-attachment.eml` lacks its closing `--BOUNDARY123--`.

**Slice A — checked, no finding:** poll-scheduler overlap (cycles awaited, no re-entrancy); DELE ordering (never before successful persist); dot-de-stuffing per RFC 1939. Note: `ownerHeaderValue` now uses `lastHeader()` ("relay stamp wins") — correct only if the future relay **appends** its stamp below forged occurrences; decide when the relay is built (ties into security finding #2).

---

## Findings — Slice B: Mail tRPC router (verified ✅)

### B1 [P0-if-wired] `bulkDelete`/`delete` hard-delete threads where the UI promises "move to bin" with undo
- file: `mail.ts:433-462`
- bug: SQL `DELETE` on `mail_thread`, FK-cascading messages/attachments/drafts. The frontend's `optimisticDeleteThreads` shows "Moved to bin" **with an Undo button** and a Bin folder exists in nav; the old server moved to a TRASH label. Pilot has no trash state at all (`FOLDER_VALUES` has no bin). The code comment itself warns "do not delete threads casually".
- failure: select → Delete → toast says bin + undo → rows permanently gone; undo and Bin can never recover them. Currently gated by the input-key drift (B3) — which is why it's "P0 **if wired**".
- fix sketch: `isTrashed`/`trashedAt` soft-delete + bin filter; hard-delete only on empty-bin.

### B2 [P1] listThreads cursor pagination broken: page 2 always empty, token never advances
- file: `mail.ts:112-156`
- bug: SQL always fetches the top `limit+1` rows (cursor not in WHERE); `nextPageToken` computed **before** the in-memory cursor filter, which then drops every row `>=` cutoff.
- failure: 51+ threads → page 2 returns `{ threads: [], nextPageToken: <same> }` forever; `use-threads.ts` keeps `isReachingEnd=false` → infinite-scroll request loop; threads beyond 50 unreachable. Ties on `latestMessageAt` at a boundary also skip rows (strict `<` on a non-unique key).
- fix sketch: keyset cursor `(latestMessageAt, id)` in SQL; compute token from the post-filter last row.

### B3 [P1] Every bulk mutation's input keys mismatch the frontend (`ids`/`wakeAt` vs `threadIds`/`snoozedUntil`)
- file: `mail.ts:273, 314, 344, 359, 395, 419, 434, 467-468, 486`; frontend `use-optimistic-actions.ts:220, 254, 287, 394…`
- bug: pilot takes `{ threadIds }`; frontend sends `{ ids }` (verified) — for markAsRead/markAsUnread/toggleStar/important/bulkDelete/snooze/unsnooze; snooze also sends `wakeAt` vs pilot's `snoozedUntil`.
- failure: every thread action from the real UI → zod BAD_REQUEST. Root cause: apps/mail typed against `@zero/server/trpc` (old router), so TS can't catch it; pilot's own tests encode the drifted names.
- fix sketch: rename pilot inputs to the frontend contract (or transform aliases).

### B4 [P1] listThreads folder enum rejects the frontend's canonical slugs
- file: `mail.ts:38-46`; frontend `lib/utils.ts:11-15, 32-38`
- bug: pilot enum has `drafts/archived`; frontend routes/sends `draft`, `archive`, `bin`, `spam` (verified).
- failure: navigating Drafts/Archive/Bin/Spam → zod enum failure → folder views error out.
- fix sketch: accept the frontend slugs; map to existing semantics (bin/spam need state — see B1).

### B5 [P1] `mail.send` input shape breaks against the real composer
- file: `mail.ts:506-529`; frontend `create-email.tsx:107-116` (verified: sends `to: [{email,name}]`, body in `message`, `attachments`, `fromEmail: "Name <email>"`)
- bug: pilot expects `to: string[]` + `html`/`text` + bare `fromEmail` compared with strict `!==` to `ctx.transportEmail`.
- failure: (a) zod rejects `to` objects; (b) if coerced, body would be empty (`message` stripped) and attachments silently discarded; (c) any user with a display name → FORBIDDEN "spoofed from address" on every legitimate send.
- fix sketch: accept Sender objects + `message` + attachments; parse address out of `"Name <email>"` before the spoof check.

### B6 [P1] `mail.send` accepts `draftId` but never consumes it — sent drafts linger forever
- file: `mail.ts:517` (validated, never referenced); `mailDraft.isSent`/`sentMessageId` never written by anyone.
- failure: send from draft → draft still listed as unsent → re-open/re-send duplicates; drafts accumulate.
- fix sketch: mark `isSent=true, sentMessageId` (or delete) after the message insert.

### B7 [P1] `drafts.create` can't accept the frontend payload and ignores its upsert `id`
- file: `drafts.ts:88-123`; frontend `email-composer.tsx` sends `to` as comma-joined **string** + `id: draftId` for create-or-update; never calls pilot's `drafts.update`.
- failure: (a) autosave → zod "Expected array, received string" → drafts unsavable; (b) if coerced, every autosave inserts a new row (id ignored) → orphan duplicates per composition, lost updates.
- fix sketch: match old schema (string recipients + optional `id`), upsert on `id`.

### B8 [P1] `mail.get` returns newest-first with non-ParsedMessage field shape — thread view reversed/broken
- file: `mail.ts:201-253` (`orderBy(desc(receivedAt))`, fields `fromAddress/htmlBody/isRead/receivedAt`)
- bug: frontend consumes `ParsedMessage` (`sender {name,email}`, `decodedBody`, `receivedOn`, `unread`) and assumes ascending: `latestMessage = nonDraftMessages[length-1]`, `findLast(isDraft)` (use-threads.ts:238, verified).
- failure: frontend picks the **oldest** message as "latest" (reply targets wrong message); with field drift, `latestMessage?.sender?.email`/`decodedBody` are undefined → bodies/senders don't render.
- fix sketch: order asc + map rows to the ParsedMessage shape.

### B9 [P2] `toggleImportant` is a silent no-op; system-label filtering can never match
- file: `mail.ts:358-390`; `labels.ts:17-25, 45`
- bug: `toggleImportant` looks up a `mailLabel` **row** named IMPORTANT — nothing ever seeds one → `{ updated: 0 }`. `labels.list` synthesizes `{id:'IMPORTANT'}` without a row; `modifyLabels` writes literal string ids into `labelIds` — two inconsistent schemes. Filtering by STARRED/UNREAD "labels" can't match either (they're columns).
- fix sketch: treat `'IMPORTANT'` as a literal id in `labelIds` (matching labels.list), or seed system rows.

### B10 [P2] `markAsUnread` leaves all messages read
- file: `mail.ts:334-339` (vs markAsRead 298-308 updating both tables)
- failure: `mail.get`'s `hasUnread` stays false; thread/message state permanently disagree.
- fix sketch: also set `message.isRead=false`.

### B11 [P2] Snooze does nothing to the inbox and nothing ever wakes threads
- file: `mail.ts:83-91, 464-498`; schema `mail_thread_snooze_wake_idx` has no consumer (verified by D too)
- bug: inbox filter is only `isArchived=false`; no wake job exists.
- failure: snoozed thread stays in the inbox; after `snoozedUntil` passes it sits in the snoozed folder forever.
- fix sketch: inbox condition `or(snoozedUntil is null, snoozedUntil <= now())` + lazy wake.

### B12 [P2] listThreads label/search filters run in memory after LIMIT
- file: `mail.ts:158-172`
- failure: search matches beyond the newest 51 threads are invisible; a page can return `[]` with a live token → frontend `isEmpty` short-circuit shows "no results" though matches exist.
- fix sketch: push `q` (ILIKE) and labelIds (jsonb `?|`) into SQL before LIMIT.

### B13 [P2] `mail.send` non-transactional: SMTP failure leaves a ghost thread; DB failure after SMTP loses the sent copy
- file: `mail.ts:556-608` (thread insert → SMTP → message insert → thread update, no tx)
- fix sketch: wrap DB writes in one transaction; insert thread only after SMTP outcome known; record failures.

### B14 [P2] `drafts.list` ignores `cursor`, hardcodes `nextPageToken: null`; `q` filtered post-LIMIT
- file: `drafts.ts:18-58`
- failure: drafts beyond the newest 50 unreachable; draft search misses older matches.
- fix sketch: keyset pagination on `(updatedAt, id)`; push `q` into SQL.

### B15 [P3] `unsend` leaves stale thread metadata and ghost empty threads
- file: `mail.ts:622-639`
- fix sketch: recompute `latestMessageAt` after delete; drop the thread if no messages remain.

### B16 [P3] Bulk mutations non-atomic and contradict their own NOT_FOUND policy
- file: `mail.ts:289-291` (comment: bulk skips unknown ids) vs toggleStar/important/modifyLabels/bulkArchive/bulkDelete/snooze/unsnooze calling `requireThreadForTransport` per id mid-loop
- failure: unknown id at position 6 of 10 → threads 1–5 mutated, then NOT_FOUND with no partial-success indication; duplicated ids inflate `updated` (returns `input.threadIds.length`).
- fix sketch: prefilter to visible ids + single `UPDATE … WHERE id IN (...)`, return actual count (markAsRead pattern).

### B17 [P3] `toggleStar` flips per-row instead of uniform bulk semantics
- file: `mail.ts:343-356`; old contract: if any starred → unstar all.
- fix sketch: compute `shouldStar` once, set uniformly.

### B18 [P3] `mail.get` hardcodes `attachments: []`; `getMessageAttachments` returns `body: ''`
- file: `mail.ts:247-252, 716`
- failure: inbound mail with a PDF shows no attachment indicator in the thread payload.
- fix sketch: join attachment rows per message in `mail.get` (metadata only).

### B19 [P3][latent] `desc()` on nullable timestamps sorts NULLs first
- file: `mail.ts:132, 207, 548`; `latestMessageAt`/`receivedAt` are nullable
- bug: Postgres `DESC` = NULLS FIRST; a NULL-timestamp row would pin to the top and be dropped from page 2+ by the cursor filter. No current writer produces NULLs (ingest falls back to `new Date()`), so latent.
- fix sketch: `NULLS LAST` or make columns NOT NULL.

### B20 [P3] `labels.create` maps every insert error to CONFLICT; `labels.update` 500s on duplicate rename
- file: `labels.ts:59-72` (bare catch), `101-107` (unique violation unhandled)
- fix sketch: check pg error code `23505`; handle in update too.

**Slice B — no findings:** `mail-helpers.ts` (guards correctly transport-scoped, consistent NOT_FOUND).
**Test observations:** isolation/send tests encode the drifted contract (`threadIds`, string recipients, bare fromEmail) — they pass while the real UI fails; no pagination-past-page-1, folder-slug, draftId, or markAsUnread message-state coverage.

---

## Findings — Slice C: Auth/context/wiring (verified ✅)

### C1 [P1] `settings.save` input shape drifted — every settings save fails
- file: `settings.ts:31-33` (requires `{ settings: <full schema> }`); frontend sends the **bare, often partial** settings object (verified: `saveUserSettings(params.values)`), old router took `userSettingsSchema.partial()`.
- failure: saving any settings page or trusting a sender → BAD_REQUEST. Bonus: `mail-content.tsx:37` destructures `{ success }`; pilot returns `{ id }` → "Failed to trust sender" even on success (verified).
- fix sketch: accept `userSettingsSchema.partial()` raw, merge server-side, return `{ success: true }`.

### C2 [P1] `connections.setDefault` is a no-op but `getDefault` recomputes highest-role — mailbox switch reverts on reload
- file: `connections.ts:85-107` (verify-then-return, comment admits nothing persisted); `getDefault` 71-83 returns highest-role transport.
- failure: user with 2+ mailboxes switches → reload → `MailCacheScopeSync` re-seeds the transport header from `getDefault` → silently back in the highest-role mailbox. In-session revert also possible after `queryClient.clear()` refetches `getDefault`.
- fix sketch: persist a default (`mailboxAccess.isDefault` or user column); `getDefault` honors it.

### C3 [P2] Default-transport selection nondeterministic on role ties
- file: `context.ts:66-89` (no ORDER BY; sort by roleRank only), same pattern `connections.ts:36-53`
- failure: user owning two mailboxes gets a different "default" across requests as DB row order shifts — compounds C2.
- fix sketch: tie-break by `(roleRank, transportId)`.

### C4 [P1] Zero-mailbox users get FORBIDDEN → frontend force-sign-out loop
- file: `context.ts:79-81` (zero accesses → `MailboxForbiddenError`), `trpc.ts:132-137` (→ TRPCError message 'FORBIDDEN'); frontend `query-provider.tsx:118-131` (verified: any query error whose message includes 'FORBIDDEN' → `signOut()` + redirect `/login?error=required_scopes_missing`).
- failure: any signed-up user not seeded with mailbox access (signup allowlist exists but nothing grants access on signup), or whose access is revoked mid-session, gets their valid session destroyed on inbox mount — sign-in → kick-out loop with no explanatory UI.
- fix sketch: distinct "no mailboxes" response (empty payload / NOT_FOUND) instead of FORBIDDEN.

### C5 [P1] No body-size configuration: nginx 1MB default caps every tRPC POST
- file: `deploy/nginx.conf:11-16` (no `client_max_body_size`, verified); attachments travel as unbounded base64 JSON (`serializedFileSchema` has no size cap).
- failure: draft/send with attachment over ~700KB binary → nginx 413 HTML → tRPC parse error → user sees generic "failed".
- fix sketch: `client_max_body_size 35m;` + zod max on file size.

### C6 [P2][latent] `RealS3Storage.putObject` drains a Readable body, then uploads the exhausted stream
- file: `s3.ts:62-74, 153-160` (verified: `byteLength()` consumes the stream; comment "will re-read from buffer" is false)
- failure: any future stream caller stores a 0-byte object while reporting correct bytes; FakeS3Storage handles streams correctly so tests pass while the real path corrupts. Latent — all current callers pass Buffers.
- fix sketch: `toBuffer` once, use for both length and Body (or drop Readable from the interface).

### C7 [P2] `FakeSmtpTransport` is the production send path and leaks every sent email into memory
- file: `smtp.ts:46-58, 101-109` (verified: pilot default is fake — `SMTP_ENABLE_REAL` unset; singleton `sent` array never drained)
- failure: HTTP process memory grows with every send → eventual OOM restart in long-lived PM2 fork.
- fix sketch: ring-buffer (last N) or skip recording outside tests.

### C8 [P2] Better Auth cookieCache trusted for 30 days — server-side session revocation ineffective
- file: `auth.ts:92` (verified: `cookieCache.maxAge = 60*60*24*30`, same as `expiresIn`)
- failure: deleting a session row (revocation/forced logout) is not observed by an active client for up to 30 days.
- confidence: medium (better-auth revalidation semantics; config value verified).
- fix sketch: `maxAge: 300`.

### C9 [P3] `getSessionUser` swallows all errors — DB outage masquerades as "no session"
- file: `trpc.ts:70-78` (verified: bare `catch { return null }`)
- failure: RDS blip → every private procedure returns UNAUTHORIZED instead of retryable 500; clients may drop caches / bounce to login.
- fix sketch: rethrow unexpected errors.

### C10 [P3] `user.getIntercomToken` shape drift boots Intercom with a garbage JWT
- file: `user.ts:12-14` (returns `{ token: null }`); frontend `nav-main.tsx:63-67` treats the truthy wrapper object as the token (verified).
- fix sketch: return bare `null` (`string | null`).

### C11 [P3] `settings.save` select-then-insert race on first save
- file: `settings.ts:36-55` (verified)
- failure: two concurrent first saves → PK violation `settings-${userId}` → one 500s.
- fix sketch: drizzle `onConflictDoUpdate` upsert.

### C12 [P3] `connections.delete` leaves stale active-transport header and orphans shared access
- file: `connections.ts:109-154` (verified: deletes only the caller's access row)
- failure: owner deletes the active mailbox → client keeps sending its id → FORBIDDEN → C4's sign-out loop. Other members keep access to an owner-less transport; non-owners can't leave at all.
- fix sketch: cleanup + server falls back to default instead of FORBIDDEN when user still has other mailboxes.

**Slice C — no findings:** `main.ts` route order/auth mounting (but see D1), `env.ts`, `trpc/index|router|types.ts`, `auth-providers.ts`, `schemas.ts` (`deserializeFiles` needs Node ≥20 `File`, unused in prod paths), `driver/types.ts`, S3 key write/read consistency, smtp interface vs its only caller.

---

## Findings — Slice D: DB/schema/scripts/deploy (verified ✅ unless marked)

### D1 [P1] tRPC queries 405: server lacks `allowMethodOverride`, frontend and load script POST queries
- file: `src/main.ts:67-77` (verified: `fetchRequestHandler` with no `allowMethodOverride`); frontend `query-provider.tsx:208-209` (`methodOverride: 'POST'`, `maxItems: 1`); `scripts/load-50-users.ts:219-223`
- bug: tRPC v11 fetch adapter accepts only GET for queries unless `allowMethodOverride: true`. The real frontend POSTs **every** query; so does the load script.
- failure: every `listThreads`/`get`/`settings.get`/session-adjacent query from the real UI → 405 METHOD_NOT_SUPPORTED. The 50-user load gate counts these fast 405s as success (`fiveXx === 0 && p95 < 1000`) → **gate passes while never exercising the DB read path**. This is the single clearest proof the pilot API was never driven by the real frontend.
- fix sketch: `allowMethodOverride: true` in `fetchRequestHandler` (one line) + make the gate assert 200s.

### D2 [P1] 50-user load gate is vacuous
- (folded into D1 — the gate's success criteria don't require any 2xx on list/get.)

### D3 [P2] Dedupe query cannot use the partial unique index → per-message seq scan
- file: `store.ts:184-193` vs `schema/mail.ts:190-192` (verified: index is `WHERE direction='inbound'`, SELECT has no direction predicate)
- failure: every ingested message seq-scans `message`; at 15k/day → linear degradation; benchmark passes only on a near-empty table.
- fix sketch: add `eq(message.direction,'inbound')` to the dedupe WHERE.

### D4 [P1] `seed-prod` rotates all pilot passwords before a Secrets Manager write that can't create the secret
- file: `scripts/seed-prod.ts:19-43, 56-57` (put-secret-value only, no create fallback — verified); `src/db/seed.ts:92-128` (verified: unconditional per-run password regeneration + `onConflictDoUpdate` on account)
- failure: first run without the pre-created secret (or any AWS failure): DB already has new hashes, plaintexts exist only in process memory → all pilot users locked out. Any casual rerun silently invalidates saved passwords.
- fix sketch: write secret first (create-or-put); rotate only when the account row is absent or behind `--rotate`.

### D5 [P2] Worker exits immediately in the deployed config → PM2 restart churn ending `errored`
- file: `worker.ts:268-273` (graceful skip returns); `deploy/pm2.config.cjs` (verified: no `autorestart: false`/`min_uptime`); `write-ec2-env.sh` never writes POP3 vars (verified)
- failure: PM2 restarts the clean-exiting worker ~16× then marks it `errored`; it stays errored when POP3 config is later added unless someone knows to `pm2 restart worker`.
- fix sketch: idle loop when POP3 unset, or `autorestart: false` for the worker.

### D6 [P2] btree index on the entire `settings` jsonb can make saves fail
- file: `schema/app.ts:52` (verified: `index('user_settings_settings_idx').on(t.settings)`)
- bug: btree entries cap ~2704 bytes; blob contains free-text `customPrompt` + growable arrays; index serves no query.
- failure: long custom prompt → "index row size exceeds btree maximum" → that user can never save settings.
- confidence: medium (needs the blob to exceed the cap post-compression).
- fix sketch: drop the index.

### D7 [P2] `.env.production` written unquoted and consumed via bash `source`
- file: `write-ec2-env.sh:28-39` (verified: `DATABASE_URL=${DATABASE_URL}` unquoted); consumers `set -a; source` it
- failure: a `DATABASE_URL` with `&` (e.g. `?sslmode=require&connect_timeout=5` — exactly what drizzle.config.ts appends) truncates at `&` and backgrounds the remainder; metacharacter secrets break parsing.
- fix sketch: emit `KEY='value'` with single-quote escaping.

### D8 [P2] `ingest-benchmark` writes 1,000 fixture messages into the production mailbox with no cleanup *(agent-verified)*
- file: `scripts/ingest-benchmark.ts:104-108`
- failure: 1,000 "Benchmark…" threads in the live pilot inbox + S3 objects; reruns dedupe-short-circuit and report a passing gate while measuring only duplicate lookups.
- fix sketch: refuse to run against the pilot transport; clean up inserted rows.

### D9 [P3] Thread row created outside the message transaction
- file: `store.ts:204-208` vs `215-253` (verified)
- failure: message insert fails → empty thread visible in listThreads (converges on retry unless the message is poison — pairs with A8).
- fix sketch: move thread resolution inside the same `db.transaction`.

### D10 [P3] `rds-smoke.sh` fallback requires `pg`, which isn't a dependency *(agent-verified)*
- fix sketch: use `postgres` or require psql.

### D11 [P3] `deploy-ec2.sh` picks the nvm node version lexicographically *(agent-verified)*
- file: `deploy-ec2.sh:24` (`ls | tail -1` — `v9.x` > `v22.x`)
- fix sketch: `sort -V`.

### D12 [P3] `deploy-ec2.sh` health check is one probe after a fixed 2s sleep *(agent-verified)*
- fix sketch: retry loop.

### D13 [P3] `ssm-run-command.sh`: `--timeout-seconds` is delivery timeout; poll loop can spin forever *(agent-verified)*
- fix sketch: pass `executionTimeout` parameter; cap empty-status polls.

### D14 [P3] No graceful shutdown in the http process
- file: `main.ts:79-83` (verified: no SIGTERM handler; `closeDb` exists, never wired)
- failure: every deploy aborts in-flight requests; RDS sees resets.
- fix sketch: SIGTERM → stop accepting → `closeDb()` → exit.

### D15 [P3] Seed user upsert on email can strand the account insert (FK mismatch)
- file: `seed.ts:96-126` (verified: upsert keeps existing row's id; account insert hardcodes `userId: spec.id`; no wrapping transaction in seed-prod)
- failure: organically-created user with a seed email → seed dies mid-way after rotating some passwords (compounds D4).
- fix sketch: wrap in a transaction; select actual user id after upsert.

### D16 [P3] `seed-contract` test asserts a global count of credential accounts *(agent-verified)*
- failure: first real credential user in shared RDS breaks the test permanently.

### D17 [P3] `package-contract` test bypasses package.json `exports` via vitest aliases *(agent-verified)*
- failure: a broken export map ships while the contract test stays green.

**Slice D — no findings:** `schema/index|auth.ts` (one redundant email index), migration SQL (no drift vs schema — verified by agent), `drizzle.config.ts`, `load-pm2-config.ts`, `s3-smoke.sh`, `vpn-route-check.sh`, `sync-ec2-git-bundle.sh` (space-safe), `schema-contract`/`deploy-config` tests, pool sizing (10 × 2 processes fine for t4g.medium).

---

## Findings — Slice E: Frontend cache/polling (verified ✅)

### E1 [P1] User mail data persisted into the shared `anonymous` IDB bucket, hydratable by the next user
- file: `query-provider.tsx:139-149, 259-260`; `mail-cache-scope.ts:7-10` (verified end-to-end)
- bug: the scope singleton boots `{null,null}` → cold load renders with persister key `zero-query-cache-anon-default` and hash prefix `{anon,pending}`. Queries fetched before `MailCacheScopeSync`'s effect runs are cached under that hash, and the still-active anon persister writes the user's real inbox into the shared bucket.
- failure: user A's threads persisted to `anon-default` → cleanup skipped (tab close, E2's race, E5's FORBIDDEN path, session expiry) → user B on the same browser cold-loads, restores `anon-default`, and **renders A's inbox rows** until B's session resolves. Privacy bug — belongs on the security list too.
- fix sketch: never persist while scope unresolved (gate `persistClient` on both ids), or seed the singleton synchronously pre-render.

### E2 [P1] `await toast.promise(...)` doesn't await — logout redirect races the cache cleanup
- file: `nav-user.tsx:208-224` (pattern verified: `await toast.promise(signOut().then(cleanup))` then immediate `window.location.href`)
- bug: sonner 2.x `toast.promise` returns `{ unwrap }`, not a thenable (agent verified in installed package) → the `await` resolves in a microtask and navigation commits while signOut/cleanup are still in flight.
- failure: IDB-persisted mailbox data non-deterministically survives logout — feeding E1. Distinct from the already-reported wrong-key deletion: here the deletion often never runs at all.
- fix sketch: `await toast.promise(p, …).unwrap()` (or await the raw promise) before navigating.

### E3 [P1] Scope-key change recreates the QueryClient on the next incidental re-render — full in-memory cache wipe
- file: `query-provider.tsx:158-176, 259-281` (verified: `getQueryClient(scopeKey)` builds a brand-new client when the key changes; `setMailCacheScope` triggers no re-render, so the swap happens on the next router-state re-render)
- failure: first navigation after cold load (e.g. opening a thread) flips `anon-default → u1-t1` → new empty QueryClient → session/threads flash to loading and refetch; can happen twice (userId wave, transport wave).
- fix sketch: make scope React state driving the provider, or keep one QueryClient and swap only the persister key.

### E4 [P2] Unstable hash prefix causes 2–3 duplicate fetch waves per cold load + 24h orphan cache entries
- file: `query-provider.tsx:139-149` (verified: hashFn reads the live singleton)
- failure: same logical query occupies up to three hashes (`{anon,pending}` → `{u1,pending}` → `{u1,t1}`); each step refetches; orphans persist for `gcTime` 24h and get written to IDB.
- fix sketch: keep queries disabled until scope fully resolved; exclude bootstrap queries from the prefix.

### E5 [P2] Auth-error sign-out paths skip cache cleanup entirely
- file: `query-provider.tsx:124-131` (verified: `signOut` + redirect, no `runLogoutCleanup`/IDB deletion); `root.tsx:181-192` ErrorBoundary "Log Out and Refresh" same *(agent-verified)*
- failure: FORBIDDEN-triggered sign-out leaves the full persisted mailbox in IndexedDB for the next browser user.
- fix sketch: route both paths through the same cleanup helper.

### E6 [P2] `QueryProvider`'s effect can clobber a fresher scope written by `MailCacheScopeSync`
- file: `query-provider.tsx:262-264` (verified: parent effect writes its render-time snapshot back after child effects run)
- failure: singleton stuck at `activeTransportId: null` → transport header never sent, hashing stays on `pending` — until an unrelated dep change.
- confidence: medium (needs the navigation re-render batched with getDefault resolution).
- fix sketch: delete the effect — `MailCacheScopeSync` is the single writer.

### E7 [P3][latent] Account switch: persister still bound to the old scope's bucket; post-clear `refetchQueries` is a no-op
- file: `nav-user.tsx:156-190` (verified: `setMailCacheScope` after `setDefaultConnection`; provider doesn't re-render → keeps persisting into t1's bucket; `refetchQueries` right after `runLogoutCleanup` matches zero queries)
- latent: switch UI currently gated off (`allowConnectionManagement = false`), and C2 means the switch wouldn't stick anyway.
- fix sketch: same as E3 (scope as React state).

### E8 [P3] Legacy pre-migration bucket `zero-query-cache-default` orphaned with old mailbox data *(agent-verified)*
- bug: persister key format changed; `CACHE_BURST_KEY` not bumped; old bucket never opened again, never deleted.
- fix sketch: one-time `del('zero-query-cache-default')` on boot.

**Slice E — no findings:** `thread-polling-policy.ts` (clean), `server-providers.tsx`/`client-providers.tsx`, `query-cache-policy.ts` helper itself. Test observation: `logout-cache-clear`/`query-cache-policy` tests validate the helper, not the flows — they can't fail on the E2 race. Pre-existing (out of range): `use-threads.ts:195` staleTime is 1h, comment says 1 minute.

---

## Rejected agent findings (false positives)
None — every P1/P2 claim survived main-thread re-verification against source. Overlapping findings across agents (threading, thread metadata, snooze, quarantine dedupe, isMain) corroborated each other and were merged.

## Cross-cutting recommendations (not bugs, but what would have caught them)
1. **One real-frontend E2E smoke** (login → list → open → reply → settings save) against the pilot server would have caught D1 + all of B3–B8/C1–C2 at once. Highest-leverage test to add.
2. Pilot tests should **pin the frontend wire format** (import the old router's input types or golden-file the payloads) instead of encoding the pilot's own drifted shapes.
3. Before enabling real POP3: fix A3–A6 and add a socket-mock test for `RealPop3Client.multiline` chunk splitting.
