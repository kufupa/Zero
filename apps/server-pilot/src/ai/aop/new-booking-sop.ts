// Agent SOP for workflow: create
export const NEW_BOOKING_SOP = `AOP-2 New booking. This SOP beats quote-despite-book and skip-OTA for booking instructions. Channel-manager notices are forward, not skip and not create.

Entry: an agent voucher, "please book/confirm/reserve/provisionally book", "please assist with a reservation/room", or a signed quote/pro forma accepted. "Provisionally book" with a rooming list is create, not quote. A named rate on a book instruction is the rate to key, not a quote ask. "Looking for accommodation" or a rate/DBB question with no book/confirm/reserve/provisionally-book instruction stays quote — never send_document.

Find first — never double-create. After HMS find, call findFirstStayMatch with lastName + arrival (voucherNumber if known) and the candidate rows. match → stay exists: acknowledge (resend/duplicate) or amend if they asked a change; put that confirmationNumber; do not create. possible or conflict → clarify one question for the confirmation number; never pick. none → new stay. Cancelled stays never count. Two matches = conflict. A voucher that repeats a stay already named in this thread → acknowledge, not create.

Create (new stay only, and only when they did not ask you to send a document back): take dates, rooms, board, guest and billing from the mail and voucher. Run create_reservation_dry_run to validate; it never saves. Default: workflow=hms_todo, todoTarget=create, todoNextStep="Key into HMS", replyDraft empty (most agent vouchers are silent). Direct guest or internal who asked you to confirm the booking: workflow=create, replyDraft "Booking done, pro forma to follow." Payment, VCC or deposit in the mail: keep todoTarget=create and note posting payment in todoNextStep. That is not payment_ack (POP on an existing stay).

Not create:
- Channel manager / GDS / OTA "Booking Update … via Channel Manager" (this hotel included): stay already arrives via the channel → forward_to_partner (partnerDestination = channel). Never create, amend, or skip.
- Voucher or booking for another property, or events/conference team → forward_to_partner.
- They ask you to send/issue an invoice, pro forma or bank letter, or ask if the hotel takes virtual/card payment → send_document. A billing address on a book instruction (no send-invoice / bank-letter ask) is not a document ask.
- TMC/agent hotel voucher with only a voucher number and attachment, and no book/confirm/reserve ask → acknowledge (empty reply). Do not clarify missing fields.
- Guest still deciding, "I will confirm", enquiry not yet accepted, billback, or a travel/city voucher that does not name this hotel as the property → clarify, not acknowledge. One question.
- Group block / room allocation / "keep this block" / unsigned contract → other, not a stay read and not create.
- Pre-stay self-mail with a confirmation number is an existing stay: never create.

Done: fill stayAsk from the mail/voucher. confirmationNumber only when found. Never claim an HMS write happened.`;
