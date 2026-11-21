# Cancellation scope and fees

Use editable `action.details.requested_scope`: `whole_stay` for the entire named booking, `specific_room` for a room or part, `unspecified` when unclear. Native Prepare supports whole stays only. One reference on a group message does not authorize cancelling every matching room. Put an explicit reason in editable `cancellation_note` using the sender's words (up to 200 characters); leave `cancellation_reason` null until staff selects an exact current HMS option. Use editable `guest_name` and ISO dates for target hints.

Staff uses Prepare for current options and penalties. An unreturned fee is unknown. Show the exact charge and let staff decide in the pane; surface any changed charge before proceeding. If the stay is already Cancelled and a charge dialog remains, use the separate fee decision rather than cancelling again.
