---
title: Centurion Retrospective ROI Dashboard - Plan
type: feat
date: 2026-11-16
topic: centurion-retro-roi-dashboard
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-brainstorm
execution: code
---

# Centurion Retrospective ROI Dashboard - Plan

## Goal Capsule

- **Objective:** Replace the dashboard inside Nava with a client-facing estimate of staff time that today's Nava could have saved on Centurion's preceding 30 days of reservation work.
- **Product authority:** Owner-confirmed scope, layout and forecast assumptions on 2026-11-16; `AGENTS.md` and `PRODUCT.md` govern the implementation and HMS write boundaries.
- **Planning blockers:** None requiring an owner decision. A fresh, deduplicated source frame and sufficiently grounded task assessments are prerequisites to publishing populated results.
- **Initial source window:** `[2026-10-17T04:17:49Z, 2026-11-16T04:17:49Z)`, exactly 30 days. Display the bounds in Centurion's local time, Africa/Johannesburg.

## Product Contract

### Summary

Overhaul Nava's existing dashboard with a Centurion retrospective forecast, a workflow breakdown, editable timing assumptions and task-level evidence.
Retain each distinct requested action independently of its time assumptions so future recalculation can use more detailed workflow or task timings without rerunning the email analysis.

### Problem Frame

There is no measured staff-adoption or handling-time baseline supporting a realised savings claim.
The existing dashboard reports mail activity and prediction quality, while the owner needs a clear estimate of the value Nava could have delivered on recent reservation work.
Historical email counts and unchanged fields do not establish distinct completed tasks or staff hours saved.

### Key Decisions

- **Retrospective forecast first:** Evaluate a pinned version of today's Nava against past workload; actual usage does not multiply the counterfactual estimate.
- **Distinct requested actions:** Count staff tasks rather than emails, threads, rooms, fields or tool calls; retain those relationships for explanation and future modelling.
- **Editable assumptions:** Start with six manual minutes and two Nava-assisted minutes for correct complete preparation; all other outcomes receive zero savings credit.
- **Evidence remains visible:** Retain correction, wrong-preparation and unknown categories even though their initial time credit is identical.
- **Replace the app surface:** The new experience occupies the existing dashboard entry point and replaces its old panels, using the existing authorised viewer access.

### Requirements

**Source coverage and assessment**

- R1. Analyse Centurion only over the explicit rolling 30-day source window, using original timezone-qualified email timestamps rather than work-item update times.
- R2. Establish a fresh source frame through the end cutoff and retain canonical source mappings when deduplicating mailbox copies and historical exports.
- R3. Show source coverage, exclusions and unassessed records; incomplete capture must not appear as a complete 30-day analysis.
- R4. Use Luna for the full-corpus email/task assessment and reuse verified existing corpus and product-replay capabilities where they fit the task-level question.
- R5. Pin the source frame, product version and assessment versions for each analysis, checking content and provenance before reusing older artifacts.
- R6. Keep information available at the request separate from later outcome evidence; unavailable historical native facts remain unknown rather than supporting a correct-preparation claim.
- R7. Assess supported client/agency reservation work according to the project scope, retaining hotel confirmations, proformas and payment notices as related evidence rather than extra tasks by default.
- R8. Keep replay and analysis read-only with respect to HMS; no real-guest Save, amendment, cancellation, filing or outbound send is part of the retro run.

**Task records and classifications**

- R9. Retain one record per distinct requested staff action, linked to its source emails, workflow and related work item or bookings where available.
- R10. Treat a multi-room Create request as one task under the initial uniform timings, while retaining room, guest and target counts for later complexity adjustments.
- R11. Retain the requested work, Nava preparation, remaining work, outcome reason and supporting evidence for each task.
- R12. Classify each task separately as correct complete preparation, minor correction, wrong preparation, partial preparation, unsupported or unknown.
- R13. Require evidence for task completeness and correctness; field retention, Read ticks, tool existence or a successful model call alone are insufficient.
- R14. Preserve task and workflow classifications independently of timing assumptions so later global, workflow or task-level recalculation requires no new model assessment.

**Forecast calculations**

- R15. Initialise the manual baseline to six minutes per distinct task and Nava-assisted effort to two minutes for correct complete preparation.
- R16. Credit correct complete preparation with the manual baseline minus assisted effort; initially this is four minutes per task.
- R17. Credit minor corrections, wrong preparation, partial preparation, unsupported tasks and unknown tasks with zero estimated minutes saved.
- R18. Allow viewers to change global and workflow timing assumptions and recalculate the displayed totals from the retained task outcomes.
- R19. Label timings and derived hours as forecast assumptions, keeping model latency, scheduled email gaps and measured staff labour distinct.
- R20. Calculate workflow and overall totals from the same task records, with unknown and excluded populations visible alongside the assessed population.

**Nava dashboard replacement**

- R21. Replace the current dashboard page at `/settings/admin-dashboard`, including its existing traffic, service and prediction panels, with the confirmed retro experience.
- R22. Show estimated hours saved, distinct tasks assessed, the source period and coverage prominently in the client summary.
- R23. Show counts, outcome categories and estimated hours by workflow, with access to the underlying tasks.
- R24. Show editable timing assumptions and expandable task evidence explaining the original ask, Nava preparation, remaining work and score.
- R25. Preserve existing authorised dashboard access and make the replacement reachable through the app's dashboard navigation for those viewers.
- R26. Show unavailable or incomplete results clearly; demonstration fixtures must be identified as examples and never mixed with source-backed hosted totals.

### Forecast Model

For task i with workflow w:

- Correct complete preparation: `credit_i = manual_minutes_w - assisted_minutes_w`.
- Every other outcome: `credit_i = 0` under the initial policy.
- Workflow hours: `sum(credit_i for workflow w) / 60`.
- Overall hours: `sum(credit_i) / 60`.

With the initial defaults, overall estimated hours equal `4 * correct_complete_task_count / 60`.
Zero credit for wrong or corrected work is the owner's forecast policy, not a measurement of its handling or rework cost.
The initial result is an estimate of time saved, not measured net ROI, cash savings or unattended automation.

### Layout and Key Flows

The page presents the client summary first, then the workflow breakdown, timing assumptions and expandable task evidence.
This is a replacement inside Nava rather than a separate report application.

- F1. An authorised viewer opens the existing dashboard entry, sees the analysed period and coverage, then inspects estimated hours and the workflow mix.
- F2. The viewer changes a global or workflow timing assumption; the displayed totals recalculate from the same task assessments.
- F3. The viewer expands a workflow and task to inspect the source ask, preparation, remaining work and evidence behind its classification.

### Acceptance Examples

- AE1. A supported task with evidence-backed correct complete preparation receives four minutes of credit with the default six/two assumptions.
- AE2. A task needing a minor correction and a task with wrong preparation each receive zero credit, while remaining distinguishable in the breakdown.
- AE3. One multi-room Create request followed by a separate Amend request counts as two tasks; mailbox copies do not increase that count.
- AE4. An email with independently requested Create and Filing actions can contribute two tasks when evidence establishes both asks.
- AE5. A missing native historical fact leaves the affected assessment partial or unknown; it is not silently promoted to correct complete preparation.
- AE6. Changing Amend's manual baseline to nine minutes and assisted effort to three credits its correct complete tasks with six minutes each, without rerunning Luna or changing other workflows.
- AE7. If retained mail ends before the selected cutoff, the page identifies incomplete coverage and does not describe its totals as the entire 30-day workload.
- AE8. An unauthorised account remains unable to view the replaced dashboard; an authorised viewer sees the new retro content through the existing entry point.

### Dependencies and Assumptions

The completed feature workstreams are the target capability assumption for the counterfactual; their exact integrated version must be pinned before the analysis.
Local saved corpus and labels inspected during discovery end around 2026-10-29 and 2026-10-30 respectively, with unresolved duplicate candidates and timestamp limitations.
They do not establish the selected rolling 30-day population.
Existing field traces and operation receipts can help ground task assessments but do not already constitute a task-level ROI dataset.
The current dashboard source grants access to `navaai@legacyhotels.co.za`; live deployment state was not verified by this brainstorm.

### Scope Boundaries

- **Deferred:** Live adoption/realised-savings analytics, the equivalent Da Vinci assessment, measured staff handling-time calibration and a dedicated per-action timing editor.
- **Measurement TODO:** Compare manual and Nava-assisted active effort on representative comparable tasks, including reading, review, corrections, fallback and verification.
- **Outside this release:** Unattended HMS writes, monetary ROI or revenue attribution, inferred labour from email intervals, and redesign of other Nava workflows.

### Deferred to Planning

- Resolve the fresh-export and canonical-source path for the exact period, including cross-export duplicates and timestamp provenance.
- Define evidence-based task grouping and completeness grading across workflows without replacing them with per-field or per-stay accuracy counts.
- Freeze the latest integrated feature and runner versions, avoiding superseded wrapper defaults and stale replay results.
- Separate data preparation and dashboard implementation into parallel work with a shared task/outcome contract.
- Select existing focused checks for changed code; follow project rules prohibiting new tests and local typechecks.

### Sources and Research

- `PRODUCT.md`: Staff approval, supported workflows and HMS write boundaries.
- `apps/mail/app/(routes)/settings/admin-dashboard/page.tsx`: Current dashboard surface and content being replaced.
- `apps/mail/lib/admin-dashboard/access.ts` and `apps/server-pilot/src/metrics/admin-dashboard-access.ts`: Current client and server access controls.
- `apps/server-pilot/src/metrics/admin-dashboard-aggregates.ts`: Existing aggregate conventions and limited 7d/28d selectors.
- `apps/server-pilot/scripts/export-centurion-thread-corpus-live.ts`: Existing fresh Centurion corpus exporter.
- `docs/research/halloween/corpus-analysis/mailbox-frame-build.py`: Source framing and canonical email mappings.
- `docs/research/halloween/corpus-analysis/luna-corpus-runner.py`: Existing full-corpus model runner to evaluate for reuse.
- `docs/research/halloween/corpus-analysis/2026-11-02-centurion-corpus-run.md`: Historical window and final correction-layer provenance; its labels are email-level potential help, not task-level time saved.
- `apps/server-pilot/scripts/export-reservation-field-trace.ts`: New feature-worktree exporter with request/workflow links and operation evidence; verify its final integrated version rather than assuming the current checkout contains it.

## Planning Contract

Product Contract preserved: R1–R26 and AE1–AE8 retain the owner-confirmed scope and scoring policy.

- KTD1. Publish an immutable, schema-validated task report from an offline analysis runner. The existing authenticated dashboard API reads this report; page visits do not start LLM work or HMS sessions. Use private runtime storage outside the deployment checkout, avoiding migrations and changes to ingestion.
- KTD2. Derive client response types from the pilot tRPC router. The parent owns the report schema and route, the UI lane owns only dashboard presentation, and the analysis lane owns only the runner. This separates concurrent writes before dispatch.
- KTD3. Run the real reservation prefill against request-time source context, with no DB persistence or HMS writes. Missing historical native observations make completeness unproven. A model classification or plausible suggestion alone cannot earn positive credit.
- KTD4. Retain a fixed 30-day source window per report and display its cutoff and coverage. Classify all canonical inbound mail with Luna; preserve exclusion and failure counts. Fresh-export coverage must be established from source provenance, rather than treating the last email timestamp as proof of complete export.
- KTD5. Recalculate timings in the client from retained task outcomes. Global and workflow overrides are viewer-scoped; source outcomes remain unchanged.

### Sequence and Ownership

U1 freezes the schema and API contract. U2 and U3 then run in parallel on disjoint files; U4 integrates, validates, reviews and prepares delivery. No workers modify shared schemas, lockfiles, Git history or deployment state. The parent owns integration and checks.

Product change estimate: approximately 800–1,400 added lines across report validation/loading, runner and UI, plus removal of the existing large dashboard page. This is a scope estimate based on these three existing seams, not a delivery-time proxy. New test lines: zero, following AGENTS.md. Completion ETA remains unknown until export coverage and real replay throughput are observed; no comparable full-month task-level replay has been verified.

## Implementation Units

### U1. Task report contract and authenticated read

- Owner: parent.
- Goal: expose a validated Centurion retrospective report through the existing dashboard authorization boundary.
- Requirements: R1–R3, R5–R6, R9–R20, R25–R26.
- Dependencies: none.
- Files: `apps/server-pilot/src/metrics/centurion-retro-roi.ts`, `apps/server-pilot/src/trpc/routes/admin-dashboard.ts`.
- Approach: define task/source/evidence/outcome schemas and bounded report loading from private persistent runtime storage; return an explicit unavailable state for missing or invalid reports. Validate unique task IDs, source windows and evidence before allowing correct-complete credit. Preserve existing metrics endpoints for callers while replacing the page.
- Patterns to follow: existing dashboard grants and Zod boundary schemas.
- Test scenarios: authorized versus unauthorized access, missing artifact, invalid period, duplicate tasks and incomplete evidence; validate with direct artifact execution and existing focused checks.
- Verification: existing dashboard access/query checks and remote pilot typecheck.

### U2. Retro dashboard replacement

- Owner: UI lane.
- Goal: show the client an understandable forecast with editable assumptions and source-backed task explanations.
- Requirements: R15–R26; F1–F3; AE1–AE2, AE6–AE8.
- Dependencies: U1 contract.
- Files: `apps/mail/app/(routes)/settings/admin-dashboard/page.tsx`, `apps/mail/hooks/use-retro-roi.ts`, `apps/mail/lib/admin-dashboard/retro-roi.ts`.
- Approach: replace the page with summary, workflow outcomes, timing controls and expandable evidence; use typed tRPC data, existing access gates and UI components. Identify example mode; hosted missing reports display unavailable, never fixtures. Preserve account-scoped cache and timing settings. Display fixed analysis dates in Africa/Johannesburg.
- Patterns to follow: existing settings page shell, auth/session gates and dashboard cache scoping.
- Test scenarios: default 6/2 assumptions, non-success zero credit, workflow overrides, empty/partial/unavailable/error states and narrow layouts.
- Verification: existing access checks, remote mail typecheck, running browser inspection when available.

### U3. Source refresh and task assessment runner

- Owner: analysis lane; source scout supplies export evidence.
- Goal: produce a reproducible, source-linked report for the selected 30-day Centurion population.
- Requirements: R1–R14, R19–R20, R26; AE3–AE5, AE7.
- Dependencies: U1 contract; current live source export route.
- Files: `apps/server-pilot/scripts/build-centurion-retro-roi.ts` and directly required runner helpers only.
- Approach: reuse the live corpus exporter and canonical source grouping, classify with the approved Luna adapter, identify distinct workflow actions and replay through the actual prefill. Preserve multi-room complexity, source IDs, reasons, replay versions and unresolved cases. Checkpoint outside Git and resume without repeating completed model calls. Publish atomically only after schema validation. Export reads and model analysis are authorized; real-guest HMS/DB writes are outside scope.
- Patterns to follow: `scripts/export-centurion-thread-corpus-live.ts`, `src/ai/reservation-workflow-v2-prefill.ts`, `src/ai/extraction/extract.ts`, and the existing as-of prefill replay tooling.
- Test scenarios: duplicate source copies, repeated amendments, multiple actions, multi-room create, excluded automated traffic, unavailable historical native facts and interrupted runs.
- Verification: run against the actual refreshed corpus; inspect representative source-linked classifications, replay receipts, coverage and final aggregate arithmetic. New tests are prohibited by AGENTS.md.

### U4. Integration, review and delivery proof

- Owner: parent.
- Goal: make the replacement reviewable and working with the actual report, reporting any remaining demo limitation accurately.
- Requirements: R1–R26 and AE1–AE8.
- Dependencies: U2 and U3.
- Files: integrated changed files, existing deployment scripts unchanged.
- Approach: integrate disjoint changes; run focused checks, remote typechecks and real report/UI verification. Open a reviewable PR and launch Greptile Apex on its final head, using an independent reviewer if unavailable. Merge and deploy only through normal project gates and authorized delivery routes; verify runtime and report access. Never bypass hooks or trigger non-installer GitHub Actions.
- Patterns to follow: `PRODUCT.md` delivery rules and existing ops deployment guards.
- Test scenarios: report reload after deployment, denied unauthorized access, consistent overall/workflow/task totals and no fixture data in hosted mode.
- Verification: final-SHA typechecks, focused existing checks, review, UI/report proof; runtime SHA/health if deployed.

## Verification Contract

No new tests or local TypeScript checks. Run existing focused dashboard access/query checks with database environment variables unset. Remote typecheck both affected apps using the host remote-typecheck script on committed clean final heads. Inspect actual report counts and representative task evidence. Browser-verify desktop and narrow layouts when tooling is available. Report unrun or blocked checks explicitly. The retro runner must never persist work items, send mail or run HMS writes.

## Definition of Done

The existing Nava dashboard entry shows the new retro experience to its authorized viewers. A source-backed report covers the exact analysed period, preserves distinct task/evidence records and recalculates correctly under timing edits. Missing coverage or native evidence is visible and receives no unsupported positive credit. Required checks and review have passed. Client-demo readiness additionally requires a populated current-period report and verification of the deployed page; a fixture render, commit or merge alone does not prove that milestone.
