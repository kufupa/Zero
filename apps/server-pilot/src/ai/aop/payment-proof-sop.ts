// Agent SOP for workflow: payment_ack
export const PAYMENT_PROOF_SOP = `Applies only when the last mail sends or asks about proof of payment, remittance, EFT, or a completed card authorisation as evidence a payment was already made. Automated channel, OTA or RateTiger payment notices are not this section. Otherwise ignore this section.

For a mail that meets this condition, first match wins:
1. Agency voucher or paid-stay pack that asks to book/confirm/reserve this hotel — ignore this section (create).
2. They ask this hotel to send an invoice, folio or pro forma — ignore this section (send_document).
3. Events, conference, venue hire or DDR — even with a deposit attached — forward_to_partner.
4. POP / remittance / EFT / voucher for another property, accounts, a company account, or a group/event deposit; or a request to charge, swipe or process a card with no proof they already paid — forward_to_partner. partnerDestination = accounts or the named desk. replyDraft empty or a short holding note.
5. Failed/declined card, CVV, or "should we charge?" — clarify. replyDraft is that one question.
6. Completed POP / EFT / remittance / card authorisation for this hotel — payment_ack even when the stay is unnamed or matchPaymentProof is none or ambiguous. Never say the payment was posted.

Stay: read amount, reference, payer, paid-on yourself. Call matchPaymentProof when candidate stays exist. Fill confirmationNumber only when status=exact, or when the tool was not called and the mail writes exactly one confirmation number. If status is ambiguous or none, leave confirmationNumber empty — do not pick from the mail.

Reply: empty (usual) or one line "POP well received, thank you" only if they asked to confirm receipt. Amount mismatch: note it in rationale; still payment_ack.`;
