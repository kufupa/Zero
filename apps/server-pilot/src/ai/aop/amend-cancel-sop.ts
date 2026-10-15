// Agent SOP for workflow: amend, cancel
export const AMEND_CANCEL_SOP = `AOP-6/7 Amend and cancel. First matching rule wins. Use the named workflow, not hms_todo, except rule 8b. Never claim the write is done. confirmationNumber exactly as written. requestedChange one short line.

1. This inbound sends or attaches a voucher, remittance, EFT, POP, refund proof, or "please find payment" → payment_ack. Wins over date/dinner/checkout/cancel words in the same thread. Never post payment.
2. They explicitly ask you to send/issue an invoice, folio or pro forma → send_document. A rooming-list PDF is not that ask.
3. Wrong hotel, events/accounts, reception, or another property's block → forward_to_partner. Fill partnerDestination.
4. A needed fact is missing (which stay, resend the list, guide name/contact, arrival time, "was it cancelled?", meal charging) → clarify. One question in replyDraft. Do not set todoTarget. Do not send_document.
5. Thank-you or internal "noted" / "checking" with no completed change → acknowledge.
6. Rate, menu, buffet or availability price, no stay field to key → quote.
7. Requested night/room cannot be done; offer another date → other. Not hms_todo.
8. Cancel only if they ask to cancel, release, or stop travelling now.
   8a. Fees-remain-due / no-waiver / refund-form-for-signature, with no cancel instruction → other or clarify. Not cancel.
   8b. Same-day, late, or no-show cancel they asked for now → hms_todo, todoTarget=cancel, todoNextStep="check cancellation charge". Never accept a penalty dialog.
   8c. Other cancel/release/event-moved/group-release → workflow=cancel. Name+dates suffice. replyDraft empty unless they asked you to confirm, then "Booking has been cancelled as per your request." Cancel vs still-travelling → clarify.
9. Else existing stay + change (dates, names, occupancy, board, room, early checkout, payment-arrangement note, complete rooming list to apply) → amend. Keep the same rate plan. replyDraft empty unless they asked you to confirm, then "Booking has been amended as per your request." Side-effect invoice: still amend unless they asked to be sent the document.

Roaming list: missing guide/arrival/resend → clarify; complete list to apply → amend; never send_document only because a list is attached.

Silent HMS is the usual staff move (amend ~81%, cancel ~69%). Staff approve every write.`;
