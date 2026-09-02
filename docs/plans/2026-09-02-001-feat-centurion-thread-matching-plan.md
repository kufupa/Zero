---
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
execution: implementation
product_contract_source: corpus-analysis-2026-09-01
title: "feat: Centurion thread matching + conversation signals + inbox linking"
created: 2026-09-02
updated: 2026-09-02
---

# Centurion thread matching + conversation signals + inbox linking

## Summary

Nava inbox uses **flat `thread_id` per transport** assigned at ingest via header lookup. Centurion Aug-30 corpus proves that model under-counts **responded** commercial threads by ~68% when KPIs rely on same-thread outbound alone. **Separate problem:** inbox shows duplicate rows for the same real conversation (e.g. spaced-subject RE chains, PMS confirm on new thread) because there is no conversation overlay in API or UI.

**Product split:**

| Layer | Question | v1 ship |
|-------|----------|---------|
| **A — Ingest threading** | Which `thread_id` for new message? | Ordered RFC References walk + canonical Message-ID; no subject merge at ingest |
| **B — Conversation signals** | Was guest RFQ answered (any channel)? | Port defensible-chart detector; KPI + link hints |
| **C — Conversation groups** | Should UI show one conversation? | **Yes v1** — `mail_conversation_link` + `conversationId`; deterministic backfill; no `thread_id` rewrite |
| **D — LLM linker** | Resolve ambiguous pairs? | Gated; Bedrock batch; ≤50 pairs/mailbox/day |
| **E — Frontend** | How does user see links + replied state? | **Yes v1** — linked stub rows, merged timeline, `conversationResponded` badge |

Phase 1 triage/backfill **unchanged** — no `thread_id` rewrite during backfill.

**Execution:** Entire implementation in git worktree `feat/centurion-thread-matching` at `.worktrees/centurion-thread-matching`. Merge after Phase 1 triage worker/mail-triage stabilize.

## Evidence anchors

- Gold: `.private/connected-mailbox-corpus/follow-up/_work/defensible-daily-chart-2026-09-01.json` — 438 actionable, 246 responded, 192 unanswered (audit PASS)
- Linkage audit: `.private/connected-mailbox-corpus/follow-up/_work/thread-linkage-audit-2026-09-02/`
- Walkthrough: `.private/connected-mailbox-corpus/follow-up/_work/thread-walkthrough-2026-09-01.json`
- Breakfast Pack exemplar (full corpus, staff-internal): delta batch `d942ddbf` / `1e7d405d` — RE chain with quoted prior in body
- Ingest: `apps/server-pilot/src/mail/ingest/store.ts:1722-1796`
- Inbox: `apps/mail/components/mail/mail-list.tsx` — per-thread rows, N+1 `hasReplied`

## Requirements

- R1. Fix ingest parent resolution: walk References in order; append In-Reply-To per RFC 5256; canonical Message-ID compare.
- R2. Add DB index on `(transport_id, message_id_header)` where header not null.
- R3. Port conversation signal detector from defensible chart (6 signal types).
- R4. Gold eval: ≥90% responded recall (≥221/438); ≤2% false responded on gold-unanswered (≤4/192).
- R5. Wire `conversationResponded` into triage **metrics** without changing spam refine until `promptVersion` bump.
- R6. Export In-Reply-To/References in private markdown dump.
- R7. Document compose→SMTP Message-ID gap.
- R8. **Ship deterministic conversation links** (header, B-signal pairs, guarded subject clusters).
- R9. **Ship inbox UX:** `conversationId`, linked stub rows, merged thread detail, replied badge from `conversationResponded`.
- R10. LLM linker only if ≥10 residual pairs after deterministic pass (Task 14 gate).

## Non-goals (v1)

- Full JWZ container tree in production ingest hot path
- Subject-based **ingest** merge (hotel collision risk)
- Rewriting historical `thread_id` column
- Titan embeddings (optional spike only)
