# 2026-10-19 HMS queue wait + prepared-quote dead letters (Chat A)

Read-only SQL on prod `ai_workflow_run` / `hitl_tool_run` and ai-worker pm2 logs, 2026-10-19 ~10:00–10:30Z. No HMS reads, no writes.

## Finding

The 72 h figure "party wait p50 411 s" was one overnight burst, not staff-hours behaviour.

| Window | Party jobs | Party wait p50 | Source mail |
|---|---|---|---|
| 18 Oct 21:00Z → 19 Oct 04:59Z | ~175 | 94 s → 1,189 s by hour (outage first, then queue) | median 59–307 h old; 70–85% `action=no_action`; 0 admission snapshot |
| 19 Oct 05:00Z → 10:00Z (staff hours) | 3 | 1 s (max 3 s) | live, < 20 min old |

Cause: the 2,044-message re-extraction at 18 Oct 21:00Z (`extract-3e750d4a3e7c`, no admission snapshot) ran `scheduleQuotePreparationForExtraction` for every message. That function, unlike `prefetchHmsConfirmations`, never checked for live admission, and party prefetch never checked `action`. One HRCEN browser then served ~30 background party reads an hour for 7 h.

## The 5 `staff quote execution failed` dead letters (19 Oct 00:15–04:29Z)

All 5 were system-prepared quotes (`quotePrepared=true`, no user, 1 attempt by design). Their tool rows show `PRECONDITION_FAILED` wrapping `staff_quote_failed {code: EXECUTION_FAILURE, phase: 'attach'}` (CDP attach to the borrowed browser), during the burst. 4 of 5 were days-old backfill mail. Prepared-quote success that night: 27/34. No staff-kicked quote dead-lettered.

## Fix

PR "background party/quote prep only for live mail that needs action": no prep without an admission snapshot; party prefetch and quote-ready skip `no_action`. Expected effect: the next backfill adds 0 HMS reads; live no_action mail adds 0 party reads.

## Open

- Attach failures under sustained load are not explained beyond "burst"; watch for any new `phase: 'attach'` after the deploy.
- Party run time (~70 s) has no per-phase timing in stored results; a probe needs one live read.
- Bar (owner, 2026-10-19): staff-kicked party wait p50 and share of mail with party ready before open; < 120 s is a starting guideline, not a pass line.
