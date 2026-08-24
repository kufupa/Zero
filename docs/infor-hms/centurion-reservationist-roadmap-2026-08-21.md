# Centurion reservationist roadmap

Status: evidence-led plan. Not proof that any write integration is available or authorized.

## Product outcome

Reservation team sees high-value work first, gets an evidence-backed draft and structured facts beside the conversation, then approves any consequential action. Success means faster, safer handling of genuine reservation work—not maximum autonomous sends.

## Current truth

- Fresh corpus has not been pulled or analyzed yet. Retained DB rows are historical baseline; raw inbound MIME is best-effort enrichment because it expires after 30 days. Outbound RFC822 source and attachments are generally not retained.
- One Cursor standard local subagent is authorized to analyze the private corpus by local path only. Repository AI adapters are fake or remote Bedrock; they must not receive raw corpus data.
- Existing HMS source includes a `live_verified` reservation-find tool, but it is not `shadow_enabled`; the active shadow registry remains gated. No PMS/HMS write executor is enabled.
- Paid SynXis/Infor APIs are intentionally unavailable and out of scope. Product integration uses the hotel's existing authorized HMS browser workflow, not purchased API access.

## Delivery sequence

1. **Corpus evidence**
   - Export all retained `transport-centurion` rows and the entire designated-reservationist mailbox as equal Centurion sources in one repeatable-read snapshot; recover historic address-matched rows if needed, then deduplicate overlaps while retaining non-PII scope membership.
   - Hydrate raw MIME and attachment objects once where still available.
   - Produce one PII-free aggregate report: workflow/source mix, request-fact coverage, reply-link versus SMTP-accepted evidence, attachment gaps, automation candidates, and unknowns.

2. **Safe attention triage**
   - Add `Automated` only after shadow evaluation proves narrow source/marker/no-risk rules.
   - Auto-file only audited routine noise. Failure, payment, policy, cancellation-fee, complaint, security, VIP/privacy, document, and low-confidence messages remain visible/escalated.
   - Snapshot, audited backfill, rollback proof, and manual-override semantics are required before visibility changes.

3. **Draft-first review**
   - Show source conversation, extracted stay/guest/company facts, identity-match evidence, freshness, policy/availability evidence, proposed action, customer-facing draft, and explicit uncertainty.
   - Operator controls: approve, edit, take over, dismiss, pause, retry after reconciliation.
   - No action claims a reservation is confirmed until an authoritative system response proves it.

4. **HMS browser read automation**
   - Release one non-mutating HMS browser surface at a time after existing-user role, tenant/property, request-firewall, live-proof, and shadow-proof gates.
   - Re-check availability/rate/policy immediately before any later action. An availability result is not a hold or confirmed reservation.

5. **Human-approved HMS browser actions**
   - Playwright RPA is the planned action path. Require a per-operation state machine:

```text
proposed → approved → revalidated → submitted → authoritative_outcome → reconciled → customer_notified
```

   - Persist approval identity/time/comment, correlation/idempotency key, request/response hashes, final record lookup, and manual-reconciliation cases.
   - Treat `rejected`, `expired`, `failed`, `duplicate_prevented`, and `unknown_outcome` as distinct states. Never retry create/cancel blindly.

6. **RPA operating controls**
   - Use an existing authorized HMS account or approved operator-session design, test-tenant/shadow proof, selector regression coverage, kill switch, before/after evidence, and named manual exception ownership.
   - RPA never bypasses authentication, MFA, permissions, access controls, or vendor terms.

## HMS browser-automation gates

An HMS browser operation remains unavailable until all apply:

- authorized existing HMS user/role and property proof;
- allowed non-mutating or human-approved action scope;
- approved MFA/session handling;
- test-environment or shadow validation;
- rate/policy, identity-match, and reconciliation contract;
- operation-specific audit, idempotency, and escalation design.

## KPI claim boundaries

- Fresh corpus: inbound volume, workflow/source mix, routine-system share, unknown/uncovered share, attachment-evidence gaps.
- Reviewed triage: rule precision/recall sample, manual overrides, queue placement.
- Draft-review instrumentation: approval/edit/dismiss/takeover rate, approval latency, extraction fidelity.
- Authorized system outcomes: quote-to-confirmed conversion, transaction/reconciliation exception rate.
- Baseline/attribution study: revenue, conversion uplift, staffing savings, response-time impact.

Do not claim revenue uplift, bookings rescued, error-free updates, fully autonomous booking/cancellation, or ROI from draft volume alone.

## Evidence references

- [Centurion corpus refresh plan](../../.cursor/plans/centurion-evidence-refresh_c5e13fb9.plan.md)
- [HMS capability matrix](capability-matrix.md)
- [Infor HMS CRS reservation workflow](https://docs.infor.com/hms/2026.08/en-us/hmsolh/s_t1424428583967.html)
- [Temporal approval pattern](https://docs.temporal.io/design-patterns/approval)
- [Playwright tracing](https://playwright.dev/docs/api/class-tracing)
