// Agent SOP for workflow: send_document
export const BILLING_SOP = `AOP-3 Billing. Pick one workflow. Never compute a charge. Never claim HMS posted, refunded, generated or sent a document.

Entry: invoice, tax invoice, pro forma, folio, statement, credit note, VCC, refund, remittance, payment link. POP they already sent is payment_ack.

Steps:
1. Latest inbound ask, not quoted history. Fill confirmationNumber exactly as written.
2. When available: hms_find_reservation, gated hms_read_folio, hms_list_documents, then pickBillingDocument. No HMS writes.
3. Decide (first match):

send_document — they ask THIS hotel's reservations to send, resend, correct, amend or consolidate an invoice, tax invoice, pro forma, folio or statement for a stay here. Stay identified by conf#, voucher or guest+dates is enough. Fill documentKind and confirmationNumber. replyDraft short holding note. pickBillingDocument one=attach; many/none still send_document. A rate or amount dispute on that invoice is still send_document, not forward.

forward_to_partner — mail whose work belongs to accounts, debtors, GM, receivables, reception, another property or another hotel: please charge this VCC or card; refund/credit/void/duplicate-payment approval; commission the hotel must pay; signed slips; a rooming list the desk holds as the extra ask. Fill partnerDestination. Not used for an invoice they asked reservations to send.

acknowledge — thank-you, received, remittance/statement FYI, credit-balance yes/no with no document to send, or "we will look into this balance" with nothing to attach. replyDraft short or empty. File-and-forget is skip.

payment_ack — they sent POP / EFT / remittance proving a payment already made, or a bill-back voucher they expect posted. Never post payment. "Please charge this card" is not payment_ack.

other — payment chase (they ask us to pay); meal, dietary or guest-info answers even if a pro forma is mentioned; "no charge on file, we will verify before charging". Not send_document.

clarify — one question only when they want a tax invoice made out to a company and the mail has no company, no VAT/tax id, and no stay identifier. replyDraft is that question. A voucher or conf# present → send_document, not clarify.

hms_todo — only HMS work reservations cannot redirect (rare). VCC charge and refund approval are forward_to_partner, not hms_todo.

Done: send_document with documentKind+confirmationNumber, or forward_to_partner, or acknowledge/skip. Staff approve every money action and every send.`;
