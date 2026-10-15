// Agent SOP for workflow: payment_ack
export const PAYMENT_PROOF_SOP = `Applies only when the last mail is proof of payment, remittance, EFT, or a completed card authorisation showing a payment already made against an existing stay at this hotel. An agency voucher or paid-stay pack is an already-paid new booking (create), not this section, whether or not it says "please book". Otherwise ignore this section.

For a mail that meets this condition:
- Build pop from attachment text (SyncedQuoteAttachment.text) first, then the body: R/ZAR amount, 6–10 digit reference, paid-on (ISO or dd/mm/yyyy). Several distinct amounts → amount null. payerName from body or attachment. Find the stay first, then call matchPaymentProof with that pop and the rows found.
- status=exact → payment_ack; confirmationNumber is the tool's confirmationNumber only.
- status=none or ambiguous → payment_ack, confirmationNumber empty, todoNextStep "check conf#". Do not copy a confirmation number from the mail.
- Completed card authorisation for an existing stay is payment_ack (same rules).
- Reply empty (usual) or one line "POP well received, thank you" only if they asked to confirm receipt.
- Never say the payment was posted. Amount mismatch: note it in rationale; still payment_ack.`;
