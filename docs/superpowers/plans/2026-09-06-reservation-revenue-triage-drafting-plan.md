---
title: Centurion Single Live Read-Only PMS Tool Proof - Plan
date: 2026-09-06
revised: 2026-09-11
type: feat
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
execution_routing: gpt-5.6-luna-max
coordination_model: astra-dispatch-dependency-gate-only
execution_baseline: 62169b437b49f87e923c8545e07f357e8ccc7bb6
review_status: live-priority-amendment-approved-implementation-in-progress
planning_mode: nava-plan-pipeline
source_checkout: d80fbcd4b79bb5cf1580b25500b8f6e8e0f7b214
supersedes_analysis: docs/superpowers/plans/2026-09-04-gold-response-tool-agent-architecture.md
---

# Centurion Single Live Read-Only PMS Tool Proof - Plan

**Execution posture:** user approved implementation, then on 2026-09-11 explicitly narrowed this run to ONE complete live read-only tool and its final video, and authorized disabling the existing `hms-shadow-disabled` marker for the rest of this Codex session. This active contract supersedes the previous twelve-tool stopping condition and marker prohibition, and conflicting retained history below. Work in the existing isolated `feat/centurion-dashboard-tools` worktree; preserve existing changes.

## Goal Capsule

- **Now:** complete `hms_find_reservation` through its genuine guarded application executor against live PMS and deliver ONE final private playable Playwright video plus matching trace/report and source/result comparison.
- **Stopping condition:** the selected tool is implemented, tested, independently reviewed and actually proven on a real PMS record; hand its final evidence to the owner. Do not continue to the other eleven tools until the owner resumes them.
- **Paused:** the other eleven HMS tools, dashboard expansion, U11, historical-email backtesting, drafting agents, model evaluation and unrelated cleanup. Preserve their inventory/contracts for later resumption.
- **Application path:** actual application factory/executor plus trusted runtime composition. This copied development runtime is not a deployed Nava UI demonstration. Parser-only calls, invented execution contexts, synthetic handlers and enqueue routes do not qualify.
- **User experience:** the agent develops, tests and repairs; the owner reviews final live recordings afterward. Do not ask the owner to operate the browser or code.

## Global Constraints

- **PMS reads only.** No save, create, amend, delete, payment, cancellation, document generation, business write, send, queue/outbox operation, application model call, migration, production test runner, Nava deployment/restart, credential change or authorization bypass.
- **Allowed infrastructure scope:** copy necessary development files/runners to private isolated VPS/EC2 directories and run bounded development processes. Reuse existing approved transport, authenticated access and pinned browsers. Do not replace the deployed repository, active release, service configuration, workers or installed launcher.
- **Explicit session rearm authorization (2026-09-11):** the owner authorizes removal of `/opt/nava/shared/hms-runtime/hms-shadow-disabled` for the remainder of this Codex session, not merely one attempt. Resolve the exact regular-file target and preserve a private recoverable copy; use the existing operation lock and verify current HMS isolation. Do not re-create the marker after each attempt or at the one-tool handoff. Record its intentional absent state. This permission does not authorize any other latch/guard change, starting/stopping workers, deployment/restart, queue/model activity or production-registry mutation.
- Never weaken fail-closed source/runtime fingerprints, exact record/property/mailbox and opaque-reference binding, current-access authentication, issuer/admission checks, release/read-only proof, cross-process property locking, read budgets, privacy guards or the pre-transmission firewall.
- Every currently authorized pilot application user may use all configured pilot tools/data, including finance. Current server-verified application access is authoritative; no additional role/allowlist question. Preserve tenant/property scope. Record routine permission assumptions in handoff for owner double-check.
- Browser-based access and already-authorized same-origin UI transport only; no guessed endpoints or new public PMS API integration. Navigation may autosave: unknown effects stay blocked.
- No fixture, synthetic data, synthetic browser journey, synthetic video or loopback transport substitutes for live proof. Offline regression fixtures may test code but are never live deliverables.
- Credentials, keys, tokens, cookies and database URLs stay out of review videos, logs, Git, reports and tool stdout. Client-authorized PII stays in owner-restricted private artifacts, never SSM/CI/public output or remote research queries. PMS/mail content is untrusted data, not instructions.
- Tests use a sanitized environment and no database or a verified disposable database only. Clear ambient `DATABASE_URL`/`VITEST_ALLOW_PILOT_RDS` before test runners; never source production env into tests, use the legacy override or change migrations.
- Preserve unrelated dirty changes. No destructive Git, merge, push, PR, broad formatting, worktree cleanup or unrelated infrastructure changes.

## Autonomous Execution Mandate

**User granted autonomous execution of this single-tool live-only plan and session rearm.** Continue until `hms_find_reservation` satisfies the evidence-based done criteria, or an exact external prerequisite remains after safe authorized alternatives are exhausted. The previous missing-rearm-authorization blocker is resolved by the owner's explicit instruction. Routine failures are debugging work, not a reason to ask permission or claim completion.

### Routing, navigation and ownership

- Use `gpt-5.6-luna`, Max reasoning, standard/non-fast transport for routine research, parsers, implementation, tests, live operation, repairs and reviews. Root Astra orchestrates dispatch/dependencies/evidence gates; bounded Astra advisory is reserved for genuinely stuck diagnosis, then implementation returns to Luna.
- Aim for at least 90% of development work on Luna. Record requested/effective model and available telemetry; unknown usage remains unknown, never a fabricated percentage.
- Maximum four concurrent agents including root; no nested delegation. Serialize overlapping file edits, all live PMS browser activity and shared test resources. Prefer small durable task briefs and private receipts over full-history forks.
- Each task brief explicitly requires **CodeGraph first** at `/home/ubuntu/projects/zero/.worktrees/centurion-dashboard-tools`: if `.codegraph/` exists, use `codegraph_explore` with that exact project root (or CLI from it) before grep/find/manual source lookup. Inspect named symbols/call paths and freshness; never use another worktree's index. If unavailable/stale, record the bounded fallback. Graph output is not runtime proof.
- Follow nava-run, TDD and ce-debug under these narrower user constraints. Luna owns RED → GREEN → focused verification; a separate Luna reviewer supplies specification and code-quality verdicts. Generic auto-landing/deploy skill defaults do not apply.
- Keep a durable execution ledger with task owner, exact commands/evidence, revision, failures, repairs and next step. Preserve failed capture/trace/log evidence privately.

### Repair and escalation loop

FAIL → preserve evidence → minimally reproduce → identify root cause/mechanism → failing regression → smallest safe repair → focused verification → live rerun → compare actual facts → repeat.

- Expected TDD RED is not a blocker. Stubs, `unavailable`, denial tests, local passes, old videos and browser-only observations are not completed tool capabilities.
- Repeated distinct failed hypotheses trigger fresh Luna diagnosis, then bounded Astra advice if necessary. There is **no automatic two-attempt parking or failed-capability-as-success rule**.
- Stay focused on the one selected tool; do not expand to the other eleven while investigating failures. Stop only after all safe authorized alternatives are exhausted for missing access, human-only interaction, external outage or a genuine safety conflict; report exact evidence and the prerequisite needed. Do not claim this goal complete without the selected tool's live evidence.
- Follow the project autonomy overlay only within the restrictions above. Its broad deploy/restart/migrate permissions are expressly superseded for this run.

### Infrastructure and privacy anchors

| Resource | Established route / constraint |
| --- | --- |
| EC2 | `i-008f737974a9ba9b3`, `af-south-1`; read-only SSM checks and isolated copied development files |
| Existing remote repo | `/home/ubuntu/repos/zero`; inspect/reuse, do not deploy over it |
| Browser | Playwright `1.52.0`, Chromium revision `1169`; verify actual pins |
| Historical immutable proof layout | `/opt/nava/releases/<revision>/worktree`; reuse precedent without installer/stop/service lifecycle changes; the exact session marker removal above is now authorized |
| Existing private captures | `/opt/nava/shared/hms-browser-artifacts`; private transfer route with authenticated digest checking |
| Retention | Existing 24-hour capture TTL; retrieve in time, report earliest expiry, do not disable purge or extend retention silently |

The earlier installed `asm-exec` pin mismatch and `artifact-video/live-wave` placeholder require investigation, not a PMS-access failure claim. Use a verified scoped route with source/browser provenance intact; never switch off a checksum guard. Reuse actual machinery, not lifecycle-mutating wrapper steps.

## Active Implementation Units

### L1. Establish the one selected genuine live proof

- Reuse the completed inventory and accepted entry/auth work; revalidate only current prerequisites needed by `hms_find_reservation`. Do not repeat completed research or build the other tools.
- Selected tool: `hms_find_reservation`. Deferred inventory: `hms_read_reservation`, `hms_read_folio`, `hms_quote_stay`, `hms_list_documents`, HMS-source branches of `documents_list_existing`/`documents_read_existing`, `hms_sent_email_audit`, `hms_company_account_read`, `hms_group_block_read`, `hms_event_read`, `hms_read_notes_traces`.
- Explicitly classify non-PMS `mail_read_artifact` and `property_read_knowledge` as outside PMS video proof; do not falsely certify them or expand dashboard work.
- Create a checksummed private copied development runtime using the pinned EC2 browser and existing transport. Extract/reuse a trusted synchronous application execution seam if necessary; no tRPC enqueue, fabricated workflow run, invented user/issuer/admission or injected fake handler.
- Reuse existing cross-process property isolation. Remove only the specifically authorized session marker after the stated checks; never clear other safety latches, stop a worker or fake isolation to launch proof.
- Extend closed capture schemas explicitly where required, retaining all privacy/runtime guards.
- Complete one real reservation tool invocation with observed source facts, genuine returned result and playable private recording. Scaling is deferred until a later owner request.

### L2. Finish and repair the selected reservation tool

- Use an existing live PMS record with sufficient positive coverage for `hms_find_reservation`. Independently observe visible facts, invoke the real application tool, then compare returned facts.
- Probe relevant ambiguity, paging, legitimate absence, stale references and partial source coverage. Negative claims require request/response/parser/scope/window evidence and a known-positive control under the existing live-negative verification gate.
- Debug every failure using the mandate loop. Implement missing source readers/contracts rather than counting `manual_required` handler placeholders as features.
- Run focused reservation, admission, runtime/capture/privacy regressions and relevant build/type checks with safe test environments. Existing shared repairs needed for this tool remain required; do not start unrelated document/finance/quote/context work. Denial/guard tests supplement rather than replace successful live proof.
- No historical-email backtest or drafting dependency is introduced.

### L3. Record final private evidence on the completed revision

- Explicitly enable video, then verify one nonempty playable final video, trace and matching receipt/report for `hms_find_reservation`. Rerun it after relevant repairs; final evidence must match the completed source/runtime revision.
- The final video shows real Chromium, the actual PMS record and visible facts, the genuine application invocation, and its actual returned result matching those facts.
- Keep credential entry out of review media and scrub secret-bearing trace headers/cookies without misrepresenting source provenance.
- Playwright is per-page: one final file may join **only actual contemporaneous** PMS and genuine result-viewer recordings. Label segments; retain originals and operation IDs, times and hashes. Do not claim a seamless single-page journey.
- Never inject output into the PMS DOM or use `setContent` there. A separate private result viewer may render only the actual returned payload, never canned data.
- Retrieve final artifacts under owner-restricted directories before the unchanged retention deadline and inspect the final review copies for secrets.

### L4. Independent review and handoff

- Separate Luna review covers spec, code quality, guards, real application invocation, source/result comparison and evidence provenance. Fix valid findings and rerun impacted proof.
- Provide the selected tool's private final video, trace/report, record/scenario, visible PMS facts, actual result/comparison, focused tests, repairs, source/runtime versions, digests and expiry. Mark the other eleven tools deferred, not verified and not part of this run's completion claim.
- Record excluded non-PMS tools and any exact exhausted external dependency honestly. Earlier synthetic/expired evidence is historical only.
- No landing/deploy/cleanup; leave the worktree ready for owner review.

## Active Verification and Definition of Done

- [x] Inventory reconciles all applicable unions/callers and current remote registry (private source inventory and fresh registry report, 2026-09-10). This is not a live capability pass.
- [ ] `hms_find_reservation` is implemented and succeeds through its real guarded application path against live PMS; no synthetic context/transport, stub or unavailable-as-success.
- [ ] Its returned result has an independently checked source/result comparison using a sufficiently populated real record.
- [ ] It has one final private playable video plus matching trace/report from the completed revision, with secret-safe review copies and explicit provenance.
- [ ] Focused regressions/build/type checks and independent review pass; guards and read-only boundaries remain intact.
- [ ] Handoff index includes exact paths, tests, repairs, revision/digests and earliest expiry; no unresolved prerequisite affects a claimed completed tool.

## Execution Mode

Autonomous now. Resume L1 for `hms_find_reservation` only and proceed dependency-first without routine checkpoints, using the explicit session marker-removal permission. Development files may be copied to EC2; Nava services/repository must not be deployed or restarted. Stop after delivering the selected tool's completed live proof/video. The user's newest scope governs all retained material below.

---

## Retained Earlier Product Contract — Reference Only

Everything from this heading onward is preserved historical/product context. It does not authorize paused work, fixture deliverables, queues, models, migrations, deployment, restarts or a weaker live-completion gate. Earlier implementation/verification/DoD sections are inactive unless explicitly reactivated by the owner.

### Problem Frame

The client may be seeing its email operations analysed for the first time. A general B2B executive dashboard is useful independently of AI triage or drafting. The existing eleven workflow folders provide a business-work breakdown; they need not dictate every chart.

The selected sent-mail corpus shows which facts and actions recur, but is not a complete archive or a set of uniformly correct answers. The user is repairing two-way capture; this plan assumes the repaired feed from a recorded start point and exposes limited diagnostics. The earlier “one-third of revenue lost” interpretation is unsupported.

Current code has dashboard, browser-read and drafting foundations. Some tool registrations are not executable capabilities, and some documents/quote screens can cause writes. Prioritize independently useful, proven reads before the master drafting/evaluation workflow.

### Actors

| ID | Actor | Relevant authority |
| --- | --- | --- |
| A1 | Current pilot reservationist | Optional assistance in the existing workflow; retains control of customer replies. |
| A2 | Hotel manager | Defines service expectations; no individual ranking inferred from shared-mailbox data. |
| A3 | Finance/groups/property staff | Remain the source for actions, exceptions and off-email work outside released read capabilities. |
| A4 | Client executive | Sees useful Centurion aggregates; current pilot application access also authorizes the application's tools/data under the owner-approved policy. |
| A5 | Nava operator/developer | Reviews errors, data quality, tool releases and costs; same all-tool pilot access policy, with configured research/cohort boundaries preserved. |
| A6 | Guest/booker/payer | Receives accurate authorized replies; shadow experimentation must not affect service. |

### Requirements

Stable IDs retain their concepts; the earlier product revision changed sequencing and scope at the user's request, while this amendment adds Phase 2/B validation and CodeGraph navigation rules without changing product safety or counts.

| ID | Requirement | Current disposition |
| --- | --- | --- |
| R1 | Preserve reproducible corpus provenance and distinguish rows/messages/replies/bookings. | Pin the 420-record selection and 581-record extended audit; retain the new per-record tool-demand mapping, not a population-frequency claim. U1. |
| R2 | Recognize current requests independently of folder and old replies. | Prospective observed-reply slice, then ask-aware service enrichment; no ownership-system dependency. U2. |
| R3 | Owned, explainable priority queue. | Deferred U3/U4; existing Inbox/folders remain usable. Not needed for first measurement release. |
| R4 | Useful drafting across reservation work families. | Build after tools; consume only supported facts/bytes, clarify missing information, and distinguish pending business actions. U5/U6/U13. |
| R5 | Proven scoped browser-based PMS reads. | Expand the corpus-prioritized read portfolio, not only reliability of old tools. U8/U7/U9/U15/U16/U17. |
| R6 | Separate language from customer facts, approved policy, PMS facts and actual actions. | Shared draft/evaluation contract. U5/U8/U17/U13. |
| R7 | Human approval, edits, freshness, recipient safety and auditability. | Required for visible pilot assistance; shadow never bypasses it. U6/U11. |
| R8 | Truthful client metrics with named denominators and coverage. | First milestone is a general executive email dashboard, Centurion only; existing folders are one breakdown. U10/U12/U2. |
| R9 | Assess value without invented ROI/headcount claims. | Operational usefulness and internal tool/model cost only in this pass; no task timing, labor-saving or causal revenue estimate. U11/U13. |
| R10 | Usable human exception handling, including groups/internal work. | Briefs and manual path now; full assignment/handoff UI deferred with U3/U4. |
| R11 | Minimize build and maintenance complexity. | Reuse existing dashboard, worker, storage and browser release system. No warehouse or general evaluation platform. |
| R12 | Reproducible tests, independent checks and reversible rollout. | U1/U11; no pilot-RDS tests or skipped-evidence green. |
| R13 | Separate client service metrics from Nava capability/operating metrics. | Distinct audience-oriented views, not one misleading score or an additional staff-role permission system. U10/U13. |
| R14 | Make capture assumptions and limits visible. | User owns feed repair. Record a prospective two-way-capture start plus lean diagnostics; do not build import repair, source certification or a polling monitor. U12. |
| R15 | Freeze unseen draft predictions and compare later replies without leakage. | Separate private artifacts; missing/changed-state references explicit. U13. |
| R16 | Work with one intermittent user. | Dashboard/read tools/private evaluation do not depend on daily staff adoption; timer/study removed. U10/U13. |
| R17 | Explain and bound every tool contract. | Typed input/output, provenance, partial/unknown states, privilege and output limits; tools independently usable before drafting. U8/U7/U9/U15/U16/U17. |
| R18 | Preserve future business-action research without enabling writes. | Catalogue create/change/cancel, profile/group, payments/refunds, documents and communications with inputs, effects, approvals and recovery. Documentation only. |
| R19 | Show attractive, intelligible business charts. | Traffic lines, activity/folder bars, counts and accessible definitions; AI quality/cost remains a separate operator view. U10. |

### Flows and acceptance examples

| IDs | Given / action | Required outcome |
| --- | --- | --- |
| F1 / AE1 | New enquiry lacks dates, occupancy or trusted price. | Specific clarification or supported partial; no invented total, availability or held inventory. |
| F2 / AE2 | Guest accepts a quote. | Acknowledge and flag staff action; “confirmed” requires actual creation evidence, not a reference-shaped string. |
| F3 / AE3 | Cancellation/amendment or POP arrives. | Preserve deadline/current asks; no completed cancellation or cleared-funds claim from request/proof alone. |
| F4 / AE4 | Customer requests an invoice/confirmation. | A missing document yields an honest staff blocker; “attached” requires exact authorized current bytes. |
| F5 / AE5 | Internal/group message carries commercial work. | Include it in classified demand/briefs; do not infer guest reply from an internal forward. Assignment UI is deferred. |
| F6 / AE6 | Staff edits a draft; mail/evidence/recipient changes. | Preserve text, invalidate only affected approval, require re-review before dispatch. |
| F7 / AE7 | Outbound is queued, failed, externally sent or partially accepted. | Preserve separate evidence states; no queued-as-replied or acceptance-as-delivery claim. |
| F8 / AE8 | Model/tool/coverage is unavailable. | Specific reason and manual path; no blank editor, fake success or guessed metric. |
| F9 / AE9 | Old sent history is incomplete; new requests arrive after the recorded two-way-capture start. | Show prospective response metrics with the capture assumption, eligible/scored/unknown counts and valid clocks; keep old/unknown-start work separate. |
| F10 / AE10 | Late sent backfill answers a historical request. | Recompute/version the affected report, preserve prior report provenance; do not count import as today's staff work. |
| F11 / AE11 | Shadow is completed before a later human reply. | Seal prediction; score later against same-request evidence without exposing it to staff. |
| F12 / AE12 | Human reply contains new facts, a mistake, or cannot be linked. | Separate changed-state/error/ambiguous outcomes; no blind imitation or missing-reference model failure. |
| F13 / AE13 | Task timing and study are explicitly removed. | No timer, assignment experiment, staff tracking or inferred minutes saved is built. |
| F14 / AE14 | A browser tool fails or returns no result. | Private repro and guarded repair; not-found needs a known-positive control and valid scope/window/parser. |
| F15 / AE15 | Evaluator receives zero labels or “not confirmed” vs “confirmed.” | Quality unavailable for zero labels; negation is a material contradiction, regardless of word overlap. |
| F16 / AE16 | A document screen offers Print or Generate beside an existing invoice. | Separate metadata, existing-byte retrieval and generation; block any read path with unproven side effects. |
| F17 / AE17 | An executive asks about overall email operations. | Show demand/activity/folder/correspondent/service patterns without requiring AI adoption or exposing customer bodies. |
| F18 / AE18 | The tool can prove reservation facts but not payment or document availability. | Return the proven sections with typed unknown/denied states; no fabricated whole-result success and no unneeded PII dump. |

### Scope boundaries

**In this implementation plan:** general executive dashboard; prospective response definitions and lean feed diagnostics; corpus-prioritized read tools and private trace/video proof; then request-aware enrichment, drafting, private evaluation and narrow visible assistance. No master drafting agent or full historical baseline before the tools milestone.

**Deferred to follow-up work:**

| Preserved U-ID | Work | Re-entry condition |
| --- | --- | --- |
| U3 | Durable ownership, delegated obligations and accepted handoffs | Observed handoff/backlog pain that the current mailbox cannot address. |
| U4 | Ranked Needs action/Waiting views | Valid inbound-first current-request evidence and staff need; chronological Inbox stays. |
| U14 | Task timing and within-person study | Removed at user request; no automatic re-entry or implementation in this plan. |
| Future business actions | Create/change/cancel, profile/group writes, payment/refund, document generation and communications | Separate future approval/implementation using the researched catalogue; never register these as current read tools. |

U7 availability/rate evidence and U9 existing-document retrieval are reactivated as read-only work. U8 expands from old-tool repairs to independent read execution and reservation context; U17 owns finance, and new units cover group/company context and approved non-PMS evidence. A capability can remain unavailable when tenant role, read-only transport or evidence is genuinely missing; that is a reported capability blocker, not a stub counted as working.

Do not build a new CRM, warehouse, per-folder agent fleet, generic OCR/knowledge platform, autonomous browser self-repair service, capture supervisor or procurement project. Buying/partnering remains an optional later economic decision, not another pilot to organise now. Do not rank staff, manufacture poor performance or claim incremental revenue from observational mail joins.

---

## Evidence and Research

### Local evidence retained

- Historical “433” was concatenated rows, not distinct gold: **420 distinct selected records**, comprising 388 sent/outbound and 32 staff-origin inbound. Extensions/exclusion review/addendum produce **581 individually annotated records**, not 581 verified correct human replies.
- The locally retained September 2 snapshot has 4,536 rows and 560 distinct outbound fingerprints. Only 196 of those outbound fingerprints are individually represented in the expanded selection; 364 confirmation-cover messages were structurally reviewed, not fully adjudicated. None proves full outgoing coverage.
- In the original selected 253 external/mixed reply candidates, document/payment/quote work is common; action and judgment dependencies are substantial. These counts help choose examples and modules, not estimate production prevalence or automation savings.
- Keep all detailed counts, G/E/X/P/N review IDs, attachment limitations and historical sources in ignored `.private/gold-product-research-2026-09-06/`. Its prior final audit is historical and pins the pre-revision plan; do not present it as verification of this revision.
- The new [durable tool catalogue](../../infor-hms/2026-09-07-corpus-driven-pms-tool-catalog.md) contains schemas, counts, source limits and future-action contracts. New evidence is retained in ignored `.private/pms-tools-replan-2026-09-07/`; `source-plan-before.md` archives the immediately previous revision. Older baseline/shadow review artifacts remain historical, not proof of this tools-first revision.
- Fresh count checks retain 420 selected records/388 physical outbounds, with 253 external/mixed candidates and 251 strict outbound candidates. Seven-family labels were recomputed from pinned annotations; 25 ambiguous/representative source records and 19 source conditions were checked. This is a bounded re-audit, not a fresh complete-source census. Family support overlaps and is not measured full-reply coverage.

### Checkout findings that shape the build

| Verified local mechanism | Existing source | Decision |
| --- | --- | --- |
| Response UI withholds values but API still emits live reply metrics | `apps/server-pilot/src/metrics/admin-dashboard-aggregates.ts`; `apps/mail/app/(routes)/settings/admin-dashboard/page.tsx` | Gate server payload, not only tiles. |
| Active-mailbox query mixes pilot/research; broad executive allowlist is not a cohort grant | `apps/server-pilot/src/trpc/routes/admin-dashboard.ts`; `src/metrics/admin-dashboard-access.ts` within that package | Resolve authorized cohort before querying. |
| Sender Date stored as receivedAt; sent import may lose IDs and collapse subject/minute | `apps/server-pilot/src/mail/ingest/parse-message.ts`; `store.ts`; `scripts/ingest-centurion-catchup-gold.ts` within that package | Read existing event/first-known provenance with explicit clock limits; feed/importer repair belongs to the user, not this plan. |
| Historical outbound/quoted text can mark a conversation responded | `apps/server-pilot/src/mail/conversation-signals.ts` | New request-specific evidence projection; no reuse as resolution truth. |
| Outbound/draft “sent” rows precede SMTP acceptance | `apps/server-pilot/src/trpc/routes/mail.ts`; `src/mail/send/outbound-queue.ts` | Preserve native acceptance vs imported observed-send evidence. |
| Shadow discards bodies; visible draft store is a different lifecycle | `apps/server-pilot/src/ai/hms-shadow.ts`; `drafts.ts`; `worker.ts` | Separate explicit private prediction/evaluation writer; keep legacy counters-only shadow unchanged. |
| Context builder can include post-trigger messages; backtest links by createdAt | `apps/server-pilot/src/ai/thread-context.ts`; `draft-backtest.ts` | Filter/freeze sources before context construction; imported order is not historical knowledge. |
| Synthetic negation mismatch scored full word overlap; missing-rate bracket scored full coverage; zero-label evaluator passed | `apps/server-pilot/src/ai/draft-backtest.ts`; `eval-runner.ts` | Characterization tests, task/fact rubric and unavailable-quality gate. |
| Current quote is incomplete; listed documents are not downloadable bytes; active releases cannot be inferred from static registry | `apps/server-pilot/src/hms/quote-stay-candidate.ts`; `active-read-runtime.ts`; `apps/server-pilot/src/ai/candidate-draft-agent.ts` | Build independently callable rich reads and expand the portfolio; preserve per-field unknowns and prove all-night/byte capabilities before claiming them. |

Earlier synthetic checks used fake inputs and are historical evidence. The earlier product revision performed local source/count checks and primary-doc research, not application tests. September deployed flags, live mailbox completeness, current PMS reliability, staff performance and economic outcomes remain unverified.

### Primary evidence and limits

| Source | Decision supported | Limit |
| --- | --- | --- |
| [Microsoft mail-flow reports](https://learn.microsoft.com/en-us/exchange/monitoring/mail-flow-reports/mail-flow-reports) | General email traffic/activity reporting is useful independently of AI | Reports have exclusions; volume is not commercial value or staff productivity. |
| [ONS line charts](https://service-manual.ons.gov.uk/data-visualisation/chart-types/line-chart) and [bar charts](https://service-manual.ons.gov.uk/data-visualisation/chart-types/bar-charts) | Trends, category comparisons, meaningful gaps, readable labels | Design guidance, not hotel performance evidence. |
| [Zendesk first reply](https://support.zendesk.com/hc/en-us/articles/4408821871642-Understanding-ticket-reply-time) and [duration metrics](https://support.zendesk.com/hc/en-us/articles/4408834848154-About-native-Support-time-duration-metrics) | Separate first reply, resolution, event clocks and incomplete pairs | Nava is not a ticket store; useful answer and off-email completion need their own evidence. |
| [RFC 5322](https://www.rfc-editor.org/rfc/rfc5322.html) | Original IDs/reply headers and timestamp basis matter | Sender Date is not receipt/delivery; this plan does not repair ingestion. |
| [Infor Hotel Availability](https://docs.infor.com/hms/2026.08/en-us/hmsolh/jxo1557688477063.html) and [CRS](https://docs.infor.com/hms/2026.08/en-us/hmsolh/s_t1424428583967.html) | Rich read candidate fields; distinguish inert search from creation/hold | CRS Check Availability creates a record; Shop by Day ignores restrictions; current complete quote unproved. |
| [Infor invoice view](https://docs.infor.com/hms/2026.08/en-us/hmsolh/s_t1424428580083.html) and [generation](https://docs.infor.com/hms/2026.08/en-us/hmsolh/s_t1424428579864.html) | Separate metadata/bytes/generation/finalization | Print count and financial/fiscal state can change; current role/byte route unproved. |
| [Writing tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents) | Bounded rich resource tools, concise/detail output, pagination and actionable errors | Exact best granularity is task-specific, not a universal rule. |
| [MCP tool schema guidance](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) | Closed inputs/outputs, access control, timeouts/audits | Design reference only; no MCP production integration and read-only annotations are not enforcement. |
| [FActScore](https://aclanthology.org/2023.emnlp-main.741/) and [judge study](https://arxiv.org/abs/2306.05685) | Later fact checking/calibration, not wording imitation | Not hotel-accuracy guarantees; all-ask/action checks remain necessary. |
| [Point-in-time joins](https://docs.feast.dev/getting-started/concepts/point-in-time-joins) and [Playwright locators](https://playwright.dev/docs/locators) | Causal evaluation and repeatable tested browser reads | No Feast/new browser framework; current PMS facts cannot substitute missing historical state. |

Research used three independent bounded tracks, root dashboard/code work and ordinary domain-filtered Exa searches. Exa basic/fetch were unavailable; advanced auto and public-page fetching supplied the fallback. No Exa Agent ran. The [tool catalogue](../../infor-hms/2026-09-07-corpus-driven-pms-tool-catalog.md) links 53-source Infor evidence, exact counts and counterexamples. Documentation is not current role, transport or activation proof.

---

## Planning Contract

### Alternatives and recommendation

| Approach | Pros | Cons / risks | Decision |
| --- | --- | --- | --- |
| Dashboard, then concrete read tools, then drafting/evaluation | Immediate client value; tools are testable independently and useful across reply families | Capability proof and typed contracts require careful work | Recommended; matches the user's priority and corpus evidence. |
| Master drafting agent/private evaluation first | Finds end-to-end language failures early | Delays the facts/bytes the agent needs and repeats the rejected priority | Defer until the read milestone. |
| Dashboard only | Fast general business visibility | Does not deliver the requested toolkit | First slice, not the whole plan. |
| Many tiny getters or one unrestricted everything-tool | Tiny calls are narrow; a giant result looks convenient | Call/coordination overhead versus excessive context, disclosure and failure coupling | Bounded rich resource reads, composed from guarded internal primitives. |
| Full ownership platform, new staff study or separate pilot | Could answer later workflow/economic questions | Not needed for this build; study explicitly rejected | Excluded. |

### KTD1. Metric truth precedes presentation

Every metric carries unit, cohort, window, observation cutoff, source vintage, timestamp basis, denominator/exclusions and availability reason. Mutable folder/spam/trash membership also carries `classificationAsOf` and snapshot basis, distinct from the mail-event window. Values are observed, estimated or unavailable; unknown is never zero. An unavailable server field must not leak an attractive numeric fallback through export or another client.

Default client scope is Centurion, display timezone Africa/Johannesburg, with 7-day and 28-day windows limited to available coverage. Keep PMBOBO research behind an operator-only cohort grant. Authorize aggregate, drilldown and export separately; aggregate access does not grant raw-mail access.

### KTD2. Prospective start and honest clocks, not ingestion repair

U12 supplies server-owned mailbox configuration with `measurementStartAt` (T0), capture-assumption basis, configuration version and any explicitly confirmed gap intervals. Use the user's repaired two-way feed as the working assumption after T0. Resolve T0 from the actual feed-change record/configuration; do not invent it from today's date or the earliest stored message. If it is absent, show observed traffic and valid historical paired intervals, but no population unanswered rate.

New qualifying external requests starting at or after T0 can contribute response metrics without a complete old sent archive. A pre-T0 unresolved request or its follow-up stays in a separate pre-period/unknown-start backlog. A supported new ask in an old thread may enter the new-request cohort. All contributing arrivals, responses, links and classifications are bounded by the observation cutoff.

Use trusted source receipt/send event times when available. The current parser stores RFC Date as `receivedAt`; intervals using that field are labelled sender-timestamp estimates, not certified receipt/handling time. Invalid, reversed, future or missing clocks contribute to unscorable counts. Import/`createdAt` is an availability clock, never a substitute historical event time.

Show eligible requests, valid answered durations, still-waiting counts/ages, unknowns and the assumed-capture-since date together. A historical valid pair can support a descriptive interval without proving the historical unanswered denominator. Confirmed capture gaps affect their intervals; diagnostic warnings alone do not certify an outage or suppress unrelated traffic charts.

Read existing canonical IDs, reply headers, message/source observations and existing thread-link evidence. Do not change importer identity, rethread mail, introduce source manifests/capture-cycle records or repair Exchange/VPN/polling in this plan. Report a demonstrated feed defect to its owner and continue independent work. Bounded analytics can restate a report after late data, with a new source vintage/cutoff; no backfill-as-today activity or historical shadow generation.

### KTD3. Outstanding communication and unfinished work are different

First expose a narrow observed first-reply measure for qualifying new conversations after T0. Label it as such; a thread-level first reply is not proof that every ask was answered. U2 later adds a versioned request/ask projection, using the existing ledger and the approved model adapter, without becoming an ownership system or blocking initial tool development.

For each supported ask retain `replyState` (`awaiting_hotel`, `awaiting_customer`, `answered`, `no_reply_required`, `unknown`) separately from `workState` (`open`, `partially_complete`, `complete`, `not_required`, `unknown`). A clarification may move the next turn to the customer while work stays open. An acknowledgment or promised action cannot mark work complete. `not_required` means no separate work obligation was identified; it is not evidence of an action being completed.

Derive one primary display bucket per request, applying the following rows in order across its current asks. Keep the per-ask states so a primary bucket never erases other obligations.

| Precedence | Evidence at cutoff | Primary bucket |
| --- | --- | --- |
| 1 | Any supported ask awaits a hotel response | Awaiting hotel reply |
| 2 | Otherwise, any ask needs specific customer information | Awaiting customer information |
| 3 | Otherwise, any hotel work remains open/partly complete | Hotel action pending — completion not observed |
| 4 | Otherwise, any reply/work state or request boundary is unknown | Unknown |
| 5 | Otherwise, at least one requested answer is supported and all asks/work are complete or not required | Answered |
| 6 | Otherwise, all items explicitly require no response and no open work remains | No reply required |

`Partly answered` is an overlapping badge/filter, not a seventh additive bucket: at least one current ask has a supported answer and another remains unresolved. Unknown-evidence is also a badge when a known pending ask gives the primary bucket. Primary bucket totals are exclusive; ask counts, partial badges and open-work totals are separate denominators. A mixed answered-plus-unknown request stays Unknown, not Answered.

“Awaiting hotel reply” means an external ask needs a hotel response and no sufficient answer or specific clarification to that ask has been observed by cutoff. “Hotel action pending” means supported open/partly complete hotel work with no higher-priority known communication turn; it does not prove a reply occurred. If reply evidence is unknown, retain the Unknown-evidence badge. An action may have happened off-email; absence of evidence is not proof that staff did nothing. Remaining asks, source spans, interpretation version and unknowns support every classified state.

Scoped headers plus request evidence support linking; weak subject/participant links remain candidates. Old replies, internal forwards, automated acknowledgments and quoted history do not prove a current ask answered. One response may address several asks; partial answers preserve the remainder. Follow-ups do not reset the original wait; a genuinely new ask gets a new start. Folder/read/archive state and existing ever-replied flags are not closure evidence.

Answered-only durations, still-waiting ages, pre-period/unknown-start backlog and unscorable cases have separate denominators. Persist compact semantic facts; no body scans or LLM work on dashboard GET. Unknown model/linkage evidence produces Unknown, not a fabricated state. Service summaries describe observed email, not all hotel work.

The initial U10 cohort is newly observed external-human-started conversations after T0 with a supported start, direction/author classification and scoped reply link. Pre-T0 messages/references or quoted prior exchange exclude a presumed new start; uncertain start/automated-versus-human cases are counted separately. Use existing header/source/triage evidence, not a new semantic model prerequisite. Its measure is explicitly first observed human reply, not first useful reply or an unanswered-request rate. U2's later first useful reply is the first source-supported answer or necessary ask-specific clarification; a generic acknowledgment is excluded, and partial usefulness never means all asks/work finished.

### KTD4. General executive email dashboard

| Question | Show | Gate / wording |
| --- | --- | --- |
| Is communication demand growing? | Incoming/outgoing daily line chart; totals; comparable previous-window change | Messages, not bookings or staff effort; do not compare unequal capture windows. |
| How much conversation activity is there? | Active conversations; newly observed versus continuing; distinct external sender addresses | Addresses are not people; observed start is not necessarily first-ever contact. |
| When is it busy? | Day-of-week and hour-of-day arrival bars in Africa/Johannesburg | Arrival pattern, not staffing utilization. |
| What business work dominates? | Horizontal bars using the existing eleven workflow folders, plus explicit unclassified/legacy bucket | Unique conversations active in period, grouped by the currently observed primary folder; show classificationAsOf. Historical membership is unavailable without a retained matching snapshot. |
| Who generates correspondence? | Top external domains/known partners; public email providers grouped | Domain is not verified company identity or commercial value; aggregate access only by default. |
| What needs attention? | Awaiting hotel/customer, hotel action pending, partial and unknown counts; age bands and repeat follow-ups | Named request-state contract; off-email work may be missing. |
| How quickly do we reply? | First observed human reply and later first useful reply; answered-only median/p90/distribution beside waiting counts/ages | New-request T0 cohort, valid links/clocks, classification coverage; calendar elapsed time, not labor. |
| Are there data warning signs? | Last observed incoming/outgoing, direction-count trend, singleton share and singleton quoted-mailbox-reply share | Compact diagnostics, not a feed monitor or completeness certificate. |

Reuse Bookings, Groups & Events, Manage Existing Stay, Confirm & Reconcile, Money & Billing, Documents & Delivery, Exceptions & Recovery, Guest Experience, Internal & Partner Ops, Automated / Channel, and Unknown / Needs Review. Urgent is an overlay, not a twelfth exclusive category. Do not replace these with the earlier coarse six-category explanation, silently retag mail, or double-count conversations with multiple primary labels. Folder describes work type; request state describes what is waiting; tool demand describes needed facts/actions.

The first useful slice contains traffic, activity, folder and correspondent views plus definitions/diagnostics. Service enrichment follows its evidence gates; it is not a hidden prerequisite for the read-tool milestone. Nava quality, tool failures and model/browser cost belong in the separate operator view. Requested stay lead times, room-nights or commercial attribution need checked extraction/linkage and are not promised from raw email in this first screen.

Use calendar elapsed hours by default. Business-hours clocks and target attainment remain unavailable until actual staffing/holiday/service rules are approved. Optional 24h/48h age bands are diagnostics, never implicit hotel SLAs. Acknowledgment and substantive response remain separate even when an acknowledgment meets a target.

Revenue tiles remain unavailable. Quoted value is not revenue, no email is not a lost booking, and exact booking associations would still not establish incremental AI revenue. Correct the earlier one-third-loss interpretation in the client-facing reporting notes before reusing it.

### KTD5. Private shadow lifecycle

~~~mermaid
flowchart TB
  M[Scoped mail and source coverage] --> B[Passive client baseline]
  M --> E[Eligible new request]
  E --> S[Freeze inputs and seal private draft]
  S --> T[Typed facts, asks, limitations and tool evidence]
  O[Later observed outbound and attachments] --> J[Scoped delayed matching]
  T --> J
  J --> Q[Versioned factual and task evaluation]
  Q --> I[Internal quality and cost view]
  Q --> R[Reviewed defect, fixture and guarded repair]
  R --> E
~~~

Reuse the existing run ledger, leases, idempotency, lanes and private storage. Add one narrow prediction/evaluation store with immutable predictions and append-only assessment revisions. Keep bodies out of generic run metrics. Preserve the old counters-only HMS shadow; do not weaken it or insert hidden candidates into the visible draft store.

Admission key binds mailbox + request/trigger version + context hash + model/prompt/playbook/tool release version. A retry reuses the same generation; a deliberate new experiment gets a new version. Record eligible, admitted and skipped counts before applying budgets. Start with thread/approved-policy modules and already-proven entitled reads.

~~~mermaid
sequenceDiagram
  participant Mail
  participant Worker
  participant Private as Private evaluation store
  participant Human as Usual staff workflow
  Mail->>Worker: New inbound with source provenance
  Worker->>Worker: Freeze allowed input; generate under read-only limits
  Worker->>Private: Seal prediction, evidence, versions and time
  Human->>Mail: Independently authored later reply
  Mail->>Private: Match reference and append assessment
  Note over Worker,Human: No shadow display, send, draft replacement or work closure
~~~

Historical replay uses only facts valid and available by its historical horizon. Exclude target reply, later messages, later attachment/policy versions and current PMS state. Missing historical PMS facts stay unscorable or the replay becomes thread-only. Prospective tool evidence may arrive after mail snapshot but before sealing; retain each observation/expiry time.

A late-imported human reply may already predate prediction: mark late prediction. If new instructions, payment posting or booking changes explain a difference, mark changed state rather than asserting the AI was wrong/right. Scoring can change with corrected linkage; the original prediction never changes.

~~~mermaid
stateDiagram-v2
  [*] --> Pending
  Pending --> Matched: verified same-request reference
  Pending --> Ambiguous: competing or weak link
  Pending --> Unobserved: covered observation window ends
  Pending --> UnknownCoverage: sent gap
  Matched --> Assessed: facts and rubric available
  Matched --> StateChanged: later facts explain difference
  Matched --> Unscorable: missing evidence
  Assessed --> RevisedAssessment: corrected evidence or rubric version
~~~

Pending, unobserved, ambiguous, late, changed-state and unscorable counts remain visible. Missing human reply is not a model failure; poor match coverage cannot be hidden behind high quality on convenient pairs.

### KTD6. Judge answers against facts, not imitation

| Dimension | Primary check | Anti-gaming rule |
| --- | --- | --- |
| Task coverage | Required asks answered, justified clarification/pending action, all-ask completion | Fact-free acknowledgments cannot score full completion. |
| Material facts | Names/refs, dates, amounts/currency/tax basis, policy, availability and document facts supported and correct | Preserve negation; brackets/missing slots are missing facts. |
| Action/recipient safety | No invented completion, wrong guest/property, unauthorized disclosure or unproven attachment | Critical errors reported separately; average scores cannot cancel them. |
| Tool correctness | Correct scoped fields, parser/surface/role proof, fresh evidence, valid not-found control | Tool/HTTP success is not business correctness. |
| Operational yield | Eligible → admitted → generated → sealed in time → matched → assessed | Include failures, budget skips, abstentions and missing evidence. |
| Comparator result | AI better/equivalent/worse/both wrong/not comparable | Human reply is fallible evidence, not automatic truth. |

Levenshtein and semantic similarity may help identify wording differences or review candidates. They are not primary correctness, adoption, labor or revenue metrics. Only a known adopted revision can yield an edit-distance diagnostic; an independently written Outlook reply is not an “edit” of a hidden draft.

Start with deterministic checks and a restricted review queue. An optional approved-route judge produces evidence-linked structured verdicts and “cannot determine”; pin its model/rubric, blind author identity, randomize order and mirror a subset. Calibrate against reviewer-adjudicated cases, including agreements, disagreements and every serious safety flag. Record reviewer independence and label provenance. A second LLM is not an independent source of hotel truth.

Quality is unavailable if outputs/references/labels are absent, duplicated, mismatched or insufficient for that rubric dimension. Publish counts and uncertainty per intent/source; do not claim population accuracy from a selected corpus or sparse correlated observations.

### KTD7. Tools first, bounded rich facts and guarded repair

Use the [tool catalogue](../../infor-hms/2026-09-07-corpus-driven-pms-tool-catalog.md) as the interface/source contract. A typed read service plus existing drivers/harness is sufficient; do not create a new framework or require the drafting agent to test a tool. Keep browser primitives private and each internal request's authorization distinct.

| Read family | Selected external/mixed support, n=253 | Priority reason | Build boundary |
| --- | ---: | --- | --- |
| Reservation lookup/context | 111 | Identity and current stay facts support many other reads | Exact lookup then separately entitled rich context |
| Existing documents | 136 | Largest family; correct bytes/identity/version matter | Mail/approved sources first; PMS metadata versus inert bytes separate |
| Folio/deposits | 28 | High-consequence financial claims; +7 touches after reservation/documents | Unknown is not zero/paid; bounded ledger sections |
| Availability/rates | 42 | +19 touches after preceding families | Every night/occupancy/tax/restriction checked; no hold |
| Group/event context | 53 | Needed depth despite +2 final marginal touches | Distinguish HMS groups from SCS/events; each section proved |
| Mail artifacts | 122 | Existing documents and input facts already in the mailbox | Non-PMS bounded authorized reader, not another 122 complete replies |
| Approved property knowledge | 70 | Policies/amenities/conditions are not all PMS facts | Small owner/version/effective-date reader |

Counts overlap and reflect retained manual labels. Reservation+documents touch 164/253; the five PMS/mixed-source families touch 192/253, but only 49 records have all their annotated tool labels inside that bundle. Complete reply/action coverage is unmeasured. The strict outbound subset is 251, with 41 rate labels and a 191-record five-family union. Do not label 136 as HMS invoice retrievals: only 78 primarily concern reservation/folio/final-tax documents, and even their exclusive source is unproved.

Common read outputs have concrete per-tool data, field-level known/unknown/source/time, section outcomes, bounded pagination and safe error reasons. Model-supplied routing uses opaque scoped references, not raw record IDs/URLs/credentials/selectors; an authorized confirmation number may still be returned as a business fact. Finance/company/notes/bytes have separate disclosure boundaries. Partial factual help is useful independently of whole-draft readiness; retain conservative predecessor adapters and new release fingerprints for changed schemas.

User states the tool objective → coding agent researches and explores safely → agent implements and tests → agent fixes failures → agent establishes fresh capability proof/release → user receives results and private trace videos for review afterward.

For existing failures, the agent owns the shorter loop: classify cause → restricted repro → synthetic fixture → guarded repair → negative/known-positive tests → fresh proof → compare versions. This is not a request for the founder to write or debug tools.

Permit coding-time exploration using existing view-only credentials and public docs. Retain code-owned runtime actions, requester/record-specific entitlement, tenant-scoped session, allowlisted observed transport, audited captures, durable budgets, expiry and cleanup. A parser returning empty is not a proven absence without valid scope/paging/date window and a positive control.

No hot patch under an old release fingerprint. No automatic repair promotion from a judge score. Prioritize wrong-record/unsupported-field errors before cosmetic wording. An unavailable tool yields a partial or manual path, not broader permissions. Hand off private trace/video locations, tested scenarios, read-only proof, limitations and artifact expiry; exclude credential-entry/secrets from shareable evidence. User review afterward is not a routine prerequisite to coding/testing. Raw trace retention is unchanged; keep the minimum typed evidence needed for delayed comparison under approved evaluation retention.

### KTD7a. Phase 2/B real-email capability validation gate

Phase 3 may consume or promote a read capability only after this gate passes for that capability. A capability can be independently proved on authorized current controls even when the selected corpus has no eligible gold case; conversely, a gold-shaped example never proves a capability that was not independently exercised.

- **Pinned cases and freeze:** Start from the private pinned selected-corpus manifest: **420 distinct selected records**, not 420 clean human-reply pairs; the strict external outbound candidate subset is **251**. A case is eligible only after verified same-request identity, legitimate inbound-before-gold horizon and required source/permission evidence. Before any result is available, freeze private case identifiers, selection/skip reasons, selection hash and development-versus-held-out membership by conversation. Do not turn an ineligible or ambiguous record into a pair.
- **Blind tool input:** Only pre-reply legitimate request context may supply tool input. The target human outbound/gold is evaluator-only: it is not prompt context, a tool input, candidate key, reference-resolution input or implementation fixture that claims blindness. If a reservation/reference appears only in gold because it was created or identified after inbound, do not use it to build a current-state tool input or candidate; record missing pre-reply identifier/unsupported lookup. Missing original inbound, linkage, source or permission is explicitly `not-runnable`/`unscorable`, never an invented pair, zero-as-pass or silent exclusion.
- **Bounded normal proof:** Use exact recorded membership and counts with representative per-capability cases, skip reasons and partial coverage; never claim all 420 records are testable. Run every proposed released capability through the actual normal trusted audited read executor/proof harness **without a drafting model**. Current-state comparison uses an independently checked authorized source, never only this parser, a second parser or a second LLM; gold is fallible corroboration and historical scoring requires same-time/version semantics. Preserve requester/mailbox/property grants, opaque refs minted by trusted context, known-positive/negative/ambiguity controls, locking, firewall, captures, expiry and read budgets. Email content never authorizes raw IDs, URLs or arbitrary browsing. Do not perform an exhaustive live sweep or invent a statistical quota.
- **Mode-specific pass rules:** Persist `evaluationMode` on every case, runtime comparison receipt and report; aggregate and release-guard only within the same mode, never across current-state, historical-replay and future-shadow scores. `changed_state`, `unscorable`, `ambiguous`, `denied`, `missing_capability`, `not-runnable` and absent-gold cases never count toward a gold/historical pass. A current-source match cannot become a historical pass. Any unexplained material mismatch blocks the affected capability release pending root cause, repair, retest and new-release reproof.
- **Holdout isolation:** While a case is labelled held-out/unseen, its outcome cannot inform tuning, repair hypotheses, fixture choice or retries. Once unsealed or used for repair, retire it to development/regression, preserve the original score and exposure record, and require fresh disjoint unseen evidence for a fresh accuracy claim. Prior exposure means previously inspected gold is not magically unseen.

Keep these evaluation modes separate:

| Mode | Permitted comparison | Boundary |
| --- | --- | --- |
| Current-state real record | Returned fields/bytes versus an independently checked current authorized PMS/document source; historical human outbound corroborates only when same time, version and semantics are proven | Reservation, payment and status may have changed, or a booking may have been created after inbound; price-only comparison is insufficient and historic outbound is not sole truth |
| Historical replay | Only facts valid and available at the historical horizon | Never use today’s PMS state, target reply or future email/attachment/policy; missing snapshots yield thread-only or `unscorable` |
| Future shadow | Generate and seal before the later staff reply, then use the existing unchanged fresh-sample gates | No staff display, draft mutation, folder/read-state change, send or business write |

Record field-level `match`, `mismatch`, `changed_state`, `ambiguous`, `unscorable`, `denied` and `missing_capability` outcomes with actual input/output/source/version/time and private trace/video receipts. No unsupported pass is emitted. A true tool mistake creates a synthetic regression, guarded fix and new-release proof. A missing eligible gold example is a coverage gap, not a capability pass. Missing external proof blocks that capability's Phase 3 use/live claim, not the dashboard, independently useful work or framework coding.

Reuse U1/U8/U11 and the relevant U9/U17/U7/U15/U16 read units. U5 dependencies and the Phase B→C release verification, Verification Contract and DoD consume this per-capability disposition; U13/U6 cannot use an unvalidated read. Reuse the [known-positive/negative live-result gate](../../solutions/conventions/live-negative-result-verification-gate.md), [as-of/source/manifest drift safeguards](../../solutions/logic-errors/centurion-triage-audit-createdat-vs-finishedat-spam-at.md) and [pilot-RDS test prohibition](../../solutions/database-issues/vitest-production-pilot-db-wipe.md); their historical counts/window details do not replace the canonical 420/253/251 counts or current tool bounds. Do not create a broad evaluation framework, commit raw corpus data or place raw corpus data in public fixtures; synthetic regression fixtures remain permitted. Do not run a pilot-RDS test runner. Existing ≥30 fresh cases, ≥5 per family, ≥90% overall and within each family, and zero-critical launch gates remain unchanged.

### KTD8. Narrow visible assistance

After shadow gates, offer the current pilot only supported reply families through the existing editor. Do not auto-promote a historical shadow draft: regenerate/revalidate current context, entitlement, evidence and recipient scope. All new visible generation and refresh entry points explicitly inject U5's approved adapter, as do extraction/shadow/judging; missing route refuses before generic factory fallback or any model network call.

Guest text and staff-only evidence/blockers are distinct. Modules cover clarification, acknowledgments, approved information, supported reservation/finance/quote/document answers and group/internal briefs. Read-backed families consume only released fields and exact authorized bytes. Business writes remain deferred: no booking creation, payment settlement, completed cancellation or attachment without the corresponding actual evidence.

Separate source-context version, evidence/policy version and editable draft revision. Explicit refresh allocates a fenced generation; retries reuse it. Preserve active human text on refresh/failure. Stale edited text shows what changed and a Review updated evidence action: refresh only affected evidence, keep the body editable, then explicitly approve the current body/recipients/attachments/evidence together. Never route AI-bound invalidation through the existing Send anyway override. If revalidation is unavailable, retain the draft and offer the normal manual path without silently approving stale AI claims.

Validate the approved payload, current entitlement and relevant evidence at enqueue and immediately before every actual SMTP transmission, including retry after confirmed zero acceptance. Finalizing a persisted accepted outcome is not a new transmission and must not cause resend. Unknown outcomes go to reconciliation. Plain manual mail remains available.

### KTD9. Existing pilot without a task study

The dashboard and read-tool milestone do not require daily Nava use. Later private evaluation can run between visits; visible assistance stays optional in the current mail workflow. Do not create a second pilot, timer, randomized task assignment or foreground-effort telemetry.

Keep operational counts, tool correctness, failure/abstention rates, model/browser cost and documented maintenance effort in the internal view. These explain capability and running cost, not labor saved or hotel-wide ROI. No effort-saving number is emitted without separately authorized future evidence. The selected sent examples guide tool design; prospective inbound-first evaluation later checks missing/never-replied cases rather than assuming sent-only demand represents every incoming request.

### KTD10. UI, defaults and operating bounds

- Reuse the existing Recharts/admin dashboard, Geist/theme and responsive navigation. Top controls: Centurion cohort, 7/28-day window, observation cutoff and compact data note. Lead with traffic, then business breakdowns, then conditional service panels; no prime-screen AI/revenue placeholder mosaic.
- Use line charts for time trends, zero-baseline horizontal bars for category comparisons, and numbers for totals/medians. Limit competing series, keep labels readable and provide keyboard-accessible definitions/data tables. Reuse folder presentation colors, not a new taxonomy or design system.
- Unknown historical capture days are gaps; assumed-covered no-arrival days after T0 may be zero with the assumption disclosed. Confirmed gaps remain visible. Loading, stale, unavailable, empty and error are different states; no demo fallback. Previous-period deltas require comparable intervals.
- The folder chart counts unique active conversations using the current observed folder snapshot, labelled with classificationAsOf separately from the activity window. Resolve multiple/unmapped labels into an explicit ambiguity/legacy bucket. Urgent is an overlay. It is not a history of arrival classifications.
- A metric opens its definition, denominator, exclusions and evidence basis. Raw-message drilldown requires separate mailbox access; executive aggregate access does not grant it. Authorized mailbox switching must synchronize connection/cache scope before navigation. Cache keys bind cohort/window/cutoff/report version/viewer scope.
- Lean data diagnostics are last-observed incoming/outgoing, direction counts/ratio, singleton share, and singleton-with-quoted-mailbox-reply/no-matching-outbound share. Quotes stay private. Newsletter volume, one reply covering several messages and forwards/thread fragmentation are counterexamples; no universal imbalance threshold or automatic outage claim.
- Later internal scorecard stays in the operator/admin surface with separate permission, compact counts/error families and restricted evidence/export. No annotation SaaS. Visible assistance preserves active edits and shows ready/partial/stale/failed with a manual path.
- Preserve keyboard focus, mobile back behavior and touch targets of at least 44px; status is not color-only and refresh never steals focus. Charts expose values without requiring a pointer.
- Reuse property-serialized browser lanes, deadlines and durable read budgets. Rich read packs do not grant extra reads or concurrent PMS sessions. New read caps default no higher than existing limits; evidence sections are requested explicitly and paginated.
- Later costly model work requires explicit per-property/day admission, token/spend and browser caps; unset caps disable live admission. Proposed initial shadow cap: 100 episodes/day and at most one browser read in flight per property. Record sampling/skips; prioritize interactive work. No model call on dashboard GET.
- Typed evidence and private predictions use approved storage/retention. Proposed evaluation retention is 30 days after sealing, subject to existing policy and earlier mailbox deletion; raw captures retain their shorter existing expiry. No indefinite archive.

### Assumptions and later inputs

| Item | Decision now | Scoped runtime gate |
| --- | --- | --- |
| Two-way capture | User is repairing the feed; assume correctness from recorded T0 | Resolve the actual mailbox start/basis; absent T0 leaves prospective denominators unavailable, not charts or tools blocked |
| Cohort | Centurion client; PMBOBO operator-only research | Server-owned mailbox/property/viewer grants |
| Service clock | Calendar elapsed time; sender-date approximation where necessary | Valid event pair; real staffing/holiday/target approval before business-hours or target claims |
| PMS | Extend existing guarded browser/same-origin reads | Current role, version, surface, field visibility, positive/negative controls and release proof per capability |
| Existing documents | Prefer already-stored authorized bytes; PMS bytes only on proven read path | Exact document/version/recipient/price-visibility binding; list or print is not retrieval proof |
| Property knowledge | Read approved versioned material; do not mine old replies into policy | Responsible owner/effective date and authorized disclosure; missing approval stays unavailable |
| Model processing | Approved route only; tools and initial dashboard do not need a drafting model | Concrete adapter, worker egress and retention before semantic extraction/drafting/judging |
| Commercial value | Descriptive email/capability/cost metrics | No staff study, minutes saved, bookings-won or causal revenue claim in this pass |

These are capability/data gates, not routine architecture questions for the founder. Build/test safe independent portions, exhaust authorized read-only alternatives, then report a precise unavailable capability when external authority is genuinely missing.

---

## Implementation Units

Existing U-IDs keep their concepts. U3/U4 remain deferred; U14 is removed. U7/U9 are reactivated as read-only work; U15/U16/U17 add scoped context, knowledge and finance delivery. Order is priority/dependency order, not renumbering. A blocked source does not stop another safe source or tool.

| Unit | Focus | Primary files | Depends on |
| --- | --- | --- | --- |
| U1 | Safe fixture and test entry | gate script; synthetic fixtures | None |
| U10 | Executive email dashboard | dashboard aggregate/route/types/page | U1; U12 for prospective slice |
| U12 | T0 and lean diagnostics | measurement config; data health | U1 |
| U8 | Independent reads and reservation context | read service; runtime; reservation driver | U1; initial U10/U12 slice |
| U9 | Existing documents/mail artifacts | existing-document service; artifact/communications drivers | U8 |
| U17 | Finance/deposit facts | folio contract/driver/completeness | U8 |
| U7 | All-night availability/rates | quote normalization/contract/driver | U8 |
| U15 | Company/group/event/notes context | existing context drivers; notes contract | U8; U9/U17 only for requested sections |
| U16 | Approved property knowledge | versioned knowledge contract/reader | U1; U8/U9 shared interfaces as needed |
| U5 | Later safe drafting/model route | playbooks; prepared inputs; approved adapter | U1 and read milestone |
| U2 | Ask-aware service enrichment | baseline extractor/projection/repository | U12/U5 |
| U13 | Private predictions/scorecard | shadow store; matcher; scorer | U2/U5; relevant read releases |
| U6 | Human-reviewed visible drafts | editor; draft approval; outbox | U5/U13; relevant read releases |
| U11 | Slice release/runbook | fixture journeys; safe gates; runbook | Units in released slice |

### U1. Reproducible evidence and safe test entry point

- **Goal:** provide synthetic dashboard/tool fixtures and safe scoped test execution; later evaluation fixtures must not delay the first dashboard.
- **Requirements:** R1/R6/R11/R12; AE8/AE15.
- **Dependencies:** none.
- **Files:** create `apps/server-pilot/scripts/reservation-pilot-gate.sh`, `apps/server-pilot/tests/reservation-pilot-gate.test.ts`, `apps/server-pilot/tests/fixtures/reservation-tools-pilot.json`; existing `apps/server-pilot/tests/draft-backtest-scorer.test.ts`, `apps/server-pilot/tests/ai-eval-runner.test.ts` and `apps/server-pilot/tests/ai-triage-input.test.ts` are extended with U5/U13, not an initial dashboard prerequisite.
- **Interfaces:** gate modes `unit`, `db`, `browser`, `build`, each with a named slice; fixture manifest identifies synthetic data, source/hash versions, expected facts and rejected operations. Unit mode has no DB; required DB mode refuses absent/production-looking connections and never silently skips.
- **Approach:** preserve the selected-corpus count/mapping hashes and development/holdout membership. U1 owns the private Phase 2/B case manifest and mode/holdout contract: it freezes case identifiers, `evaluationMode`, selection and skip reasons before any result and keeps development/holdout membership by conversation; gold targets never enter tool input or blind implementation fixtures. Initial fixtures cover traffic/cohort/T0, ambiguous reservations, partial reads, wrong documents, folio/deposit differences and prohibited browser effects. Add shadow/negation/zero-label fixtures with their later units. The later inbound-first unseen set is sampled independently of reply existence; target 200 episodes for later triage promotion, not a tool-build gate or a statistical guarantee.
- **Patterns:** existing pure aggregate/eval tests and pilot-DB refusal. Local private references never copied into public fixtures.
- **Execution note:** characterization first, then failing behavioral tests.
- **Test scenarios:** production-looking or absent required DB is refused; required suite cannot skip green; forbidden external sockets fail fixture mode; private corpus paths cannot leak into public fixtures; Phase 2/B freeze prevents target leakage and preserves conversation-level development/holdout membership; missing inbound/link/source/permission is explicit `not-runnable`/`unscorable`; a held-out outcome cannot tune, repair, choose fixtures or retry; unsealing retires it to development/regression while preserving the original score/exposure; later holdout selection excludes target/future context and is not restricted to replied cases.
- **Verification:** run the gate's refusal tests with no ambient DB/model/browser credentials; expected refusal before any connection. Unit slices use synthetic data. DB mode verifies a disposable owned target and cleans only its exact owned resources; browser mode uses loopback fixture services and fake transports.

### U10. Executive email dashboard first

- **Goal:** useful first client release for email/business operations, independent of the drafting agent and complete old sent history.
- **Requirements:** R8/R11/R13/R16/R19; AE7/AE8/AE9/AE17.
- **Dependencies:** U1. U12's small configuration/diagnostics slice enables prospective first-reply fields; later U2 semantic enrichment does not block the first dashboard or tool milestone.
- **Files:** modify `apps/server-pilot/src/metrics/admin-dashboard-access.ts`, `apps/server-pilot/src/metrics/admin-dashboard-aggregates.ts`, `apps/server-pilot/src/trpc/routes/admin-dashboard.ts`, `apps/mail/lib/admin-dashboard/types.ts`, `apps/mail/hooks/use-admin-dashboard.ts`, `apps/mail/app/(routes)/settings/admin-dashboard/page.tsx`, `apps/server-pilot/tests/admin-dashboard-access.test.ts`, `apps/server-pilot/tests/admin-dashboard-metrics.test.ts`, `apps/mail/tests/admin-dashboard/response-metrics-availability.test.ts`; create `apps/server-pilot/tests/admin-dashboard-query.test.ts`, `apps/mail/tests/admin-dashboard/business-overview.test.tsx`.
- **Interfaces:** `ExecutiveDashboardQuery` carries authorized cohort, window and cutoff; `MetricResult<T>` carries value/null, unit, denominator/exclusions, timestamp/capture basis, source vintage, classificationAsOf/snapshot basis where relevant, and availability reason. Server cohort grants distinguish aggregate, mail drilldown and export. `ExecutiveDashboardPayload` contains traffic, activity, conversations, folders, correspondents, service and data-health sections; internal AI scorecard is a separately authorized response.
- **Approach:** reuse existing charts/route/theme. Show inbound/outbound daily trends, total and comparable-window change, active/newly observed conversations, sender-address count, weekday/hour arrivals, current eleven-folder mix and external-domain breakdown. Use the current observed primary-folder snapshot for active conversations, with classificationAsOf, explicit ambiguity/legacy bucket and separate Urgent overlay. Exclude spam/trash from business-work charts with counted exclusions; raw observed transport totals are labelled separately. Use existing event dates, not import dates. Existing category mutations delete old membership rows, so an earlier observation cutoff cannot reconstruct prior folders or mutable spam/trash exclusions. Serve such a classification-dependent section only from an already-retained matching snapshot; otherwise mark it unavailable, keeping raw traffic available. No category-history platform is introduced. Narrow first-observed-reply metrics only for valid post-T0 qualifying new conversations; disclose classification/unknown coverage. No invented useful-response or resolution labels.
- **Test first:** synthetic fixture with two authorized client mailboxes, one research mailbox, queued/failed/accepted/imported sends, unknown days, a known-zero post-T0 day, duplicate source copies and current folder changes. Pin exact expected totals before changing aggregation. Both directions and all joins are bounded by cutoff.
- **Test scenarios:** unauthorized cohort denied before load; research never included; same domain is not unique customer; unknown/legacy/multiple folders not double-counted; changing/clearing membership after a historical cutoff cannot substitute today's classification; mutable spam/trash exclusions obey the same snapshot gate; old backfill not today activity; unavailable response has null API/export value; post-T0 valid new-conversation pair gives duration without certifying old history; acknowledgment not all-ask resolution; known/unknown gap and invalid clock remain distinct; loading/stale/error no demo fallback; accessible chart/table/definition and mobile layout.
- **Verification:** `bash apps/server-pilot/scripts/reservation-pilot-gate.sh unit dashboard` runs scoped server/UI tests; `bash apps/server-pilot/scripts/reservation-pilot-gate.sh browser dashboard` exercises real fixture browser. Expected: exact fixture counts, authorized aggregate-only screen, no raw-body leak, zero external/model/PMS calls. API, UI and export definitions agree.

### U12. Prospective start point and lean capture diagnostics

- **Goal:** support new-request measurement and useful warning signals without implementing the user's feed repair.
- **Requirements:** R1/R8/R12/R14; AE9/AE10.
- **Dependencies:** U1; deliver with the initial U10 slice, not as a separate capture platform.
- **Files:** create `apps/server-pilot/src/metrics/mail-measurement-config.ts`, `apps/server-pilot/src/metrics/mail-data-health.ts`, `apps/server-pilot/tests/mail-measurement-config.test.ts`, `apps/server-pilot/tests/mail-data-health.test.ts`; modify `apps/server-pilot/src/env.ts`, `apps/server-pilot/tests/env.test.ts`, `apps/server-pilot/src/metrics/admin-dashboard-aggregates.ts`, `apps/server-pilot/src/trpc/routes/admin-dashboard.ts`.
- **Interfaces:** `MailboxMeasurementConfig` binds transport/cohort ID, `measurementStartAt`, capture-assumption basis, version and optional explicitly confirmed gap intervals. `MailDataHealth` exposes direction counts/last-observed times, singleton numerator/denominator, structured quoted-mailbox-reply/no-matching-outbound numerator/denominator and observation cutoff. It contains no message body or processing credentials.
- **Approach:** parse one server-only versioned configuration input, `MAIL_MEASUREMENT_CONFIG_JSON`; absent/invalid configuration fails closed for dependent metrics without breaking ordinary mail. Use existing mail/linkage/triage summaries; if quote detection needs computation, run a bounded background projection and expose unavailable until computed. Do not repeatedly scan bodies on dashboard GET. Retain canonical IDs/header references and event-versus-first-known times as analytics inputs; do not change ingest or globally rewrite mail timestamps.
- **Test first:** fixed T0 and source clocks; pre-T0 open ask, new post-T0 conversation, old-thread follow-up, invalid/reversed timestamp, healthy empty period, newsletter-heavy traffic, forward with quoted reply and a confirmed gap. Expected gates/diagnostics are explicit before implementation.
- **Test scenarios:** no T0 does not imply zero unanswered; new cohort works without old Sent completion; warning does not certify missing capture; confirmed gap affects only its interval; aliases/property scoped; native queued send not last-observed sent; header Date approximation labelled; late import restates source vintage rather than today's activity; diagnostic payload has no raw quote; no source-cycle table/importer/monitor/network polling introduced.
- **Verification:** `bash apps/server-pilot/scripts/reservation-pilot-gate.sh unit measurement` passes pure configuration/health tests with no DB/model/browser calls. Disposable-DB query tests under `bash apps/server-pilot/scripts/reservation-pilot-gate.sh db dashboard` prove authorization/cutoff and bounded access. Actual T0/feed basis is checked read-only during authorized activation, not invented in fixtures.

### U8. Independent read service and reservation context

- **Goal:** make real typed reads usable without a drafting model, then extend exact lookup to a useful resolved-reservation snapshot.
- **Requirements:** R5/R6/R11/R12/R17; AE8/AE14/AE18.
- **Dependencies:** U1 and the initial useful U10/U12 slice. No U5/U13 dependency; no historical-capture certification gate. Phase 2/B validation is required before any Phase 3 consumer promotes a read capability.
- **Files:** create `apps/server-pilot/src/hms/read-service-contracts.ts`, `apps/server-pilot/src/hms/read-service.ts`, `apps/server-pilot/src/hms/agent-read-tools.ts`, `apps/server-pilot/src/hms/reservation-context-contract.ts`, `apps/server-pilot/src/hms/reservation-context-facade.ts`, `apps/server-pilot/src/hms/live-reservation-context-driver.ts`, `apps/server-pilot/scripts/hms-read-tool-harness.ts`, `apps/server-pilot/tests/hms-read-service.test.ts`, `apps/server-pilot/tests/hms-normal-runtime-read-service.test.ts`, `apps/server-pilot/tests/hms-reservation-context.test.ts`, `apps/server-pilot/src/hms/property-read-lock.ts`, `apps/server-pilot/tests/hms-property-read-lock.test.ts`, `apps/server-pilot/drizzle/0023_read_tool_runs.sql`; modify `apps/server-pilot/src/hms/read-tools.ts`, `apps/server-pilot/src/hms/read-handler-index.ts`, `apps/server-pilot/src/hms/requester-authorization.ts`, `apps/server-pilot/src/hms/candidate-graph.ts`, `apps/server-pilot/src/hms/active-read-runtime.ts`, `apps/server-pilot/src/hms/release-kernel.ts`, `apps/server-pilot/src/hms/reservation-candidate-session.ts`, `apps/server-pilot/src/hms/production-runtime.ts`, `apps/server-pilot/src/ai/worker.ts`, `apps/server-pilot/src/ai/run-ledger.ts`, `apps/server-pilot/src/db/schema/mail.ts`, `apps/server-pilot/drizzle/meta/_journal.json`, `apps/server-pilot/src/env.ts`, `apps/server-pilot/tests/env.test.ts`.
- **Interfaces:** `executeRead(context, request) -> ReadResult` is a closed discriminated union by tool ID; trusted context owns scope/candidates/signal/budget/release/capture. Public `hms_find_reservation({candidateId})` returns bounded matches and minted refs; `hms_read_reservation({reservationRef,sections?,detail?})` returns concrete core/stay/rates/policies/operations facts under the [catalogue contract](../../infor-hms/2026-09-07-corpus-driven-pms-tool-catalog.md). New versions preserve explicit predecessor adapters; no runtime arbitrary dispatcher or duplicate agent-visible aliases.
- **Approach:** reuse release/authorization/candidate/runtime primitives. Replace seed-stub-only execution with explicit real typed dispatch while retaining binding checks. Add `read_tool` to the existing run-kind enum, with closed `readRequest` input and private `readResultRef` columns on ai_workflow_run; no separate job platform. Trusted admission binds the actual mailbox/thread/trigger, requested tool/release/input digest and idempotency key. Preserve the current required modelId column using an explicit `not_applicable` sentinel for this kind; exclude it from model usage/quality totals. Prompt-version storage records the read-contract version, not a model prompt. The HMS worker claims this kind under an independent `HMS_READ_SERVICE_ENABLED` switch even with drafting off; a default-lane worker cannot claim it. Resolve/revalidate refs and candidate bindings from bounded private request/result artifacts, not model-supplied record identity. Reuse the existing run fence, heartbeat, cancellation/deadline, durable per-branch budget and cleanup; persist a fenced typed result receipt without a draft, model client or workflow invocation. Browser ownership stays in the existing worker singleton, not HTTP/default AI lane. External deterministic callers enqueue/read a receipt; an already-claimed in-worker tool call reuses its fence rather than enqueuing a self-dependent job. Before PMS I/O, every worker/proof entry obtains the same tenant/property-scoped PostgreSQL advisory lock through `property-read-lock.ts`, held on a dedicated connection; lease/lock loss aborts and closes the session before further requests. Enable admissions only after all PMS-owning entries use that lock. The purpose-built proof harness normally uses the same read executor; any separate authorized proof runtime requires exclusive ownership under the same lock (or an explicitly stopped/drained worker), never a second uncoordinated process-local semaphore. Wire required auditSpec on every normal session and preserve one branch authorization per internal operation. Add only observed inert detail/history reads; simple linked identity is not privileged company billing. Optional unavailable sections cannot destroy valid facts or become zero values.
- **Test first:** deterministic admission → claimed read_tool → no-model service call → typed receipt with fake browser/secret/storage must initially fail on missing worker dispatch/audit metadata, including drafting off. Add exact lookup → resolved ref → context fixtures and capture/cleanup assertions before driver work.
- **Test scenarios:** expired/cross-mailbox/wrong-parent/wrong-branch refs rejected before I/O; unknown keys/raw URL/selector/script rejected; same-surname ambiguity; hidden guest fields; old release/schema mismatch; independent per-field freshness; too many children/rows/bytes/deadline; real handler versus stub; read_tool admission/claim/idempotency with drafting off and no model initialization; receipt replay/expired refs; two worker/proof processes cannot concurrently own one property; lock/heartbeat loss aborts without result overwrite; known positive and controlled negative; autosave/mutation blocked before transmission; abort/reclaim closes capture/session.
- **Verification:** `bash apps/server-pilot/scripts/reservation-pilot-gate.sh unit reads` and `bash apps/server-pilot/scripts/reservation-pilot-gate.sh db reads` prove contracts, model-free admission/dispatch, worker/property ownership, receipts and leases. Authorized purpose-built non-test proof then confirms each enabled branch through the actual normal trusted audited runtime, with known-positive/negative/ambiguous scenarios and private trace/video receipts; U8's read executor/harness owns the runtime comparison receipt with `evaluationMode`, actual input/output/source/version/time and mode-specific outcome/guard, while U11 carries it into handoff without a new platform. The Phase 2/B manifest records exact membership, skip reasons and field-level outcomes without a drafting model. Fixture/blocker success is not live-read completion or Phase 3 release.

### U9. Existing documents and mail artifacts

- **Goal:** discover, retrieve and validate existing authorized documents, using mailbox bytes first and PMS bytes only when independently proven inert.
- **Requirements:** R4/R5/R6/R7/R12/R17; AE4/AE14/AE16/AE18.
- **Dependencies:** U8 for common contracts/scope; source-specific mail work does not wait for a blocked HMS tax-invoice permission.
- **Files:** create `apps/server-pilot/src/mail/artifacts/existing-document-contracts.ts`, `apps/server-pilot/src/mail/artifacts/existing-document-service.ts`, `apps/server-pilot/tests/existing-document-service.test.ts`, `apps/server-pilot/tests/existing-document-validation.test.ts`; modify `apps/server-pilot/src/mail/artifacts/read-artifact.ts`, `apps/server-pilot/src/hms/document-list-contract.ts`, `apps/server-pilot/src/hms/live-document-list-driver.ts`, `apps/server-pilot/src/hms/live-sent-email-observer.ts`, `apps/server-pilot/src/hms/read-service.ts`, `apps/server-pilot/src/hms/read-tools.ts`, `apps/server-pilot/tests/hms-live-communications-reads.test.ts`, `apps/server-pilot/tests/hms-artifact.test.ts`.
- **Interfaces:** `documents_list_existing({scopeRef,source,kinds?,limit?,cursor?})` returns typed metadata/source outcomes; `documents_read_existing({documentRef,format})` returns validated text or private artifact ref with exact hash/version/extraction state. Preserve `hms_list_documents`, `hms_sent_email_audit` and `mail_read_artifact` through explicit adapters. Metadata-only sources return retrievable false, no usable byte ref.
- **Approach:** reuse mailbox attachment ownership, bounded S3 extraction and identity recheck. Source is explicit; no arbitrary filenames/storage keys/signed URLs to models. Validate guest/property/stay/payer/type/current version and requested price visibility before deeming a document usable. An SCS/supplier/manual document already in authorized mail can be read without a new connector. PMS byte retrieval gets a separate observed request branch only after proving no print/generate/finalize/send or audit-count mutation; otherwise retain the blocker and use existing safe sources.
- **Test first:** fixture documents include wrong guest, old dates, wrong bill-to/VAT, price-visible versus no-price request, proforma versus final invoice, expired compliance file, promised-only document and missing bytes. Assert source/ref/hash and validation outcomes before implementing.
- **Test scenarios:** metadata cannot claim bytes/attached; cross-mailbox/source/ref replay denied; changed locator/hash invalidates ref; unsupported/encrypted/scan-only files retain gaps; PDFs/bytes bounded before parsing; no implicit OCR platform; page truncation explicit; bank/card secrets omitted; print/download with side effect blocked; raw signed URL never in model result; sent-log record is not delivery.
- **Verification:** `bash apps/server-pilot/scripts/reservation-pilot-gate.sh unit documents` and `bash apps/server-pilot/scripts/reservation-pilot-gate.sh db documents` pass authorization/identity/format tests; real fixture-browser journey demonstrates select/read/validation/manual fallback. Each enabled PMS byte branch requires separate current inert-transport proof, not a successful metadata list or a generated replacement.

### U17. Rich finance and deposit evidence

- **Goal:** return useful reservation-scoped finance facts without false zero, paid or complete-ledger conclusions.
- **Requirements:** R5/R6/R12/R17; AE3/AE14/AE18.
- **Dependencies:** U8; prioritize after the first document slice, without waiting on blocked document permissions.
- **Files:** modify `apps/server-pilot/src/hms/folio-read-contract.ts`, `apps/server-pilot/src/hms/folio-read-facade.ts`, `apps/server-pilot/src/hms/live-folio-read-driver.ts`, `apps/server-pilot/src/hms/read-service.ts`, `apps/server-pilot/src/hms/read-tools.ts`, `apps/server-pilot/tests/hms-folio-read.test.ts`, `apps/server-pilot/tests/hms-live-folio-read.test.ts`; create `apps/server-pilot/tests/hms-finance-completeness.test.ts`.
- **Interfaces:** `hms_read_folio({reservationRef,sections?})` supports balance/deposits and a separately proved transactions branch. Concrete amounts are `ReadFact<Money>`; deposits distinguish due, paid, refunded, forfeited, transferred and untransferred, separately per currency. Transactions bind exact account/folio/posting/date/currency/source/destination, with page/completeness and liability-location evidence. Missing branch is unknown, never 0.00.
- **Approach:** preserve existing folio/deposit drivers and historical release evidence; revalidate present role/dispatch. Replace partial placeholders with typed unknowns, wire auditSpec, enforce true pre-clamp size/time counters and exact reservation filters. Extend bounded line-item evidence only on observed allowed routes. Property-day deposit totals are not reservation totals; a seven-date scan is not all history. No post/adjust/transfer/settle/refund controls.
- **Test first:** known balance + unavailable deposit must return a useful partial result and never zero deposit. Fixture states cover paid, unpaid, deposit-only, refunded, forfeited, transferred-to-guest, guest-zero/A-R-liability and authorization-only. An unrecognized deposit activity must stay unmapped/unknown and make affected totals incomplete, not fall through the current classifyDepositActivity default to paid; require a closed source-code mapping before financial claims.
- **Test scenarios:** mixed currency/sign conventions; transfer counted once; unrelated reservation rows excluded; >50 rows/>7 dates expose incompleteness; missing page can't become not-found; expired scope denied; normal capture required; partial fields do not become full-ready legacy draft claims; every business mutation blocked.
- **Verification:** `bash apps/server-pilot/scripts/reservation-pilot-gate.sh unit finance` plus normal-runtime integration tests pass; actual read-only proof validates known-positive finance states and relevant negatives. Do not claim the ledger proves bank settlement or customer liability beyond its scoped evidence.

### U7. All-night availability and rate evidence

- **Goal:** support quote questions with validated dates/occupancy and every requested night, without creating or holding a reservation.
- **Requirements:** R4/R5/R6/R12/R17; AE1/AE14/AE18.
- **Dependencies:** U8; priority after core document/finance slices. No master-agent dependency.
- **Files:** create `apps/server-pilot/src/hms/quote-request-normalization.ts`, `apps/server-pilot/tests/hms-quote-request-normalization.test.ts`, `apps/server-pilot/tests/hms-quote-completeness.test.ts`; modify `apps/server-pilot/src/hms/quote-stay-candidate.ts`, `apps/server-pilot/src/hms/quote-stay-contract.ts`, `apps/server-pilot/src/hms/quote-stay-facade.ts`, `apps/server-pilot/src/hms/live-quote-stay-driver.ts`, `apps/server-pilot/src/hms/reservation-candidate-session.ts`, `apps/server-pilot/src/hms/read-service.ts`, `apps/server-pilot/src/hms/read-tools.ts`, `apps/server-pilot/tests/hms-quote-stay-v2.test.ts`, `apps/server-pilot/tests/hms-live-quote-stay.test.ts`.
- **Interfaces:** trusted normalized QuoteRequest carries dates, rooms/occupancy/child ages, currency and authorized room/rate/org/agency/group refs; producer mints quoteRequestRef. `hms_quote_stay({quoteRequestRef,detail?})` returns per-night facts, restrictions/inclusions, coverage, totals and bookability. Separate stay segments retain explicit coverage. Missing input returns a typed request-input outcome, not defaults.
- **Approach:** repair quote_stay versus surname_dates wiring and auditSpec through the independent service. Use existing observed grid for what it proves; explore documented Hotel Availability/Rate Shop only under new branch proof. Never use CRS Check Availability, Reserve or temporary-hold Guest Stay path. Distinguish nightly display rates, arithmetic sum and complete occupancy-priced stay total. Legacy bookable false means unproven, not sold out; keep stayTotal null until all relevant facts are supported.
- **Test first:** two rates across three nights, sold-out middle night, documented negative availability from overbooking, missing child age, multiple rooms, split stays, negotiated eligibility, room-move requirement, tax/package unknown and restricted sell options. Requested quantities stay non-negative; observed availability preserves its signed source value without clamping or inferring bookability. Expected full/partial facts and unpriced inputs are pinned.
- **Test scenarios:** locale/date ambiguity asks clarification; no two-adult guess; missing night/closed arrival/LOS restriction cannot become complete quote; Shop by Day ignores restrictions and cannot establish bookability; mixed currency not summed; current caps enforced; no quote paging escape; no inventory hold/creation side effect; wrong-property/rate ref denied.
- **Verification:** `bash apps/server-pilot/scripts/reservation-pilot-gate.sh unit quotes` and normal audited-runtime fixture tests pass. Current read-only all-night/occupancy/tax/restriction proof is required for a complete-quote claim; otherwise ship accurately named displayed-rate capability plus exact blockers, not a fabricated quote.

### U15. Linked company, group, event and notes context

- **Goal:** add useful business context with independent field/section authority, without pretending group/event corpus material all belongs to HMS.
- **Requirements:** R5/R6/R10/R12/R17; AE5/AE14/AE18.
- **Dependencies:** U8; group document bytes use U9, finance amounts use U17 only when those sections are requested.
- **Files:** modify `apps/server-pilot/src/hms/company-account-read-contract.ts`, `apps/server-pilot/src/hms/live-company-account-read-driver.ts`, `apps/server-pilot/src/hms/group-block-read-contract.ts`, `apps/server-pilot/src/hms/group-read-candidate.ts`, `apps/server-pilot/src/hms/live-group-block-driver.ts`, `apps/server-pilot/src/hms/event-read-contract.ts`, `apps/server-pilot/src/hms/event-read-candidate.ts`, `apps/server-pilot/src/hms/live-event-read-driver.ts`, `apps/server-pilot/src/hms/read-service.ts`, `apps/server-pilot/src/hms/read-tools.ts`; create `apps/server-pilot/src/hms/notes-traces-read-contract.ts`, `apps/server-pilot/src/hms/live-notes-traces-read-driver.ts`, `apps/server-pilot/tests/hms-context-reads.test.ts`, `apps/server-pilot/tests/hms-notes-traces-read.test.ts`; extend existing company/group/event contract and live-blocker tests.
- **Interfaces:** keep `hms_company_account_read({reservationRef})` billing semantics; `hms_group_block_read({groupRef,sections?})` exposes summary/blocks and separately entitled delegates; `hms_event_read({eventRef})` requires exact HMS source; `hms_read_notes_traces({resourceRef,states?,limit?,cursor?})` returns bounded permitted observations only. Use common ReadResult and source-specific concrete fields in the catalogue.
- **Approach:** inspect actual role/menu/version first; retain structural blockers until a safe observed route proves needed fields. Narrow status/dates/linked identities can be returned independently of unavailable billing/block counts. Preserve Company text versus Organization/Agency/A-R distinctions, group end-date versus departure semantics, raw CON/BLK until mapped, and private note audience. No new SCS/OTA/provider connector.
- **Test first:** company label with no billing terms; group status/dates with unknown aggregate counts; delegate rows differing from room count; Tentative inventory semantics; HMS versus SCS event; event depositAmount 5000, depositReceived 1000 and a separate depositDueDate must remain three source-bound facts, not one paid amount; private/untrusted note with a misleading instruction. Unproved event deposit meanings stay unknown; recorded receipt is not bank settlement.
- **Test scenarios:** linked relationship does not grant full account disclosure; credit approval not paid cash; current policy not automatically booked policy; partial group/rooming pages unknown; no create-rooming-list/delegate update; profile-tab autosave denied; trace Complete/Submit/send/checkout-lock blocked; incognito/privacy filtering; role/version absence produces precise section blocker.
- **Verification:** `bash apps/server-pilot/scripts/reservation-pilot-gate.sh unit contexts` plus normal-runtime scoped tests pass. Each claimed enabled reader/section has source/field/read-only proof and private trace/video evidence; unchanged blocker functions are not counted as completed tools.

### U16. Approved property knowledge companion

- **Goal:** supply current approved property facts and documents without a PMS call or new knowledge-management platform.
- **Requirements:** R4/R6/R11/R12/R17; AE1/AE4/AE8.
- **Dependencies:** U1; reuse U8 result/reference contract and U9 artifact validation when those inputs are needed. Can proceed alongside other read families after the initial dashboard.
- **Files:** create `apps/server-pilot/src/ai/property-knowledge-contract.ts`, `apps/server-pilot/src/ai/property-knowledge-read.ts`, `apps/server-pilot/tests/property-knowledge-read.test.ts`, `apps/server-pilot/tests/fixtures/property-knowledge.json`; modify `apps/server-pilot/src/hms/agent-read-tools.ts` only for the thin non-PMS adapter, without adding it to HMS browser permissions.
- **Interfaces:** `property_read_knowledge({topic,detail?})` returns entries with approved content/source/version/owner/approval/effective dates/audience and existing-document refs. Fixed topics include check-in/out, cancellation, deposits/payment, rooms, meals/children, amenities, transport, contacts, groups/events and compliance.
- **Approach:** load an approved versioned property file/attachment set through existing storage/authorization; synthetic fixtures contain no live hotel policy. No web crawl/vector database/editor or policy generation from historical replies. Missing/conflicting/expired approval returns unavailable evidence. Authoritative booked policy remains reservation-specific; generic current policy cannot overwrite it.
- **Test first:** approved current fact, future/expired version, conflicting sources, unapproved bank instruction, wrong property/audience and missing topic.
- **Test scenarios:** unapproved/expired content cannot become guest fact; raw payment secrets never returned; bank instructions require approved source; missing child/meal conditions not guessed; linked document identity/expiry rechecked; no external call for local knowledge read.
- **Verification:** `bash apps/server-pilot/scripts/reservation-pilot-gate.sh unit knowledge` passes deterministic schema/effective-date/privacy tests. Live data activation requires real owner/version/source approval, not an agent-created fixture.

### U5. Safe reusable replies and task/fact contract

- **Goal:** produce useful guest text or a clear internal brief from the facts actually available.
- **Requirements:** R4/R6/R10/R11; AE1–AE5/AE8/AE15.
- **Dependencies:** U1 and the read-tool milestone (U8/U9/U17/U7/U15/U16 with explicit per-capability release/blocker status). Every capability branch/version consumed by U5 must first pass the KTD7a Phase 2/B gate; safe implementation and independent work may proceed before that proof. U5 is scheduled after useful read-tool delivery; it is not their prerequisite. U2 later supplies live asks. Missing permission for one read must not prevent drafting from other proven sources.
- **Files:** create `apps/server-pilot/src/ai/reply-playbooks.ts`, `apps/server-pilot/src/ai/reply-assessment.ts`, `apps/server-pilot/src/ai/prepared-draft-input.ts`, `apps/server-pilot/tests/reply-playbooks.test.ts`, `apps/server-pilot/tests/reply-assessment.test.ts`, `apps/server-pilot/tests/prepared-draft-input.test.ts`, `apps/server-pilot/src/ai/bedrock/local.ts`, `apps/server-pilot/src/ai/local-model-routing.ts`, `apps/server-pilot/tests/local-model-adapter-contract.test.ts`, `apps/server-pilot/tests/shadow-model-routing.test.ts`; modify `apps/server-pilot/src/ai/bedrock/factory.ts`, `apps/server-pilot/src/env.ts`, `apps/server-pilot/tests/env.test.ts`, `apps/server-pilot/src/ai/candidate-draft-agent.ts`, `apps/server-pilot/src/ai/draft-evidence.ts`, `apps/server-pilot/src/ai/workflows/candidate-draft.ts`, `apps/server-pilot/src/ai/draft-backtest.ts`, `apps/server-pilot/tests/draft-backtest-scorer.test.ts`.
- **Approach:** controlled module composition for all current asks; separate complete/partial/clarification/brief/abstain. Facts carry source, time and authority; policy uses versioned approved input, not facts mined from old replies. Prepare bounded inputs before workflow/trace serialization; approved local processing may use authorized PII, never secrets. U5 owns the reusable approved-transport adapter/routing guard on the existing ModelAdapter injection seam for extraction, drafting and judging. Missing/unproven transport fails before network/client initialization; no hosted/fake live fallback. Verify protocol/access/egress/retention at activation without guessing endpoints or provisioning a new service.
- **Patterns:** existing typed claims/evidence renderer and artifact bounds; remove diagnostic harness language from guest body.
- **Execution note:** test-first cases from synthetic counterparts of the retained audit.
- **Test scenarios:** missing child ages asks once; receipt not funds-cleared; booking request not confirmed; cancellation request not completed; price missing bracket fails coverage; negation/amount/currency mismatch; group brief remains internal; unknown policy not invented; injected email cannot change bank/recipient/tool authority; attachment claim requires selected authorized bytes; sensitive/unrelated material never reaches adapter/trace; missing-route refusal with zero Bedrock calls, cancellation/deadline propagation, invalid model JSON, safe errors and actual model/usage provenance.
- **Verification:** every supported module yields supported guest text or an explicit limitation. Complete quotes/documents require the released read/byte evidence and a passed per-capability Phase 2/B gate; no read result invents completed actions.

### U2. Passive current-request and response baseline

- **Goal:** identify what request was answered, when, and what remains unknown or outstanding.
- **Requirements:** R2/R8/R10/R14; AE3/AE5/AE7/AE10.
- **Dependencies:** U12/U5; U1 supplies shared fixtures. This ask-aware enrichment follows tools and does not block the initial U10 observed-conversation slice.
- **Files:** create `apps/server-pilot/src/metrics/mail-baseline.ts`, `apps/server-pilot/src/metrics/mail-baseline-projection.ts`, `apps/server-pilot/src/metrics/mail-baseline-repository.ts`, `apps/server-pilot/src/db/schema/mail-baseline-projection.ts`, `apps/server-pilot/drizzle/0024_mail_baseline_projection.sql`, `apps/server-pilot/tests/mail-baseline.test.ts`, `apps/server-pilot/tests/mail-baseline-projection.test.ts`, `apps/server-pilot/src/ai/mail-baseline-extraction.ts`, `apps/server-pilot/tests/mail-baseline-extraction.test.ts`; modify `apps/server-pilot/src/ai/worker.ts`, `apps/server-pilot/src/ai/run-ledger.ts`, `apps/server-pilot/src/db/schema/index.ts`, `apps/server-pilot/drizzle/meta/_journal.json`, `apps/server-pilot/src/ai/triage.ts`, `apps/server-pilot/src/ai/triage-input.ts`, `apps/server-pilot/src/metrics/admin-dashboard-aggregates.ts`, `apps/server-pilot/src/trpc/routes/admin-dashboard.ts`, `apps/server-pilot/src/mail/send/outbound-queue.ts`, `apps/server-pilot/tests/outbound-queue.test.ts`.
- **Approach:** pure versioned reducer over scoped source/interpretation evidence and a compact immutable projection for classified service facts; bounded repository reads, no model call on GET. Preserve classifier/reviewer/source versions and unknowns. Reuse triage extraction without changing folder taxonomy or making analytics state an authoritative work owner. Explicitly produce semantic evidence through the analytics-only extraction stage on committed inbound/outbound and bounded replay, including no-label/unknown outcomes. Capture native acceptance-observation time; external Sent copies remain observed sends, not forced to have Nava queue rows.
- **Patterns:** current triage as-of/fencing and conversation links, but not broad ever-responded semantics.
- **Execution note:** characterize old calculations, then request-level synthetic counterexamples.
- **Test scenarios:** new ask after old reply reopens; follow-up doesn't restart wait; multiple asks and partial answers; unknown reply plus open work yields action-pending with Unknown-evidence and no replied claim in UI/export; internal forward/auto-ack not substantive response; headerless ambiguous link unresolved; arrival/observation bounds reject future reply; opening backlog/left censoring; covered mature unreplied vs not-yet-due vs gap; calendar/Johannesburg boundaries and optional confirmed business schedule; partial recipient acceptance; cancelled/queued/unknown send not answered; crash finalization doesn't invent acceptance time; inbound/outbound commit enqueues one semantic generation; historical replay excludes future references; extraction retry/version changes retain source lineage without folder writes.
- **Verification:** fixed fixture counts and clocks can be independently recomputed; same report inputs/version reproduce totals; changed coverage creates a traceable restatement, not silent historical rewriting.

### U13. Private predictions, delayed evaluation and internal scorecard

- **Goal:** learn continuously between staff visits without exposing or sending shadow replies.
- **Requirements:** R6/R11/R12/R13/R15/R16; AE8/AE11/AE12/AE15.
- **Dependencies:** U1/U12/U2/U5 and the relevant released read families; every capability branch/version consumed by Phase 3 shadow evaluation requires its own passed KTD7a Phase 2/B gate. Internal evaluation follows the tool milestone.
- **Files:** create `apps/server-pilot/src/db/schema/ai-shadow-evaluation.ts`, `apps/server-pilot/drizzle/0025_ai_shadow_evaluation.sql`, `apps/server-pilot/src/ai/shadow-evaluation.ts`, `apps/server-pilot/src/ai/shadow-reference-matcher.ts`, `apps/server-pilot/src/metrics/shadow-scorecard.ts`, `apps/server-pilot/tests/shadow-evaluation.test.ts`, `apps/server-pilot/tests/shadow-reference-matcher.test.ts`, `apps/server-pilot/tests/shadow-scorecard.test.ts`; modify `apps/server-pilot/drizzle/meta/_journal.json`, `apps/server-pilot/src/db/schema/index.ts`, `apps/server-pilot/src/ai/worker.ts`, `apps/server-pilot/src/ai/run-ledger.ts`, `apps/server-pilot/src/ai/thread-context.ts`, `apps/server-pilot/src/ai/eval-runner.ts`, `apps/server-pilot/src/ai/bedrock/factory.ts`, `apps/server-pilot/src/env.ts`, `apps/server-pilot/src/trpc/routes/admin-dashboard.ts`, `apps/mail/app/(routes)/settings/admin-dashboard/page.tsx`, `apps/server-pilot/tests/ai-eval-runner.test.ts`, `apps/server-pilot/tests/hms-shadow.test.ts`.
- **Approach:** explicit new evaluation purpose/writer, immutable prediction plus append-only assessment revisions; existing run ledger/safe counters remain. Freeze as-of inputs before current-state context builder. Admission after new-inbound processing, delayed rematch after outbound ingest, bounded scheduled assessment. Bind versions, timing, scope, artifacts and sampling/skip reasons. Keep legacy HMS shadow's no-body contract intact.
- **Model gate:** prove/reuse the approved local route through the current adapter interface before live runs. If absent, keep live generation/judging disabled and record access/processing blocker; do not silently use Bedrock on raw mail. Reuse U5's ModelAdapter/planModel approved-transport adapter and purpose-specific fail-closed routing. Verify route identity/protocol/model, worker access, real egress and retention; a loopback proxy does not prove local inference. No guessed endpoint or new inference infrastructure is authorized by this plan. Test missing-route refusal before client initialization, zero Bedrock fallback, timeout/cancellation, output validation, safe errors and truthful model/usage provenance. Fake fixtures prove plumbing, never live quality.
- **Patterns:** ledger fencing/leases/idempotency, private artifact controls, existing admin permission separation.
- **Execution note:** characterize zero-label/current-context failures; then lifecycle and crash tests.
- **Test scenarios:** before-target sealing; late-imported earlier sent copy marked late; future message/attachment/PMS/policy excluded; retry/reclaim cannot duplicate or overwrite seal; model identity/order bias diagnostic; absent/duplicate/unbound labels fail quality availability; new facts distinguish changed-state; unmatched/ambiguous/no-reference denominators retained; admission caps include skips; no visible draft/labels/read-state/SMTP side effect; wrong cohort denied; retention deletion removes private derivatives.
- **Verification:** a synthetic inbound produces one private sealed prediction; later synthetic reply creates a traceable assessment; restart/rematch keeps prediction unchanged. Operator scorecard reports real coverage and defects, including failures and absent labels. Approved live mode requires separate processing, scope and retention proof.

### U6. Narrow human-reviewed drafting and send safety

- **Goal:** expose supported assistance during the existing pilot without requiring a new queue.
- **Requirements:** R4/R7/R10/R16; AE6/AE7/AE8.
- **Dependencies:** U5/U13 and relevant per-family shadow gates; every capability branch/version consumed by visible assistance must have its own passed KTD7a Phase 2/B gate, while the separate per-family draft-quality gates remain required. Only independently released read capabilities are exposed.
- **Files:** modify `apps/server-pilot/src/ai/drafts.ts`, `apps/server-pilot/src/trpc/routes/drafts.ts`, `apps/server-pilot/src/trpc/routes/mail.ts`, `apps/server-pilot/src/mail/send/outbound-queue.ts`, `apps/server-pilot/src/env.ts`, `apps/server-pilot/tests/outbound-queue.test.ts`; create `apps/server-pilot/src/ai/draft-approval.ts`, `apps/server-pilot/tests/draft-approval.test.ts`, `apps/server-pilot/tests/draft-refresh-generation.test.ts`, `apps/mail/tests/draft-assistance.test.tsx`; modify `apps/mail/components/mail/thread-display.tsx`, `apps/mail/components/mail/thread-draft-card.tsx`, `apps/mail/components/mail/reply-composer.tsx`, `apps/mail/hooks/use-drafts.ts`, `apps/mail/lib/mail/thread-draft-view-model.ts`, `apps/mail/components/create/email-composer.tsx` without replacing the editor.
- **Approach:** validated draft-only purpose and named-person/family switches; current regeneration instead of promoting hidden historical drafts. Require the approved adapter at visible generation/refresh entry points, never generic fallback. Bind source/evidence/revision separately, fence refresh, preserve manual edits, distinguish guest candidate from internal brief. Show stale changes, revalidate evidence without replacing text, then bind explicit re-approval; no AI-bound Send anyway bypass. Persist exact approval in existing outbox; check at enqueue and before every actual SMTP transmission.
- **Patterns:** existing immutable draft revisions, queue acceptance/undo/uncertainty and editor UX.
- **Execution note:** approval/refresh race tests before enablement.
- **Test scenarios:** same-source adoption not self-stale; concurrent refresh one generation; human edits preserved after failure; invalidation → evidence refresh → explicit re-review → safe send without text loss; Send anyway cannot bypass AI binding; new mail/recipient/attachment/policy invalidates approval; confirmed zero acceptance then invalidation blocks retry; persisted/unknown outcomes never resend; visible generation/refresh with absent route makes zero hosted-model calls; partial accepted recipients; undo/cancel not response; existing manual reply unaffected; keyboard/mobile error and manual fallback.
- **Verification:** fixture browser user can adopt/edit/review a supported draft and explicitly send through a fake transport; stale/incompatible payload never dispatches. Live staff activation is scoped and separately evidenced.

### U11. Fixture journeys, slice release and operating handoff

- **Goal:** release useful slices independently and leave reproducible proof, safe rollback and a concise tool handoff.
- **Requirements:** R7/R9/R11/R12/R16/R18/R19; AE6–AE18.
- **Dependencies:** applicable units in each released slice, not deferred U3/U4 or removed U14.
- **Files:** create `apps/mail/tests/e2e/reservation-tools-pilot.spec.ts`, `apps/server-pilot/tests/reservation-tools-pilot-integration.test.ts`, `docs/infor-hms/dashboard-tools-pilot-runbook.md`, `apps/mail/vite.pilot-fixture.config.ts`; modify `apps/server-pilot/scripts/reservation-pilot-gate.sh` and relevant existing deploy verification wiring only when authorized.
- **Interfaces:** U1 owns the private Phase 2/B manifest and mode/holdout contract. U8's read executor/harness owns the runtime comparison receipt; U11 binds its `evaluationMode`, capability branch/version, case membership/skip reasons, mode-specific aggregation/release guard, actual input/output/source/version/time, field-level outcomes, gate outcomes, capability blockers, private trace/video paths and expiry into the handoff. Runbook specifies fixture entry, actual runtime proof, kill switches and compatibility rollback; progress lives outside the plan.
- **Approach:** journeys for executive traffic/T0 assumptions → independent reservation/finance/document/quote reads → Phase 2/B real-email capability validation → later ask-aware/private prediction matching → supported visible draft. No timer or capture subsystem. Tool calls are verified without an LLM before later agent adaptation. Keep future-write contracts documented and absent from runtime registries.
- **Test first:** establish failing end-to-end fixture journeys for the released slice before final wiring. Use the actual Playwright runner, fake mail/PMS transports and isolated services.
- **Test scenarios:** aggregate-only executive cannot inspect mail; research never leaks; known/unknown capture intervals render correctly; private shadow has no visible/send effect; Phase 2/B case manifest is frozen before results and target leakage is rejected; mode-specific aggregation never pools current/replay/future scores; a held-out outcome cannot tune, repair, choose fixtures or retry, and unsealed exposure retires it to development/regression with original score preserved; source outage gives manual path; stale approval refuses transmission; changed tool fingerprint prevents stale release; model unavailable does not disable independently useful tools; no future-write registration; rollback preserves accepted SMTP outcomes without resend.
- **Verification:** `bash apps/server-pilot/scripts/reservation-pilot-gate.sh browser pilot`, required disposable-DB slices and scoped builds pass with zero required skips. Independent code/security/UX findings are resolved for the released slice. The Phase 2/B receipt distinguishes no eligible gold coverage from an independently proved current capability. Purpose-built live checks remain read-only; unavailable external authority is reported, never marked successful.

---

## Verification Contract

### Execution environment and commands

These are future implementation commands, not application suites run during planning. U1 implements the named gate and fails on unknown mode/slice, required skips or unsafe environment. Run from repository root.

All future execution and review workers follow the central Development routing and coordination mandate above. Execution receipts record requested/effective model, effort, usage (or unknown when unavailable) and evidence; a fresh-main reconciliation is required before implementation. The final whole-branch review must be a separate Luna review with both specification and code-quality verdicts, and all critical/important findings must be fixed and retested. This amendment defines no application-test or live-capability result.

Every root-dispatched brief and receipt also follows the literal CodeGraph-first rule above: record the assigned worktree root, queried project/root and query/result relevance, or the explicit no-index/tool-failure fallback. This worktree was observed without `.codegraph/` at setup on 2026-09-07; the user has since authorized local index creation in this assigned worktree only. Recheck for each actual task root and do not claim index completion from this amendment; never implicitly use or copy another worktree's index.

| Gate | Command / scope | Required result |
| --- | --- | --- |
| Dashboard + measurement unit | `bash apps/server-pilot/scripts/reservation-pilot-gate.sh unit dashboard`; `unit measurement` on the same script | Exact counts/T0/gaps/authorization/clock cases pass with no DB/model/PMS |
| Read-family unit | Same script: `unit reads`, `unit documents`, `unit finance`, `unit quotes`, `unit contexts`, `unit knowledge` | All named U8/U9/U17/U7/U15/U16 scenarios; schemas/limits/normal audit composition/compatibility pass |
| Required database | Same script: `db dashboard`, `db reads`, `db documents`, later `db baseline`, `db shadow`, `db outbox` | Independently verified disposable connection; migrations, scoped queries, leases, projection/seal/rematch/outbox races; zero required skips |
| Later draft/evaluation unit | Same script: `unit drafting`, `unit baseline`, `unit shadow`, `unit approval` | U5/U2/U13/U6 facts, causal inputs, state, route and send invariants |
| Fixture browser | Same script: `browser dashboard`, `browser documents`, `browser pilot` | Real Playwright against loopback isolated services; desktop/mobile/keyboard/access/error/manual paths, no external sends |
| Scoped builds | Same script: `build server`, `build mail` wraps `pnpm --filter @zero/server build` / `pnpm --filter @zero/mail build` | Backend TypeScript and actual React Router build; scripts/new contracts separately type-checked |
| Formatting/static | Existing tooling on changed files; scoped diff whitespace check | No unrelated formatting; pre-existing failures reported separately |
| Runtime read proof + Phase 2/B gate | `hms-read-tool-harness.ts` via existing normal trusted audited proof/runtime entry, no drafting model or test runner | Exact role/property/source/release, frozen private case membership/skip reasons, persisted `evaluationMode` and mode-specific guard, field-level outcomes and positive/negative/ambiguity evidence; actual audited trace/video, zero business effects |

The gate maps each named slice to the exact test files listed in its unit; tests are not selected by a broad live-looking filename glob. Database mode refuses missing required input. Clear ambient DATABASE_URL and VITEST_ALLOW_PILOT_RDS before every runner; the gate accepts a separately verified disposable connection through NAVA_TEST_DATABASE_URL and passes it only to the required child without logging it. Never source production env or set the prohibited override. Provision/verify an owned disposable target; cleanup is restricted to its exact owned resources.

Frontend Vite loads monorepo env files and a broad lint plugin, so clearing shell variables alone is insufficient. Fixture config disables env-file loading, live bindings/.dev.vars and external sockets; uses explicit loopback public origins and fake transports. Disable broad lint only for this fixture gate and run scoped lint separately. No root db command (legacy package), no test runner pointed at pilot RDS. Existing test filenames containing “live” may still use mocks; they are not live capability proof.

Migration 0023 is the next unused number in the inspected checkout: U8 adds the read_tool run kind and bounded request/result-reference columns. Apply/commit its enum migration and deploy kind-aware workers before enabling admission. U2 then uses 0024 for the baseline projection; U13 uses 0025 for shadow evaluation. Recheck numbering before execution, use focused additive SQL/journal changes, and test fresh plus already-migrated disposable databases. U12 adds no ingest/source-cycle/timing schema. The backend build excludes scripts/tests: separately type-check the harness, gate contracts and test-side schemas.

Each unit follows the central mandate's concrete TDD cycle: add its named failing fixture/assertion → run its exact slice and inspect the intended RED → implement the smallest scoped change → rerun that slice and inspect evidence → applicable DB/browser/compatibility gates → separate review and fresh proof. Every root-dispatched brief carries the literal CodeGraph-first instruction and assigned worktree root; every receipt records graph queries/relevance or the explicit fallback. Fixture success never promotes a new PMS branch or Phase 3 capability by itself.

### Release ladder

| Slice | Staff attendance needed? | Activation proof |
| --- | --- | --- |
| A: executive dashboard, T0 and lean diagnostics | No | Authorized cohort, truthful traffic/folder/time semantics, assumption/gap notes and no false response/revenue payload |
| B: independent read toolkit + Phase 2/B validation | No coding/babysitting by founder | Per-tool schema/dispatch/runtime/role/source/field/negative/side-effect proof, frozen real-email case disposition and private traces/videos; precise blockers for unavailable branches |
| C: ask-aware service and private drafting evaluation | No daily use | Only Phase 2/B-released capabilities; approved model/storage route, causal inputs, source-linked request state, immutable predictions, real label availability and cost/retention caps |
| D: supported visible assistance | Software no; usage cannot be fabricated | Per-family safety evidence, current reads, human edit/approval/send protections and named pilot scope |

The read milestone means useful proven tools and explicit per-capability disposition, not “all registrations exist.” Do not stop at stubs. Complete implementation/testing, exhaust safe read-only alternatives for a blocked surface, and distinguish implemented, independently proved, live enabled and unavailable. A missing external permission blocks that branch, not all later work; never mark the blocked capability live or the entire deployment complete.

Critical fixture escapes tolerated: zero. For visible family promotion, independently review at least 30 fresh eligible request runs across the proposed slice with at least five per released family, sampled before generation outcomes are known. Require no critical recipient/action/fact errors and at least 90% useful supported complete-or-correctly-partial outcomes both overall and within each released family. Failed generation/missing output is not useful; unscorable evidence stays unknown and cannot improve the success numerator. Test the 25/25 good-family plus 2/5 weak-family case: the pooled 90% must not promote the weak family. These are operating floors, not statistical accuracy guarantees; retain counts/uncertainty and keep unproven families off. If independent review is unavailable, remain shadow-only. The separate inbound-first holdout measures missed asks, including never-replied mail; the qualified draft sample cannot establish triage recall.

“Independent review” means evidence checked against source/policy by an accountable reviewer who did not write the candidate, with uncertain/high-risk cases adjudicated. Model-only agreement must be labelled as such and cannot manufacture external business truth. Full queue promotion is deferred.

Proposed performance budgets: dashboard p95 under two seconds on the documented representative fixture; API does not wait for AI; no-PMS draft p95 under 20 seconds; read-enriched generation retains the existing bounded 90-second/maximum-read policy unless current runtime is stricter. Count timeout/late results, don't erase them. Reassess budgets from measured service time before increasing admission.

### Rollback and data lifecycle

Disable read-tool admissions, new shadow admissions/scoring or the affected family/release first; retain private evidence under its retention policy and keep normal mail/manual drafts available. Never mass-retag, erase source mail or rewrite an immutable prediction to improve a score.

For read_tool rollback, stop admission and drain/cancel owned pending read jobs before reverting to workers that do not recognize the kind; preserve private receipts until expiry and leave additive enum/columns in place. No old worker may claim new-kind jobs. For new AI-bound outbox payloads, keep approval-aware readers/workers until accepted outcomes finalize and incompatible unsent rows are cancelled/quarantined. Verify no old worker can claim a new-format unsafe payload before reverting binaries. No blind resend after unknown acceptance.

Access is checked at read time; export and artifact links are scoped/short-lived using existing controls. Purge private derivatives on expiry/mailbox deletion; append-only assessments do not mean indefinite retention. Logs contain opaque IDs and counters, never mail bodies or credentials.

---

## Definition of Done

### Software delivery

- [ ] Before implementation, fresh `main` is reconciled against the recorded `source_checkout`, and changed files, constraints and dependencies are rechecked; this amendment is not a baseline recertification.
- [ ] Central development routing is followed: routine workers explicitly request Luna with `max` effort and `fork_turns=none`; root remains Astra for allowed summaries and delegates routine work; receipts record requested/effective model, effort, usage and evidence; the separate Luna final review issues both specification and code-quality verdicts, with critical/important findings fixed and retested.
- [ ] Every root-dispatched brief includes the literal CodeGraph-first rule for its actual assigned worktree; receipts record project/root and query relevance or an explicit no-index/tool-failure fallback. No index is silently taken from `main` or another worktree.
- [ ] Initial executive dashboard shows useful general email/business metrics, existing-folder breakdown and accessible bar/line charts; AI metrics are separate.
- [ ] T0/configuration and lean diagnostics support new-request measurement without repairing old history or introducing a capture subsystem.
- [ ] Active read units are implemented and independently callable without a drafting model; exact schema/fact/source/permission/limit contracts are enforced.
- [ ] Each Phase 3-consumed read capability passes the Phase 2/B real-email gate with frozen private membership/skip reasons, no gold leakage, normal trusted audited no-model proof, field-level outcomes and private traces; absence of eligible gold cases is recorded as a coverage gap, never a gold-validation pass, and independent current proof remains separate.
- [ ] Cases, comparison receipts and reports persist `evaluationMode` and mode-specific aggregation/release guards; current/replay/future scores are never pooled, and held-out exposure retires to development/regression with original outcomes preserved before any fresh disjoint claim.
- [ ] Every claimed enabled read has current positive/negative/ambiguity, field/completeness and non-mutating transport proof; stubs/blocked permissions are not counted as shipped capabilities.
- [ ] Existing documents have exact authorized bytes/version/type/recipient/price-visibility checks; metadata or generation never substitutes for retrieval.
- [ ] Agent-owned tool handoff includes private trace/video receipts, scenarios, limitations and expiry; no coding/debugging/babysitting delegated to the user.
- [ ] Later request/response enrichment handles new asks, partial answers, separate reply/work state, pre-period starts, observation bounds, clocks and recipient outcomes.
- [ ] Later private evaluation is immutable/versioned/causally bounded and does not affect staff drafts, folders or guest sending.
- [ ] Supported visible drafts preserve human edits, source/evidence freshness, explicit approval and delivery-uncertainty behavior.
- [ ] Future write/action research is retained in the catalogue; no new business-write or automatic-send tools are registered.
- [ ] No task timer, staff study, importer repair, capture-cycle ledger, polling monitor, new PMS API/MCP/agent framework or speculative warehouse is introduced.
- [ ] Required scoped/local/disposable-DB/actual fixture-browser gates pass with zero required skips; independent review findings resolved; abandoned experiments removed.
- [ ] Release/run receipt identifies exact revision/slice/scope/processing/retention, capability blockers and verified rollback. Blocked external activation is not “done.”

### Claims requiring their own evidence

“Complete mailbox history,” “live read capability,” “complete occupancy-priced quote,” “existing PMS document retrieved,” “live shadow,” “staff used Nava,” “minutes saved” and “incremental revenue” each require real corresponding observations. Implemented unavailable states do not prove them. This plan makes no labor-saving or causal revenue claim and contains no task study.

Planning completion is this amended canonical plan, durable tool catalogue, reproducible count/source research, the documented historical review disposition and a self-contained walkthrough. The historical review disposition certifies the earlier revision only; this amendment claims no new product implementation, live deployment or current PMS capability.

---

## Developer Experience and Operating Handoff

- **First useful result:** synthetic executive dashboard, then direct no-model reservation/finance/document read calls through the normal audited fixture runtime and the Phase 2/B real-email capability disposition. Later add one sealed prediction and matched assessment. No live credentials for fixtures.
- **Execution routing and receipts:** the Autonomous Execution Mandate above is the single routing policy: explicit Luna/max/`fork_turns=none` for routine development and review, root/Astra only within its stated narrow boundary. Keep task/file briefs and small receipts as the coordination surface; retain full histories, logs and diffs privately, and record requested/effective model, effort, usage and evidence with unknown or unavailable usage left unknown.
- **Source navigation:** the CodeGraph-first task-brief rule above is the single source-navigation policy. This worktree was observed without `.codegraph/` at setup on 2026-09-07; the user has since authorized local index creation here only. Recheck per actual task, record the applicable fallback or query, and do not claim index completion from this amendment or use another worktree's index.
- **Baseline and review status:** before implementation reconcile fresh `main` with `source_checkout`. Research/count/source hashes and private audit pins remain historical and are not resealed. The review disposition below is historical evidence for the earlier revision, not a certification of this amendment; no new validation is implied.
- **Contract authority:** tool catalogue defines proposed public names/data/limits; primary product docs define evidence about capabilities, not executable endpoints. Existing versions retain adapters until consumers migrate.
- **Errors:** stable reasons for missing T0, bad clocks, ambiguous refs, denied scope, unproved surface, stale release, missing bytes, incomplete quote, unapproved policy, absent model route and missing labels. Each maps to a safe next action.
- **Documentation:** one runbook for fixtures, source-to-metric definitions, exact tool proof/trace retrieval, activation, kill switches and rollback. Link existing ops procedures; never copy secrets.
- **Data changes:** additive read-run enum/request/receipt fields and baseline/shadow tables only where required, compatible readers and bounded projection replay; no destructive rethread/retag or source-mail edits.
- **Stack:** existing TypeScript/Hono/tRPC/Drizzle/React Router/Recharts/Playwright/Vitest/Mastra components. No extra warehouse, model-judge platform, KB editor or browser-control framework.
- **Change loop:** private repro → synthetic failing case → scoped code fix → independent review → fresh capability evidence. No hot patch under an old fingerprint or public customer artifacts.
- **Operating measures:** tool correctness, incomplete/failure/abstention rates and actual run/maintenance cost. These do not establish labor savings. Routine developer decisions belong to the agent; real authority gaps remain explicit.

---

## Independent Review Disposition

The assertions in this section are historical: they certify the earlier plan/catalogue revision, not this plan-execution/validation amendment. No new review or validation is claimed for this document-only edit.

Seven independent reviewers checked the earlier revised plan/catalogue for coherence, feasibility, scope/simplicity, product fit, design, security and adversarial cases. Six findings (two P1, three P2, one P3) were resolved: model-free worker admission/ownership, honest historical classification limits, action-pending wording, distinct event deposit fields, signed overbooked inventory and explicit alternative count ordering. A source-verified follow-up also prohibits the existing unknown-deposit-activity-to-paid fallback.

For that earlier revision, feasibility, security, design and adversarial reviewers performed bounded fix checks and reported no remaining findings. The primary agent checked the small coherence wording fix against recomputed counts and reviewed developer-experience requirements. These are document/source reviews, not application tests or current live capability proof.

The separate historical scope review retained dashboard → read tools → later drafting/evaluation, generic C-suite metrics, existing folders as one breakdown, and removal of the task study/feed-repair platform. Selected examples still do not establish population prevalence, complete replies, labor savings or commercial impact.

Historical tooling exception: GStack helper binaries and the named ponytail-review skill were unavailable. Written-checklist engineering/design/developer-experience review and an independent scope/simplicity review provided the disclosed fallback. Alternate reviewer deployment/rate-limit failures were retried successfully with bounded inherited-model work; all seven review angles completed for that earlier revision. No formal named-helper pass or host-wide skill installation is claimed.

The [private research and review disposition](../../../.private/pms-tools-replan-2026-09-07/research-and-review-disposition.md) records original findings, resolutions, source checks, fallback limits and preserved local state. The prior final planning audit pins that earlier revision; previous plan reviews do not certify this amendment. Actual capture start, approved processing, installed PMS roles/inert transport/current releases and later implementation tests remain scoped activation gates.

---

## GSTACK REVIEW REPORT (HISTORICAL EARLIER REVISION)

| Review | Rounds | Status | Findings |
| --- | ---: | --- | --- |
| Engineering completeness | 2 | Written checks + independent feasibility/security/adversarial review and fix checks; helpers unavailable | Model-free execution/ownership, classification vintage, event deposit meaning, signed inventory and unknown financial activity resolved |
| Simplicity / scope | 1 | Independent fallback complete; named ponytail skill unavailable | Preserve executive dashboard first, bounded read toolkit second; no timer/feed-repair platform or new queue/browser framework |
| Design / accessibility | 2 | Written checks + independent design review and fix check; helpers unavailable | General business charts, accessible states and truthful action-pending definition retained |
| Developer experience | 1 | Primary-agent written-checklist review; helper unavailable | First fixture result, direct read executor, contracts, errors, exact gates, additive migrations, release/rollback and trace handoff covered |

Rounds count document review and performed fix verification, not successful invocations of unavailable helpers. Implementation, deployment and business impact remain unverified.

VERDICT (EARLIER REVISION ONLY): PLAN REVIEWED WITH DISCLOSED TOOLING FALLBACK. NO UNRESOLVED PLANNING DECISIONS. THIS AMENDMENT HAS NO NEW REVIEW VERDICT.
