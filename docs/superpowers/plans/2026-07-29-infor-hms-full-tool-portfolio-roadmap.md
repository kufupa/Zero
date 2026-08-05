# Infor HMS Full Email-Automation Tool Portfolio Roadmap

> This roadmap defines the complete product direction. Executable implementation starts in `docs/superpowers/plans/2026-07-30-infor-hms-read-foundation.md` and continues through evidence-gated child plans. The 2026-07-29 autonomous-tools plan is superseded.

**Goal:** Maximize accurate autonomous drafting and eventually execute approved hotel workflows, while keeping autonomous live-HMS discovery and development strictly non-mutating.

**Core correction:** `hms_find_reservation`, `hms_quote_stay`, and `mail_read_artifact` are a foundation slice, not the final production portfolio. Permanent read-only scope would not meet product goal.

## Empirical Coverage Baseline

Corpus: 223 messages in 193 threads from 27–29 July 2026.

Independent whole-corpus audits used different valid questions. Keep their denominators separate:

- **Primary drafting denominator:** 56 threads that required a customer/staff draft, including four internally routed requests. Current three tools strictly complete at most 0–3: **0–5.4%**. The upper bound assumes quote/document evidence that this revised plan now keeps partial until proven.
- **Historical workflow denominator:** 68 real historical reply/action workflows. Seven survey replies need no HMS tool. Current candidate pipeline, including those no-tool replies, completes about 7–11: **10.3–16.2%**.
- **Tool-dependent historical denominator:** 61 of those 68 required authoritative facts or actions. Tool-earned Full is about 0–4: **0–6.6%**, depending on attachment and quote evidence.
- **Broad reply-worthy denominator:** 97 threads when outbound-only and unclear cases are included. A permissive audit counted 9 Full, but seven were email-only feedback replies and two relied on optimistic quote behavior.
- **Operational portfolio denominator:** 116 hotel-operational threads when machine booking/payment sync and document delivery are included. Use this to size integrations and operational tools, not to claim drafting success.

Current tools are useful in many more workflows—roughly three quarters of tool-dependent cases—but mostly as partial enrichment. “Useful” must never be reported as “autonomously draftable.”

Maintain five separate KPIs:

1. `draft_eligible_full_rate = materially complete draft-eligible workflows / 56`
2. `historical_full_draft_rate = materially complete historical workflows / 68`
3. `tool_full_or_partial_rate = workflows receiving useful evidence / 61`
4. `operational_capability_rate = operational threads with authoritative disposition / 116`
5. `open_action_full_rate = materially complete current open actions / current open-action denominator`

Do not combine no-tool replies, completed/no-action messages, machine sync, or outbound wrappers with tool-earned drafting coverage.

## Corpus Workflow Demand

- Stay and accommodation quotes: 24 threads.
- Invoice, payment, voucher, pro-forma, and tax-document workflows: 20.
- Post-booking guest service: 20.
- Group, series, allocation, and rooming workflows: 10.
- Reservation amendment/cancellation: 3.
- Automated channel notices, system reports, confirmation wrappers, internal operations, spam, and quarantine messages remain triage—not draft-tool wins.

Observed demand comes from a two-day sample. Tool priorities must be re-scored monthly against a larger labelled corpus.

### Outbound workflow evidence

All 26 recorded outbound messages were templated reservation confirmation/pro-forma deliveries:

- 26/26 used document-delivery wrappers; zero contained a bespoke human-written explanation.
- Each claimed one confirmation plus one pro-forma: 52 document references.
- 17/26 had a recoverable booking/change trigger; nine lacked a preserved preceding trigger.
- Current three reads provide partial evidence for all 26 but complete none.

Therefore end-to-end coverage needs more than drafting text:

- Related-message reconstruction across split threads.
- Full reservation/account/folio state.
- Existing document/version lookup.
- Confirmation and pro-forma generation.
- Controlled attachment delivery.
- Delivery-status, retry/reroute, OTA fallback, and communication audit.

## Safety and Product Boundary

### Autonomous build/discovery boundary

- Live HMS actions remain read-only.
- Never submit, save, create, amend, cancel, assign, post, settle, refund, send, print, or export during autonomous discovery.
- Never type into a live form where input/change/blur can autosave.
- Unknown requests abort before transmission.
- Mixed read/write screens require a view-only role plus request-level allowlist.
- CRS `Check Availability` is forbidden for discovery because official documentation states it creates a reservation record.

### Product target

- Production does not remain permanently read-only.
- Write adapters are implemented against synthetic fixtures and disabled for live HMS first.
- Each write operation receives a separate human-supervised live-validation plan.
- Only validated operations enter production registry.
- Every production write requires authorization, idempotency, before/after evidence, post-action reread, audit record, and action-specific rollback/escalation behavior.
- Financial writes remain later than reservation/group writes.

## Verified Infor Surfaces

Official documentation supports these capability families:

- Room inventory viewing: [Room Availability](https://docs.infor.com/hms/3.8.x/en-us/hmsolh/s_t1424428570987.html)
- Rate calculation: [Display Rates](https://docs.infor.com/hms/2025.x/en-us/hmsolh/s_t1424428571268.html)
- Reservation creation and confirmation: [CRS reservation](https://docs.infor.com/hms/2025.x/en-us/hmsolh/s_t1424428583967.html)
- Existing-stay lifecycle: [Guest Stay](https://docs.infor.com/hms/3.8/en-us/hmsolh/pages/osresv_help.html)
- HMS delivery audit: [Sent Email](https://docs.infor.com/hms/2025.x/en-us/hmsolh/pages/pssnel_help.html)
- Property-specific forms and terms: [Property Forms](https://docs.infor.com/hms/2025.x/en-us/hmsolh/s_t1424428600707.html)
- Folio documents: [Email Folios](https://docs.infor.com/hms/2025.x/en-us/hmsolh/msh1719480545520.html)
- Folio transactions and balances: [Working with Folios](https://docs.infor.com/hms/2024.x/en-us/hmsolh/s_t1424428571861-2.html)
- Ledger facts: [Hotel Ledger Report](https://docs.infor.com/hms/2025.x/en-us/hmsolh/s_t1424428555324.html)
- Deposits: [Advance Deposit](https://docs.infor.com/hms/3.8/en-us/hmsolh/s_t1424428571674.html)
- Tax documents: [Tax Invoices](https://docs.infor.com/hms/3.8/en-us/hmsolh/s_t1424428580083.html)
- Group context and rooming lists: [Group Booking](https://docs.infor.com/hms/3.8/en-us/hmsolh/pages/groupbooking_help.html)
- Group blocks: [Subgroup Room Blocks](https://docs.infor.com/hms/2025.x/en-us/hmsolh/s_t1424428588367.html)
- Group room assignment context: [Group Delegate Room Blocking](https://docs.infor.com/hms/2025.x/en-us/hmsolh/s_t1424428590099.html)
- Event operations: [Event Reservations](https://docs.infor.com/hms/3.8/en-us/hmsolh/s_t1424428591097.html)
- Event documents: [Banquet Event Order](https://docs.infor.com/hms/3.8/en-us/hmsolh/s_t1424428560300.html) and [Event Pro Forma](https://docs.infor.com/hms/3.8/en-us/hmsolh/s_t1424428560909.html)
- Internal guest requests: [Guest Messages](https://docs.infor.com/hms/2025.x/en-us/hmsolh/s_t1424428576354.html)
- Follow-up tasks: [Traces, Alerts, and Locators](https://docs.infor.com/hms/2025.x/en-us/hmsolh/mru1429015474343.html)

Documentation proves product capability, not target-tenant entitlement, permissions, selectors, or harmless report execution. Live read promotion still requires guarded observation.

## Tool Portfolio

### Wave 0 — Email and approved-knowledge evidence

Production:

- `mail_read_artifact`
  - Read authorized email attachment by server-derived ID.
  - Current formats: text and embedded-text PDF.
  - Next native formats: DOCX, XLSX, and CSV with bounded parsers.
  - Images and scanned PDFs remain `manual_required`; no OCR in this program phase.
- `mail_search_related`
  - Reuse existing transport-scoped mail FTS/thread primitives to reconstruct split workflows using server-derived reservation references.
  - Keep this deterministic preprocessing, not a model-exposed arbitrary mailbox query tool.
- `property_policy_lookup`
  - Read approved property facts: check-in/out, parking, Wi-Fi, meals, amenities, cancellation wording, transport contacts, and escalation rules.
  - Source must have named human owner, version, and expiry.
- Deterministic thread-state parser
  - Resolve latest request, quoted staff replies, duplicate history, automated notifications, and already-completed actions before any tool call.

Expected observed-corpus effect: seven email-only workflows plus better evidence for attachment-heavy threads. No HMS mutation.

### Wave 1A — Read foundation

Detailed implementation: `2026-07-30-infor-hms-read-foundation.md`.

This executable lake includes required thread-state and native-artifact parts of Wave 0 plus HMS reads below. `property_policy_lookup` waits for a named human-owned source.

- `hms_find_reservation`
  - Search by confirmation, external reference, or bounded surname/date tuple.
  - Return core stay identity, dates, status, room type, rate plan, source, and ambiguity.
  - Do not silently widen into finance, documents, profiles, or service requests.
- `hms_quote_stay`
  - Compose separately observed Room Availability and Display Rates reads.
  - Return inventory observation, rate calculation, amount basis, room type, rate plan, currency, tax/inclusion/restriction evidence, organization eligibility, and unresolved fields.
  - Always return `bookable: false`; separate screens do not prove one executable offer.
Wave 1A consumes the Wave 0 `mail_read_artifact` capability rather than redefining it. Foundation is successful when architecture, evidence, safety, freshness, UI, and shadow evaluation work. It is not program completion.

### Wave 1B — Safe communication/configuration reads

Add immediately after foundation:

- `hms_read_sent_email_audit`
  - Determine whether HMS sent a confirmation/document.
  - Return timestamp, type, recipient, attachment metadata, report code, error, and delivery state.
- `hms_read_property_forms`
  - Return approved property-specific confirmation, cancellation, pro-forma, and folio wording/terms.
  - Suppress configuration controls; never save.
- `hms_find_existing_document`
  - Start with confirmation/pro-forma version, generation state, confidentiality suppression, attachment metadata, and missing/stale status.
  - Expand document-type enum in Wave 2 rather than adding overlapping lookup tools.
- `mail_get_delivery_status`
  - Return delivered, deferred, bounced, or channel-reroute state for an authorized message/recipient.

These prevent duplicate sends, explain delivery failures, and ground property-specific wording.

### Wave 2 — Finance and document reads

Highest missing read family by observed actionable-thread count.

- `hms_read_folio`
  - Return authorized balance, charges, payments, adjustments, settlement state, and source transaction IDs.
- `hms_read_advance_deposit_status`
  - Return requested, due, paid, refunded, forfeited, transferred, and unresolved deposit facts.
- `hms_read_tax_invoice`
  - Return existing invoice ID, status, pay-by date, void/final state, fiscal/e-invoice state, and safe document metadata.
- `hms_run_hotel_ledger_report`
  - Return bounded account/guest/group ledger facts only after report side effects are proven harmless.
- Extend `hms_find_existing_document`
  - Add quote, folio, invoice, voucher, and receipt document types without generating or sending them.

Required policies:

- Recipient-class disclosure matrix.
- PCI/card/VCC redaction.
- Fiscal and e-invoice rules per property/country.
- No payment allocation, settlement, refund, transfer, finalization, generation, or send in read wave.

Recompute cumulative autonomous coverage after each read child plan passes tenant discovery and frozen-corpus replay. Do not pre-credit unbuilt or unverified reads.

### Wave 3A — Group reads

- `hms_read_group_booking`
  - Return group status, dates, rates, billing instructions, linked events, notes, and transport context.
- `hms_read_group_blocks`
  - Return room block by date/type, pickup, release date, restrictions, and remaining allocation.
- `hms_read_rooming_list`
  - Return delegate/reservation summary with privacy filtering.
- `hms_read_group_room_assignment_context`
  - Return assigned/unassigned delegate counts and eligible room context without assigning.

### Wave 3B — Event reads

- `hms_read_event_reservation`
  - Return event status, dates, room/items, organization/group, billing reference, and totals.
- `hms_run_beo_report`
  - Return BEO operational requirements and existing artifact metadata.
- `hms_run_event_pro_forma`
  - Return estimated event charges/tax and existing artifact metadata.

### Wave 3C — Guest-service and operational reads

- `hms_read_guest_messages`
  - Return current message/callback/internal-action status.
- `hms_read_guest_traces`
  - Return trace/alert/locator status and due context.
- `hms_read_room_status`
  - Return authorized room-readiness/housekeeping context.

No block updates, room assignments, event edits, message creation, trace creation, or room-status writes in read wave.

## Write-Capability Track

### Wave 4A — Fixture-tested candidate adapters

Implement one operation per child plan and run only against literal-loopback synthetic fixtures. Start with `reservation.create`; do not scaffold all operations at once.

Write-adapter development remains live-HMS read-only:

- Adapters may be production-real deterministic write code, including exact request construction and submit logic.
- They must execute only against literal-loopback synthetic fixtures. Production HMS origins, credentials, cookies, and guest records are forbidden test inputs.
- The test harness must fail closed before transmission if a write adapter is pointed at any non-fixture origin.
- Autonomous research may read reviewed HMS screens only. It must not open write-form screens, type into forms, trigger autosave events, or issue mutation requests to discover fields.
- Official documentation, sanitized read-only observations, and synthetic fixture forms provide contracts until Wave 4B.
- Adapters remain outside Mastra and production registries. Building real write code does not authorize running it against live HMS.

Internal operation IDs remain stable across phases:

- `reservation.create`
- `reservation.amend`
- `reservation.cancel`
- `document.generate_confirmation_proforma`
- `document.send_confirmation`
- `folio.email`
- `mail.send_with_attachments`
- `mail.retry_or_reroute`
- `group.update_block`
- `group.update_rooming_list`
- `group.assign_delegate_room`
- `guest_message.create`
- `guest_trace.create`
- `event.create_or_amend`

Fixture adapters are not Mastra tools and do not enter production registry. Promotion changes registry policy, not operation names or implementation namespaces.

Each adapter must define:

- Strict typed input and server-derived property/actor.
- Preconditions and authorization scope.
- Idempotency key.
- Preview of exact intended changes.
- Expected request signature.
- Synthetic before/after state.
- Success proof and post-action reread contract.
- Ambiguous-outcome handling.
- Action-specific escalation/compensation.

### Wave 4B — Human-supervised live validation

Separate plan, one operation at a time:

1. Human reviews docs, selectors, request signature, preview, and rollback/escalation.
2. Human selects a client-approved synthetic/test record or explicitly authorized production case.
3. Human supervises one live execution.
4. System rereads authoritative state and compares expected delta.
5. Audit log and duplicate replay test pass.
6. Operation remains disabled until agreed success threshold is reached.

Validation order:

1. Create reservation.
2. Amend low-risk reservation fields.
3. Cancel an explicitly authorized test reservation.
4. Send confirmation to controlled recipient.
5. Group block/rooming-list operations.
6. Guest messages/traces.
7. Event operations.
8. Financial/document delivery operations.

### Wave 4C — Gated production writes

Validated operations enter registry behind per-action policy with these model-facing tool IDs:

- `hms_create_reservation`
- `hms_amend_reservation`
- `hms_cancel_reservation`
- `hms_generate_confirmation_proforma`
- `hms_send_reservation_confirmation`
- `hms_email_folio`
- `mail_send_with_attachments`
- `mail_retry_or_reroute`
- `hms_update_group_block`
- `hms_update_rooming_list`
- `hms_assign_group_delegate_room`
- `hms_create_guest_message`
- `hms_create_guest_trace`
- `hms_create_or_amend_event`

Model never receives a generic browser, selector, arbitrary URL, or arbitrary form-submit tool.

Do not publish write-coverage projections before each operation passes fixture replay, human-supervised validation, and frozen-corpus recomputation.

## Non-Infor and External Tools

Infor cannot authoritatively complete every workflow.

- `ota_reply_status`
  - Booking.com/Expedia/Trip.com delivery failures and platform messaging.
- `payment_link_status`
  - H-Pay/ProfitRoom or contracted payment provider; source not assumed to be HMS.
- `reputation_case_context`
  - GuestRevu/survey workflow.
- `crm_or_sales_case_context`
  - Corporate/group sales follow-up outside HMS where applicable.

`property_policy_lookup` and `mail_get_delivery_status` remain defined once in Waves 0 and 1B. No web-scraped value may become a live price, policy, payment, or booking commitment.

## Execution Program

1. Execute `2026-07-30-infor-hms-read-foundation.md` through read-only shadow evaluation.
2. Let each active child plan own guarded discovery for its exact surfaces; do not browse future waves speculatively.
3. Lock the 56-thread draft-eligible eval set and 116-thread operational capability set; retain the 68 historical reply/action set as a secondary replay lens.
4. Write and execute detailed child plan for Wave 1B.
5. Write and execute detailed child plan for finance/document reads.
6. Write and execute detailed child plan for group/event/operational reads.
7. Recompute all denominators after each wave without changing their membership rules; report newly received mail separately until relabelled.
8. Build only `reservation.create` fixture adapter first; add another operation after its contract and demand justify reuse.
9. Stop before any live write.
10. Start separate human-supervised validation plan only with explicit user authorization.

Child-plan creation is evidence-gated: exact target selectors, request signatures, tenant features, and view-only behavior come from guarded discovery rather than invented placeholders.

Every executable child plan must embed the overnight autonomy/RCA mandate, explicit per-task subagent routing, one-implementer-at-a-time review loops, orchestrator-only live HMS access, and the same fixture-only boundary for write-capable code. Implementation uses Composer 2 normal/non-fast by default; Grok 4.5 normal/non-fast handles research, difficult RCA, high-risk review, and final review. Fast variants and GPT-5.6 Sol Max implementation are forbidden.

## Promotion Gates

Per read tool:

- 100% request-policy compliance.
- Zero observed live mutation.
- Exact property/tenant binding.
- No cross-thread or cross-property leakage.
- Factual precision at least 99% on labelled eligible fields.
- Explicit unresolved fields rather than guesses.
- Freshness policy enforced.

Per write tool:

- Read gates pass first.
- Fixture before/after, replay, timeout, ambiguous-outcome, and idempotency tests pass.
- Human-supervised live validation completed.
- Post-action reread proves exact intended delta and no unrelated delta.
- Named approver and role policy configured.
- Action remains independently disableable.

Program:

- Coverage reported against historical workflows, current open actions, and rolling live corpus separately.
- New tool added when a repeated uncovered authority appears, not from speculative product breadth alone.
- No tool is removed from roadmap merely because it is not in the first implementation tranche.

## Terminal Condition

Autonomous program may finish read tools and fixture candidate writes. It must stop before first live write. Human-supervised validation is the next explicit authorization boundary.
