# Decide prelookup, eligibility and price freshness

Type: grilling
Labels: wayfinder:grilling
Status: open
Assignee: unassigned
Blocked by: 01, 05
Mode: HITL

**Map:** [Centurion end-to-end reservation agent](../map.md)

**Dependencies:** [Establish the current Centurion SaaS read path](01-cloud-read-evidence.md), [Assemble representative cases from existing truth](05-truth-cases.md)

## Question

How should Nava prefetch and present the right native guest, company and agency records, room options, eligible rate plans and nightly prices, while respecting staff edits and freshness?

Existing availability prefetch currently selects quote extractions only. Static labels are not current availability or entitlement. An exact agency ID must inform its applicable rate lookup; ambiguous records need staff selection. Current create cannot write a staff-entered price override and emits manual_rate_change. Decide the supported override path or explicit refusal, what changes invalidate cached choices, and what must be rechecked at action time.

**Starting evidence:** [prefetch query](../../../apps/server-pilot/src/ai/hms-jobs.ts) · [rate catalogue](../../../apps/server-pilot/src/hms/rate-catalogue.ts) · [booking draft override flag](../../../apps/server-pilot/src/ai/booking-draft.ts) · [party lookup](../../../apps/server-pilot/src/ai/pane-party-lookup.ts).
