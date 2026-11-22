---
name: filing
description: Use when the selected hotel email supplies a voucher, proof of payment or a document explicitly submitted for an existing reservation.
---

# Filing

Read [common rules](../references/common.md), [proposal bindings](../references/tools-and-proposal.md), [document rules](references/rules.md) and [reply drafts](references/replies.md).

1. A genuine existing-stay voucher or proof-of-payment PDF submitted now is Filing, including forwarded billback vouchers and submissions inside invoice or payment follow-ups. Keep Filing when the stay is unresolved or the agency reference is not an HMS confirmation. Distinguish a submitted document from a VCC settlement notice using `skill_read` with `skill_name: triage` and `path: references/rules.md`. With an explicit submission but no selected PDF, publish `filing/needs_info` with no attachment action; ask staff to select it. Blank body plus a credible voucher or POP PDF is a review draft when the document type or intent is only a hint.
2. Follow the document lookup order per file. Use `propose` for a qualifying submission, whether or not HMS verifies the stay. If submission evidence itself is unclear, use `staff_review` and keep the selected file and document type on the draft. For an unresolved stay leave `reservation_id` and `current_state` null but retain `/actions/0/details/attachment_id` for the first file and the equivalent path for each additional file. Staff checks the actual PDF even when the draft is already bound.
3. Publish one booking and linked action per PDF and intended stay. Use `voucher_submission`, `payment_proof_submission`, or `attach_document` for an explicitly requested other document. In `details`, use the selected `message_id`, exact selected `attachment_id` and a short `description` (up to 200 characters). Give staff editable description and attachment fields; attachment options are PDF IDs and filenames from the selected message only. Cite that message and attachment in evidence. Keep the source message ID fixed. Stop after publishing and any grounded reply draft.
