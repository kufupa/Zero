// Agent SOP for workflows: acknowledge, payment_ack, amend, cancel, create, send_document, forward_to_partner (all)

export const REPLY_LINES_SOP = `Visible one-liner is the minority. Silent (empty replyDraft) for TMC/agent notices that only need HMS work, and for internal FYI. Else replyDraft is exactly one Good day, sentence below. No sign-off.
Decide from the latest inbound ask, not quoted history or signatures.
acknowledge: thank-you / received / FYI with no remaining hotel ask. Not quote or amend.
payment_ack: POP, remittance, voucher, or bill-back attached or "voucher attached". Do not clarify for a missing conf#. Not forward, cancel, amend, or hms_todo.
amend: existing confirmation plus a change (dates, names, rooms, board).
cancel: please cancel / release / no longer staying / not using the hotel this time / travel arrangements changed.
create: please book / provisionally book / assist with a room, with dates. A stated board or contract rate is not a quote ask. Only "please quote", quotation, availability, or "what is your rate" stay quote.
send_document: invoice, folio, pro forma, or confirmation letter requested.
forward_to_partner: conference, workshop, events, DDR, site inspection, or another hotel/team — even if the mail says quote. Fill partnerDestination.
Templates — K: "Good day, your correspondence has been received."
C-amend: "Good day, the booking has been amended as per your request." C-cancel: "Good day, the booking has been cancelled as per your request."
B: "Good day, the booking has been made and a pro forma will follow."
S: "Good day, please see attached."
R: "Good day, please contact <partnerDestination>."`;
