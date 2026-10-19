# Ready before open: Centurion first-pane HMS readiness

Snapshot: 2026-10-19 15:33:23 UTC, one read-only Postgres statement. Source-code revision at that snapshot: `9c946212f`. The 24-hour and 7-day windows are anchored to that statement time.

## Headline

In the 7-day cohort, 3 of 21 quote opens (14.3%) had a prepared quote available at the first recorded pane-open event. Party preparation was ready for 0 of 36 new-booking opens; booking-find preparation was ready for 0 of 18 amend opens and 0 of 3 cancel opens. The 24-hour subset had 7 recorded opens and no workflow was ready before open. All 78 target-action pane events in the snapshot were before the approximate 15:00Z rollout of #390/#391; there were no **recorded** post-15:00Z opens to measure either change.

Important cohort caveat: workflow labels below are the latest successful extraction action at query time, not a historical label guaranteed to have been visible at open. A separate as-of-open check at 15:35:40Z found `payload.action` null in the latest successful extraction available at open for 73 of the 78 messages; only 5 had a target action then. Historical action-at-open coverage is therefore not reconstructible for most of this cohort.

| Window / source | Action → workflow | First opens | Ready before open | Ready rate | Observed open-to-result wait |
|---|---|---:|---:|---:|---|
| 24 h, pane event | `quote_availability` → quote | 2 | 0 | 0% | — (n=0) |
| 24 h, pane event | `new_booking` → party | 0 | 0 | — | — (n=0) |
| 24 h, pane event | `amend` → booking find | 4 | 0 | 0% | — (n=0) |
| 24 h, pane event | `cancel` → booking find | 1 | 0 | 0% | — (n=0) |
| 7 d, pane event | `quote_availability` → quote | 21 | 3 | 14.3% | p50 4m22s; p90 1h50m17s (n=3) |
| 7 d, pane event | `new_booking` → party | 36 | 0 | 0% | — (n=0) |
| 7 d, pane event | `amend` → booking find | 18 | 0 | 0% | — (n=0) |
| 7 d, pane event | `cancel` → booking find | 3 | 0 | 0% | — (n=0) |

The wait percentiles are not a population-wide staff-wait estimate: they use only three successful matching results observed after open (one already-created system run and two priority-10 interactive results). They exclude system-prep jobs first created after open, failures, unresolved rows, and opens with no observed successful completion. They are small-sample diagnostics, not a causal estimate of time saved.

Fallback proxy, kept separate from pane events: for messages with no recorded pane event, the first exact-message priority-10 `read_tool` job was used as a proxy for staff starting work. In the 7-day window this found 2 quote messages, 0 ready at that proxy time, and no successful wait sample; it found no party or booking-find rows. A staff-kicked job is not proof that a pane was opened.

## Not ready at first recorded open: ranked persisted reasons

These are the 75 non-ready pane events in the 7-day cohort; the 3 ready quote events bring the cohort to 78. Ties are shown together. “Admission snapshot present” means only that the run row had an admission snapshot; it does not establish that a workflow-specific prefetch was eligible or expected.

| Rank | First-open bucket | Events | Action mix | What the database establishes |
|---:|---|---:|---|---|
| 1 | Admission snapshot present, but no exact-message system prep run by open | 39 | new booking 24; amend 11; cancel 1; quote 3 | No matching system run was linked by `trigger_message_id`; the skip cause is not persisted here. |
| 2 | System prep first created after open | 10 | new booking 8; quote 2 | The system job was not present at the open event; this is not a running-at-open wait sample. |
| 3 | No prep admission snapshot and no system prep | 9 | quote 4; amend 3; cancel 1; new booking 1 | No workflow-specific reason can be recovered from these fields. |
| 4 (tie) | System job superseded before open | 4 | new booking 2; amend 1; quote 1 | A matching system run existed but was superseded by open. |
| 4 (tie) | System job not reusable at open | 4 | amend 2; cancel 1; quote 1 | A matching run did not meet the result/reuse checks at open. |
| 4 (tie) | Staff-kicked only | 4 | quote 4 | No reusable system-prepared result was present at open. |
| 5 (tie) | System job running at open | 2 | quote 2 | One of the two later succeeded; the other has no qualifying observed completion in the wait sample. |
| 5 (tie) | System-notice path, no system prep | 2 | amend 1; new booking 1 | The stored path was system-notice; no system prep was present. |
| 6 | Prepared quote result expired at open | 1 | quote 1 | A prior prepared quote did not pass the expiry check at open. |

The persisted data does **not** support labeling the 39 rows “flag off.” Runtime flag history, candidate-match outcome, per-workflow eligibility, cap decisions, origin guards, and idempotent reuse are not distinguished by these rows. Code in effect at the snapshot also made party and booking-find prep conditional: party work depends on candidate selection; find work needs sufficient lookup inputs. The denominator is all currently action-labeled pane opens, not only messages proven eligible for each prefetch. No first-open bucket proves that every non-ready message should have been prefetched.

## Three evidence-backed follow-up targets

The query cannot estimate counterfactual staff-minutes removed, so these are ranked by observed affected opens and evidence quality—not promised time savings.

| Rank | Follow-up target | Evidence in this snapshot | Limitation / next measurement |
|---:|---|---|---|
| 1 | Verify quote preparation and the #391 attach-retry change against first-open readiness. | 21 quote opens; 3 ready; 2 system jobs running at open; 3 successful post-open waits, p50 4m22s and p90 1h50m17s. | No recorded open occurred after the ~15:00Z rollout, and this data does not attribute misses to attach failures. Re-measure after post-rollout pane events. |
| 2 | Instrument party-prefetch eligibility/skip reasons, then ensure eligible candidates are queued before open. | 36 new-booking opens; 0 ready; 8 system jobs first created after open; 24 had an admission snapshot but no exact-message system prep run by open. | Party prep is candidate-conditional; the 24 rows do not identify flag, candidate, cap, origin, or reuse causes. #390’s effect is unmeasured here. |
| 3 | Instrument booking-find eligibility and result-reuse misses for amend/cancel. | 21 amend/cancel opens; 0 ready; 12 had an admission snapshot but no exact-message system prep run; 4 had no prep admission snapshot; the remaining 5 were superseded (1), non-reusable (3), or system-notice (1). | No successful post-open wait sample; action-at-open labels are incomplete; eligibility requires the relevant lookup inputs. |

## Method and limits

- A real open is the earliest persisted `work_event` with type `pane.opened` for a `work_item.source_message_id`. The pane records it only after stored work is ready and a work-item ID exists. Telemetry is asynchronous, batched on a 5-second flush interval; failed sends are dropped, and the database event time is the server insert time. This measures the first **recorded** open, not a guaranteed exact UI-open time, and missing telemetry is not proof that staff never opened the pane. See `apps/mail/components/nava-pane/nava-pane.tsx`, `apps/mail/lib/quote-workflow/pane-telemetry.ts`, and `apps/server-pilot/src/ai/work-events.ts`.
- The target actions are grouped from the latest successful `mail_extraction.payload->>'action'` at the snapshot: `quote_availability` → quote, `new_booking` → party, and `amend`/`cancel` → booking find. As noted above, this is not a reliable historical action-at-open label for 73/78 rows.
- Runs are linked only by exact `ai_workflow_run.trigger_message_id = message.id`. The request discriminator is `read_request->>'kind'` (with `tool` accepted as a compatibility fallback); matching workflows are `staff_quote`, `party`, and `find`/`search_guest`. This avoids joining a later run to an earlier pane event, but may miss reusable/idempotent work whose original trigger message was different.
- Quote readiness required a priority-0 system `read_tool` run, `metrics.quotePrepared=true`, succeeded and finished by open, a present `read_result` with status `ready`, and an unexpired receipt at open. Party/find readiness required a matching successful system result usable at open. “Running at open” required the matching system run to exist by open and not yet be complete. The wait sample is `finished_at - first_recorded_open_at` for qualifying successful results after open; jobs first created after open are counted separately, not mixed into the running-at-open or pre-existing-system wait percentiles.
- Queue state and scoped read receipts are persisted, so a result can finish while the pane is unmounted; readiness here uses the DB receipt and its expiry/scope checks, not whether the pane stayed mounted (`apps/server-pilot/src/ai/run-ledger.ts`).
- The separate inbound-coverage check around 15:34Z found 1,145 Centurion inbound messages received in the prior 7 days; 18 had no extraction and no recorded pane event. They are outside the action-labeled pane cohort because there is no action to assign. This is a separate statement, not part of the 15:33:23 readiness snapshot.
- The rollout cutoff is approximate (~15:00Z, #390/#391). At the readiness snapshot, every target-action pane event and both fallback-proxy rows were pre-cutoff; recorded post-cutoff sample size was zero.
- Queries were aggregate-only: no names, addresses, subjects, confirmation numbers, or raw read-result contents were selected for output. The DB URL was sourced silently by the authorized SSM helper; the session forced UTC and read-only mode.

## SQL appendix

The production run was a single-statement, read-only aggregate at the snapshot above. This excerpt shows its event/action cohort, exact-message run mapping, and quote-ready predicate; the reported reason and percentile buckets were computed in the same aggregate and only grouped counts/percentiles were returned.

Review validation: a follow-up aggregate using the same `as_of` cutoff compared both extraction orderings. Latest-success-then-target-filter and target-filter-then-latest produced identical per-action window counts for this cohort, so the published denominators did not change. The excerpt below uses latest-success-then-target-filter ordering.

```sql
WITH params AS (
  SELECT TIMESTAMPTZ '2026-10-19 15:33:23.580562+00' AS as_of
), first_pane AS (
  SELECT wi.source_message_id AS message_id, MIN(we.at) AS opened_at
  FROM work_event AS we
  JOIN work_item AS wi ON wi.id = we.work_item_id
  WHERE we.type = 'pane.opened'
    AND wi.source_message_id IS NOT NULL
  GROUP BY wi.source_message_id
), pane_cohort AS (
  SELECT p.message_id, p.opened_at, m.received_at
  FROM first_pane AS p
  JOIN message AS m ON m.id = p.message_id
  CROSS JOIN params
  WHERE m.transport_id = 'transport-centurion'
    AND m.direction = 'inbound'
    AND p.opened_at > params.as_of - INTERVAL '7 days'
    AND p.opened_at <= params.as_of
), latest_success AS (
  SELECT DISTINCT ON (e.message_id)
         e.message_id, e.payload->>'action' AS action
  FROM mail_extraction AS e
  CROSS JOIN params
  WHERE e.status = 'succeeded'
    AND e.created_at <= params.as_of
  ORDER BY e.message_id, e.created_at DESC
), action_at_snapshot AS (
  SELECT message_id, action
  FROM latest_success
  WHERE action IN ('quote_availability', 'new_booking', 'amend', 'cancel')
), matched_runs AS (
  SELECT p.message_id, p.opened_at, a.action, r.*
  FROM pane_cohort AS p
  JOIN action_at_snapshot AS a USING (message_id)
  LEFT JOIN ai_workflow_run AS r
    ON r.trigger_message_id = p.message_id
   AND r.run_kind::text = 'read_tool'
   AND CASE
         WHEN a.action = 'quote_availability'
           THEN COALESCE(r.read_request->>'kind', r.read_request->>'tool') = 'staff_quote'
         WHEN a.action = 'new_booking'
           THEN COALESCE(r.read_request->>'kind', r.read_request->>'tool') = 'party'
         WHEN a.action IN ('amend', 'cancel')
           THEN COALESCE(r.read_request->>'kind', r.read_request->>'tool') IN ('find', 'search_guest')
         ELSE FALSE
       END
)
SELECT action,
       COUNT(DISTINCT message_id) AS first_opens,
       COUNT(DISTINCT message_id) FILTER (WHERE
         action = 'quote_availability'
         AND priority = 0
         AND state::text = 'succeeded'
         AND created_at <= opened_at
         AND finished_at <= opened_at
         AND metrics->>'quotePrepared' = 'true'
         AND read_result IS NOT NULL
         AND read_result->>'status' = 'ready'
         AND read_result_expires_at > opened_at
       ) AS quote_ready_at_open
FROM matched_runs
GROUP BY action;
```

The production aggregate also computed 24-hour counts, run-state/reason buckets, running-at-open counts, completion waits, and the no-pane priority-10 proxy. The action-at-open null-coverage and inbound extraction-coverage checks were separate aggregate statements at the timestamps noted above.
