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
| **C — Conversation groups** | Implemented | `mail_conversation_link`, `conversation-link.ts`, `conversation-group.ts`, migration `0021_mail_conversation_link.sql`, backfill script |
| **D — Bedrock linker** | Not implemented | Gated; 63 LLM-band pairs from Task 5 |
| **E — Frontend UX** | Implemented | Option C stub rows, `conversationResponded` badge, merged timeline (`mergeLinked`) |

**Not in this handoff:** Task 6 triage metrics wire (`conversationResponded` on workflow run) — still open.

## Dump ancestry headers (Task 7)

`connected-mailbox-markdown-dump.ts` now exports `In-Reply-To` / `References` when present on DB row. Offline `execute-reverse-joins` counts should rise after dump regen from pilot RDS.

## UI (Layer E)

- **Option C:** Primary row + `linked-thread-stub-row.tsx` compact stubs under primary
- **Badge:** Replied icon on primary when `conversationResponded` (not per-thread `hasReplied` on inbox)
- **Thread detail:** `mergeLinked: true` chronological timeline; divider + jump links across linked threads

Breakfast Pack class: staff-internal spaced-subject RE split — not in 438 actionable set; audit found no exemplars in actionable slice (`breakfastPackExemplars: []`).

## Pilot RDS probe (2026-09-02)

- This agent host **cannot** TCP to pilot RDS (`CONNECT_TIMEOUT`) — dry-run must run on EC2 via SSM.
- SSM `psql` diag: `transport-centurion` **4503** messages; `mail_conversation_link` **absent** (`to_regclass` null) → migrations **0020+0021** required before `--apply`.
- Backfill script now needs only `DATABASE_URL` (not full `parseEnv`); dry-run tolerates missing link table (`tableMissing: true`).

## Pilot ops

1. Apply migrations **0020** + **0021** on pilot RDS (header index + `mail_conversation_link`).
2. Backfill deterministic links:

```bash
# Dry-run first
pnpm --filter @zero/server exec tsx scripts/backfill-centurion-conversation-links.ts \
  --transport=transport-centurion --confirm-pilot-rds

# Apply
pnpm --filter @zero/server exec tsx scripts/backfill-centurion-conversation-links.ts \
  --transport=transport-centurion --apply --confirm-pilot-rds
```

3. Regen private markdown dump (Task 7 headers) before offline reverse-join scripts.
4. Merge worktree → integration after Phase 1 triage stable; deploy via `ops-deploy.sh`; smoke linked conversation in inbox.

## Phase 2 dashboard hook (Task 9)

`docs/superpowers/plans/2026-09-01-centurion-evidence-dashboard-implementation.md` — `DAILY_ANSWERED_UNANSWERED_COPY` card spec + `availability: live_conversation_signals`.

## Remaining work

- Task 6: Wire `conversationResponded` to triage workflow metrics (v1 metrics-only, not spam refine)
- Task 14 (gated): Bedrock linker for 63 medium-band pairs if deterministic backfill leaves ≥10 FN pairs
- EC2 deploy + smoke after integration merge
- Optional: provisional `messageIdHeader` on compose send
