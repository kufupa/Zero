# Audit B — Correctness + Data-Integrity Verification of the 4 FIX commits

**Date:** 2026-07-03
**Branch:** `EC2-pilot` (fork base `4b4a728c`)
**Scope:** Verify the 4 fix commits that close the P0/P1s from
`docs/superpowers/plans/2026-07-02-ec2-pilot-bug-hunt.md`. **No code was
modified.** Report only.
**Method:** `git show <hash>` for each commit + read of the CURRENT working-tree
source (which contains all 4 commits) + cross-check against the real frontend
call sites in `apps/mail/**`.
**Calibration:** solo dev, 1 EC2 + 1 RDS, fixtures/fakes only this pass; real
POP3/SMTP deferred → `[latent]`. Severity P0..P3.

**Headline for the user's #1 concern — multi-tenant isolation:** every reshaped
query in these 4 commits still carries its `transportId` (or is scoped through a
transport-filtered id set). **No cross-mailbox scope drop was found.** The
inbound thread-join — the single most dangerous reshape — is correctly
`transportId`-scoped (`store.ts:434-443`), so no cross-tenant thread merge. See
the dedicated section at the end.

---

## Fix 1 — `e5bda6b0` transactional ingest persistence + size limits

Files: `mail/ingest/store.ts`, `mail/ingest/limits.ts`, `mail/ingest/worker.ts`,
`mail/ingest/parse-message.ts`, `env.ts`.

### Targeted findings

| Finding | Verdict | Evidence |
|---|---|---|
| **N2** message+attachment in one tx | **FIXED** | `store.ts:200-245` — thread resolution + `message` insert + `attachment` insert all inside one `db.transaction`. |
| **D9** thread row created outside the tx | **FIXED** | `resolveThreadId(...)` is now called *inside* the same `db.transaction` (`store.ts:200-206`); a failed message insert rolls back the thread. |
| **N3 / A-slice** unbounded buffering → memory DoS | **PARTIAL** | Attachment stream is bounded incrementally (`parse-message.ts:332-337`). **Message size is checked only AFTER the whole raw is already buffered and PUT to S3** — see REG-3. |

Size limits come from env: `INGEST_MAX_MESSAGE_BYTES` / `INGEST_MAX_ATTACHMENT_BYTES`
(`env.ts` + `limits.ts:9-10,43-56`; defaults 25 MB / 15 MB).

Safety order (regression-hunt checklist):
- **DELE-after-commit still holds.** Normal path S3 PUT → parse → tx commit
  (`store.ts:245`) → `dele` (`worker.ts:178`). Duplicate/oversized/poison paths
  each DELE only after a durable quarantine row is written
  (`worker.ts:194,218`). ✔
- **Size-limit rejection quarantines + DELEs** (no infinite retry): `worker.ts:183-198`
  → `quarantineOversizedMessage` + `archiveQuarantineRawMime` + `dele`. ✔

### New regressions introduced

- **REG-2 [P2][latent] — poison-retry counter resets every cycle → the new
  quarantine-on-poison code is DEAD in production; poison messages retry forever
  and block the head of the queue (A8 is NOT actually fixed).**
  `worker.ts:113` creates `failureCounts = opts.failureCounts ?? new Map()`
  *per `ingestOnce` call*. `runWorker` calls `await ingestOnce()` with **no**
  shared map (`worker.ts:305`). Within one cycle each UIDL appears once, so
  `next` (`worker.ts:202-206`) only ever reaches **1**; `next >= POISON_MAX_RETRIES(3)`
  (`worker.ts:205`) is never true. Trigger: a genuinely un-parseable message →
  fails, count 1, not DELEd, retried next cycle with a fresh map, count 1 again…
  forever. Because `uidls.slice(0, maxMessages)` (`worker.ts:142`) processes the
  oldest first, ≥500 accumulated poison messages permanently starve all newer
  mail. Safety is preserved (never lost), liveness is not. Confidence: high.

- **REG-3 [P2][latent] — message-size limit does not prevent the memory DoS it
  targets.** `pop3.retr(uidl)` fully buffers the raw into memory and
  `storage.putObject({ body: msg.raw })` PUTs it to S3 (`worker.ts:145-156`)
  **before** `parseRawMessage` runs the `assertWithinIngestLimits(raw.length,'message')`
  check (`parse-message.ts:78-79`). So a 2 GB message is buffered and uploaded in
  full, then rejected. The limit correctly prevents *parsing/persisting* an
  oversized body (poison-loop safe), but not the buffering/upload. The real
  memory bound is one RETR payload, which is unbounded in the real POP3 client
  (ties to A3). Confidence: high.

- **REG-7 [P3][latent] — attachment S3 orphans accumulate per retry.**
  `worker.ts:146` regenerates `messageId = generateMessageId()` on every attempt;
  attachment keys are `attachments/{messageId}/...` (`parse-message.ts:109-113`),
  so each failed retry writes new orphan objects. Compounded by REG-2 (poison
  never quarantined → unbounded). Raw-mime key is now deterministic
  `(ingestMailboxId, uidl)` so raw MIME overwrites (A12 raw-mime portion fixed);
  attachments still orphan. Confidence: high.

- **Orphan-on-tx-abort (known, low):** raw MIME (`worker.ts:152`) and attachments
  (parse) are in S3 before the DB tx; a tx rollback leaves them. Raw MIME is
  bounded (deterministic key); attachments are REG-7.

### Prior findings NOT addressed here
A3–A6 (real POP3 client) `[latent]`; A16 (blank From stored as `''`, still
`store.ts:219`); A17 O(n²) UIDL `[latent]`.
**Bonus fixes shipped in this/adjacent commits:** A7 (quarantine dup-check
`store.ts:268,305,387` + unique idx `schema/mail.ts:62-65`), A11
(`archiveQuarantineRawMime`), A14 (`isMain` via `pathToFileURL(argv[1])`
`worker.ts:368-369`), A15 (abortable sleep `worker.ts:327-344`), D3 (dedupe now
`eq(direction,'inbound')` `store.ts:344`).

---

## Fix 2 — `4b173f5e` tRPC POST queries + FE wire-contract alignment

Files: `main.ts`, `trpc/wire-compat.ts` (new), `routes/mail.ts`, `drafts.ts`,
`settings.ts`, `user.ts`.

### Targeted findings

| Finding | Verdict | Evidence (server ↔ real FE) |
|---|---|---|
| **D1** 405 on every query (no `allowMethodOverride`) | **FIXED** | `main.ts:73` `allowMethodOverride: true`; route mounts `['GET','POST']` (`main.ts:68`). |
| **B3** `ids`/`wakeAt` vs `threadIds`/`snoozedUntil` | **FIXED** | `bulkIdsInput`/`snoozeThreadsInput`/`modifyLabelsInput` unions accept FE keys (`mail.ts:63-108`). FE sends `{ids}` (`use-optimistic-actions.ts:220,254,287,396,437`), snooze `{ids,wakeAt}`, modifyLabels `{threadId:[],addLabels,removeLabels}` (`:471-479`). |
| **B4** folder slugs `draft/archive/bin/spam` | **FIXED** | `MAIL_FOLDER_VALUES` (`mail.ts:48-60`) accepts both; semantics mapped `mail.ts:151-195`. |
| **B5** `mail.send` shape (`to:[{email,name}]`, `message`, `attachments`, `Name <email>`) | **FIXED** | `sendInput` (`wire-compat.ts:34-59`) accepts objects+`message`+attachments; spoof check parses `Name <email>` via `parseFromEmail` (`mail.ts:641-646`). Matches `create-email.tsx:97-104`. |
| **B6** `draftId` never consumed | **FIXED** | `mail.ts:726-737` marks `isSent=true, sentMessageId` after send. |
| **B7** `drafts.create` payload + upsert `id` | **PARTIAL — saves now, but body is lost on reload (REG-1).** | `createDraftInput` accepts comma-string `to` + `id` (`wire-compat.ts:119-142`); upsert on id (`drafts.ts:141-175`). Matches `email-composer.tsx:536-544`. |
| **B8** `mail.get` order + ParsedMessage shape | **FIXED** | `orderBy(asc(receivedAt))` (`mail.ts:327`); `latest = messages[len-1]` (`mail.ts:358`); `toParsedMessage` maps `sender/decodedBody/receivedOn/unread` (`wire-compat.ts:163-207`). FE reads `nonDraftMessages[len-1]`, `.decodedBody`, `.sender.email` (`use-threads.ts:238,254,273`). |
| **C1** `settings.save` shape + `{success}` | **FIXED** | input `userSettingsSchema.partial()`, returns `{success:true}` (`settings.ts:18,55,63`). |
| **C10** intercom token bare `null` | **FIXED** | `user.ts:12-14` returns `null`. |
| **C2** `connections.setDefault` (mailbox-switch persistence) | **STILL-OPEN — not touched** | `connections.ts` is not in any of the 4 commits. Mailbox switch still reverts on reload. |

### New regressions introduced

- **REG-1 [P1] — draft body silently lost on every reload/reopen (data loss of
  the user's in-progress composition).** `drafts.create` writes the body to
  `htmlBody` and hard-codes `textBody: null` (`drafts.ts:155-156`). But the read
  paths return the body from `textBody`: `drafts.get` → `content: r.textBody`
  (`drafts.ts:128`) and `drafts.list` → `body: r.textBody` (`drafts.ts:99`). The
  FE populates the composer from `draft.content` (`create-email.tsx:243`,
  `use-drafts.ts:10,63`). The FE autosave path only ever calls `drafts.create`
  (not `drafts.update`, which *does* write `textBody` — `drafts.ts:214`), so the
  body never round-trips. **Trigger:** compose → type a body → autosave fires
  `drafts.create({ message/body: html })` → close → reopen the draft → editor is
  empty; the list preview is also blank. Recipients/subject round-trip fine;
  only the body is lost. Pre-fix drafts couldn't save at all (B7), so this is a
  new bug the fix introduced. Confidence: high.

- **REG-6 [P3] — `bulkDelete` is a stateful toggle; a second invocation permanently
  deletes.** `bulkDelete`/`delete` hard-delete a thread whose `trashedAt` is
  already set, else soft-delete (`mail.ts:556-568,578-591`). The FE `delete`
  action and the bin "delete forever" both hit `bulkDelete`. A duplicate/retried
  `bulkDelete({ids})` on a just-trashed id (optimistic retry, double-click), or
  any `bulkDelete` on a thread already in the bin, hard-deletes with FK cascade
  before the "Undo" can run (undo restores via `modifyLabels` remove `TRASH`).
  needs-check (depends on FE retry behavior). Confidence: medium.

### Method-confusion note
`allowMethodOverride:true` lets a POST carry a query. tRPC still dispatches by
procedure type, not HTTP verb, and every mailbox route re-derives scope from the
session + `x-zero-active-transport` header — so no method-confusion auth bypass.
✔

### Prior findings NOT addressed here
B9 (toggleImportant now uses literal `IMPORTANT` — improved but system-label
filtering still can't match a real row), B13 (`mail.send` still non-transactional
`mail.ts:672-725`), B15 (unsend stale metadata), B16 (bulk mutations non-atomic,
per-id loops), B17 (`toggleStar` still per-row `mail.ts:461-467`), B20, C2/C3, C4
(zero-mailbox FORBIDDEN → sign-out loop), C5 (nginx 1 MB cap), C6–C9, C11
(settings still select-then-insert, no upsert), C12.
**Bonus:** B10 (`markAsUnread` now updates `message` too `mail.ts:446-451`), B11
(snooze inbox filter + lazy wake `mail.ts:140-149,163-170`), B12 (`q`/labelIds
pushed into SQL `mail.ts:214-228`), B18 (`mail.get` joins attachments
`mail.ts:329-347`).

---

## Fix 3 — `1df697b5` soft-delete bin + seed-prod + benchmark guards

Files: `routes/mail.ts`, `db/seed.ts`, `db/schema/mail.ts`, `scripts/seed-prod.ts`,
`scripts/ingest-benchmark.ts`, migration `0001_tired_blizzard.sql`.

### Targeted findings

| Finding | Verdict | Evidence |
|---|---|---|
| **B1** hard-delete where UI promises bin+undo | **FIXED** | `trashedAt` column added (`schema/mail.ts:142`, migration 0001). `bulkDelete`/`delete` soft-delete first, hard-delete only when already trashed (`mail.ts:556-568,578-591`). Bin filter: `bin → isNotNull(trashedAt)`, **every other folder → `isNull(trashedAt)`** (`mail.ts:157-161`) so trashed mail is hidden everywhere except bin. Restore via `modifyLabels` remove `TRASH` clears `trashedAt` (`mail.ts:504-526`). Hard-delete cascades (FK `onDelete:'cascade'` message/attachment/draft `schema/mail.ts:169,210,232`). |
| **D4** seed-prod rotates before an un-creatable secret write → lockout | **FIXED** | Order reversed: `planPilotCredentials` computes the set first (`seed-prod.ts:96`), `ensurePilotSecret` create-if-absent + `putPilotSecret` **before** `seedAll` (`seed-prod.ts:100-108`). Rotation gated: only missing accounts, or `--rotate` (`seed.ts:78,144`). DB rotation reuses the pre-written plaintext (`seed.ts:150`) → secret and DB stay consistent. Also fixes D15 (seed now in a tx, selects actual user id `seed.ts:135-177`). |
| **D8** ingest-benchmark writes into prod mailbox | **FIXED** | `assertSafeToRun` refuses unless `--allow-prod` (`ingest-benchmark.ts:68-82`) + `--cleanup` (`:84-91`). |

### New regressions introduced

- **REG-4 [P2][ops] — seed-prod overwrites the whole pilot secret with only the
  *changed* credentials.** `putPilotSecret(credentialsToWrite)` calls AWS
  `put-secret-value` with `JSON.stringify(credentialsToWrite)` (`seed-prod.ts:70-82,102`),
  and `credentialsToWrite` contains only accounts that were missing or
  `--rotate`d (`seed.ts:64-86`). `put-secret-value` replaces the entire value.
  **Trigger:** add one new user to `PILOT_USERS`, run `seed:prod` (no `--rotate`)
  → `credentialsToWrite = {newUser}` → the secret is overwritten to just that one
  user, dropping the stored plaintexts of the existing users. No lockout (their
  DB hashes are untouched), but their recorded passwords are gone from Secrets
  Manager (recover with a full `--rotate`). Pre-fix D4 always wrote all three, so
  the partial-clobber is new. Confidence: high.

- Minor: `onPilotIngestMailbox = INGEST_MAILBOX_ID === 'ingest-nava-legacy'`
  (`ingest-benchmark.ts:71`) is a compile-time constant that is always `true`, so
  the benchmark refuses on *any* DB unless `--allow-prod` — which then also
  bypasses the prod-DB host check. Fails safe (over-conservative), not a data
  bug. P3.

### Prior findings NOT addressed here
D5 (worker PM2 churn), D6 (btree jsonb settings index can reject long
`customPrompt`), D7 (`.env.production` unquoted `&` truncation), D10–D14, D16, D17.
S3 attachment objects are not deleted on hard-delete (orphan S3 after empty-bin) —
DB cascades, bytes leak; P3.

---

## Fix 4 — `79d1793b` threading + date headers + keyset pagination

Files: `mail/ingest/parse-message.ts`, `mail/ingest/store.ts`, `routes/drafts.ts`,
`routes/mail-helpers.ts`, `routes/mail.ts`.

### Targeted findings

| Finding | Verdict | Evidence |
|---|---|---|
| **A1** replies never join threads | **FIXED** | `resolveThreadId` matches `message.messageIdHeader IN (inReplyTo, …references)` scoped to `transportId` (`store.ts:427-456`), falls back to own message-id / `no-message-id-${uidl}`. |
| **A2** Date header ignored | **FIXED** | `buildParsedMessage` handles `dateVal instanceof Date` (`parse-message.ts:214-220`); `receivedAt`/`sentAt` now from the header. |
| **A9** no-Message-ID collapse | **FIXED** | fallback root now `no-message-id-${pop3Uidl}` (`store.ts:459`) — per-message, not a shared constant. |
| **A13** references stored with angle brackets | **FIXED** | `normalizeReferences` maps `stripAngles` (`parse-message.ts:272`); `messageId`/`inReplyTo` also stripped (`:204,206`) → join candidates and stored ids match. |
| **A10** thread metadata not updated on inbound reuse | **FIXED** | both reuse paths `UPDATE latestMessageAt/snippet/isRead=false/updatedAt` (`store.ts:446-454,472-480`). |
| **B2** listThreads keyset pagination broken | **FIXED** | keyset cursor pushed into WHERE (`mail.ts:230-264` via `keysetBefore`), fetch `limit+1`, token from the post-filter last kept row (`mail.ts:286-291`). FE advances on `nextPageToken` and stops when null (`use-threads.ts:112,156-159`). Drafts get the same keyset fix (`drafts.ts:49-89`). |

Tie-break correctness: `keysetBefore` uses a row-value comparison
`(COALESCE(ts,to_timestamp(0)), id) < (cursorTs, cursorId)` (`mail-helpers.ts:73`)
against `ORDER BY latestMessageAt DESC, id DESC` — for the non-null case this
gives no dropped/duplicated rows at page boundaries. ✔

### New regressions introduced

- **REG-5 [P3][latent] — NULLS-LAST is NOT handled; ORDER BY and the keyset
  disagree on where a NULL timestamp sorts.** `ORDER BY desc(latestMessageAt)`
  (`mail.ts:283`) is Postgres default **NULLS FIRST**, but the keyset coalesces
  a NULL to epoch (`mail-helpers.ts:73`), i.e. treats it as the *oldest*. A row
  with `latestMessageAt IS NULL` would appear at the top of page 1 and again on a
  later page (duplicated) or be dropped, depending on the boundary. Latent: no
  current writer produces a NULL `latestMessageAt` (ingest and send always set
  it), so B19 stays latent — but the fix did not close it, and introduced the
  ORDER-BY/keyset inconsistency. Confidence: high (that it is unhandled);
  no live trigger today.

- Low-confidence: `COALESCE(latest_message_at, to_timestamp(0))` mixes `timestamp`
  (column) with `timestamptz` (`to_timestamp`) → the coalesced expression is
  `timestamptz` while `ORDER BY` compares the raw `timestamp`. Under a non-UTC DB
  session timezone the exact-tie boundary could shift between filter and order.
  Tests presumably run UTC. needs-check, P3.

- **No cross-tenant merge.** The thread-join `SELECT ... FROM message WHERE
  eq(transportId, transportId) AND inArray(messageIdHeader, candidates)`
  (`store.ts:434-443`) is transport-scoped: a reply's In-Reply-To/References can
  only match a parent in the *same* transport. The P0 the brief warned about is
  averted. ✔

### drafts pagination
**FIXED** with the same keyset (`drafts.ts:77-89`), and `q` pushed into SQL
(`drafts.ts:42-47`) — B14 pagination + search addressed. (Draft body round-trip
is still broken — REG-1.)

---

## Multi-tenant isolation audit (user's #1 concern) — CLEAN

Every reshaped/new WHERE clause was checked for a retained `transportId`
predicate (or scoping through a transport-filtered id set):

- `listThreads` base `eq(transportId)` + every folder branch + keyset + cursor
  fallback lookup (`mail.ts:155,197-212,242-264`). ✔
- `sent`-folder `exists()` subquery is `transportId`-scoped (`mail.ts:197-211`). ✔
- `markAsRead/Unread`, `toggleStar/Important`, `modifyLabels`, `bulkArchive`,
  `bulkDelete`, `delete`, `snooze/unsnooze` — all update `WHERE id=… AND
  transportId=…` and pre-check via `requireThreadForTransport` (`mail.ts:378-624`). ✔
- `mail.get` — thread via `requireThreadForTransport`; messages `eq(transportId)`;
  attachments via `inArray(messageId, <transport-filtered ids>)` (attachment has
  no transport column, so id-set scoping is correct) (`mail.ts:320-341`). ✔
- `mail.send` reply-header lookup + draft-consume update are `transportId`-scoped
  (`mail.ts:656-666,734`). ✔
- `drafts.list/get/create/update/delete` — all `eq(mailDraft.transportId)`
  (`drafts.ts:38,60,115,146,200,235`). ✔
- Inbound thread-join — `transportId`-scoped (`store.ts:439`). ✔
- `settings`/`user` are per-`userId`, not transport (correct). ✔

**No `transportId` drop found in any of the 4 commits.** Confidence: high (~95%).

---

## Consolidated regressions (new bugs the fixes introduced)

| ID | Sev | One-line |
|---|---|---|
| REG-1 | **P1** | Draft body lost on reload — create writes `htmlBody`, get/list read `textBody` (`drafts.ts:99,128,155-156`). |
| REG-2 | P2 `[latent]` | Poison-retry counter is per-cycle → quarantine never fires → poison mail retries forever + head-of-line starvation (`worker.ts:113,305`). |
| REG-3 | P2 `[latent]` | Message-size limit runs after full buffer + S3 PUT → does not prevent the memory DoS it targets (`worker.ts:145-156` vs `parse-message.ts:79`). |
| REG-4 | P2 (ops) | seed-prod `put-secret-value` clobbers whole secret with only changed creds → adding a user drops others' stored passwords (`seed-prod.ts:102`). |
| REG-5 | P3 `[latent]` | Keyset ORDER BY (NULLS FIRST) vs `COALESCE(ts,epoch)` disagree; NULLS-LAST unhandled (`mail.ts:283` vs `mail-helpers.ts:73`). |
| REG-6 | P3 | `bulkDelete` is a toggle — a retried/second call hard-deletes before undo (`mail.ts:556-568`). |
| REG-7 | P3 `[latent]` | Attachment S3 orphans per retry (fresh `messageId` each attempt, `worker.ts:146`); worsened by REG-2. |

None of REG-1..7 is a tenant-scope leak.

---

## Prior bug-hunt findings still open after these 4 commits

Ingest: A3–A6 `[latent]`, A8 (nominally coded, ineffective — REG-2), A12
(attachment orphans — REG-7), A16, A17 `[latent]`.
Mail router: B9 (partial), B13 (send non-transactional), B15, B16, B17, B19
(REG-5), B20.
Auth/wiring: C2 (connections.setDefault — untouched), C3, **C4 (zero-mailbox
FORBIDDEN → sign-out loop)**, C5 (nginx 1 MB body cap), C6–C9, C11, C12.
DB/scripts/deploy: D5, D6, D7, D10–D14, D16, D17.
Frontend cache/polling: **all of E1–E8** (no commit in this set touches
`apps/mail` cache/logout paths — E1/E2/E5 privacy items remain).

**Bonus fixes that landed alongside the targeted ones:** A7, A11, A14, A15, D3,
D9, D15, B10, B11, B12, B18.
