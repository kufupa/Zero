# Establish the current Centurion SaaS read path

Type: task
Labels: wayfinder:task
Status: open
Assignee: unassigned
Blocked by: none
Mode: AFK

**Map:** [Centurion end-to-end reservation agent](../map.md)

## Question

Which current Centurion SaaS paths can reliably find a stay, look up a company/agency and return the applicable availability and nightly rates, and where exactly does each failure occur?

Reuse the dated cloud handoff and local WIP commit 4614002af before rebuilding the reader. Its author reported one 32-second BAR result; that is not independently verified current proof. If a live read is appropriate, check current property ownership and both historical lock keys; use a named read-only target and record the exact version, request, result and elapsed time. Do not disturb another browser or restart a paused Pomerado mint.

Finish with a minimal facts-and-gaps receipt, including whether a supported tenant API is actually available. Existing browser-internal endpoints are not proof of a supported API. No new general framework study.

**Starting evidence:** [Cloud handoff](../../../docs/plans/2026-10-27-001-dv-run-007-handoff.md) · [HRCEN lock split](../../../docs/research/2026-10-27-hrcen-two-locks.md) · [current quote reader](../../../apps/server-pilot/tooling/playwright-quote/fetch-quote.mjs) · [API and runtime assessment](../../../docs/research/2026-10-28-pomerado-runtime-replacement-assessment.md).
