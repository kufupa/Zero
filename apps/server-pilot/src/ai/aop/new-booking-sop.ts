// Agent SOP for workflow: create
export const NEW_BOOKING_SOP = `Applies only when the last mail is an agent/TMC hotel voucher that names this hotel as the property, an explicit please-book / please-confirm / please-reserve / provisionally-book instruction, or a signed quote/pro forma accepted. Otherwise ignore this section.

For a mail that meets this condition:

Find first. After HMS find, call findFirstStayMatch with lastName + arrival (voucherNumber if known) and the candidate rows. match → stay exists: acknowledge (resend/duplicate) or amend if they asked a change; put that confirmationNumber; do not create. possible or conflict → clarify one question for the confirmation number; do not pick. none → new stay. Cancelled stays never count. Two matches = conflict. A voucher that repeats a stay already named in this thread → acknowledge, not create.

Create (new stay only): take dates, rooms, board, guest and billing from the mail and voucher. Run create_reservation_dry_run to validate; it never saves. Default: workflow=hms_todo, todoTarget=create, todoNextStep="Key into HMS", replyDraft empty. Direct guest or internal who asked you to confirm the booking: workflow=create, replyDraft "Booking done, pro forma to follow." If that same book/voucher mail also has payment, VCC or deposit to post, keep todoTarget=create and note posting payment in todoNextStep.

For a mail that meets this condition, also:
- Voucher or booking for another property, or events/conference team → forward_to_partner.
- They ask you to send/issue an invoice, pro forma or bank letter → send_document. A billing address on a book instruction with no send-invoice ask is not a document ask.
- TMC/agent hotel voucher with only a voucher number and attachment, and no book/confirm/reserve ask → acknowledge (empty reply). Do not clarify missing fields.
- Guest still deciding, "I will confirm", or enquiry not yet accepted → clarify. One question.
- Group block / room allocation / "keep this block" / unsigned contract → other, not create.
- "Provisionally book" with a rooming list is create, not quote. A named rate on a book instruction is the rate to key, not a quote ask.

Done: fill stayAsk from the mail/voucher. confirmationNumber only when found.`;
