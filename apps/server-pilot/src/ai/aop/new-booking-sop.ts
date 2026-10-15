// Agent SOP for workflow: create
export const NEW_BOOKING_SOP = `Applies only when the last mail asks for a stay at this hotel and is an agent/TMC hotel voucher, an explicit please-book / please-confirm / please-reserve / provisionally-book instruction, or an accepted quote/pro forma (signed or not). Otherwise ignore this section.

For a mail that meets this condition:

Find first. After HMS find, call findFirstStayMatch with lastName + arrival (voucherNumber and confirmationNumber if the mail states them) and the candidate rows. match → stay exists: acknowledge (resend/duplicate) or amend if they asked a change; put that confirmationNumber; do not create. possible or conflict → clarify one question for the confirmation number; do not pick. none with stated_conf_not_found → the create to-do below, with todoNextStep starting "Check stated confirmation number in HMS first"; never copy that number into confirmationNumber. Other none → new stay. Cancelled stays never count. Two matches = conflict. A voucher that repeats a stay already named in this thread → acknowledge, not create.

Create (new stay only): take dates, rooms, board, guest and billing from the mail and voucher. Run create_reservation_dry_run to validate; it never saves. Default: workflow=hms_todo, todoTarget=create, todoNextStep="Key into HMS", replyDraft empty. Direct guest or internal who asked you to confirm the booking: workflow=create, replyDraft empty; the booked line is written only after staff save the stay in HMS. If that same book/voucher mail also has payment, VCC or deposit to post, keep todoTarget=create and note posting payment in todoNextStep.

For a mail that meets this condition, also:
- They ask you to send/issue an invoice, pro forma or bank letter → send_document. A billing address on a book instruction with no send-invoice ask is not a document ask.
- TMC/agent hotel voucher with no book/confirm/reserve wording is still an already-paid new booking: find first, and when it is new → the silent create to-do above ("Key into HMS", empty reply). Do not clarify missing fields; staff read the voucher.
- Guest still deciding, "I will confirm", or enquiry not yet accepted → clarify. One question.
- Group block / room allocation / "keep this block" / unsigned contract → other, not create.
- "Provisionally book" with a rooming list is create, not quote. A named rate on a book instruction is the rate to key, not a quote ask.

Done: fill stayAsk from the mail/voucher. confirmationNumber only when found.`;
