# Choose browser tools without blocking delivery

Type: grilling
Labels: wayfinder:grilling
Status: open
Assignee: unassigned
Blocked by: 01
Mode: HITL

**Map:** [Centurion end-to-end reservation agent](../map.md)

**Dependencies:** [Establish the current Centurion SaaS read path](01-cloud-read-evidence.md)

## Question

For each Centurion operation, should the delivery path use existing Playwright, Stagehand-assisted discovery or replay, a reviewed Pomerado-generated operation, or an actually available supported API?

The existing Pomerado Stay 360 mint was incomplete; a different published arrival tool failed before searching. Stagehand reached Rate Shop with generic accessibility assistance but produced no nightly prices. Those results are not a controlled head-to-head. Compare build time, fresh-session correctness, runtime, drift recovery and total cost on the same cases; keep existing working paths available. Do not hold the booking workflow for an optional framework experiment.

**Starting evidence:** [Stagehand trial](../../../docs/research/2026-10-28-stagehand-fresh-trial-f777f33d.md) · [Pomerado diagnosis](../../../docs/research/2026-10-28-codex-pomerado-477-runtime-diagnosis.md) · [local SDK comparison](../../../docs/research/2026-10-28-local-pomerado-stagehand-comparison-0b0c189d.md).
