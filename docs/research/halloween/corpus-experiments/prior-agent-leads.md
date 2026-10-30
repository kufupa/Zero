# Prior-agent linkage leads

**Summary:** An independently written [count verifier](verify-prior-counts.py) reproduced the selected aggregate claims listed below from saved source records. Other incidental counts in the stopped transcript were not all independently checked. Near-time address overlaps are not proof of shared booking journeys. Follow-up source review strengthened one case, E1, after finding an earlier customer-facing PDF record.

## Method and denominators

- The prior run read the saved corpus for 19–23 Oct: 759 resolved threads, 1,288 message rows, 92 PDF records, and 68 duplicate-candidate groups (transcript events 67–69, 90). The PDF-parent joins were checked against thread, timestamp, direction, and stored-date fields (event 87; result 90).
- For the ±30-minute pass, it parsed From/To/Cc with Python `email.utils.getaddresses`, trimmed and lowercased addresses, and inferred the internal domain from the unique domain in outbound From fields. Remaining addresses were treated as external. Each PDF's `selectedMessageTimestamp` anchored an inclusive ±30-minute window. Candidates shared either an exact normalized address or, in the relaxed pass, an external domain; the parent message itself was excluded, messages were grouped by Message-ID (or source-row ID if absent), and results were split by same versus other thread (tool call 87; result 90). The PDF denominator was 92.
- A separate strict rule counted only earlier inbound messages in another thread whose external From matched an external address on the PDF parent. It used 30-minute, 6-hour, and 24-hour windows and only the 86 PDF parents with at least one external address (tool call 122; result 124).

The verifier reads the private five-day directory and prints aggregate counts only:

```sh
python3 -I -B docs/research/halloween/corpus-experiments/verify-prior-counts.py \
  .private/centurion-five-day-20261019-23-data-20261030-02
```

It independently reproduced the input counts, all 92 parent joins, duplicate-group count, the following overlap and strict-window counts, candidate composition, and the In-Reply-To counts. Its grouping follows the old method's Message-ID deduplication, inclusive time window and inferred internal domain; it does not independently label candidate journeys.

## Independently reproduced aggregates

| Prior-run result | Result | Evidence |
|---|---:|---|
| Exact-address overlap in another thread, ±30m | 70/92 PDFs (76.1%); 198 candidate links | Events 87, 90 |
| External-domain overlap in another thread, ±30m | 75/92 (81.5%); 320 links. Domain-only subset: 34/92 (37.0%), 122 links | Events 87, 90 |
| Strict earlier inbound, other-thread match | 15/86 within 30m; 59/86 within 6h; 64/86 within 24h. A prior strict link was found for 67/86, with median nearest-link lag 68m | Events 122, 124 |
| Exact same-thread inbound before PDF, within ±30m | 0/92 | Events 87, 90 |
| Other-thread exact ±30m candidates after excluding PDF-parent messages | 70/86 had any candidate; 55/86 still had at least one non-PDF-parent candidate | Events 122, 124 |

The broad overlaps are weak journey evidence: among 198 other-thread exact candidates, 173 were outbound and 116 were other PDF-parent messages (event 106). The reproduced header count shows 91/92 PDF parents lacked an In-Reply-To header; one resolved to an inbound message in the same thread (event 90). The PDF counts in the exact and domain-only rows can overlap and must not be added. These are saved-record co-occurrences, not bookings, customer outcomes, or recall.

## Scope of journey leads in the stopped transcript

The stopped agent's own messages and count-only outputs identify one example journey, E1; they do not establish a separate no-booked-reply case or a quote-without-confirmation case. Those examples were selected independently from the saved source corpus and checked as [B02](booking-journeys.md) and [QJ-03](quote-journeys.md), not attributed to the stopped agent. The [case lead verifier](verify-case-leads.py) rechecks E1's source relationships and bounded searches for B02 and QJ-03. Their search limits are stated in the case reviews.

## E1: candidate request/reply sequence

The prior tool found one saved thread with an inbound message, a non-PDF outbound reply, and a later PDF parent: positions 1, 2, and 4 in a six-message thread. The inbound-to-reply gap was 66 minutes; reply-to-PDF was 1,433 minutes; inbound-to-PDF was 1,499 minutes (events 106, 115). Its header checks reported that the reply's In-Reply-To named the inbound message, and the PDF's References/In-Reply-To named the inbound message but not the reply. The inbound and reply shared an external address; neither shared an external address with the PDF parent (event 115).

**Initial interpretation:** E1 supports an inbound-to-reply sequence, with a later PDF parent that has no external participants. That internal forward alone does not prove a customer-facing confirmation. The case was selected as the first sequence in file order, not ranked as strongest evidence. Exact source pointers are retained only in the owner-only, ignored file `.private/corpus-experiments-20261030/prior-agent-leads-pointers.json`.

**Follow-up source review:** E1 is the independently selected case B03 in [booking journeys](booking-journeys.md). The original PDF email, on the preceding day, went to the request sender about eight stored minutes after the staff reply. Its PDF bytes match the next-day internal forward. The request, staff reply and original PDF therefore have supporting participant, header, identifier and file-hash evidence. Stored records still do not prove delivery or the historical HMS write.

## Limits

- The corpus note read in event 38 describes this as a source-linked snapshot, not a complete mailbox export, delivered-mail count, labeled set, or current HMS truth. The prior aggregate output marked the timestamp timezone basis unverified (event 69).
- The verifier reproduced that 91/92 PDF parents were earliest among their saved thread messages. It also reproduced zero cases where saved thread-first metadata preceded the earliest saved message. That metadata check does **not** establish whether earlier mail exists outside the saved window. A nearby match can reflect batching or other coincident mail; it cannot by itself establish a booking, reply, or PDF delivery.
- The verified aggregate calculations remain exploratory candidate counts, not a representative or accuracy evaluation. E1 received the separate source review described above; the HMS write and delivery remain unobserved.
