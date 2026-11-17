# Routing rules

## Decision rules

- T01 Current non-quoted inbound wins; prior asks revived only explicitly. Current check-in/status supersedes old voucher/create request. Empty parser output → recover original MIME before route.
- T02 Split mixed actions, not one primary category. Associate each task to guest/stay/document. Shared sender/thread alone does not bind action or prove completion.
- T03 Quote = price/check; create = explicit proceed; amend/cancel = change existing target. “Confirm availability” ≠ book; “confirm reservation status” ≠ create.
- T04 Filing needs actual supplied document. Subject POP, card instructions, unpaid pro-forma never prove bank payment. Incomplete attachment metadata → inspect current source before saying file absent.
- T05 / R7: hard skip exact normalized From hosts `tiket.com`, `ratetiger.com`, observed RateTiger relay hosts `erevmax.co.uk`, `erevmax.net`, `erevmax.com`, `hospitality.cloud`, `profitroom.com`; skip Booking.com notices. Owner 2026-11-17. Audit: 13/13 Tiket OTP, 49/49 RateTiger failures/OTP, 25/25 hospitality.cloud payment links; 385 Booking.com messages, 7/385 guest needs handled via extranet. No substring/body-address match; don't infer extra hosts.
- R7 exceptions before skip: Profitroom “Default contact form” with actual guest ask → triage normally (28/234 forms, 18/28 got staff replies; coordinator exception pending owner). TBO booking notice relayed by RateTiger → triage normally (21 TBO-labelled notices observed; not permission to Create). Travel agency/GDS/no-reply wording alone ≠ excluded host.
- T06 / R8: ≥10 rooms to book → rooming-list/group review; no hard numeric execution cap. Count rooms, not attendees/room-nights/pax. Keep supported read-only group quote and independent tasks. Confirmation counts reached 10 among 222 creates; requests reached 30.
- T07 `other` requests require inspection: status, invoice, logistics, payment questions may coexist with supported reservation tasks. Do supported task; leave other explicit for staff.
- T08 Distinct dispositions: needs info = unresolved required detail; staff review = unsupported/ambiguous task; decline = established inability; skip = no new work. Tool failure → explicit error, never skip.
- T09 “Replied” separate from “completed.” Check same request/stay and actual result before suppressing follow-up. Duplicate subject/message ID/thread ≠ duplicate task.
- T10 / R6: existing confirmation → route actual existing-stay task; never Create from notice. Automated pre-stay text → note/Amend candidate if actionable (20/107 self-mails contained guest text); no text/ask → skip. Preserve separate current asks. No Centurion-only rule.

## Drafts

Templates = proposed wording, not verbatim staff quotes. Fill only supported facts.

- Missing dates/count: “Could you please send the accommodation dates and number of rooms required so we can review your request?”
- Ambiguous target: “Could you please confirm which reservation this request relates to? Please send the booking reference and guest name.”
- Document not accessible: “Your message refers to an attachment, but we cannot access it. Could you please resend it?” Only after actual source check.
- Handoff: “Thank you for your request. Our reservations team will review this and follow up with you.” Use only when staff-review task actually recorded.
