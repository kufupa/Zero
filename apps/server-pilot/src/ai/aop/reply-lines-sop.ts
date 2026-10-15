// Agent SOP for workflows: acknowledge, payment_ack, amend, cancel, create, send_document

export const REPLY_LINES_SOP = `Applies only when the last mail is one staff would answer with a visible one-liner (thank-you/received, amend or cancel after the HMS write, booked plus pro forma after a saved create, or please see attached) and the workflow is already acknowledge, payment_ack, amend, cancel, create or send_document. Otherwise ignore this section.
This section does not pick the workflow.
For a mail that meets this condition, replyDraft is exactly one Good day, sentence from pickReplyLine; no sign-off. TMC/agent notices that only need HMS work, and internal FYI, stay silent (empty replyDraft) — silence wins over a one-liner when both could apply.
K (acknowledge, or payment_ack for POP/EFT/remittance on an existing stay): "Good day, your correspondence has been received."
For a mail that is a voucher or already-paid "please log this booking", ignore this section: not payment_ack and not acknowledge. create-path rules own that mail.
C: only after the HMS write succeeded; pass done. When amend and cancel both fit, cancel wins if the ask is cancel, release or no longer staying; else amend. "Good day, the booking has been {amended|cancelled|released} as per your request."
B: only with a confirmationNumber from a saved create, not from a dry-run. "Good day, the booking has been made and a pro forma will follow."
S: only when the document is attached. "Good day, please see attached."`;
