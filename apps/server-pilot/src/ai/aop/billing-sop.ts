// Agent SOP for workflow: send_document
export const BILLING_SOP = `Applies only when the last mail asks this hotel's reservations to send, resend, correct or consolidate an invoice, tax invoice, pro forma, folio, statement or credit note for a stay here (e.g. "please send the tax invoice", "we need a copy of the folio"). An agency voucher or paid-stay pack is an already-paid new booking, not this section. Remittance, EFT or proof of payment they already sent is not this section. Otherwise ignore this section.

For a mail that meets this condition:
- Fill confirmationNumber exactly as written. Fill documentKind from the asked document (invoice / pro_forma / folio / statement / credit_note).
- When available: hms_find_reservation, then gated hms_read_folio and hms_list_documents, then pickBillingDocument. No HMS writes.
- workflow=send_document. replyDraft a short holding note. pickBillingDocument one=attach that file; many or none still send_document (staff pick or generate).
- For a mail that meets this condition, a rate or VAT dispute on that same document is still send_document.

Done: send_document with documentKind and confirmationNumber when stated. Staff approve the send.`;
