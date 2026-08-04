# Shared inbox replied marker + auto-read

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pilot FO can scan which threads Centurion already answered (reply arrow) and which still need eyes (bold/unread), including replies sent from Outlook.

**Architecture:** Keep `direction` as source of truth. No new DB columns. On outbound success (`mail.send` or hotel-sent ingest), reuse the same “mark thread + all messages read” path as `markAsRead`. Expose `hasReplied` on `mail.get` (exists outbound). FE shows Outlook-style reply icon next to the draft pencil; grey/bold stays on existing unread styling.

**Tech Stack:** `apps/server-pilot` (Drizzle, tRPC, Vitest + disposable DB), `apps/mail` (React list row).

## Global Constraints

- Never Vitest against pilot RDS; `unset DATABASE_URL VITEST_ALLOW_PILOT_RDS` before tests; disposable DB only (`TEST_DATABASE_URL` + `CONFIRM_DISPOSABLE_TEST_DB=1`).
- No PII in logs/prompts.
- Do not invent claim/lock or new triage queues.
- No commits unless user explicitly requests.

## Settled product

| Priority | Need | Mechanism |
|----------|------|-----------|
| C Outlook parity | Know it was replied | Ever-replied arrow (`hasReplied`) |
| B Triage scan | Pick next work | Bold = unread; auto-read when we answered |
| A Double-reply | Soft reduce | Same signals; no claim/lock in v1 |

**Not in v1:** `awaitingUs` wire field, denormalized columns, Needs-reply filter, separate forward icon, double-reply locking.

## Auto-decisions

- Any **outbound** counts as replied (reply and forward).
- Hide arrow in **Sent** folder.
- Icon: Lucide `Reply`, `h-3 w-3`, muted, tooltip “Replied”, beside draft pencil.
- Manual Mark unread after reply stays allowed until next inbound or next outbound auto-read.
- Pilot ops backfill once for threads whose latest message is outbound.

## Files

| File | Role |
|------|------|
| `apps/server-pilot/src/mail/thread-read.ts` (new) | `markThreadRead(db, transportId, threadIds)` |
| `apps/server-pilot/src/trpc/routes/mail.ts` | markAsRead + send + get `hasReplied` |
| `apps/server-pilot/src/mail/ingest/store.ts` | hotel-sent → markThreadRead |
| `apps/server-pilot/src/lib/driver/types.ts` | `hasReplied` on ThreadDetailResponse |
| `apps/mail/lib/demo-data/adapter.ts` | Demo `hasReplied` |
| `apps/mail/components/mail/mail-list.tsx` | Reply icon |
| `apps/server-pilot/scripts/backfill-outbound-latest-read.mjs` | Ops dry-run/apply |

Origin plan UI: `.cursor/plans/replied_marker_auto-read_4fdbf50d.plan.md`

---

### Task 1: Shared `markThreadRead` + wire `hasReplied`

**Files:**
- Create: `apps/server-pilot/src/mail/thread-read.ts`
- Modify: `apps/server-pilot/src/trpc/routes/mail.ts`, `apps/server-pilot/src/lib/driver/types.ts`
- Test: extend `apps/server-pilot/tests/mail-thread-actions.test.ts`

**Interfaces:**
- Produces: `markThreadRead(db, transportId, threadIds: string[]): Promise<number>`
- Produces: `mail.get` → `{ ..., hasReplied: boolean }`

- [ ] Failing test: inbound-only `hasReplied: false`; with outbound `hasReplied: true`
- [ ] Implement helper; route `markAsRead`; add `hasReplied`
- [ ] Run tests PASS

### Task 2: Auto-read on `mail.send`

- [ ] Failing test: unread inbound → send reply → all read, `hasUnread` false, `hasReplied` true
- [ ] Call `markThreadRead` in send path
- [ ] Run `mail-send` tests PASS

### Task 3: Auto-read on hotel-sent ingest

- [ ] Failing test: unread inbound + hotel-sent ingest → thread/messages read; inbound alone stays unread
- [ ] Implement hotel-sent branch in store
- [ ] Run ingest tests PASS

### Task 4: FE reply arrow + demo

- [ ] Demo `hasReplied`; list icon when `hasReplied` && !Sent
- [ ] Typecheck / targeted tests PASS

### Task 5: Ops backfill script

- [ ] `backfill-outbound-latest-read.mjs` dry-run + apply, transport-scoped, counts only
- [ ] Dry-run against disposable first; pilot apply needs explicit ops approval

## Acceptance

1. Nava reply → grey + arrow
2. Guest follow-up → bold again, arrow stays
3. Outlook reply → hotel-sent ingest → grey + arrow
4. Inbound-only → no arrow
5. Sent folder → no arrow
6. Manual unread after reply sticks until next transition
7. No Vitest with pilot `DATABASE_URL`
