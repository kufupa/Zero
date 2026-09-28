---
title: Standalone Stagehand Fetch Quote - Plan
type: feat
date: 2026-09-17
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: user-approved-standalone-quote-scope
execution: code
---

# Standalone Stagehand Fetch Quote - Plan

> **Superseded implementation plan:** `docs/plans/2026-09-17-002-feat-playwright-fetch-quote-plan.md` is now canonical. Preserve this document as requirements/history, but do not follow its Stagehand/model implementation loop when executing the quote tool.

## Goal Capsule

- **Goal:** build and prove one standalone Stagehand v4 tool that obtains real Infor HMS availability, prices and terms for the selected corpus request.
- **Client-mandated screen:** Front Desk → Availability → **Hotel Availability**, including its adult/child/age inputs. Room Type and Rate Availability (OSRRAV) is not an acceptable substitute.
- **Deliverable:** a repeatable, parameterized command/script, its actual quote result, and concise evidence showing that the result matches the PMS. No Nava integration is required.
- **Authority:** the user approved the current PMS account, unrestricted Stagehand development requests, GPT-6 Astra inference, live-first development and later deterministic conversion. These decisions supersede conflicting legacy Stagehand development instructions.
- **Coding model policy:** GPT-5.6 Luna at max reasoning orchestrates and handles normal coding; GPT-6 Astra at extra-high reasoning writes the Stagehand workflow and handles qualifying debugging escalations. Stagehand's Azure Astra runtime is a separate model configuration and usage stream.
- **Scope correction:** this replaces the earlier conversational plan's Nava UI/API/job-store work. There is no U4 for Nava. Do not build an email parser, classifier, reply generator, service, queue, deployment integration or folio tool.
- **Execution posture:** implement the complete goal-directed workflow, run it, inspect what happened, repair the actual failure and rerun. Login, scaffolding, tests and a partial extraction are not the deliverable.
- **Planning boundary:** this document authorizes future implementation when explicitly launched. Its creation did not execute PMS actions, change the runtime or start a goal.

## Product Contract

### Client screen requirement

The client's instruction supplied on 2026-09-17 is explicit: use **Hotel Availability**, not Room Type and Rate Availability, because the client's quoting workflow must account for children. This is a workflow requirement, not a recommendation to choose whichever screen is easiest to automate.

[Infor's 2026.08 Hotel Availability instructions](https://docs.infor.com/hms/2026.08/en-us/hmsolh/jxo1557688477063.html) specify Front Desk → Availability → Hotel Availability and a Guests input covering adults, children and child ages. Search displays rates for the entered criteria; selecting a rate opens Availability Details; Reserve is a separate reservation-creation action.

Verify the actual Hotel Availability heading/form and applied guest inputs during execution. A guessed function code, matching URL, generic shell, old quote test, or HTTP 200 does not establish that the correct screen produced the quote. Do not fall back to OSRRAV, Room Availability, Display Rates, Start Center summaries or CRS as the quote search source. Related read-only rate/policy details remain usable without replacing Hotel Availability as the pricing workflow.

**Current evidence boundary:** the plan selects the correct screen; the new `fetch-quote.mjs` entrypoint was not implemented at this plan update. Legacy quote code still exists and is not proof of this workflow. The screen choice is verified from the client instruction and official docs; tenant execution and child-pricing behavior must be demonstrated by the implementation.

### Selected real request

Use Message 33 in `.private/connected-mailbox-corpus/connected-mailbox-inbox-2026-09-01-eod.md`, headed `Quotation request - Sanatmetal Ltd.`; its text starts near line 5284. Read that message directly, not the whole corpus. No guest names or email addresses are needed in the tool's public examples.

| Input | Value / interpretation |
|---|---|
| Property | Centurion, HRCEN |
| Arrival | 2026-09-24 |
| Departure | 2026-09-27; three nights |
| Guests / rooms | Two adults, two rooms; use one adult per room, documenting this interpretation |
| Children | Zero in this adult-only request; explicitly clear stale child inputs. This case does not prove child pricing. |
| Room preference | Standard room with a double bed |
| Board | Breakfast |
| Flexibility | Flexible cancellation and/or date modification requested |
| Additional question | Whether advance payment by bank transfer is possible |

These are request inputs, not assumptions about availability, room codes, prices or hotel policies. Resolve actual room/rate labels from the PMS. If execution happens after these dates cease to be searchable, select another suitable real corpus request and document the substitution; never silently change the original dates or present a current quote as a historical price.

### Requirements

- R1. The tool accepts already-understood quote inputs from a private JSON file or equivalent ordinary function arguments. The implementing LLM prepares the selected input; no email ingestion or extraction application is built.
- R2. Execute the complete client-mandated Hotel Availability workflow and return the actual matching options, availability, prices, currency, price basis and displayed terms. Verify the real screen and inspect relevant read-only details for breakfast, flexibility and payment information; no alternate quote-search source is an acceptable fallback.
- R3. Distinguish requested preferences from satisfied preferences. Preserve missing information and unmet preferences; never invent availability, a room-code mapping, a policy or a total.
- R4. Produce a structured result plus a short readable explanation. A small extraction schema is allowed; a bespoke deterministic PMS parser is not required for this phase.
- R5. Use Stagehand code mode with the approved Azure GPT-6 Astra deployment for model-assisted actions/extraction. Prefer existing deterministic login and stable locators where they already work.
- R6. Diagnose and repair application, selector, wait, session, extraction and tool failures until the quote workflow works. Removing automatic request blocking is not permission to ignore broken behavior or accept false success.
- R7. Preserve adults, children, supplied child ages and their per-room allocation in the request and applied PMS criteria. Do not flatten children into adults, drop ages, reuse stale occupancy or invent missing ages needed for pricing. Add one bounded child-bearing live verification case before claiming child-aware quoting is proven.

### Not part of this goal

Nava sidebar/forms/buttons; tRPC/API integration; server job state; email parsing/classification; response templates; sending mail; reservation create/amend/cancel; folio/deposit completion; document generation; production promotion; a whole-portfolio rewrite; model-free execution before initial delivery.

## Global Constraints

- **No Stagehand request allowlist:** do not install the legacy request firewall, exact endpoint/body manifests, unknown-request teardown, or a replacement upfront request-approval system in this development path. Normal browser requests, search-field changes and page navigation do not require individual approval.
- **Task intent still matters:** this is a quote request. Filling dates, occupancy, beds/room preferences and filters is expected. Do not click Reserve, create a reservation, change an existing booking/rate, post money or send an email. Enforce this through the task instructions and chosen code, not a newly built network firewall.
- **No account detour:** use the current authorized PMS account. Do not require a read-only account or test hotel as a prerequisite. A real credential failure or PMS permission denial still needs diagnosis and truthful reporting.
- **No inherited release ceremony:** do not require the legacy registry, role-proof adapter, immutable proof bundle, per-request review or video packaging pipeline before each run. Do not wrap the new script in the old guarded runtime.
- Preserve unrelated code, dirty worktree changes and evidence. No commit, push, destructive Git, global cleanup, production database migration or unrelated deployment is authorized by this plan.
- Never point tests at pilot/production RDS or set `VITEST_ALLOW_PILOT_RDS`. Before any Vitest invocation, unset `DATABASE_URL` and `VITEST_ALLOW_PILOT_RDS`; no database is needed here.
- Keep credentials, API keys, cookies, session/CSRF tokens and authentication headers out of prompts, logs, Git and SSM command output. Authorized customer/business data can be inspected privately for this task. Provider retention settings do not establish retention for our own files or logs.

## Autonomous Execution Mandate

When launched, work toward this plan's Definition of Done without routine approval questions. Use `$caveman` for concise progress messages; write code and documentation normally.

Use Codegraph for targeted code exploration before editing. Fall back to `rg` and direct reads when the index is unavailable, stale or does not cover the needed material. Do not re-audit weeks of chats or reclassify the corpus.

One owner controls the live PMS browser. Inspect current ownership before starting; a paused parent chat does not establish that its workers or browser stopped. Reuse or hand over only explicitly owned resources. Do not terminate unrelated processes or launch a competing browser operation.

Make ordinary implementation and repair choices independently. Use current official Stagehand/Infor documentation and web research when a concrete unknown warrants it; keep customer data out of web queries. New MCP installations are not prerequisites: those servers are optional documentation connectors, not the automation runtime.

The loop is **complete workflow attempt → inspect real outcome → identify cause → repair → repeat**. Build an elegant end-to-end script, not separate micro-goals for login and each click. Individual Stagehand actions remain specific even though the script covers the entire task.

If two attempts repeat the same failure without new evidence, inspect the failing state and change the mechanism rather than repeating the same approach. Expected slow PMS work is a wait, not proof of a stuck session. No short checkpoint is permission to call an incomplete tool complete.

Delegate the Stagehand workflow implementation to the Astra specialist specified below; other bounded subagent tasks are optional and default to Luna. Do not create a mandatory implementer/reviewer pipeline or parallel browser controllers. A specialist may run the live workflow only after an explicit exclusive-browser handoff. The user-approved live-first sequence overrides generic test-first/per-task-review workflow defaults for this goal.

Missing customer data, a genuine external outage, or access requiring human intervention may be a blocker after relevant checks. An unknown request shape, a failing test, a browser-path mismatch or an unfamiliar UI is not by itself an external blocker: investigate and fix it.

## Planning Contract

### Coding models and escalation

The user manually selects the main Codex session's model. The orchestrator must select subagent models explicitly for the authorized exceptions; this plan does not change the main session or global Codex configuration.

| Role | Model / reasoning | Scope |
|---|---|---|
| Main orchestrator | GPT-5.6 Luna, `max` | Coordination, integration, routine diagnosis and final verification; manually selected by the user |
| Default coding/research subagents | `gpt-5.6-luna`, `max` | Normal supporting code, documentation, bounded research and routine fixes |
| Stagehand coding specialist | `gpt-6-astra`, `xhigh` (extra high) | Write the complete Stagehand quote script, its browser/model integration and initial workflow repairs; authorized from the start, without waiting for three failures |
| Major-debugging escalation | `gpt-6-astra`, `xhigh` (extra high) | One focused blocker still unresolved after three substantive Luna diagnosis/repair/verification attempts on that same issue |
| Stagehand runtime inference | Existing approved Azure GPT-6 Astra deployment | Model-assisted browser actions/extraction inside the running script; separate from Codex coding agents, retaining the existing runtime configuration |

For debugging, count distinct evidence-backed repair attempts, not tool calls, clicks or identical retries. The earlier two-repeat rule means change approach; after the third unsuccessful Luna attempt on the same issue, delegate that blocker to an Astra xhigh subagent. Include the failure evidence, attempted fixes and success criterion. Do not manufacture three failures before using the already-authorized Stagehand coding specialist.

Keep Astra assignments bounded to the Stagehand workflow or the escalated blocker, then return routine work to Luna Max. Do not upgrade the orchestrator, default every subtask to Astra, or restart whole-project research. Explicitly pass the requested model and reasoning settings when spawning; use a supported task-scoped context handoff rather than a full-history fork if the latter prevents model overrides. If the requested model/settings are unavailable, report that instead of silently substituting.

Give each coding agent a clear file scope and preserve one live browser owner. Record actual coding model/reasoning, escalation reason and available usage in the existing progress/handoff notes, separately from Stagehand runtime usage; no new orchestration or billing framework is required.

### Reuse facts, not the old machinery

- The isolated dependencies already exist at `apps/server-pilot/tooling/stagehand/package.json`: Stagehand 4.1.0, Playwright 1.63.0, Node >=22.18. Use the matching installed Chromium 1243 and extension configuration, not an ad-hoc Playwright 1.52/Chromium 1169 overlay.
- Chromium runs on the PMS-connected EC2 host through the existing VPN. Retain the existing private SSM/CDP connection model; the Stagehand controller and Azure credentials can remain on this VPS. Do not build an application service or move credentials merely to execute this standalone task.
- `apps/server-pilot/src/hms/runtime.ts` contains working login actions, `waitForAuthenticatedShell` and timing instrumentation, but its session orchestration installs the old guards. Extract/reuse the login behavior through native Playwright, not the guarded session wrapper.
- `apps/server-pilot/src/hms/stagehand-browser.ts` and `apps/server-pilot/scripts/hms-stagehand-observe.mjs` show the installed extension/CDP composition and model callback. They are references, not mandatory entrypoints: their existing guards and command restrictions must not carry over.
- Reuse the approved Azure callback in `apps/server-pilot/src/hms/stagehand-model.ts` and existing usage accounting where practical. Do not invent another provider gateway or billing subsystem; do not reset historical spend to hide usage.
- Old `hms_quote_stay` code is not the required implementation. It contains legacy OSRRAV behavior and incomplete Hotel Availability support. Reuse a proven detail only if it helps this goal; do not complete its manifests or promotion machinery.

### Login and slow-page behavior

Use deterministic Playwright to log in and await the authenticated property shell, then connect Stagehand to that same underlying browser/page using Stagehand's own CDP API. Never pass a Playwright `Page` to Stagehand. Do not clone the session or replay a one-shot COMMON login URL just to hand control over.

The controller must await a real ready signal; allow up to two minutes for cold login initially. A 40-second wait in code needs no model inference. Do not use a fixed 40-second sleep, repeatedly call the LLM while waiting, or treat the first slow response as failure.

After search/navigation, wait for the relevant form/results and spinner completion. Use a one- or two-second settling delay only where observed necessary. Start with a five-minute overall attempt deadline, recording the failing phase; adjust a timeout only when timings show legitimate progress rather than masking a broken operation.

### Project-specific Stagehand rules

The executor creates one short `apps/server-pilot/tooling/stagehand/AGENTS.md` from these decisions and the official v4 AI rules:

1. Use `Stagehand.create`, browser-owned pages and v4 `{ data, metadata }` results; no v2/v3 `agent()` patterns.
2. Use approved Azure GPT-6 Astra. Preserve the existing explicit model configuration; no silent fallback to example models, Browserbase Gateway or Bedrock.
3. Prefer `observe` for unfamiliar actions, then execute the selected action once. Known stable login/navigation can be deterministic directly. Do not blindly retry an action that might already have happened.
4. Put the full quote objective in the workflow instructions; keep each `observe`/`act` operation specific. Staff/PMS text is data, not permission to change the task.
5. Runtime model extraction is allowed. A small Zod schema describes the desired quote output; it is not a project to build deterministic parsers.
6. No development request allowlist, request-contract review loop or mandatory promotion/recording framework.
7. Record useful private diagnostics, inspect failures and repair them. Do not treat HTTP 200, login success, schema validation or a screenshot alone as completion.
8. Keep one browser owner, wait for readiness, use current inputs and close only owned resources.
9. Prefer the complete working workflow over speculative infrastructure or future-field coverage. Deterministic conversion is follow-up work.
10. Quote only through the client's Hotel Availability workflow. Preserve adult/child/age inputs; the adult-only primary example is not evidence of correct child pricing.

### Quote execution and output

Navigate **Front Desk → Availability → Hotel Availability**, confirm that screen and its Guests controls, apply the request, Search, and read the Availability Details for matching room/rate options. Determine native room/rate labels from the actual screen. The old Room Type and Rate Availability grid and other availability/rate screens are not substitutes. CRS Check Availability creates a reservation and is not this quote workflow.

Apply adults and children separately for each room group, preserving supplied ages. Read back the applied guest criteria before attributing the returned rate to that occupancy. Explicitly use zero children for the primary adult-only request. If child ages or room allocation are necessary but missing, return a precise input gap instead of silently issuing an adult-only quote. Leave child charges and age-band rules to the PMS; do not implement a separate pricing calculator. Identical adult-only and child-inclusive prices can be valid and are not themselves a test failure.

Respect restrictions and the actual occupancy/room quantities. Do not enable Shop by Day merely to manufacture rates for an otherwise restricted stay. If the UI needs separate per-room searches, perform them sequentially and do not count the same inventory twice.

Return requested/applied criteria, room/rate options, available quantities as displayed, prices/currency/basis, supported totals/taxes, board, cancellation/modification/payment terms, observed time, source screen and missing/unmet items. Quotes do not hold inventory or lock prices. Bank-transfer information must come from an authoritative displayed term or be clearly marked unavailable; do not infer it from the guest's request.

The tool may use LLM extraction for all returned data. Check critical values against the visible source and make another targeted read when unclear. No standalone extraction framework, general schema catalogue or deterministic parsing library is required.

## Implementation Units

### U1. Align instructions and reuse browser bootstrap

**Requirements:** R5-R7. **Dependencies:** none.

Create the scoped rules above and reuse the deterministic login/extension/CDP behavior without installing legacy guards. Keep any bootstrap helper within `apps/server-pilot/tooling/stagehand/`; this is support for the full quote attempt, not a separate shipping milestone.

Make only targeted documentation corrections: replace current imperatives requiring discovery-only Stagehand, model-free-before-delivery and allowlist repair in `CONCEPTS.md`, the relevant Stagehand sections of `docs/solutions/workflow-issues/infor-hms-soft-open-wave-a-pms-tool-payload-patterns.md`, and conflicting generic workflow guidance in `.cursor/rules/nava-workflow.mdc`. Label old OSRRAV/video/manifest recipes as legacy where the related playbooks would otherwise misdirect this task. Preserve the actual incident findings and unrelated production rules; do not turn this into a documentation overhaul.

**Verification:** inspect the new execution composition to ensure it does not instantiate the old guarded runtime; the full live quote run must prove the login handoff works. No broad bootstrap test suite is required before that attempt.

### U2. Implement and run the complete standalone quote tool

**Requirements:** R1-R7. **Dependencies:** U1.

**Coding owner:** delegate the Stagehand workflow to GPT-6 Astra at `xhigh`; Luna Max remains the orchestrator. Follow the model policy above and explicitly hand over exclusive browser control if the specialist performs the live run.

Primary entrypoint: `apps/server-pilot/tooling/stagehand/fetch-quote.mjs`. Accept a private request JSON path and output directory; keep reusable logic in that entrypoint or small adjacent helpers. Stagehand SDK imports must resolve from the existing isolated tooling dependencies.

The implementing LLM reads the selected corpus message and prepares its private input. Implement login handoff, Hotel Availability search, details, extraction and output together, then run the entire request. Do not stop after login or build the flow as unrelated proof packets.

Write timestamped private artifacts under `.private/stagehand-quote-mvp/`: request, structured result, short human-readable quote, relevant post-login screenshots and diagnostic events. Log action names, timings, applied criteria, extracted business facts, model usage and useful error categories. Avoid credential-bearing network dumps and do not build a new generic redaction system.

**Verification:** actual PMS response and visible results support the selected dates, two-room occupancy, prices and terms. Fix observed failures; a partially navigated page or unsupported price is not success.

### U3. Verify repeatability and deliver the tool

**Requirements:** R2-R7. **Dependencies:** U2.

Repeat the selected request in a fresh browser session. Verify one changed input against another suitable real corpus request if needed to show the script is parameterized, not a recorded hardcoded answer. At least one known-positive quote must be checked; a genuine unavailable result for the selected dates is acceptable only alongside evidence that the tool reads valid quote results correctly.

Use one real corpus request containing children and supplied ages as the changed-input verification case. Confirm that Hotel Availability applies those values and the extracted rate matches its rendered result. Also exercise missing required age information as an input-gap case, without inventing an age. If no suitable complete child-bearing source can be found in a bounded search, report child-pricing verification as an explicit remaining gap; do not pretend the adult-only case proves it. This is one focused live scenario, not a family-pricing framework or synthetic PMS test suite.

Add only focused post-live regression checks for defects actually found, using `apps/server-pilot/tooling/stagehand/fetch-quote.test.mjs` when useful. These checks may cover argument handling, readiness timeout classification, output completeness or a previously observed extraction mistake. Do not build a parser or a full synthetic PMS fixture suite for this task.

Deliver a short private handoff naming the runnable command, required configuration names (not values), output locations, verified cases, limitations and runtime/inference usage. Standalone delivery is sufficient; do not connect it to Nava.

## Verification Contract

- Confirm primary input against Message 33, without using staff's eventual reply as a hidden answer.
- Confirm the actual Hotel Availability screen/form, not merely a URL/function name. Inspect applied search dates, nights, adults, children, supplied ages, per-room allocation, room quantities, room/rate identity, currency and quoted values.
- Verify one child-bearing quote against the PMS display. Do not require a nonzero child surcharge: matching the source's correctly applied occupancy is the criterion. An adult-only success or a fixture schema is not child-pricing proof.
- Verify breakfast/flexibility claims from details; identify unmet preferences. Distinguish displayed nightly sums from authoritative occupancy/tax-inclusive totals.
- Exercise a fresh-session rerun and a missing-required-input case. A timeout, login page or unrendered grid must be reported as a failure, not no availability.
- Preserve enough source evidence to compare critical returned facts without mandatory video editing, checksums for every request, or immutable bundle rebuilding.
- For new `.mjs` code, run `node --check` on the entrypoint and helpers; run `node --test apps/server-pilot/tooling/stagehand/fetch-quote.test.mjs` if focused tests were added. Run TypeScript checks only for TypeScript code actually changed. No database-backed test run is needed.
- Report elapsed wall time separately for login, PMS/navigation, inference and repair. Record token usage where supplied; do not label public-rate estimates as an Azure invoice or conflate Stagehand usage with coding-agent usage.
- Partial/unknown values stay explicit. Continue investigating missing required quote data; if a commercial policy is genuinely not exposed, document that source limitation rather than fabricating it or claiming every guest question was answered.

## Definition of Done

- The standalone command executes the full quote task using the approved Stagehand/Astra setup and real corpus inputs.
- Live evidence identifies the client-required Hotel Availability screen and supports a quote with supplied child/age inputs. No OSRRAV or alternate-screen result is credited as this proof; an unresolved child-pricing check remains explicitly incomplete.
- A live positive and fresh-session rerun support the critical availability/pricing output; any selected-case unavailability is genuine, not a script failure.
- The quote report contains supported prices and terms, applied inputs and explicit limitations. No required price/occupancy data remains unknown because of an unresolved tool defect.
- Targeted failures discovered during execution are fixed; credentials are not exposed in the delivered artifacts.
- The new Stagehand development path has no inherited request allowlist/automatic unknown-request teardown. Unexpected behavior is still inspected and corrected by the executor.
- The instructions and concise standalone handoff match the delivered behavior; owned resources are closed or explicitly handed over, and abandoned task-specific experiments are removed without disturbing user work.
- No Nava UI/API, email parser, reply system, job framework, folio work or production integration was built as a prerequisite.

## Sources and Deferred Work

Use these as targeted references, not a mandate to reread the entire project:

- [Stagehand v4 AI rules](https://docs.stagehand.dev/v4/first-steps/ai-rules): correct APIs, observe/action replay and model extraction.
- [Stagehand Playwright migration](https://docs.stagehand.dev/v4/migrations/playwright): separate page types, explicit waits and deterministic API differences.
- [Stagehand browser configuration](https://docs.stagehand.dev/v4/configuration/browser): local/CDP setup; hosted caching is not assumed locally.
- [Infor Hotel Availability](https://docs.infor.com/hms/2026.08/en-us/hmsolh/jxo1557688477063.html): Search, occupancy, rate details, restrictions and separate Reserve action.
- [Infor CRS workflow](https://docs.infor.com/hms/2026.08/en-us/hmsolh/s_t1424428583967.html): why CRS Check Availability is not a quote-only action.
- `docs/solutions/workflow-issues/hms-live-proof-packaging-vs-payload-completeness.md`: keep the lesson that successful packaging can hide wrong/missing facts, not its whole historical gate framework.
- `docs/solutions/workflow-issues/hms-hitl-ui-first-playwright-recorder-build.md`: useful wrong-input/spinner lessons; its old OSRRAV instructions are historical.
- `docs/plans/2026-09-16-001-feat-stagehand-read-tool-trial-plan.md` and `.private/stagehand-trial-20260917/`: locate working infrastructure and prior ownership evidence only. The folio objective and old execution restrictions are not this goal.

**Deferred:** deterministic conversion replaces runtime model navigation/extraction with proven code after this tool works, without freezing quote values or automatically recreating the firewall. Nava integration, email interpretation, new booking/cancel tools and additional compliance work are separate future goals. Do not pursue them during this execution.
