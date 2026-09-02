---
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
execution: analysis
product_contract_source: ce-plan-bootstrap
title: "feat: Corpus-driven AI drafting tool rediscovery (Aug-30)"
created: 2026-09-01
---

# Corpus-driven AI drafting tool rediscovery (Aug-30)

## Summary

Reanalyze the private connected-mailbox corpus (`asOf=2026-08-30T21:53:48.208Z`) email-first: define an intelligent **backfill benchmark**, identify **draft-target** threads, derive **tool portfolio + schema split**, and compute **coverage** against the correct denominators. Analysis artifacts: `.private/connected-mailbox-corpus/follow-up/corpus-tool-rediscovery-2026-09-01.md` and `_work/corpus-tool-rediscovery-2026-09-01.json`.

## Problem frame

Prior tool portfolio was inferred top-down from regex/Luna `toolDemand` on inbound obligation signals. That overstates automation and mixes channel auto-mail with Centurion-authored drafts. Product needs bottom-up grounding: **what did Centurion actually send**, **what should have been sent**, and **which read tools enable claim-safe drafts**.

## Scope

In scope: Aug-30 snapshot parse, thread-level draft archetypes, backfill tiers, registry tool coverage, schema alignment to existing Zod contracts, recommended tool split.

Out of scope: live HMS execution, production triage changes, HR/alias gold labels, sending mail.

## Key findings (verified)

| Measure | Value | Denominator |
| --- | ---: | --- |
| Messages | 3,820 | corpus |
| Outbound messages | 373 | messages |
| Human-gold outbound (backfill train) | **87** | messages (23.3% of outbound) |
| Auto/channel outbound (exclude from gold) | **286** | messages |
| Human-gold threads | **73** | threads |
| Draft-target threads (forward AI) | **1,394** | threads (49.6%) |
| Unanswered external needing draft | **831** | threads |
| Internal handoff proxy | **488** | threads |
| Full read-only draft (quote archetype) | **264** | draft targets (18.9%) |
| Partial read draft | **1,120** | draft targets (80.3%) |
| Production automation today | **0%** | all (live=false) |

## Backfill benchmark definition

1. **Gold (train/backfill):** outbound `From centurion@legacyhotels.co.za` minus auto/channel heuristics (confirmation-letter relays, OTA To, notification subjects). Message-grain for instances; thread-grain for coverage.
2. **Exclude from gold:** 286 auto outbound msgs — not human-authored Centurion prose.
3. **Forward draft targets:** unanswered external obligations + internal staff handoff (`staff_internal` intent, legacy personal From) + human-gold threads for replay evaluation.
4. **Not draft targets:** pure channel/system inbound with no staff obligation; spam/test.

## Tool portfolio recommendation

**Keep 9 `READ_TOOL_IDS` separate** — claim kinds and denied actions differ; do not merge.

Add:
- `draft_mail_compose` (compose-only, HITL send; schema separate from HMS reads)
- `hms_guest_preferences_read` (gap for guest_service partial drafts)

Defer Wave-3 writes: amend, cancel, document_send, mail_attach.

## Implementation units

### U1. Derived corpus spine (done)

Goal: parse Aug-30 snapshot into classified message/thread rollups without exposing PII in tracked artifacts.

Files: `.private/connected-mailbox-corpus/follow-up/_work/corpus-tool-rediscovery-2026-09-01.py`

Verification: denominators match snapshot header (3820/3447/373).

### U2. Backfill + draft-target classification (done)

Goal: tier threads (gold/auto/handoff/unanswered) and map draft archetypes.

Verification: 373 outbound reconciled; human gold 87 msgs / 73 threads.

### U3. Tool coverage matrix (done)

Goal: per-tool thread coverage vs draft-target and gold denominators.

Verification: overlap documented; sums not additive.

### U4. Schema contract (next code task)

Goal: align draft agent on claim envelopes per `apps/server-pilot/src/hms/read-tools.ts` + `claim-envelope.ts`; add proposed compose schema.

Files: `apps/server-pilot/src/hms/read-tools.ts`, `apps/server-pilot/src/hms/claim-envelope.ts`, new `draft-mail-compose-contract.ts`

## Definition of done

- [x] Aug-30 corpus accessed and parsed
- [x] Backfill benchmark defined with auto/human split
- [x] Draft archetypes and tool coverage computed
- [x] Schema split documented against live contracts
- [x] Assumable channel/PMS handling tier (17 threads)
- [x] Proposed Zod schemas for compose + guest preferences (private artifact)
- [x] Write-tool demand matrix
