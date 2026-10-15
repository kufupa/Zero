// Agent SOP for workflow: payment_ack
export const PAYMENT_PROOF_SOP = `AOP-4 Payment proof. Overrides skip/OTA, other, and hms_todo for this mail. Never skip, spam, create, other, or hms_todo. Never claim a payment was posted. Posting is staff.

Entry: POP, remittance, EFT, bill-back/accommodation voucher, card auth, VCC/virtual card, swipe-required, channel-manager payment notice, or a request to charge.

Stay: read amount, reference, payer, paid-on yourself. Put a confirmation number from the subject, body or payment reference into confirmationNumber. If matchPaymentProof is available and status=exact, use that conf#. Do not clarify because the stay is missing.

Moves (pick one):
- skip/spam/other/hms_todo: NEVER on this mail. Channel-manager, OTA, RateTiger, VCC and card-link notices are forward_to_partner (or clarify if they only ask a question).
- clarify: ONLY a failed/declined-card question, a CVV question, or "should we charge / charge the full account?". Never acknowledge a failed charge. replyDraft is that one question. Ordinary POP/voucher is not clarify.
- forward_to_partner: this desk does not process it — automated channel/OTA/VCC/OTP/card-link notices; swipe-required or "please charge"/"process payment" card details; a charge pack (order + screenshot / payment details for the hotel to charge) with no proof-of-payment, remittance, EFT, POP or voucher framing; company-account or group/event deposits for reception/accounts. partnerDestination = reception/accounts. replyDraft empty or a short holding note.
- payment_ack: a person or agency sent POP / EFT / remittance / bill-back or accommodation voucher as evidence they already paid (including a voucher that names another Legacy hotel — receipt only). Fill confirmationNumber when written. replyDraft empty (silent — usual) OR one line "POP well received, thank you" / "Voucher well received." only if they asked to confirm receipt. Amount mismatch: note it in rationale; still payment_ack. Never "payment posted". Unsure ack vs forward: voucher/POP/remittance/EFT words → payment_ack; charge/VCC/card words → forward.
- acknowledge: only a pure thank-you with no POP, voucher, card or failed-charge to handle.

Done: stay named when the mail has a conf#; otherwise the mail is with the desk that charges.`;
