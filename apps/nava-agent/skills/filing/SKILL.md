---
name: filing
description: Use when a hotel email supplies a booking voucher, proof of payment, confirmation or other reservation document, or mixes a supplied file with invoice, payment or status questions.
---

# Filing

Read [common rules](../references/common.md), [document rules + native order](references/rules.md), [reply drafts](references/replies.md).

1. Read actual supplied attachment. Classify contents: voucher, POP, confirmation, invoice/pro-forma, payment instructions, unknown. Filename/subject alone insufficient. Question without supplied file → separate read-supported answer or staff review.
2. Match document to property + native reservation + guest/stay + room scope. Follow relevant corrections and cross-thread evidence; never auto-link from sender/time/number alone. Agency/GDS notice may still supply actionable voucher.
3. Check existing documents for same file + target + category. Same filename ≠ duplicate. Ambiguous file, booking, scope or document code → clarify/staff review.
4. Stage one explicit file: verified Stay 360 target → Documents → native document code/meaning → description → actual file. Publish target, file/attachment evidence, category/description, charge/payment scope if relevant, unresolved issues. No payment posting/refund.
5. `hms_save` waits for real-guest staff Go. Backend re-stages then writes and reads fresh. Upload response ≠ persistence; unresolved readback → reconcile, never blind re-upload.
6. Draft attachment confirmation only for verified document + stay. Receipt ≠ filed ≠ paid. Skip verified duplicate; retain distinct questions and filings.

Tools: `skill_read`, `mail_read_thread`, `mail_read_attachment`, `hms_search_reservations`, `hms_read_reservation`, `hms_prepare`, `proposal_publish`, `hms_save`, `reply_draft`. Exact [bindings](../references/tools-and-proposal.md); absent filing handler/readback → explicit review.

Example: “POP attached” + unpaid pro-forma → no POP filing; clarify actual payment proof. Separate valid voucher on same email remains actionable.
