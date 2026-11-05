# Synthetic regression examples for classifier prompt v14

All examples below are fictional test fixtures with no real guest data. They exercise boundaries, not ground truth. “Labels” list the expected classifier fields that matter; omitted reply fields use the normal no-match defaults unless shown.

| # | Synthetic inbound/context | Expected labels | Boundary exercised |
|---|---|---|---|
| 1 | “Please quote one group booking for exactly 10 rooms.” | `reservation_email=true`, `can_help=true`, `actions=[quote]` | Exactly 10 is within supported scope; no `group` marker. |
| 2 | “Please quote one group block for 11 rooms.” | `true`, `false`, `[quote, group]` | >10 rooms for one group stays in denominator; group-only quote is unsupported. |
| 3 | “Quote the 12-room conference block; also create a separate one-room stay for the organizer.” | `true`, `true`, `[quote, booking, group]` | Help comes from the distinct individual booking, not the large group. |
| 4 | “Please reserve rooms for 13 delegates,” with no room count or occupancy. | `true`, `null`, `[booking]`; reason names missing room/occupancy count | Do not turn people into rooms or force a group/help label. |
| 5 | “Book 12 delegates in single occupancy.” | `true`, `false`, `[booking, group]` | Explicit single occupancy establishes 12 rooms; group-only booking is out of scope. |
| 6 | “Acknowledged the 18-room group quote; we will review internally.” Current message explicitly refers to that same block. | `false`, `false`, `[group]` | Group marker can survive a non-actionable acknowledgement; the acknowledgement is not a new opportunity. |
| 7 | Current message asks about an unrelated meeting; an old quoted thread below mentions a 12-room block that is not this meeting. | `false`, `false`, `[]` | Stale quoted history alone neither creates current work nor a group tag. |
| 8 | “Please book one room for these dates.” | `true`, `true`, `[booking]` | New-stay creation, not quote or acknowledgement. |
| 9 | “Change the dates on our existing two-room stay.” | `true`, `true`, `[amendment]` | Existing-stay change is amendment. |
| 10 | “Cancel our existing two-room stay.” | `true`, `true`, `[cancellation]` | Explicit cancellation; a different action from amendment. |
| 11 | “I will send the accommodation proof tomorrow.” The complete current MIME inventory confirms zero attachment parts; no other request. | `false`, `false`, `[]` | No current file plus a future promise is not a supplied-document task. |
| 12 | “The booking voucher for this stay is attached; please file it.” MIME/bytes are unavailable and no complete attachment inventory was recovered. | `true`, `true`, `[voucher]` | Unavailable MIME is not confirmed absence; sender's clear statement supports supply, not content inspection. |
| 13 | “Please process the attached document for Stay A.” Attachment metadata gives `stay-voucher.pdf`, but bytes/content are unavailable. | `true`, `true`, `[voucher]` | Filename plus current stay/task context supports an inferred voucher label; say inferred and do not claim inspection. |
| 14 | “The payment proof for this stay is attached; please file it.” A complete current MIME inventory confirms zero attachment parts. | `true`, `false`, `[other]` | Resolve the sender/MIME conflict as no file present; do not invent supplied proof. |
| 15 | “Please process the attached file.” Only metadata is available: generic filename `document.pdf`; no stay or reservation-task context. | `false`, `false`, `[]` | A generic filename without useful context establishes neither document type nor hotel/stay relevance. |
| 16 | “Please file the attached voucher for this stay.” Attachment context includes extracted text identifying it as an accommodation booking voucher for the referenced stay. | `true`, `true`, `[voucher]` | File-content context can establish document type/relevance; no need to infer from its filename. |
| 17 | “Please file the attached bank-transfer receipt for the deposit on this stay.” Attachment context identifies a transfer receipt and the same stay. | `true`, `true`, `[payment_proof]` | Stay-specific payment evidence supplied for filing can qualify. |
| 18 | Automated bank email says “card purchase/order complete,” with no hotel/stay task. | `false`, `false`, `[]` | Generic bank sale/order notice is not stay-specific payment proof. |
| 19 | Agent asks staff to charge a virtual card for a confirmed stay; card details are present in source. | `true`, `false`, `[payment_request]` | Payment-card action is not proof filing; never reproduce credentials. |
| 20 | Travel-management company automatically sends an accommodation voucher for hotel filing. | `true`, `true`, `[voucher]` | Agency/TMC voucher can be in scope despite automation. |
| 21 | OTA/channel system sends only an automated reservation notification; no hotel task is requested. | `false`, `false`, `[]` | Exclude actual OTA/channel notices, not by automation alone. |
| 22 | Internal forward to reservations says “Please quote the active request below”; quoted request is unanswered. | `true`, `true`, `[quote]` | Active forwarded request is actionable even without new prose. |
| 23 | Current email says “Thanks, noted”; only the quoted history contains a previously completed quote request. | `false`, `false`, `[]` | Stale request in quoted text does not reactivate completed work. |
| 24 | Current message requests an invoice for a stay. Candidate reply `r1` says “We will send it tomorrow.” | `true`, `true`, `[invoice]`; `reply_ids=[r1]`, `response_type=staff`, `invoice_handling=invoice_no_reply` | Invoice task is helpable; a promise is not an invoice supplied. |
| 25 | Same invoice request; matching staff reply `r1` says “The invoice is attached.” A matching HMS confirmation candidate `r2` also identifies the same stay. | `true`, `true`, `[invoice]`; `reply_ids=[r1,r2]`, `response_type=both`, `invoice_handling=staff_invoice` | Supplied staff invoice differs from promised invoice; both matching reply types are retained. |
| 26 | Current message asks only whether payment has cleared / whether the guest may check in; no quote, booking, change, cancellation, document or invoice task. | `true`, `false`, `[other]` | Reservation-related status/check-in work is not unsupported help. |
| 27 | “Please quote two rooms for Stay A.” Cross-thread candidate `r1` is from the same guest/agency but clearly identifies different dates and Stay B. | `true`, `true`, `[quote]`; `reply_ids=[]`, `response_type=none_linked` | Same guest/agency does not match a different stay. |
