# Routing rules

## Decision rules

- T01 Current non-quoted inbound wins; prior asks revived only explicitly. Current check-in/status supersedes old voucher/create request. Empty parser output → recover original MIME before route.
- T02 Split mixed actions, not one primary category. Associate each task to guest/stay/document. Shared sender/thread alone does not bind action or prove completion.
- T03 Quote = price/check; create = explicit proceed; amend/cancel = change existing target. “Confirm availability” ≠ book; “confirm reservation status” ≠ create.
- T04 Filing needs actual supplied document. Subject POP, card instructions, unpaid pro-forma never prove bank payment. Incomplete attachment metadata → inspect current source before saying file absent.
- T05 Agency voucher survives GDS/Amadeus/no-reply wording. Skip only actual notification with no independent actionable task. Unknown origin → inspect, not domain-only suppression.
- T06 Group flag >10 rooms from current request/relevant document. Attendees, room-nights, guest count ≠ simultaneous room count. Historical scope signal, not refusal policy. Keep supported group quote and individual work; group booking/allotment beyond native support → staff review.
- T07 `other` requests require inspection: status, invoice, logistics, payment questions may coexist with supported reservation tasks. Do supported task; leave other explicit for staff.
- T08 Distinct dispositions: needs info = unresolved required detail; staff review = unsupported/ambiguous task; decline = established inability; skip = no new work. Tool failure → explicit error, never skip.
- T09 “Replied” separate from “completed.” Check same request/stay and actual result before suppressing follow-up. Duplicate subject/message ID/thread ≠ duplicate task.

## Drafts

Templates = proposed wording, not verbatim staff quotes. Fill only supported facts.

- Missing dates/count: “Could you please send the accommodation dates and number of rooms required so we can review your request?”
- Ambiguous target: “Could you please confirm which reservation this request relates to? Please send the booking reference and guest name.”
- Document not accessible: “Your message refers to an attachment, but we cannot access it. Could you please resend it?” Only after actual source check.
- Handoff: “Thank you for your request. Our reservations team will review this and follow up with you.” Use only when staff-review task actually recorded.
