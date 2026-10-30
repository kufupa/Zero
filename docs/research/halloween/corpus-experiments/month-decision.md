# Expanded Centurion journey decision

Historical 2026-10-30 synthesis. For the later cloud-tool implementation, see [HMS Cloud tooling](../../../../apps/server-pilot/tooling/hms-cloud/README.md).

**Decision:** Keep the owner-set Quote → Create → Amend order. Build toward a reviewable quote prepared on open from an actual request and the rewritten HMS availability, party and rate tools. The wider evidence sharpens context, rate, attachment and existing-stay safeguards. It does not prove a universal cross-thread graph is a prerequisite, establish a production pass or quantify ROI.

## Evidence and change from the five-day run

| Evidence | What it establishes | What it does not establish |
|---|---|---|
| [Saved Centurion coverage](month-source-inventory.md) | 5,229 saved logical messages across 3,364 threads on 28 September–23 October, including 3,941 messages in the added period. The separately selected confirmation subset contains 473 PDF records, including 381 in the added period. | Complete mailbox coverage, all attachments, or 473 unique bookings. Stored dates are not timezone-verified. |
| [Predeclared inbound sample](month-sample-protocol.md) | 60 deliberately stratified inbound messages from 59 threads. Reviewers labeled 11 quote requests, 34 non-quote and 15 unclear. | Population case mix, recall, precision or a production pass. Two input cells were corrected after outcome review; their independence cannot be verified. An eight-case blind check disagreed on two classifications and two later-action categories. |
| [Earlier-period quote cases](month-quote-cases.md) and [previous five-day quotes](quote-journeys.md) | Family availability before party-rate negotiation; room-only/B&B ambiguity; multiple rooms with separate dinner; management review; a withdrawn quote. | Correct HMS eligibility or price, verified quote-file content, representative frequency or measured staff time. |
| [Earlier-period stay cases](month-stay-cases.md) and [previous five-day stays](booking-journeys.md) | Self-mail pre-stay concerns an existing stay; one email can refer to four confirmations; documents and later HMS can disagree; plausible links can remain ambiguous. | That every identifier or same-sender candidate is the intended stay, when a reservation was created, or whether a requested change was made. |

The wider period did **not** justify switching the next workflow away from Quote. It does strengthen the case for keeping separate requests and existing stays separate, treating party eligibility and meal basis explicitly, and showing an honest needs-you result. Unlike the previous recommendation, this does **not** direct work toward debugging old quote code. The owner says the tools are being rewritten.

## The recommended first product slice

1. **Understand the selected request.** Read the selected email, including quoted text already inside it. Keep human travel-agent requests in scope and apply existing front-door exclusions to automated/channel mail. Keep contact, guest and company/agency distinct. Capture dates, room-type counts, occupancy, alternatives, board and dinner. Bind prior same-thread context to the right request and show its provenance; nearby messages can describe another booking. Apply supported product defaults rather than inventing missing facts. Preserve uncertainty when text, context or a needed attachment is unavailable.
2. **Prepare using authoritative reads.** For the correct property and requested dates, read availability and eligible rates for each relevant room/occupancy option. Search company/agency candidates and confirm the intended party where uncertain; sender or domain alone is not a binding rule. Separate BAR B&B, room-only and hotel-specific dinner. Preserve staff-authorized manual or saved rates and the product's required authorization for discounts.
3. **Make review useful.** Show room lines, relevant inclusions, amounts and totals where supported, with clear exceptions. Offer the product's PDF and Excel quote outputs, editable reply and unsent draft on both Outlook and webmail. Generate the PDF on staff action. Do not say a room is held, automatically book, or put the company name in the reply body. If pricing, eligibility or availability cannot be established, say what needs staff attention rather than fabricate a quote. For genuinely full dates, use the product's one-line decline default; include an alternative only if staff selects it.
4. **Keep booking and amendments separate.** A request can ask for both quote and booking; the quote is not approval to book. For an existing stay, look up the intended confirmation, compare the request against the current record, preserve mismatches and require the separate approved write-and-review workflow. Self-addressed pre-stay mail with a confirmation is pre-arrival information, never a create request.

### Why this is the highest-value bet, not a measured ROI

The owner has prioritized quotes, and reviewed cases show concrete pricing, review and communication work. Preparing a grounded quote can remove repeated interpretation and lookup work while leaving the staff decision intact. But we observed neither staff clicks nor time saved, build/maintenance cost, production usage, nor a representative case mix. The benefit and return are qualitative hypotheses, not measured savings.

**Strongest alternative:** Leave all quotes manual until the new tool chain proves correct. This avoids a wrong price or party binding. The recommended middle ground is to prepare only what the reads support, leave exceptions to staff, and prove the end-to-end quote on real request data before treating the feature as usable. Current rewritten availability, party matching, eligible pricing, pane integration, output correctness and staff bundle behavior were not tested here.

## Context, attachments and cross-thread links

- **Selected email first.** A reminder's quoted history supplied the request; reading only its newest top-level line would miss it. In another thread, two adjacent requests concerned different stays. Carrying prior fields wholesale would mix them. [Examples](month-sample-review-b.md#anonymized-case-patterns).
- **A bounded earlier-message read is useful but not proven universally necessary.** Among four sample flags for prior context, two concerned text already quoted inside the selected message, one distinguished a separate booking, and one remained uncertain. No independently verified example in those four established that a separate earlier message was necessary to fill a quote field. The targeted follow-up blind check was not performed. Keep relevant prior context available with provenance and do not make an unbounded thread graph a condition for all new quotes.
- **Handle actual needed files; do not assert they are absent.** The saved all-mail export has neither complete attachment inventory nor raw MIME. If a real request depends on an accessible attachment, read it with its provenance or leave the relevant facts for staff. An email claiming an attachment does not prove its bytes or contents. These data do not justify building a universal attachment parser first, or deferring needed attachment handling altogether.
- **Use links as evidence, not guesses.** Confirmation references, message headers, participants and stay details can support a relationship. Same sender, domain or a short time window alone cannot prove one. Existing-stay workflows may need bounded cross-thread search; this research does not establish that a universal graph must precede a new quote.

## What the rewritten readers provide

[1a, 1b and 1c source and evidence](month-reader-capabilities.md) concern an identified existing stay, not new-request availability or current eligible quote rates.

| Reader | Useful observation | Boundary |
|---|---|---|
| **1a: confirmation** | Finds an exact existing confirmation, with optional name/date hints, and captures rendered cards and grids. | Ambiguous or capped results fail rather than guess. Existing stay rates are not new quote prices. |
| **1b: Record View** | Reads visible stay dates, occupancy, rate/meal facts, company/agency and other rendered fields. | Hidden tabs and unloaded grid pages are excluded. A readable value does not prove writability, historical state or current rate eligibility. |
| **1c: Guest Details** | Reads visible controls and the current rendered guest grid for the selected record. | The saved reader did not select a guest row. Hidden or unloaded data and transfer fulfillment remain unknown. |

An independent [added-period anchor check](month-source-inventory.md#independent-check-of-the-added-periods-saved-hms-reads) matched all 381 selected PDFs to 294 later saved reader results by attachment ID and filename-derived token. 1a/1b confirmation headers matched all 381 anchors. In the 294 later captures, first- and last-name form controls in 1c were rendered but empty, while visible aligned grid rows had nonempty cells under both name headers. Four captures had nonempty arrival-time grid cells. These are nonblank-cell counts, not proof of complete guest data or transfer arrangements. The captures are later observations, not the state at the original request.

## Verification limits and scope correction

- Only original decision-time mail and actually available prior material may be input to an evaluation. Later replies, PDFs and HMS captures can be outcome evidence but cannot fill missing original inputs. HMS batches confirmations, so PDF send time is not booking time.
- The small sample omitted some prior messages, withheld sensitive bodies, truncated one body and could mask date-like strings. Three later-outbound packets had intervening inbound mail. Missing saved outbound does not prove no reply elsewhere. Full details and blind-check disagreements are in the [protocol](month-sample-protocol.md).
- One quote worker initially processed the full snapshot: 10,812 message rows and 1,407 selected-PDF metadata rows lay outside the requested window. Its broad PDF non-link claim was withdrawn, and its retained case histories contain only in-window messages. A stay worker's exploratory metadata scan also surfaced a 16 September record; the final five cases and PDF parents are in window. Outside records are excluded from the conclusions. Private original quote dossiers remain unchanged.
- No live HMS access, product implementation, outbound mail, flag change or deployment occurred in this run. No current rate, attachment coverage, live tool chain, price correctness or workflow pass was established. The relevant product evaluation and property-specific live proof remain separate work requiring the applicable authority.
