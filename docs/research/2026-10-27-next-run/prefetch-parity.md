# Prefetch-to-pane parity — 2026-10-27

**Verdict:** Partial. Successful live extraction schedules read-only jobs; pane can hydrate persisted quote/availability results on open. Nothing guarantees every job finishes before open. V2 party hydration has a source/property identity defect; party/availability caps still drop overflow.

**Evidence boundary:** Static source at `92be0e5d2` (`origin/main` same SHA). No production env, SQL, HMS, pane session, tests, deploy, or runtime log inspected. The [2026-10-25 baseline](../2026-10-25-pane-prefetch-and-ui-evidence.md) is dated, not current runtime proof. [Run-plan units C1/C2](../../plans/2026-10-26-007-dv-faith-run-plan.md#L66-L73) and [C1/C2 sizing](../../plans/2026-10-26-007-dv-faith-run-plan.md#L150-L151) are planning evidence.

## Flow matrix

| Hotel × mail | Trigger / eligibility | Persisted output | Pane reader / edit precedence | Remaining gap |
|---|---|---|---|---|
| HRCEN × quote | On successful extraction, worker schedules asynchronously. Live-admission required. Party needs queue + `HMS_PREFETCH_ENABLED`, direct/inbound/non-spam eligible mail, `kind=quote`, candidate and valid HRCEN origin. Availability additionally needs `HMS_AVAILABILITY_PREFETCH=on` and complete stay rows. Rate prep needs `HMS_QUOTE_PREPARE=true`, plannable quote and configured strategies. | Party: `read_tool` result. Availability: dated `availability` result. Rates: one prepared `staff_quote` per configured strategy. | `PartyPicker` resumes matching thread/source. Stay panel queries saved availability by exact dates/rooms. `nava-pane` reads matching prepared rate jobs after mount; only missing stays are filled, guarded by selection/input/stay revisions. Existing staff picks/edits are not replaced. | No finish-before-open guarantee. V2 party result lacks `propertyCode`, so picker rejects it for a property-scoped pane. Availability read is one-shot if still pending. V1 party completion does not unblock quote prep. |
| HRDAV × quote | Same, plus party/availability target requires `HMS_DAVINCI_READS=on`; prepared rate target requires `HMS_DAVINCI_MAKE_QUOTE=on`. No fallback to Centurion target. | Same outputs, scoped to HRDAV transport/property. | Same readers; party bind requires stored property to match active pane. Rate readback binds only same current request/property and valid result. | Same V2 metadata and pending-read gaps. Per-transport caps multiply across HRDAV mailboxes. |
| HRCEN × new booking | Product `new_booking` maps to extraction/work-item `kind=booking`. Successful live-admitted extraction schedules party prefetch; `booking` is in `NEEDS_YOU_KINDS`. No quote-preparation or availability job: both accept quote mail only. | Party `read_tool` result only. | Party picker can resume the selected message's party read; current staff selection wins. Booking draft/rate state is not pre-prepared by this quote-only path. | V2 property metadata defect applies. No HMS availability/rate prefetch for new bookings. |
| HRDAV × new booking | Same booking eligibility, plus `HMS_DAVINCI_READS=on` and general queue/prefetch gates. | HRDAV-scoped party `read_tool` result only. | Same; no quote/availability hydration. | Same V2 metadata defect; party cap can silently drop. |

## What pane actually hydrates

- **Party is not quote-only.** `PARTY_PREFETCH_KINDS` derives from `NEEDS_YOU_KINDS`: quote, booking, amendment, cancellation, voucher-POP. `booking` therefore gets party prefetch when eligible. Domain/history hints do not auto-pick; body-named suggestions can. Existing picked field blocks a new auto-pick.
- **Prepared availability is rendered, but conditionally.** `StayAvailabilityPanel` reads saved status after mount and shows current-day all-room availability as a read-only snapshot with room choices. It is not a priced quote. It matches thread, dates and the exact ordered room JSON. Snapshot must be complete/current; a queued/running result produces a pending message, with no polling loop in this panel.
- **Prepared rates are rendered after pane open.** Quote strategy binding reads stored `staff_quote` jobs for current stays and dispatches results only while source, property, selection and edited inputs still match. Missing/stale data can trigger a pane-side auto-start for quotes; that is not pre-open completion. `staff-quote-run.ts` records staff rate-picks only for a user run, not `autoStart`.
- **V2 party identity gap:** V2 result is persisted as `{...result, kind, asOf}`; property target sits in run metrics, not the result. `PartyPicker` checks `result.propertyCode` and refuses a missing property whenever pane property is known. C2 directly targets this seam.
- **Party→rate sequencing is V2-only.** Quote evaluation waits for pending V2 party jobs and worker re-evaluates after V2 terminal state. With V2 disabled/legacy party request, no terminal callback unblocks quote preparation. Code default for `PARTY_MATCH_V2` is off; live setting not checked. Do not call contract-rate preparation reliable until live flag and behavior are proven.

## Caps and defaults from code only

- Code defaults are queue off; `HMS_PREFETCH_ENABLED=false`; `HMS_QUOTE_PREPARE=false`; `PARTY_MATCH_V2=false`; party cap 30/transport/hour; quote cap 6/transport/hour; availability off, cap 6/transport/hour. These are **not live values**. HRDAV needs exact `on` for read/quote target flags.
- `staff_quote` cap uses atomic profile-sized batches and persists a future `nextRunAt` on overflow. `prepared-quote-cap.test.ts` asserts full HRCEN/HRDAV profile fan-out and deferral; test not run here. Existing dev gate groups work by HMS slot.
- Party overflow returns no job; cap-exhausted party decision is not recorded for the ordinary full-cap path. Availability loop stops at cap and drops remaining stays. Neither defers/catches up. Reservations count by transport, not property.

## Smallest fixes to queue

1. **C2 — carry `propertyCode` in V2 party result.** Exact seam: `apps/server-pilot/src/ai/hms-jobs.ts`, `apps/mail/components/quote-workflow/party-picker.tsx`; test `apps/mail/tests/party-picker-results.test.tsx`. Estimate: 5–15 product LOC, 15–25 test LOC. Check HRCEN/HRDAV matching results hydrate; wrong/missing property stays unbound; staff pick remains authoritative; `autoStart` creates no staff pick.
2. **C1 follow-through — defer party/availability overflow.** Exact seams: `apps/server-pilot/src/ai/hms-jobs.ts`, `apps/server-pilot/src/ai/prefetch-capacity.ts`; tests `apps/server-pilot/tests/hms-jobs.test.ts` and `apps/server-pilot/tests/prepared-quote-cap.test.ts`. Estimate: 30–50 product LOC, 40–70 test LOC. Saturate each cap; verify every eligible job persists with later `nextRunAt`, reports deferred reason, then pane hydrates result without staff click.

**Scope:** No matcher-algorithm or corpus re-evaluation. No live/runtime claim. Pomerado, writes, and deployment excluded by task boundary.

## Later Phase 1 handoff evidence

The committed `docs/plans/2026-10-27-001-dv-run-007-handoff.md`, refreshed through main `69ce8fc45`, reports a failed ready-on-open party case.
An external booking forwarded by the hotel's sender was excluded as staff sender; another mailbox copy was classified other.
The extraction also confused a guest/booking-name field with Company and missed the named originating agent.
The manual party read took 53 seconds in that case.
Those observations come from the other session's handoff, not this lane's production inspection.
They show why V2 property-payload repair alone cannot certify ingest-time readiness: eligibility, extraction, job completion, hydration, and native binding must be judged separately.
No per-entity rule, extraction accuracy gain, or current-runtime readiness rate is asserted.
