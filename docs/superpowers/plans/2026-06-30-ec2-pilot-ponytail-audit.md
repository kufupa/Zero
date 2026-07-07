# Ponytail Audit — EC2 Pilot Backend Plan

> Lens: **over-engineering only.** What can be deleted, deferred, or replaced by something already here. This is NOT a correctness review — that was the gstack/Claude Opus pass already in the plan. Findings ranked most-impactful-deletion first.
>
> **Method:** 5 parallel read-only repo investigations. Every claim below is anchored to `file:line` in the *current* `apps/server` / `apps/mail`, not to the plan's assertions.
>
> **Target:** [`2026-06-30-ec2-pilot-schema-and-backend.md`](2026-06-30-ec2-pilot-schema-and-backend.md)
> **Date:** 2026-06-30

---

## TL;DR — net effect if all high-confidence cuts taken

| Lever | Plan as written | After ponytail | Delta |
|---|---|---|---|
| App tables | 20 | **~15** | −5 (jwks, message_recipient, mail_scheduled_email, writingStyleMatrix, + inbound/outbound merged to one `message`) |
| Extra DB schema | + `pgboss` (~7 tables) | none | −7 tables, −1 dependency |
| Tasks | 13 | **11** | drop Task 6 (pg-boss), Task 11 (WS server) |
| PM2 processes | 5 (2 HTTP + ingest + cron + ws) | **2–3** | drop `ws` worker; collapse ingest+cron |
| nginx | reverse proxy + `ip_hash` sticky | plain proxy | drop sticky-session config |
| New deps | + pg-boss | none | one fewer dependency to own |

All four table cuts and both task cuts have a **product gate** named below. None is "delete blindly" — each is "delete unless requirement X, and here's the one-line path to add it back."

---

## Findings

### F1 — pg-boss (Task 6) is a queue for two timers that aren't a queue's job · **HIGH confidence**

**Cut:** the pg-boss dependency + its ~7-table `pgboss` schema + Task 6 entirely.

**Evidence:**
- send-undo window is hard-coded **15s** (`mail.ts:518` `Date.now() + 15_000`). A cron can't serve a 15s window, and a queue is overkill for it — the FE already owns the payload + the Undo toast (`use-undo-send.ts:71,88`; `create-email.tsx:98,124`). FE already fires send immediately then shows undo; just delay the mutation 15s and skip on Undo. **No queue, no column.**
- snooze stores **only a `wakeAt` timestamp** (`mail.ts:764-766`); wake is a timestamp check. Today's background cron wake is **commented out** (`main.ts:1226-1235`) — only lazy on-access in `listThreads` works (`mail.ts:129-167`). A single cron polling a `wake_at` column is *strictly more* than ships today.
- Volume ~0.7 sends/min (plan line 19). **No retry** (consumer deletes on error, `main.ts:1065-1068`), no concurrency/batching, no dead-letter. pg-boss's entire reason to exist is unused.

**Replace with:** FE 15s delay for undo (or a `scheduled_at` column polled by the ingest worker you're already building); one `wake_at` column polled by the cron worker you're already building.

**Gate / add-back:** if pilot ships explicit "send later (>12h)" as a user feature, persist those in a `scheduled_at` column (Cloudflare already does exactly this via cron today — `main.ts:1125-1177`). Still no queue.

---

### F2 — Task 11 WebSocket server is infra for a feature the pilot defers · **HIGH confidence**

**Cut:** the Hono WS server on `/ws/agent/:staffMemberId`, the broadcast-after-mutation wiring, the 5th PM2 `ws` process, and the nginx `ip_hash` sticky-session block.

**Evidence:**
- The **only** WS client is the AI sidebar (`ai-sidebar.tsx:351-428`); grep finds no other socket in `apps/mail`. Core mail runs entirely on tRPC HTTP: list (`use-threads.ts:23-38`), open (`:73-83`), mark-read/send/snooze/star/label (`use-optimistic-actions.ts:61-72,202`) — all with local optimistic atoms, **no WS round-trip**.
- WS `Mail_List`/`Mail_Get`/`User_Topics` are server-push **cache invalidations** (`ai-sidebar.tsx:314-332`); `Do_State` is a **cosmetic** sync dot (`nav-user.tsx:104`). `onError` only `console.log`s (`ai-sidebar.tsx:356`) — nothing crashes without WS.
- FE already has `refetchIntervalInBackground:true` but **no `refetchInterval`** (polling off) and `refetchOnWindowFocus:false` (`query-provider.tsx:54`, `use-threads.ts:33-36`). Both are one-line flips that fully replace push-invalidation.
- The plan **already defers AI chat** ("agent AI chat full port deferred", Task 11 Step 3 stubs chat). So WS would be built to push freshness only — for **POP3-polled mail** that updates on a poll cycle anyway.

**Replace with:** `refetchInterval: 30_000` + `refetchOnWindowFocus: true` (two FE lines). Mail is not real-time over POP3; a 30s refetch matches the ingest cadence.

**Gate / add-back:** when the real-time AI chat sidebar is ported (post-pilot), bring the socket with it — that's its actual consumer.

---

### F3 — `message_recipient` per-staff fan-out invents per-user state nothing reads · **HIGH confidence (code) / GATED (product)**

**Cut:** the `message_recipient` table and the ingest fan-out (one NOT-NULL row per matched staff, ~50k rows/day). Move `is_unread` / `labels` / `star` onto `mail_thread`.

**Evidence:**
- Read state is a **thread-level Gmail-style label scoped to the mailbox, never per-user**: `markAsRead`/`markAsUnread` pass only `activeConnection.id` + `threadId`, **no userId** (`mail.ts:196-224`); `get`/`listThreads` fetch by `activeConnection.id` only (`mail.ts:62-73,74-195`); label write is one record per connection (`server-utils.ts:299-313`) and mirrors upstream `\Seen` (`google.ts:196`).
- FE consumes a **single shared bool** `message.unread` (`types.ts:132`, derived at `google.ts:1116`); rendered at `mail-list.tsx:872` with **no per-user overlay**.
- `useActiveConnection` (9 files) gates **which mailbox is selected**, not read state (`use-connections.ts:10-22`).
- On one shared `Nava@` box, all ~50 users see all mail — there's no per-staff *visibility* routing to justify the fan-out either.

**Replace with:** thread-level `is_unread`/`labels`/`star` columns (shared IMAP semantics — read by one = read for all, which is what the code does today).

**Gate / add-back — this is the one real product decision:** if the pilot *requires* each of the 50 agents to track their **own** read/unread, that capability **does not exist today** and `message_recipient` is exactly where you'd add it. Decide this explicitly — don't build 50k rows/day of per-user state by default for a UI that can't show it.

---

### F4 — `jwt()` plugin + `mail0_jwks` table are dead in the pilot · **HIGH confidence**

**Cut:** the Better-Auth `jwt()` plugin (`auth.ts:171`), the `bearer()` plugin (`:172`), and the `mail0_jwks` table → **19 tables**, smaller auth surface. (Plan currently says "keep jwt() + mail0_jwks".)

**Evidence:**
- The kept FE authenticates tRPC/HTTP **exclusively via session cookies** — `credentials:'include'`, **no `Authorization` header** anywhere (`query-provider.tsx:96-97`, `lib/trpc.ts:14`, `auth-client.ts:7-8`).
- The only Better-Auth-JWT verifier is a non-cookie **bearer fallback** that runs only when a client sends a JWT and no valid cookie (`main.ts:625-640`) — no kept path does this. Its real consumer is the **MCP/OAuth server** the pilot drops (`auth.ts:168-170`, `main.ts:789-834`).
- The two JWTs the pilot might still want — Intercom identity (`user.ts:16-23`) and Google service-account Pub/Sub (`google-subscription.factory.ts:60-74`) — are signed **independently** with `JWT_SECRET`/the SA key via `@tsndr/cloudflare-worker-jwt`. Neither touches the `jwt()` plugin or `mail0_jwks`. (And Google Pub/Sub is itself dropped with Gmail.)

**Replace with:** nothing — email+password session cookies are the whole auth path. Keep `JWT_SECRET` only if Intercom ships.

**Gate / add-back:** if an MCP/OAuth server or a bearer-token API client is added later, re-add `jwt()` then.

---

### F5 — `writingStyleMatrix` retained à la carte while its only consumer is deferred · **MEDIUM (follows the AI-compose decision)**

**Cut (conditional):** drop `writingStyleMatrix` + its post-send write + the per-send Gemini call — **iff** AI compose is deferred with the rest of AI.

**Evidence:**
- `writingStyleMatrix` has **zero non-AI readers**. Written on **every** send (`mail.ts:492` → `writing-style-service.ts:193`), via a **per-send Gemini `extractStyleMatrix` LLM call** (`writing-style-service.ts:341`). Read **only** by `ai/compose.ts:36,158` (the two composer AI buttons).
- The plan defers AI broadly (vector, `brain.generateSummary`, agent chat) yet **separately** keeps this table and ports `ai/compose` (Task 10). Same OpenAI surface, split decision.

**The inconsistency is the finding:** decide AI-compose **in or out once**, and let the table + the `writing-style-service` update + the `mail.ts:492` hook all follow that single decision.
- AI-compose **IN** → keep the matrix; its readers (`email-composer.tsx:705,977`) are live composer buttons, not the deferred sidebar. Fine.
- AI-compose **OUT** → keep the table and you have **write-only dead weight plus an LLM call on every send that nothing reads**. Drop all three.

**Side notes (same investigation):** `suggestRecipients` — **keep**, plain history query, live in composer (`recipient-autosuggest.tsx:98`), no AI. `deleteAllSpam` — **thin port only**; POP3 pilot has no spam classifier, so it acts on a near-empty manually-curated set — don't invest.

---

### F6 — `mailbox_transport` should be a 1-row table at most, and creds don't belong in a PG column · **LOW / structural + security**

**Keep as a single seeded row, not a multi-row table; put credentials in secrets.**

**Evidence:**
- One shared mailbox = one POP3 + one SMTP cred set; **no pilot path has >1 transport**. The codebase already funnels everything through a single `connectionId` partition key + FKs (`server-utils.ts:576-589`; FKs at `schema.ts:151,210`).
- A row with a stable `id` is worth keeping **only** to preserve that `connectionId`-as-partition-key/FK plumbing and leave room for a 2nd mailbox later — not for data volume.

**Do:** one seeded `mailbox_transport` row holding non-secret config + the stable id. **Don't:** store the SMTP/POP3 password as a plaintext PG column — keep it in env/secrets manager. (This is the one place ponytail says *more* care, not less: credentials at a trust boundary.)

---

### F7 — merge `inbound_message` + `outbound_message` into one `message` table · **MEDIUM-HIGH (~90%)**

**Cut:** the two-table split. Use one `message` table with a `direction enum('inbound','outbound')` discriminator → **−1 table**, and `mail.get` becomes a single `WHERE thread_root_id` + `ORDER BY` instead of a UNION.

**Evidence (verified this pass):**
- Both directions already map to the **same** output type: `toParsedMessage(inbound|outbound, …): ParsedMessage` (plan Task 7) → `ParsedMessageSchema` (`types.ts:118-155`). One mapper, one row shape out.
- Existing PG schema has **no message table at all** (`schema.ts` — 16 tables: user…emailTemplate; messages lived in DO SQLite + R2). So this is a greenfield design choice, not a migration — the cheap moment to pick the lazy shape.
- Column divergence is **small**: shared ≈ sender/to/cc/bcc/subject/body/messageId/inReplyTo/references/threadRootId/attachments (all in `ParsedMessage`). Inbound-only: `pop3_uidl`, `raw_eml_path`, `received_at`, `tls`. Outbound-only: `status`, `scheduled_at`, `sent_at`. ≈4 nullable columns per direction.
- The dedup constraint survives intact as a **partial unique index**: `UNIQUE (transport_id, pop3_uidl) WHERE direction='inbound'`. Per-direction required fields → one `CHECK`. Postgres does both natively.

**Net:** one table, one mapper input (already is), no UNION, one index set. Cost: ~8 conditionally-null columns + 1 partial index + 1 CHECK — strictly less than two tables + a UNION.

**Gate / add-back (the ~10% I won't claim):** the split wins the day outbound grows real delivery tracking — per-recipient bounce/delivery status, retries, DSN. A fire-and-forget SMTP pilot has none of that. **Unify for the pilot; split when outbound earns its own lifecycle.**

---

### F8 — PM2 5 processes → 2 · **HIGH confidence (conditional on F1+F2)**

**Cut:** from `2 HTTP + ingest + cron + ws` to **`1 HTTP + 1 worker`**.

**Evidence/reasoning:**
- `ws` process is gone with F2. With F1, there's no pg-boss daemon forcing isolation — the remaining background work is two **I/O-bound timers**: the POP3 poll loop and the snooze/scheduled `wake_at` poll. Both live in **one** Node worker process (two `setInterval`s); nothing shares mutable in-process state that needs separation.
- One HTTP process handles ~50 VPN users + ~1k emails/day (≈0.7 sends/min) with enormous headroom — Node is async; the poll loop is I/O, it won't block request latency, which is why HTTP and the poller still split into 2 processes rather than 1.

**Add-back:** bump HTTP to 2 workers **only if** a load look shows `processEmailContent` HTML-sanitize saturating a core on read. Don't hard-set 5 up front. **Dependency:** this count assumes F1 + F2 are taken; if pg-boss/WS are kept, their processes return.

---

### F9 — Task 2 "exports exactly 20 tables" assertion is brittle ceremony · **HIGH confidence**

**Cut:** the exact-count test. Keep the invariant tests already sitting next to it.

**Evidence:** the test does **exact-set equality** — `expect(tables.sort()).toEqual(EXPECTED.sort())` (plan lines 159-161). It breaks on *any* legitimate schema change, and **every cut in this audit breaks it** (drop jwks / message_recipient / mail_scheduled_email / writingStyleMatrix / merge messages). Meanwhile the same `describe` block **already** asserts what actually matters — `writingStyleMatrix` PK is `staffMemberId` (plan:163-166), `outboundMessage.threadRootId` present (plan:167-169).

**Replace with:** keep those invariant `it()`s (and add `mailThread.hasUnread` is undefined, per plan fix #1); **delete** the exact-count `it()`. Assert the contract, not the census. Minor — it's the superpowers TDD house style — but it'll fight you on every cut above.

---

## What is NOT over-engineered (ponytail approves)

Credit where due — these are already the lazy-correct calls, keep them:
- Vector search / pgvector **deferred**, `brain.generateSummary` stubbed to null (plan lines 20, 59). Right call.
- `processEmailContent` **ported verbatim** (no backend deps) — reuse over rewrite (plan line 94).
- `forceSync` / `verifyEmail` **stubbed** (plan lines 79, 96). Right.
- S3 (Task 3) and pg-boss (Task 6) **ordered before** their consumers — correct dependency ordering (even though F1 removes pg-boss).
- Building `apps/server-pilot/` **beside** untouched `apps/server/` for a parallel cutover — that's a product/migration decision, not bloat.

---

## Three decisions the planner must make (everything above hangs on these)

1. **Per-user read/unread on the shared box — required or not?** No → drop `message_recipient` (F3). Yes → keep it, it's the only home for that capability.
2. **AI compose — in the pilot or deferred?** Out → drop `writingStyleMatrix` + per-send Gemini call (F5). In → keep both.
3. **Explicit "send later" — a pilot feature?** No → send-undo is pure FE, drop `mail_scheduled_email` (F1). Yes → one `scheduled_at` column + cron, still no pg-boss.

Resolve these three and the table count, task list, and process count fall out automatically. Default lazy answer to all three: **drop**, add back on the one named trigger.
