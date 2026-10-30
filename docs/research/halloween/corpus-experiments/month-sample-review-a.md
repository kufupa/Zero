# Lane A saved-mail review

## Decision signal

**Keep Nava’s Quote → Create order unchanged.** This small, deliberately stratified packet supports a narrow product requirement: distinguish a human quote request from a booking instruction, an automated notice, and a rate or board change on an existing stay. Read only what was available at selection time, including quoted history embedded in the selected message. If stay dates, room allocation, occupancy, or board remain unclear, ask staff rather than filling gaps from unseen files or later messages.

This is a product-decision input, **not** a production evaluation, golden-set result, recall/precision estimate, or evidence of staff adoption.

## Sample and labels

All 30 supplied records are inbound and timestamped inside the protocol’s predeclared window. The packet contains 20 candidate and 10 complement records. Actual counts by stored-date block:

| Block | Candidate | Complement | Total |
|---|---:|---:|---:|
| 1 | 5 | 3 | 8 |
| 2 | 5 | 2 | 7 |
| 3 | 5 | 3 | 8 |
| 4 | 5 | 2 | 7 |
| **Total** | **20** | **10** | **30** |

Lane A is one half of the predeclared sample. Together, the two lanes met the per-block aim of ten candidates and five complement records; the selector and its independent replay verified the draw.

| Input label | Candidate (n=20) | Complement (n=10) | Overall (n=30) |
|---|---:|---:|---:|
| Human quote request: yes | 5 | 0 | 5 |
| Human quote request: no | 11 | 5 | 16 |
| Human quote request: unclear | 4 | 5 | 9 |

The strata are oversampled by design. Do not read these counts as overall mail mix, classifier performance, or quote recall.

Among the 14 yes/unclear cases, field-source labels were:

| Fact | In selected message* | Only in separate earlier message | Not provided | Unclear |
|---|---:|---:|---:|---:|
| Dates | 4 | 0 | 2 | 8 |
| Room allocation | 0 | 0 | 5 | 9 |
| Occupancy | 2 | 0 | 2 | 10 |
| Board | 2 | 0 | 2 | 10 |
| Party or rate clue | 6 | 0 | 0 | 8 |

\* “In selected message” includes earlier text quoted inline in that message. “Only in separate earlier message” means a distinct earlier same-thread record in the supplied input. An inline quote is already visible at selection; it does not imply that a separate thread fetch is required.

All input labels were first saved before outcome data was opened. After outcome review, the reviewer corrected two source-location statuses: inline quoted history counts as selected-message evidence, and screened selected text cannot support a “prior-only” claim. The reviewer reports using only the input packet for these corrections. The original pre-outcome label file was not retained separately, so independence from outcome knowledge cannot be verified for those two cells.

## Later same-thread evidence

Seven of 30 cases have at least one saved later outbound in the supplied outcome packet: 17 outbound messages are listed and 9 additional later outbounds are omitted. The first supported action counts are:

| First supported action in saved thread window | Cases (n=30) |
|---|---:|
| Price or quote | 1 |
| Clarification | 1 |
| Manual approval | 0 |
| Decline or alternative | 0 |
| Other | 3 |
| No saved outbound | 23 |
| Unclear | 2 |

One of the seven threads with a later outbound has another inbound between the selected message and that outbound. Its action is thread-level evidence, not a proven reply to the selected message. Even without an intervening inbound, same-thread presence does not prove delivery or booking completion. **No saved outbound does not establish that no reply exists elsewhere.**

## Anonymized patterns

1. **Booking instruction, then a date question.** The selected message is a booking instruction with sender-supplied rates, not a request for a quote; the visible text lacks stay dates. The first later outbound asks for dates, but another inbound arrived first. The clarification is supported as a thread action, while its relation to the selected request remains uncertain.
2. **Existing stay, rate adjustment.** The selected message asks for a bed-and-breakfast-only rate and itself contains inline confirmation context. A separate earlier same-thread message corroborates the existing/provisional stay, but is not needed to see that context. No later outbound is saved in the packet window; this is not proof that staff did not reply elsewhere. The attachment claims were not verified.
3. **Group quote, then changed allocation.** One selected message contains inline earlier request history and asks for revised, separated quotes; the first later outbound explicitly offers a quotation and states a sign-and-return condition. A later sampled message in the same thread changes the group allocation; its first later outbound is a non-quote stay update that refers to an attachment, so it is categorized as “other,” not treated as a verified quote or booking. The selected and included prior bodies are truncated, 25 earlier messages are omitted, and attachments were not opened; rooming and board remain uncertain.

## Limits and exclusions

- The packet has 30 distinct source rows but 29 distinct threads; one thread contributes two sampled records. Exact-content deduplication was not independently checked. The coordinator independently replayed the selection, including date, transport and inbound filters, against the saved snapshot. A saved row is not proof of delivery.
- The input includes 16 earlier messages and omits 27 more under its context limits. Five records have a withheld selected subject or body; one selected body is truncated. Where a masked or screened field could affect a label, it remains unclear rather than being treated as absent.
- The later packet contains 17 listed outbound messages and omits 9 more. The intervening inbound’s content was not supplied for this review. Only the first supported action was categorized; later messages do not establish a completed booking or other outcome.
- No attachment content or attachment inventory was used. Links were not followed. Attachment claims are not proof that a file was present, delivered, or contained a quote. Sender identity, delivery, room holds, booking status, charges, and refund completion were not inferred.
- Sensitive payment or credential content was not reproduced; where a message was screened for it, relevant labels remain unclear. No live mail, HMS, database, full-corpus, or external-service access was used.
- This note omits guest and company names, addresses, source identifiers, domains, exact dates, quoted prices, and raw excerpts. It does not propose a new workflow order or a production pass bar.
