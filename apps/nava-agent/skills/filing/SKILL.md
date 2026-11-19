---
name: filing
description: Use when an inbound hotel email supplies a voucher, proof of payment or reservation document, or combines a supplied file with a payment or invoice question.
---

# Filing

Read [common rules](../references/common.md), [document rules and native order](references/rules.md), and [reply drafts](references/replies.md).

1. Use `mail_read_thread`. Look at the selected inbound first. Propose Filing for an explicit current submission with a real PDF listed on that message. If the body is blank or near-blank and the selected PDF is identified by its filename or available extracted text as a voucher, POP or proof of payment, publish a Filing `staff_review` action for that file using the matching submission type; staff must check the document and its intended stay. An unclear PDF remains staff review. An earlier quoted voucher, promised payment, invoice request, or pro-forma alone is not a Filing task.
2. Extract an explicit, unambiguous booking or confirmation reference, including any stay suffix, from the selected mail or the selected PDF's available extracted text. Match it to the PDF's intended HRCEN stay; check guest and stay hints and use scoped reservation search/read where available. If a suffix is observed only in HMS, record it as HMS evidence, not as a quotation from a source that gives only the base reference. If the exact confirmation or the file is unclear, use `needs_info` or `staff_review`. Never infer a reference or stay from the filename. Keep separate questions distinct.
3. Treat filename and sender wording as source hints. Unless document text is truly available, say the PDF contents were not read and staff must check the selected file and its booking before Prepare. Do not claim paid, filed or duplicate. Do not call absent attachment or filing tools.
4. For each selected PDF and intended stay, preserve a separate booking and action, leaving the target unknown when unresolved; use `native_result: null`. Set `booking.property_code` to HRCEN and `booking.fields.confirmation_number` to the exact reference (including stay suffix), or null if unavailable. Include an editable field spec for each booking's `/fields/confirmation_number`; when unavailable, list the missing reference for staff. Put only sourced guest names or ISO stay dates in the corresponding fields. Use the following action:
   - `type`: `voucher_submission`, `payment_proof_submission`, or `attach_document`, appropriate to the current request.
   - `booking_ids`: the one booking ID.
   - `details`: `{message_id, attachment_id, description}`. Use the selected inbound message ID and an exact PDF ID listed on it. Use a short editable label such as “Accommodation voucher” or “Proof of payment”, at most 200 characters. Keep the longer explanation in the proposal summary and leave bank or card data out of the description.
   - Add editable field specs for each action's `/details/description` (text) and `/details/attachment_id` (select, source PDF IDs and filenames from this message only). The source message ID is fixed. Cite the source message/attachment in evidence. Use only the field-spec keys in the shared bindings; put explanations in `error` or `warnings`, not extra keys such as `path_note` or `required_note`.
5. Staff checks the actual PDF, confirms the exact booking and runs Prepare on the edited revision. The worker checks the HMS Documents list and opens the unsaved form with the selected PDF and description. It reports the observed document code and list coverage. Nothing is uploaded or sent.

Tools: `skill_read`, `mail_read_thread`, scoped `hms_search_reservations`/`hms_read_reservation`, `proposal_publish`. Use the complete proposal shape in [bindings](../references/tools-and-proposal.md); staff Prepare replaces any model Prepare or Save for this workflow.
