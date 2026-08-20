---
title: "Centurion message-level response metric cannot establish thread state"
date: 2026-08-10
last_updated: 2026-08-10
category: logic-errors
module: mail / Centurion thread-state audit
problem_type: logic_error
component: operational_metrics
severity: high
symptoms:
  - "A retained-snapshot message metric was read as an unanswered or missed-work queue"
  - "Direction was treated as staff authorship"
  - "Quoted history was treated as response proof or latency evidence"
root_cause: message_level_inference
resolution_type: contract_correction
tags:
  - centurion
  - thread-state
  - response-metric
  - quoted-history
  - operational-trust
---

# Centurion message-level response metric cannot establish thread state

## Problem

Request-02-style analysis attempted to answer “was this reservation request responded to?” from a retained message snapshot and limited cross-message linkage. Its output could be mistaken for a live unanswered queue even though the evidence did not establish current thread state.

A message can include quoted history from an earlier exchange while its persisted reply is elsewhere. Direction is an ingest/send classification, not proof of staff authorship. Quoted evidence can support review context, but its quoted timestamp cannot produce response latency.

## Root cause

The metric collapsed several separate assertions:

1. A message is an actionable request.
2. A later persisted staff response belongs to that request.
3. The source corpus fully covers the relevant conversation.
4. The case remains unresolved now.

Message-level absence or weak correlation cannot prove all four. In particular, subject and participant similarity remain weak indicators; they must not merge thread components or close an action.

## Corrected contract

Use the Task 1–4 contract chain for any future operational aggregate:

1. **Task 1:** create a validated, read-only canonical corpus with explicit event and ingest cutoffs, complete provenance, and integrity binding between messages and threads.
2. **Task 2:** derive thread state only from validated corpus evidence. Staff identity comes from the roster, not direction or transport. Persisted reply headers and verified quoted-message evidence are bounded hard evidence; weak correlation remains manual. Only persisted, roster-verified response turns can contribute latency.
3. **Task 3:** supply closed annotations and quote coverage. Unknown, conflicting, incomplete, quote-only, weak, or unsupported evidence stays manual. Safe adjudication artifacts contain opaque references, digests, enums, and closed reasons rather than raw mail.
4. **Task 4:** render reconciled private reports from Task 1 corpus plus Task 3 result. Public-safe receipts may expose aggregate outcomes and provenance only; case/action material remains private under owner-only controls.

This contract defines a future fresh run. It does not retroactively turn a historical snapshot result into current operational truth.

## Prevention

- Say **“no qualifying response observed in the reviewed retained snapshot”** for the retired metric. Never say unanswered, missed, or current work.
- Publish operational response figures only when Task 1, Task 3, and Task 4 receipts bind to one validated fresh run.
- Treat absent, ambiguous, incomplete, or weak evidence as `manual` or `not_available`; never as zero work or resolved.
- Keep raw content, direct identifiers, and stable mail/thread references out of tracked reports, stdout, chat, and remote stores.
- Keep drafting human-approved until fresh validated aggregate evidence exists; do not drive send, suppression, SLA, or auto-close decisions from a historical message metric.

## Related

- `docs/infor-hms/centurion-thread-state-status-2026-08-10.md`
- `docs/infor-hms/centurion-thread-state-audit-runbook.md`
- `docs/solutions/logic-errors/shared-inbox-replied-vs-read-auto-read-outbound.md`
