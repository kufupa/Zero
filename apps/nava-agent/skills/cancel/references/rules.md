# Cancellation scope and fees

Use editable `action.details.requested_scope`: `whole_stay` for the entire named booking, `specific_room` for a room or part, `unspecified` when unclear. Native Prepare supports whole stays only. One reference on a group message does not authorize cancelling every matching room. Copy the entire stated reason clause (including any qualification or explanation) into editable `cancellation_note` in the sender's words, up to 200 characters. Do not paraphrase or reduce the clause to a category; leave `cancellation_reason` null until staff selects an exact current HMS option. Use editable `guest_name` and ISO dates for target hints.

“Test Reservations” is Labtest-only; never select it for a real guest.

Staff uses Prepare for current options and penalties; no returned fee means unknown. If HMS requires fee approval before cancelling, review and cancel in HMS. If HMS reports a fee after Save, show the amount and tell staff to post it in HMS if the hotel charges it. Never cancel again to handle a fee.
