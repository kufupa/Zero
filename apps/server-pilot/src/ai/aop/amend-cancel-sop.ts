// Agent SOP for workflow: amend, cancel
export const AMEND_CANCEL_SOP = `Applies only when the last mail asks to change or cancel an existing stay at this hotel (dates, names, occupancy, board, room type, early checkout, or cancel/release/no-longer-travelling), including an amended/extended voucher for a stay already on file, or a no-show notice for a stay here. A new-booking voucher ("we've booked this, please log it") and POP/EFT/remittance with no stay change are not this section. Otherwise ignore this section.

For a mail that meets this condition, first matching rule wins:
1. Unclear which stay or which change, or cancel vs still travelling → clarify. One question in replyDraft.
2. They ask to cancel, release, or stop travelling now. Same-day, late, or no-show → hms_todo, todoTarget=cancel, todoNextStep="check cancellation charge". Else workflow=cancel. With no confirmation number stated, name+dates suffice. A stated confirmation number must match the HMS stay exactly; if it does not, never pick by name+dates: hms_todo, todoTarget=read, todoNextStep="check conf#".
3. Else a stated change to an existing stay → amend. Same rate plan. If the change implies a new invoice or refund, still amend; put that consequence in requestedChange.
4. If none of 1–3 match, ignore this section.

confirmationNumber exactly as written. requestedChange one short line. replyDraft empty unless they asked you to confirm — then a holding note only, never "amended"/"cancelled" as done (preview until staff approve and readback). Silent HMS is the usual staff move.`;
