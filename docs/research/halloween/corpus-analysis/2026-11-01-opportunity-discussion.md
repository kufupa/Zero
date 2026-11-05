# Centurion opportunity discussion

## Agreed direction

- Estimate potential help if the selected workflows work; staff approval counts. One meaningful contribution makes the answer yes, even when staff handle other parts; no partial/full reporting needed.
- Focus: quote, booking, amendment, cancellation, POP/voucher upload, and invoice-related work below. Group requests over 10 rooms are unsupported. OTA work, including failure alerts, is outside this analysis.
- Headline unit: actionable inbound emails; separately count enquiries. Base: genuine non-OTA reservation emails, including unsupported groups; show group counts separately. Triage alone is not help.
- Invoice requests linked to automatic HMS confirmations count. Invoices provided by staff in-thread also count, with a separate human-intervention flag. This is the owner's hypothetical scenario, not proof the feature is implemented.
- Keep a breakdown by category, including human-involved invoice work. Record requests to make payment as a future triage category, not a workflow to build now.
- Count potential help even when no outbound match is found. An outbound only contributes to a Nava-help metric when linked to an associated action; distinguish staff replies and HMS confirmations.
- Later replies can help interpret a request. Strip repeated quoted context while retaining relevant earlier content; avoid excessive input.
- Let the model infer from available context; do not force a random guess or offer a generic guess option. If nothing supports a decision, record the specific missing information.
- Near-term focus: rapid speed/accuracy research for the last month of Centurion, then Da Vinci and other sources.
- Use an LLM and concrete reasons for uncertainty; avoid an indiscriminate `unknown` bucket. Haiku preferred for future bulk work if available.
- Client mail may be shown in this conversation; no automatic anonymisation required.
- Batch discussion questions so the owner can answer them together.

## Evidence

- Pilot complete: 250 inbound rows assessed; 50 were random holdout. No full-corpus run yet.
- The [pilot prompt](pilot-250-review.py) is custom, not the [application triage prompt](../../../../apps/server-pilot/src/ai/workflows/mail-triage.ts). Its unknown-heavy instructions and three-way unanimity left 36/50 eligibility results unresolved.
- Case P146: all three identified a quote; one left scope unknown, so the roll-up was unresolved.
- Application prompt groups quote and booking and uses 10+ rooms/delegates for group routing. Owner's research exclusion is more than 10 rooms, so treat current triage as a reference rather than the answer.

## Open

- Determine how invoice requests, HMS confirmation letters and staff-sent invoices relate in real examples; avoid assuming every confirmation is an invoice.
- Determine how to recognise outbound actions and cross-thread confirmations efficiently without treating every nearby message as the answer.

## Next

Run a small, fast test on recent Centurion mail, including real replies; compare results and cost/time with the earlier pilot. Refine the simple opportunity-specific prompt before a bulk run.
