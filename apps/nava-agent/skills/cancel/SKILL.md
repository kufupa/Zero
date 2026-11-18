---
name: cancel
description: Use when a current hotel email asks to cancel an existing guest reservation or room, release booked rooms, or asks about a cancellation charge.
---

# Cancel

Read [shared rules](../references/common.md), [scope and fees](references/rules.md), and [reply drafts](references/replies.md).

For a current whole-stay cancellation with enough information for staff to find the stay, publish an editable `propose` action. Missing fee or native reason does not by itself prevent the proposal.

1. Read the current request and relevant thread. A withdrawn unaccepted quote is not a reservation cancellation. Shortening dates is an amendment. Releasing an unsold allotment is not a guest-stay cancellation. Split separate guests or stays into separate actions.
2. Search HMS by property and the available confirmation, guest, and arrival details when available. Staff can use the pane's Find the stay in Infor search to check a surname or confirmation and select the exact stay; this fills the target from a fresh read. Use `needs_info` when the request lacks a detail needed to identify the task. Use `staff_review` for an unsupported status, room-level cancellation or group/shared task that cannot be assigned to one stay. Do not propose a second cancellation when the matching stay already shows `Cancelled`.
3. For an identifiable cancellation, publish one `cancel` action linked to one booking. Put the known confirmation in `booking.reservation_id` or null when unknown, and retain observed guest/date hints in editable booking fields. Staff must select the stay in Infor before Prepare. Do not add field specs for `/bookings/0/reservation_id` or `/bookings/0/property_code`: those are set by stay selection, not editable fields. Use `whole_stay` only for the named booking as a whole; describe a room-level or unclear scope for staff rather than presenting it as a supported whole-stay cancellation. Add editable specs for `requested_scope`, `cancellation_reason`, `cancellation_note`, and target hints. Leave `cancellation_reason` unset until staff selects a reason offered by current HMS. Put an explicitly stated reason in `cancellation_note`; do not invent one. Keep fee unknown until HMS returns a fee.
4. Publish the proposal for staff. Do not call cancellation Prepare, Go, or Save. For `whole_stay`, staff reviews the target and scope, then runs Prepare to read current reason choices and fee facts. If HMS requires a reason, staff selects an exact returned option and runs Prepare again. For `specific_room` or `unspecified`, warn that the current tool cannot prepare the scope and leave the action for staff to handle in HMS. Preflight is not a cancellation.
5. Staff alone clicks Go. Show any exact HMS penalty or charge text and require staff's explicit decision through the pane's fee-approval step. If the charge changes before Go, show the current charge for staff to decide. A charge dialog may appear after HMS has marked the stay Cancelled; show both facts and use the pane's separate charge decision, not another cancellation. After any uncertain Save, re-read HMS before retrying.
6. Draft a customer reply only from the verified result. Never claim cancellation, cancellation number, fee, waiver, or refund from the request or a prepared result alone. Nava never sends mail.

Use the registered `skill_read`, `mail_read_thread`, `hms_search_reservations`, `hms_read_reservation`, `proposal_publish`, and `reply_draft` tools as available. Follow [proposal bindings](../references/tools-and-proposal.md).
