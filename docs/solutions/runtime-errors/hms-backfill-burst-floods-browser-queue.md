---
title: Backfill re-extraction flooded the single HMS browser with background party/quote reads
date: 2026-10-19
category: runtime-errors
module: server-pilot/hms-jobs
problem_type: performance_issue
component: hms_job_queue
severity: high
applies_when:
  - HMS read_tool wait time looks high over a multi-day window
  - Running backfill-inbound-extraction.ts or any bulk re-extraction
  - Adding a new background HMS prefetch hook after extraction
tags: [hms, prefetch, backfill, party, quote-ready, queue-wait]
---

## Symptom

Party read wait p50 = 411 s over 72 h. 5 system-prepared quotes dead-lettered with `staff quote execution failed` (`staff_quote_failed {code: EXECUTION_FAILURE, phase: 'attach'}`).

## Cause

A 2,044-message re-extraction (no `admission_snapshot_id`) ran `scheduleQuotePreparationForExtraction` for every message. Unlike `prefetchHmsConfirmations`, that path had no live-only check, and party prefetch ignored `action`. ~175 background party reads for days-old, mostly `no_action` mail queued on the one HRCEN browser over 7 h. Staff-hours wait the next morning was 1–3 s.

## Fix

#376: `scheduleQuotePreparationForExtraction` returns without an admission snapshot; `prefetchPartyForExtraction` and `evaluateQuoteReadyForMessage` skip `payload.action === 'no_action'`.

## Rules

- Every background HMS hook after extraction requires a live admission snapshot. Backfill and imports never cost an HMS read.
- Before naming a queue cause, split wait by hour and by source (snapshot present, message age, action). A multi-day p50 can be one burst.
- Read-only prod SQL from the VPS: write a CJS script, base64 it through `ops-run.sh` (`OPS_RAW=1`), run it from `apps/server-pilot` (so `postgres` resolves), inside `s.begin('read only', …)`. Print aggregates only (SSM caps stdout ~24k).
