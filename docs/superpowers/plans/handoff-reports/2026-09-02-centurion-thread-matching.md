# Centurion thread matching — handoff report

**Date:** 2026-09-02 UTC  
**Branch:** `feat/centurion-thread-matching` (worktree `.worktrees/centurion-thread-matching`)  
**Plan:** `docs/superpowers/plans/2026-09-02-centurion-thread-matching-implementation.md`

## Compose / SMTP join gap

New compose without `threadId` creates thread with synthetic root and null header until SMTP flush:

```1064:1076:apps/server-pilot/src/trpc/routes/mail.ts
      threadId = randomUUID();
      await db.insert(mailThread).values({
        id: threadId,
        transportId,
        threadRootId: `outbound-${threadId}`,
        subject: input.subject || null,
        ...
      });
```

Outbound row inserted with `messageIdHeader: null` until post-SMTP reconcile:

```1193:1211:apps/server-pilot/src/trpc/routes/mail.ts
      await tx.insert(message).values({
        ...
        messageIdHeader: null,
        inReplyTo,
        references,
        ...
        sentAt: null,
        receivedAt: now,
      });
```

**Impact:** Guest reply before SMTP flush cannot header-join via `resolveThreadId`. Rocketseed reconcile uses `X-Zero-Outbound-Id`, not ingest parent walk.

**Optional follow-up:** Provisional `messageIdHeader` on `mail.send` insert (pre-SMTP) so early inbound can link.

## Waterfall (438 actionable)

| Stage | Responded | Unanswered | Delta |
|-------|----------:|-----------:|------:|
| In-thread outbound only | 71 | 367 | baseline |
| + cross-thread conf# (daily layer) | 149 | 289 | +78 |
| + quoted + orphan (defensible) | **246** | **192** | +97 from daily-un |

Gold: `.private/connected-mailbox-corpus/follow-up/_work/defensible-daily-chart-2026-09-01.json`.

## Task 5 residual pairs

Artifact: `.private/connected-mailbox-corpus/follow-up/_work/thread-link-residual-2026-09-02.json`

| Metric | Count |
|--------|------:|
| Total pairs | 399 |
| Deterministic linker (high band) | 336 |
| LLM residual (medium band) | 63 |

By link type: `domain_guest_email` 335, `quoted_body` 42, `subject_cluster` 21, `domain_conf` 1.

## Layer status (worktree `feat/centurion-thread-matching`)

| Layer | Status | Notes |
|-------|--------|-------|
| **A — Ingest threading** | Implemented | `message-id.ts`, ordered References walk in `store.ts`, migration `0020_message_transport_header_idx.sql` |
| **B — Conversation signals** | Implemented | `conversation-signals.ts`, gold eval harness, gate ≥221/438 recall |
| **C — Conversation groups** | Implemented + pilot backfill | Migrations applied; **4040** active links after staff-internal `subject_cluster` fix (`92532000`) |
| **D — Bedrock linker** | Not implemented | Gated; 63 LLM-band pairs from Task 5 (v1 optional) |
| **E — Frontend UX** | Deployed | Option C stub rows, badge, merged timeline; Breakfast Pack RE pair share `conversationId` |

**Task 6:** `conversationResponded` metrics-only wire shipped (not spam refine / hash).

## Dump ancestry headers (Task 7)

`connected-mailbox-markdown-dump.ts` now exports `In-Reply-To` / `References` when present on DB row. Offline `execute-reverse-joins` counts should rise after dump regen from pilot RDS.

## UI (Layer E)

- **Option C:** Primary row + `linked-thread-stub-row.tsx` compact stubs under primary
- **Badge:** Replied icon on primary when `conversationResponded` (not per-thread `hasReplied` on inbox)
- **Thread detail:** `mergeLinked: true` chronological timeline; divider + jump links across linked threads

Breakfast Pack class: staff-internal spaced-subject RE split — not in 438 actionable set (`breakfastPackExemplars: []`), but **live pilot** links the RE pair after fix:

| Thread | Role |
|--------|------|
| `378fe50e-5be1-41b9-b322-6c128f267617` | primary |
| `46c21823-d6ef-423e-af59-1c319556b289` | linked (same `conversationId`, `linkedThreadIds.length=5`) |

Smoke: `breakfast_pack.conversation_smoke` → `sameConversation: true` on EC2 @ `92532000`.

## Pilot deploy evidence (2026-09-02)

- EC2 HEAD: `92532000` — health `{"ok":true,"service":"server-pilot"}`
- Migrations **0020** + **0021** applied
- Backfill: first apply **2920** links → staff-internal fix → re-apply **4040** links
- RCA: `subject_cluster` used `externalEmails` only → all-`@legacyhotels` Breakfast Pack got 0; fixed via `allParticipantEmails`

## Phase 2 dashboard hook (Task 9)

`docs/superpowers/plans/2026-09-01-centurion-evidence-dashboard-implementation.md` — `DAILY_ANSWERED_UNANSWERED_COPY` card spec + `availability: live_conversation_signals`.

## Remaining (optional / out of v1)

- Task 14 (gated): Bedrock linker for 63 medium-band pairs if residual FN ≥10 after ops review
- Optional: provisional `messageIdHeader` on compose send; archive-both UX
- Workflow DLQ backlog = pre-existing launch-readiness issue, not this feature
