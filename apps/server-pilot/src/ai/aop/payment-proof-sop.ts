// Agent SOP for workflow: payment_ack
export const PAYMENT_PROOF_SOP = `Applies only when the last mail is proof of payment, remittance, EFT, or a completed card authorisation showing a payment already made against an existing stay at this hotel. An agency voucher or paid-stay pack is an already-paid new booking (create), not this section, whether or not it says "please book". Otherwise ignore this section.

For a mail that meets this condition:
- Read amount, reference, payer, paid-on yourself. Find the stay first (the confirmation number in the reference, else payer surname and dates), then call matchPaymentProof with the rows found.
- status=exact → payment_ack; confirmationNumber is the tool's confirmationNumber only.
- status=none or ambiguous → payment_ack, confirmationNumber empty, todoNextStep "check conf#". Do not copy a confirmation number from the mail.
- Completed card authorisation for an existing stay is payment_ack (same rules).
- Reply empty (usual) or one line "POP well received, thank you" only if they asked to confirm receipt.
- Never say the payment was posted. Amount mismatch: note it in rationale; still payment_ack.`;
