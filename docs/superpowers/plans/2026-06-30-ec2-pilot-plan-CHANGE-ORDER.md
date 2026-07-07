# CHANGE ORDER — apply to the EC2 Pilot Backend Plan

**You are an implementing LLM. Your job: EDIT the plan below to incorporate every directive in this file. Do not re-derive — the analysis is done and anchored to real `file:line` evidence. Edit the plan, don't rewrite it from scratch.**

- **Plan to edit:** `docs/superpowers/plans/2026-06-30-ec2-pilot-schema-and-backend.md`
- **Source analysis (read for evidence, do not edit):** `docs/superpowers/plans/2026-06-30-ec2-pilot-ponytail-audit.md`
- **Lens:** over-engineering removal + branch-base correction. Every cut has a named add-back trigger — preserve those triggers as `ponytail:`-style notes in the plan so deferred work is tracked, not lost.

Tags: **[APPLY]** = high confidence, make the edit. **[GATED: Q#]** = conditional on a human product answer in §0; apply the default (drop) and mark it as an assumption if no answer is given.

---

## §0 — THREE PRODUCT GATES (resolve first; default = DROP)

These three answers determine the final table count and several task edits. If the human has answered, follow the answer. If not, **apply the default and add a visible `> ASSUMPTION (gate Qn): defaulted to DROP — revert if <trigger>` callout at the top of the plan.**

| Q# | Question | Default | If "keep" instead |
|---|---|---|---|
| **Q1** | Must each of the ~50 agents track their **own** read/unread on the shared `Nava@` box? | **DROP** per-user state | keep `message_recipient` (F3 reverts) |
| **Q2** | Is **AI compose** (the two composer buttons: "AI write" + "generate subject") in pilot scope? | **DROP** (defer with rest of AI) | keep `writingStyleMatrix` + ports (F5 reverts) |
| **Q3** | Is explicit **"send later (>12h)"** a pilot user feature? | **DROP** | keep one `scheduled_at` column + cron (still no pg-boss) |

---

## §1 — SCHEMA CHANGES (Task 2 + "Schema audit summary" + "Pilot schema fixes")

Final app-table count: **20 → 18 unconditionally, → as low as 15** after gates. Update EVERY place the plan says "20 tables" (lines ~7, ~23, ~48, ~138, Task 2 heading, and the `EXPECTED` test array).

### [APPLY] F4 — drop `jwt()` plugin + `jwks` table
- Remove `jwks` from the 20-table set and from `EXPECTED` (Task 2 Step 1).
- In **Global Constraints** and **Task 4**, change "keep `jwt()` plugin + `mail0_jwks`" → **"strip `jwt()`, `bearer()`, and `mcp()` plugins; drop `mail0_jwks`. Auth = email+password session cookies only."**
- Update the `mail0_jwks` row in the disposition table (line ~37) from KEEP → **DROP**. Update "9 kept" → "8 kept".
- Update Task 4 Step 1 failing test: assert `jwt` plugin is **absent** (not present). Keep `JWT_SECRET` env only if Intercom ships.
- Evidence: FE auth is cookie-only (`query-provider.tsx:96-97`); Better-Auth JWT consumed only by dropped MCP server (`auth.ts:168-171`, `main.ts:625-640`). Intercom/Google-SA JWTs are signed independently via `JWT_SECRET`, not the plugin.
- `ponytail:` note to leave: "jwt() removed — re-add if an MCP/OAuth server or bearer-token API client returns."

### [APPLY] F7 — merge `inbound_message` + `outbound_message` → one `message` table
- Replace the two tables with a single **`message`** table carrying `direction enum('inbound','outbound')`.
  - Shared columns (both directions): `sender`, `to_addrs[]`, `cc[]`, `bcc[]`, `subject`, `body`, `processed_html`/`blob_url`, `message_id`, `in_reply_to`, `references`, `thread_root_id`, attachments via the `attachment` FK.
  - Inbound-only (nullable): `pop3_uidl`, `raw_eml_path`, `received_at`, `tls`.
  - Outbound-only (nullable): `status`, `scheduled_at`, `sent_at`.
- Dedup constraint becomes a **partial unique index**: `UNIQUE (transport_id, pop3_uidl) WHERE direction = 'inbound'`.
- Per-direction required fields → one `CHECK` constraint.
- **Task 7 `mail.get`:** replace the inbound+outbound **UNION** with a single `SELECT … WHERE thread_root_id = $1 ORDER BY <time>`. The mapper signature `toParsedMessage(row, …)` stays (it already accepts either).
- Update `EXPECTED` array: remove `inboundMessage` + `outboundMessage`, add `message`. Update "Pilot schema fix #3" (thread_root_id on outbound) to "thread_root_id on `message` (all rows)".
- Evidence: both directions already map to one `ParsedMessage` (`types.ts:118-155`); no PG message table exists today (greenfield). Pilot SMTP is fire-and-forget — no delivery/bounce tracking to justify a split.
- `ponytail:` note to leave: "single message table — split outbound back out only when it grows per-recipient delivery/bounce/DSN tracking."

### [GATED: Q1] F3 — drop `message_recipient` fan-out
- Default (Q1=DROP): remove `message_recipient` from the table set + `EXPECTED`. Move `is_unread` / `labels[]` / `star` onto **`mail_thread`** (thread-level, shared = IMAP `\Seen` semantics).
  - Delete the ingest **fan-out** step (Task 5 Step 2: "fan out one row per matched staff"). Ingest writes one thread + one message; no per-staff rows.
  - Task 7 Step 4 / Task 8: `markAsRead`/`listThreads` read unread from `mail_thread`, not `message_recipient`.
  - Remove "Pilot schema fix #2" (NOT NULL fan-out) and the `(staff_member_id, …)` indexes that only served per-staff rows. Update Claude-blocker table row "NULL in UNIQUE" → "N/A — message_recipient dropped".
- If Q1=KEEP: leave the plan's fan-out as written.
- Evidence: read state is thread-level, mailbox-scoped, **no userId** anywhere (`mail.ts:196-224`, `62-195`); FE `message.unread` is one shared bool (`types.ts:132`).
- `ponytail:` note to leave: "per-user read state intentionally not built — `message_recipient` is where it goes if product later needs per-agent unread."

### [GATED: Q2] F5 — drop `writingStyleMatrix`
- Default (Q2=DROP): remove `writingStyleMatrix` from table set + `EXPECTED`; remove the post-send write hook and the per-send Gemini `extractStyleMatrix` call; do **not** port `ai/compose` / `generateEmailSubject` (move them to the deferred-AI list alongside vector search + `brain.generateSummary`). Update Task 2 Interfaces (drop the `writingStyleMatrix.staffMemberId` PK assertion), Task 10 Step 2, and "Pilot schema fix #4".
- If Q2=KEEP: keep the table, keep `staffMemberId` PK, port `ai/compose`; leave Task 10 Step 2 as written.
- Evidence: `writingStyleMatrix` has zero non-AI readers — written every send (`mail.ts:492`, via Gemini call `writing-style-service.ts:341`), read only by `ai/compose.ts:36,158`.
- `ponytail:` note to leave: "writingStyleMatrix tracks ai/compose — re-add both together."

### [GATED: Q3] F1-schema — drop `mail_scheduled_email`
- Default (Q3=DROP): remove `mail_scheduled_email` from table set + `EXPECTED`. Send-undo is handled FE-side (see §2 F1). 
- If Q3=KEEP: replace the table with a single `scheduled_at` column on `message` (outbound rows) polled by cron — still **no pg-boss**.

### [APPLY] F6 — `mailbox_transport` stays a single seeded row; creds in secrets
- Keep `mailbox_transport` as a **1-row** table (preserves the `connectionId`-as-partition-key + FK plumbing; leaves room for a 2nd mailbox). Do **not** model it as multi-tenant.
- **Security:** POP3/SMTP passwords go in **env/secrets manager**, NOT a plaintext PG column. The table holds non-secret config + the stable id only. Add this as an explicit constraint in Global Constraints.

---

## §2 — TASK / INFRA CHANGES

### [APPLY] F1 — delete Task 6 (pg-boss); rework send-undo + snooze without a queue
- **Delete Task 6 entirely** ("pg-boss setup").
- Remove `pg-boss` from: Tech Stack (line ~9), Global Constraints, the dependency list (Task 1 Step 2), the file structure tree (`src/lib/queue.ts` — delete; `src/workers/cron.ts` — keep but simplify), and the line ~23 note about the `pgboss` schema (~7 tables).
- **Task 9 Step 3 (send undo):** replace pg-boss `startDate` with a **client-side 15s delay** — FE already owns payload + Undo toast (`use-undo-send.ts`); delay the `send` mutation 15s, skip on Undo. No queue, no column (unless Q3=KEEP → `scheduled_at` column).
- **Snooze (Task 8 / cron):** store a `wake_at` timestamp; the **cron worker** (already in the plan) polls `WHERE wake_at <= now()` and restores INBOX. This is strictly more than today (current cron wake is commented out — `main.ts:1226`).
- Evidence: undo = hardcoded 15s (`mail.ts:518`); snooze = bare timestamp (`mail.ts:764`); ~0.7 sends/min, no retry/concurrency/DLQ used.

### [APPLY] F2 — delete Task 11 (WebSocket server); replace with FE polling
- **Delete Task 11 entirely** ("Minimal WebSocket sync").
- Remove `src/workers/ws.ts` from the file structure; remove the `ws` PM2 process and the nginx `ip_hash` sticky-session block from Task 13.
- **In Task 12 (FE wiring),** add one step: set react-query `refetchInterval: 30_000` + `refetchOnWindowFocus: true` (`query-provider.tsx:54`, `use-threads.ts:33-36` — `refetchIntervalInBackground:true` already set; `refetchInterval` currently unset). This replaces the WS cache-invalidation pushes.
- Evidence: WS feeds only the AI sidebar (deferred); core mail is pure tRPC HTTP with optimistic atoms (`use-optimistic-actions.ts`); `onError` only logs — nothing breaks without WS.
- `ponytail:` note to leave: "WS server deferred with AI chat — bring the socket back when the real-time agent sidebar is ported (its only consumer)."

### [APPLY] F8 — Task 13 PM2: 5 processes → 2
- Change "PM2: 2 HTTP + 1 ingest + 1 cron + 1 ws" → **"PM2: 1 HTTP + 1 worker (POP3 poll + snooze/scheduled cron, two intervals in one process)."**
- Add a one-line note: "bump HTTP to 2 workers only if a load test shows `processEmailContent` HTML-sanitize saturating a core." 
- Depends on F1 + F2 being applied.

### [APPLY] F9 — Task 2 Step 1: replace the brittle exact-count test
- Delete the `it('exports exactly 20 tables')` block (exact-set equality breaks on every legit change).
- **Keep** the invariant `it()`s already present (`writingStyleMatrix` PK — unless Q2=DROP; `outboundMessage.threadRootId` → retarget to `message.threadRootId`). **Add** `it('mailThread has no hasUnread column')` (per schema fix #1).
- Assert the contract, not the census.

### [APPLY] F5-side — Task 10 minor
- `suggestRecipients`: **keep** (plain history query, live in composer `recipient-autosuggest.tsx:98` — not AI).
- `deleteAllSpam`: **thin port only** — POP3 pilot has no spam classifier, so it acts on a near-empty manually-curated set. Note this; don't invest.

---

## §3 — BRANCH BASE CORRECTION (affects Global Constraints + Task 1 + Task 12)

**Change the base branch.** The plan cuts `EC2-pilot` from `main`. Cut it from **`FE-demo-minimal` HEAD** instead.

- Verified: `FE-demo-minimal` is **0 behind / 52 ahead** of `main` (strict linear superset) and carries the flag-gated FE/BE decoupling + the advanced Nava/Centurion UI that production must ship.
- **Global Constraints:** change "Branch: `EC2-pilot` cut from `main` HEAD" → **"`EC2-pilot` cut from `FE-demo-minimal` HEAD (0 behind main; carries the production UI + flag-gated decoupling). `apps/server/` untouched."**
- **Task 1 Step 1:** `git checkout -b EC2-pilot FE-demo-minimal` (not `main`).
- Rationale to embed: building the backend on `main` then porting 52 UI commits = integration done twice, colliding on the exact hooks the backend serves (`use-threads`/`connections`/`drafts`/`labels`/`settings`). Building on `FE-demo-minimal` eliminates the manual UI port.

### [APPLY] Task 12 amendments (new steps)
- **Flip the demo flag:** `FORCE_FRONTEND_ONLY_DEMO` is hardcoded `true` (`apps/mail/lib/demo/runtime.ts:7`). Change it to env-gated (default false) so the pilot FE actually talks to `server-pilot`. One constant.
- **Demo-cruft cleanup pass:** strip/quarantine demo-only artifacts before prod (demo guards, mock corpus, the Cursor/caveman debug-log checkpoint commit, the 112 demo-backend tests). They're dormant when the flag's off but must not ship to the 50 VPN users.
- **Pre-flight hook verification (1 pass):** confirm the decoupling didn't change the **flag-off return shapes** of the 5 touched hooks the backend must satisfy (design kept prod on tRPC, so low risk — verify, don't assume).

### [APPLY] Task 7 fixture
- Use `apps/mail/lib/demo-data/centurion-threads.json` as the mapper test fixture — it is the exact `ParsedMessage` shape the advanced UI expects.

---

## §4 — DO NOT TOUCH (these are already lazy-correct; reject any "simplification" here)

- Vector search / pgvector **deferred**, `brain.generateSummary` → null. Keep.
- `processEmailContent` **ported verbatim** (no backend deps). Keep — reuse over rewrite.
- `forceSync` / `verifyEmail` **stubbed**. Keep.
- S3 (Task 3) built **before** its consumers. Keep ordering.
- Auth security at trust boundaries, input validation, the `(transport_id, pop3_uidl)` idempotency — **do not simplify away.**

---

## §5 — FINAL CHECKLIST for the implementing LLM

1. Resolve §0 gates (use defaults + assumption callouts if unanswered).
2. Apply all **[APPLY]** edits (F4, F7, F6, F1, F2, F8, F9, branch base, Task 12, Task 7).
3. Apply **[GATED]** edits per the gate answers (F3, F5, F1-schema).
4. Recompute and replace **every** "20 tables" reference with the resulting count (18 if all gates KEEP; down to 15 if all DROP).
5. Update the `EXPECTED` array in Task 2 to the final table list.
6. Scrub all stale references to deleted items: `pg-boss`, `queue.ts`, `ws.ts`, `mail0_jwks`, `inbound_message`/`outbound_message`, `ip_hash`, the 5-process PM2 line.
7. Update the "GSTACK REVIEW REPORT" dispositions that this change order invalidates (NULL-in-UNIQUE, WS, has_unread, task ordering) with a one-line "superseded by ponytail change order" note — do not delete the history.
8. Leave every `ponytail:` add-back note so deferred work is tracked.
9. Re-read the edited plan once end-to-end for internal consistency (table counts, task numbers after deleting Tasks 6 & 11, file-structure tree).

**Renumber carefully:** deleting Tasks 6 and 11 shifts task numbers. Either renumber all tasks and their cross-references, or mark the two as `~~Task 6: REMOVED~~` in place to avoid breaking references — pick one and be consistent.
