---
title: "Evidence-first research library for Nava and Centurion"
date: 2026-10-13
category: workflow-issues
module: "Research and evaluation"
problem_type: workflow_issue
component: development_workflow
severity: medium
applies_when:
  - "A research question overlaps prior mail-mix, party, quote, or UI analysis"
  - "A feature is being called done from runtime, merge, or deployment status alone"
tags:
  - evidence-first
  - research-corpus
  - offline-evaluation
  - reservationist
  - answer-key
---

# Evidence-first research library for Nava and Centurion

## Context

Mail-mix, party-lookup, UI-ask, and quote-gold research was repeated across separate lanes while prior evidence stayed underused: the 100-case set dated 2026-09-15 had not been used until this run, auto-loaded [`docs/context/ACTIVE.md`](../../context/ACTIVE.md) still named 2026-10-09 as the current focus, and the party-index sweep had stopped on 2026-10-09. A production party-prefetch spot check ran 10 jobs and returned 0 clean results. Running work was not proof it worked. See the [2026-10-13 research index](../../research/2026-10-13/README.md).

## Guidance

1. Start new research by reading [`docs/research/`](../../research/2026-10-13/README.md). Reuse an existing report and snapshot when they cover the question and time window; otherwise use a read-only SSM export to create a new private, dated snapshot. This run's snapshot covered 75 days of mail plus staff PDFs as text; refresh into a new date folder, not over the old one.
2. Keep raw mail, PDFs, answer keys, and credentials outside Git. Run corpus-analysis lanes offline against the snapshot; identify any separate external-source research by its method.
3. Give each report a clear answer, method, findings, denominator, uncertainty, and re-run command. Mark repo/run measurements `[M]` and inferences `[I]` where applicable; distinguish recommendations from measured results.
4. Keep `needs_action` separate from `primary_action`: one says whether the inbound still needs work, the other says what work. Keep source routing separate from work labels; travel-agent mail stays in scope when it requests reservation work.
5. Use private, reservation-level answer keys from read-only HMS reads as ground truth; the party lane used a read-only `find-batch` loop. Missing company or agency data in a PDF is unknown, not a confirmed negative.
6. Define done by a score on real past mail against those answer keys, with denominators, unscorable cases, and failure classes reported. A running job, merge, or deployment alone is not a correctness result.
7. For a threshold stated in unique threads, count after deduplication and every scope/plannability exclusion before owner GO. A raw message-row pool is not an eligible-thread denominator; if eligible n is short, report a partial improvement and the extra truth required rather than planning an impossible pass. The 2026-10-20 overnight pool reduced to eight scored individual threads, below the ≥10 bar ([retro](../../research/2026-10-20-overnight-quote-retro.md)).
8. If historical mail is priced from a pre-reply extraction because later thread history changes current eligibility, label it as a historical pricing counterfactual and keep it separate from proof of current live admission/preparation.

## Why This Matters

The 2026-10-13 production spot check found 0 clean party-prefetch results across 10 jobs. Separately, the workflow sample estimated 36.53% of non-channel inbound mail needs reservationist action, while extraction kind is not an action label and changed in about 80% of repeated `booking` examples. These are different measurements: a process can run while its result is wrong, and an extraction label does not establish the work owed.

Party labels also need stronger truth than staff PDFs provide: only 30 of 1,179 confirmation PDFs contained a company/agency candidate, and only 1 of those 30 joined to an earlier eligible inbound. Treat absent document fields as unknown; score against HMS-read answer keys instead.

## When to Apply

- Before starting any new mail-mix, party, quote, workflow, or UI research lane.
- Before reporting extraction, lookup, or reservationist behavior as correct or production-ready.
- When deciding whether prior snapshots, gold cases, or reports can replace another live data pull.

## Examples

The 2026-10-13 snapshot and reports separate the evidence needed for different claims: [`r1-quote-gold.md`](../../research/2026-10-13/r1-quote-gold.md) defines quote-gold limits; [`r2-party-truth.md`](../../research/2026-10-13/r2-party-truth.md) shows why HMS reads are needed for party truth; [`r3-workflow-truth.md`](../../research/2026-10-13/r3-workflow-truth.md) separates work labels from extraction kind; [`r4-architecture.md`](../../research/2026-10-13/r4-architecture.md) is a read-only pipeline audit; [`r5-ui-asks.md`](../../research/2026-10-13/r5-ui-asks.md) limits status claims to static inspection; and [`r6-agent-architecture-sota.md`](../../research/2026-10-13/r6-agent-architecture-sota.md) is external-source synthesis, not production proof.

## Related

- [2026-10-13 research index](../../research/2026-10-13/README.md)
- [Shared vocabulary](../../../CONCEPTS.md)
