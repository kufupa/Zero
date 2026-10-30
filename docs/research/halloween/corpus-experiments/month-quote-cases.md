# Centurion quote cases: 28 September–18 October 2026 (evidence through 23 October)

**Finding:** The saved snapshot contains 3,941 Centurion message/source rows in the request-selection period. Six purposively selected threads expose useful quote-preparation needs: room and occupancy options, public versus requested party rates, room-only versus meal plans, dinner as a separate component, staff review, internal-versus-customer communication, and requests with no same-thread reply observed by 18 October (later status unknown). **No case verifies an HMS rate or an actual quote attachment. PDF linkage is unknown under the corrected scope.**

## Scope and method

- Source: the existing owner-only saved snapshot, described in the [coverage inventory](month-source-inventory.md). This note uses message dates 28 September–23 October 2026 inclusive; comparisons use each message's stored timestamp prefix, whose historical timezone basis is unverified. A saved row is not proof of delivery.
- Request-selection period is 28 September–18 October inclusive: **3,941 saved message/source rows**, 2,926 inbound and 1,015 outbound. The broader permitted evidence period through 23 October contains **5,229 rows across 3,364 threads**.
- The [local selector](month-quote-select.py) date-filters thread evidence to 28 September–23 October, then selects active Centurion-transport inbound requests dated 28 September–18 October with a quote/rate/tariff term **and** a room/stay/accommodation/meal term. Its earlier run found **772 candidate inbound messages across 578 threads** using the narrower request-period context. This is a keyword screen, not a quote-request denominator: quoted history can create false positives, and different wording can be missed.
- Six threads were selected purposively for distinct decision needs, not as a random or representative sample. Their **33 retained messages** are dated 29 September–18 October. Participant overlap and saved `References` headers were checked separately from message wording. No prevalence, quote-recall, accuracy, ROI, or time-saved claim follows.

### Scope correction and processing disclosure

- Earlier selector/thread lookup parsed the full **16,041-row** snapshot before date filtering. **10,812 rows** were outside the permitted window: **9,524 before 28 September** and **1,288 after 23 October**. The snapshot extraction extended through 29 October; those later rows are not evidence for conclusions here. The six retained case histories contain 33 messages and **zero** rows outside 28 September–23 October.
- Earlier PDF matching scanned **1,880 confirmation-PDF parent-metadata records**: **1,407 were outside scope** (**941 before 28 September; 466 after 23 October**) and **473 were dated within the permitted window**. The date filter is the parent message's stored timestamp prefix; matching used filename tokens and did not open PDF bytes. The previous broad “no case link” result is withdrawn. Although those 473 in-window records were included in the mixed-scope scan, no isolated in-window-only match result is retained. Case-to-PDF links are **unknown**; this note does not claim an in-window no-link result.
- Earlier Q04/Q06 wording “through the snapshot cutoff” exceeded scope and is withdrawn. This note reports no later same-thread staff row only through the 18 October request-selection slice; follow-up status for 19–23 October is **unknown**.
- No out-of-window message body or PDF content supports the corrected case claims. Private dossiers remain unchanged.

## Case summary

| Case | Request-first pattern | Saved staff action | Link status | Rewritten HMS need |
|---|---|---|---|---|
| **Q01** | Family availability inquiry; later asks about a party rate and multiple room options | First reply communicates rate/breakfast language; later staff review and customer-directed follow-up | Request-to-reply **supported** by thread, participants, and header references; rate-to-HMS and file links **unknown** | Availability by date, occupancy and room count; public and eligible party rates; meal inclusions |
| **Q02** | Organization-rate request with room-only and breakfast wording | First reply has rate/management language; later outbound message goes to a different recipient | First request-to-reply **supported**; later customer-facing outcome **unknown** | Separate room-only/B&B options; party eligibility; manual authorization path |
| **Q03** | Multi-room quote request with breakfast and dinner | Staff replies in-thread; later inbound follow-ups and another staff reply | Request-to-staff-message **supported**; whether a reply contained a priced quote or actual file **unknown** | Multi-room availability; breakfast rate and dinner add-on separately; staff clarification |
| **Q04** | Public-rate and room/meal wording in a long, unsegmented inbound message | No later staff row in reviewed 28 September–18 October slice; 19–23 October follow-up **unknown** | Inbound record **supported**; quote intent and public-rate interpretation **candidate**; follow-up outcome **unknown** | Separate current request from quoted/embedded history; do not bind a rate family from wording alone |
| **Q05** | Breakfast quote request needing clarification | Internal staff message precedes customer-directed rate/proceed message | Internal message is not a customer reply; later request-to-customer-reply **supported** by participants and references | Party/rate review, explicit authorization, and separate internal versus customer-facing content |
| **Q06** | Party-rate/availability request with breakfast and negotiation wording | No later staff row in reviewed 28 September–18 October slice; 19–23 October follow-up **unknown** | Inbound record **supported**; quote outcome, HMS rate, and file links **unknown** | Prepare only from verified availability/rates; otherwise show staff what needs review |

### Q01 — Availability first, party-rate discussion later

- **Request:** The first inbound message on 29 September asks about availability for a family stay and one or two rooms. It does not start as an explicit company-rate request.
- **Staff follow-up:** The first customer-addressed staff reply later that day contains rate and breakfast language. Its saved references point to the request, and its recipients include the requester. A later inbound message introduces party-rate/negotiation wording. Subsequent saved messages include internal staff review and later customer-directed rate/proceed wording.
- **Links:** Request to first reply is **supported as an email relationship** by participants and headers. Internal messages belong to the saved conversation but are not customer-facing replies when recipient differs. HMS rate, booking, and actual quote-file links remain **unknown**.
- **Staff lens:** Staff used availability and occupancy context, then reviewed a party-rate request. The record does not show an HMS-side eligibility check, a generated PDF, a pane click, a held room, or a booking.
- **Rewritten HMS capability:** Read availability for requested dates, occupancy and room-count alternatives; return public and selected-party rate options with board/inclusions. Keep any party-rate selection distinct from the first availability inquiry. Do not imply a hold.
- Private source: [Q01 dossier](../../../../.private/month-quote-cases-20260928-1018-20261030-01/cases/Q01-private.txt).

### Q02 — Room-only and breakfast wording with management review

- **Request:** The first inbound message on 1 October asks about an organization/party rate and contains both room-only and breakfast wording. Treat that combination as two options or a detail needing confirmation, not as a silently resolved board choice.
- **Staff follow-up:** A customer-addressed staff reply follows about 16 stored minutes later. It contains rate and management-review language and references the request. Several inbound follow-ups follow. A later staff outbound message is in the same thread and references the request, but its recipient differs from the original requester; do not treat thread membership alone as proof that customer received a final quote.
- **Links:** First request-to-reply is **supported** by matching participant and header evidence. Later customer-facing outcome is **unknown**. No HMS rate, booking, or quote file is verified.
- **Staff lens:** Management review is visible in correspondence; no evidence shows which party/rate was eligible in HMS, what authorization was granted, whether a quote document was produced, or whether a booking followed.
- **Rewritten HMS capability:** Offer room-only and B&B choices separately; search eligible company/agency rates only after staff selects or confirms the party. Preserve an authorized manual/discount path instead of translating an email amount into an HMS rate.
- Private source: [Q02 dossier](../../../../.private/month-quote-cases-20260928-1018-20261030-01/cases/Q02-private.txt).

### Q03 — Multi-room request with breakfast and dinner

- **Request:** The first inbound message on 7 October is an explicit multi-room quote request with breakfast and dinner wording and a requested party rate. It also contains attachment-related language; no actual file is captured in this case dossier, so file status is unknown.
- **Staff follow-up:** A customer-addressed staff reply appears the next day, with matching participants and a saved header reference to the request. More inbound follow-ups and another staff reply appear on 8–9 October. The top-level staff text review did not establish a numeric rate; do not infer a priced quote from later quoted text or an attachment statement.
- **Links:** Request-to-staff-message is **supported** as a saved correspondence link. Price, actual file, HMS state, and booking links are **unknown**.
- **Staff lens:** The request combines room count, breakfast, dinner, and party-rate requirements. Staff responded, but the saved evidence does not establish what rate or document they offered, or whether the requester accepted.
- **Rewritten HMS capability:** Read availability by date, room type and count; calculate eligible B&B pricing; keep dinner separate unless a hotel-specific dinner price is evidenced. Surface any missing party or occupancy detail before staff review.
- Private source: [Q03 dossier](../../../../.private/month-quote-cases-20260928-1018-20261030-01/cases/Q03-private.txt).

### Q04 — Public-rate wording in an ambiguous, unanswered message

- **Request:** The only inbound row in this thread is dated 15 October. The long message contains public-rate, room-only, breakfast and negotiation wording, but has no detected quoted-history boundary. Treat these as **candidate signals**, not a gold-labelled public quote request.
- **Staff follow-up:** No later staff row appears in the reviewed same-thread slice through 18 October. Whether a response followed during 19–23 October is **unknown**; this does not establish absence in another thread, channel, or unsaved mail.
- **Links:** The inbound row is **supported** as a saved message; its quote intent and rate-family interpretation are **candidate**. Reply, HMS, attachment, and booking links are **unknown**.
- **Staff lens:** No staff action is visible in this thread. No price, PDF generation, staff click, or booking is observed.
- **Rewritten HMS capability:** Separate the current request from embedded/quoted history; do not choose public versus contract pricing from sender or a keyword alone. If dates, board, or intent remain unclear, leave the quote in a staff-review state.
- Private source: [Q04 dossier](../../../../.private/month-quote-cases-20260928-1018-20261030-01/cases/Q04-private.txt).

### Q05 — Internal rate check before customer-facing reply

- **Request:** The first inbound message on 16 October asks for a breakfast quote and contains clarification/manual-review signals.
- **Staff follow-up:** The first outbound staff message references the request but is addressed to someone other than the requester; it is internal coordination, not a customer quote. An inbound follow-up follows. Later that day, a customer-addressed staff message contains rate/breakfast and proceed-question wording, with matching participant and header evidence. A later inbound row exists, but this does not prove acceptance or a booking.
- **Links:** The internal staff message is **candidate** evidence of the review path, not a customer-facing action. The request-to-later-customer-reply link is **supported**. Rate eligibility, actual quote file, guest acceptance, and booking remain **unknown**.
- **Staff lens:** Staff coordinated internally before sending a customer-facing rate message. No evidence shows a completed HMS rate check, recorded authorization, actual PDF, a click in Nava, or a reservation write.
- **Rewritten HMS capability:** Provide a property/date/party-specific rate read and explicit manual authorization state. Keep internal approval content out of the customer reply; prepare an editable unsent reply and generate a quote PDF only on staff action.
- Private source: [Q05 dossier](../../../../.private/month-quote-cases-20260928-1018-20261030-01/cases/Q05-private.txt).

### Q06 — Party-rate request with no saved same-thread response

- **Request:** The only inbound row is dated 18 October and contains rate/availability, party-rate, breakfast, and negotiation wording.
- **Staff follow-up:** No later same-thread message appears in the reviewed 28 September–18 October slice. Whether a response followed during 19–23 October is **unknown**; this does not prove no off-thread, unsaved, or otherwise uncaptured response.
- **Links:** The inbound message is **supported** as a saved record. Quote outcome, HMS rate, actual file, and booking are **unknown**.
- **Staff lens:** No staff action is visible in the thread. Do not translate an unanswered request into a decline or a booking.
- **Rewritten HMS capability:** Prepare a read-only quote when dates, room/occupancy and eligible rate are grounded; otherwise show a concise Needs-you item. Keep dinner separate from B&B and any negotiated rate subject to authorization.
- Private source: [Q06 dossier](../../../../.private/month-quote-cases-20260928-1018-20261030-01/cases/Q06-private.txt).

## What these cases support

1. **Quote-first remains the right product order, but these cases do not prove prevalence or readiness.** Staff mail shows quote/availability activity, manual review, internal coordination, and requests with no same-thread response observed by 18 October; later outcomes remain unknown. Do not infer a universal mix from six selected threads.
2. **Rate text is not HMS truth.** Any amount or rate wording in staff email is evidence of what staff communicated, not a verified, eligible, current HMS rate. The six case dossiers contain no HMS rate proof; no HMS rate was verified.
3. **A stated attachment is not a captured file.** Several messages contain attachment-related language, but no actual quote file is captured in these case dossiers. The earlier broad confirmation-PDF non-link result is withdrawn because its scan included 1,407 out-of-window parent-metadata records. Case-to-PDF links remain **unknown**; do not infer absence of quote PDFs or other files.
4. **Reply and outcome are separate.** Header references plus participant match support some request-to-reply links. They do not prove delivery, quote-document contents, customer acceptance, a room hold, HMS write, or booking. Internal replies and customer replies must remain distinct.
5. **Staff lens:** The workflow needs dates, room type/count, occupancy, requested board, party eligibility, public versus selected-party rates, and dinner pricing where supported. Observed staff actions include rate communication, management/manual review, clarification, internal coordination, and unanswered threads. **No case shows a Nava click, PDF-generation action, saved draft, or write.** No time saved or ROI is measured.
6. **Scope remains the existing quote baseline:** read-only preparation; explicit uncertainty; staff review; PDF generation on staff action; editable unsent reply; Nava never sends. The cases do not justify automatic party binding, a rate guess from sender/domain, automatic booking, or a universal cross-thread linker. See [PRODUCT.md](../../../../PRODUCT.md), [quote-first decision](decision.md), and [rewritten-reader boundaries](month-reader-capabilities.md).

## Private source records

Exact corpus-line pointers, source-row/message identifiers, participant/header fields, and raw excerpts are restricted to the linked owner-only, Git-ignored dossiers under `.private/month-quote-cases-20260928-1018-20261030-01/cases/`. The keyword candidate extraction is also private at `.private/month-quote-cases-20260928-1018-20261030-01/request-candidates.jsonl`. Do not copy those contents into tracked files or external services.
