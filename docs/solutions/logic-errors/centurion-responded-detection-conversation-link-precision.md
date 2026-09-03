---
title: Centurion responded detection and conversation-link precision
date: 2026-09-03
category: logic-errors
module: server-pilot / Centurion conversation signals and link overlay
problem_type: logic_error
component: email_processing
symptoms:
  - "The evaluator used a stale 438/246/192 gold snapshot instead of the authoritative 483/282/201 EOD ledger."
  - "Outlook, Gmail, and Apple quoted replies, RFC reply headers, and staff commercial follow-ups were missed."
  - "Weak orphan and cross-thread identity matches produced false responded labels."
  - "Generic subjects and unbounded weak fanout merged unrelated mail into large UI conversation components."
  - "Persisted unsafe link rows stayed active after discovery rules were tightened."
root_cause: logic_error
resolution_type: code_fix
severity: high
related_components:
  - database
  - background_job
  - tooling
  - testing_framework
tags:
  - centurion
  - conversation-signals
  - conversation-links
  - responded-detection
  - cross-thread-matching
  - subject-clustering
  - precision-hardening
  - eod-gold
---

# Centurion responded detection and conversation-link precision

## Problem

Centurion mail had two coupled precision failures. Layer B marked commercial requests responded from incomplete, stale signal rules; Layer C merged unrelated mail through loose subject, orphan, quoted-body, and participant heuristics. The result was missed revenue responses, false responded labels, and giant UI conversation components.

The authoritative EOD ledger is **483 actionable / 282 responded / 201 unanswered**. The old evaluator targeted **438 / 246 / 192**, so a green gate could describe the wrong denominator.

## Symptoms

- Gold evaluation used stale paths/constants and could pass against the wrong contract.
- Replies evidenced only by Outlook/Gmail/Apple quote blocks, RFC reply headers, or staff commercial text were missed.
- Generic confirmation text, short guest-name matches, stale human replies, and weak guest-email orphans could falsely set binary `responded`.
- Identical template subjects formed bounce, handover, financial-update, quotation, and Zuko mega-clusters; system-only participant overlap also bridged unrelated mail.
- One guest or quoted message fanned into many weak links. Local caps did not bound the combined connected component, and input order changed results.
- Recomputing safe proposals without superseding old rows left unsafe edges in the grouping graph.

## What Didn't Work

- **Old gold contract.** The evaluator loaded a pre-EOD snapshot and hardcoded `goldTotal === 438`; that did not prove current revenue behavior.
- **Weak orphan inference.** Treating any confirmation-letter orphan or guest-email match as proof allowed unrelated bookings through without an exact confirmation number, strong identity, quoted hotel block, or short causal window.
- **Subject as identity.** Normalized subject equality ignored template entropy, participant identity, and component size. A common subject is a weak UI hint, not a conversation key.
- **Unbounded fanout.** Quoted-body and human-orphan scans accepted every candidate. Separate local caps could still build a large component; duplicate proposals spent budgets without adding an edge.
- **Direction/noise blindness.** Staff commercial text was accepted without requiring an inbound post-trigger message and a non-system responder.
- **Stale persistence.** Tightening discovery without deactivating old active rows left the old graph eligible for union-find grouping.

## Solution

### Layer B: deterministic, EOD-aligned response signals

The evaluator now reads the EOD threads ledger and enforces the complete contract before scoring:

```ts
const GOLD = { actionable: 483, responded: 282, unanswered: 201 };
const RECALL_MIN = 268;
const FALSE_POSITIVE_MAX = 4;
```

RFC `Message-ID`, `In-Reply-To`, and `References` survive ingest, snapshot parsing, and triage mapping. `ConversationSignal` now covers Outlook/Gmail/Apple quoted `From`/`Sent`/`Date` blocks, quoted staff signatures, hotel reply phrases, `in_reply_to_hotel_msgid`, `staff_inbound_commercial_reply`, and the EOD `in_thread` taxonomy while retaining the consumer alias `in_thread_outbound`.

The KPI remains binary: `isConversationResponded(signals)` is true when deterministic evidence exists. No LLM, voucher/PoP enum, or `thread_id` rewrite was added.

Identity and causality fail closed:

```ts
withinDayWindow(triggerDay, evidenceDay) // forward-only, 0..3 days
hasStrongIdentity = exactConf || guestNorm.length >= 5
orphanAutoConfirm = withinWindow && (hasStrongIdentity || strongQuotedHotelBlock)
```

Cross-thread confirmation/name evidence uses the same short window. Human orphan evidence requires a recent, non-automated Centurion outbound. Staff commercial evidence requires an inbound, post-trigger message from a recognized non-system staff sender. Weak guest-email orphans and generic confirmations remain unanswered.

### Layer C: bounded deterministic overlay

Messages are ordered canonically by `(receivedAt,id,threadId)`. Link proposals are canonicalized and deduplicated before any fanout budget is charged.

The discovery and cleanup predicates apply these guards:

1. Reject subject overlap when shared participants are only system/ops addresses; retain shared non-system staff chains, including Breakfast Pack.
2. Refuse low-entropy/template subjects such as bounce, handover/night-audit, financial update, quotation, digest/failure, and generic booking/hello/test forms.
3. Require timestamps and a 72-hour subject span.
4. Skip subject buckets with 8 or more threads.
5. Link auto-confirmation orphans only by exact confirmation number and cap one per source thread.
6. Cap human-orphan and quoted-body fanout per source/message/guest and reject edges that would grow a weak component above 7 threads.
7. Apply a final combined weak-edge component bound so separate heuristics cannot reconnect a mega-cluster.

Persisted edge cleanup is explicit and dry-run by default. Apply mode runs in a serializable transaction, sets `supersededAt`, re-upserts current proposals, preserves history, and never rewrites `thread_id`. Conversation grouping filters superseded edges.

## Why This Works

Headers and quoted hotel blocks capture real replies even when a client starts a new thread; confirmation numbers and normalized guest identity connect legitimate cross-thread automation. A forward three-day window blocks stale history. Exact identity plus strong quoted evidence prevents generic confirmations from becoming revenue answers. Direction and sender classification stop automated/system text from impersonating a staff response.

Subject similarity remains useful only as a guarded UX fallback. Removing system-only overlap and template subjects removes the largest false bridges. Canonical ordering, dedup-before-cap, and combined component bounds make weak-link choices reproducible. Superseding stale rows makes production state converge with current discovery while retaining an audit trail.

## Prevention

- Treat the authoritative EOD ledger as a versioned contract. Load labels from the threads JSON; assert totals, skipped count, recall floor, and FP ceiling in CI/CLI.
- Add positive and negative fixtures for every signal family: each quote format, RFC header, staff direction, system noise, stale orphan, weak orphan, and identity mismatch.
- Keep Layer B tests DB-safe: unset `DATABASE_URL` and `VITEST_ALLOW_PILOT_RDS`; never run Vitest against pilot/production RDS.
- Keep linker fixtures for template buckets, system-only overlap, internal staff overlap, spaced subjects, missing timestamps, exact/non-exact confirmation numbers, fanout, duplicate proposals, input permutations, component caps, and superseded edges.
- Preserve RFC fields at every boundary and contract-test them rather than relying on source mapping by inspection.
- Run pilot backfill dry-run before apply; require explicit `--confirm-pilot-rds`, inspect aggregate counts, apply transactionally, then verify health and component gates. Deactivate via timestamps, never destructive deletion.
- Emit aggregate evidence only: counts, confusion matrices, and component metrics. Keep corpus rows, addresses, message IDs, and credentials out of Git and logs.

## Related Issues

- [Implementation plan](../../superpowers/plans/2026-09-02-centurion-conversation-link-precision.md)
- [Centurion precision handoff](../../superpowers/plans/handoff-reports/2026-09-02-centurion-link-precision.md)
- [Centurion triage retag audit semantics](centurion-triage-audit-createdat-vs-finishedat-spam-at.md)
- [Channel-auto trigger exclusion](epv-heuristic-channel-auto-trigger-fallback.md)
- [Shared-inbox replied versus read](shared-inbox-replied-vs-read-auto-read-outbound.md)

Verified aggregate evidence: offline EOD eval **272 TP / 10 FN / 4 FP / 197 TN**, recall **96.5%** (272/282), false-positive rate **2.0%** (4/201), skipped **0**; focused deterministic suite **119 passed / 5 skipped**; server build and `git diff --check` passed. Pilot backfill left **523 active links**, superseded **201** unsafe edges, maximum active subject component **6**, maximum full graph component **7**, zero bounce/handover/Nedbank/quotation/Zuko subject edges, and health checks passed. Launch readiness remained not ready only for the pre-existing workflow dead-letter backlog.
