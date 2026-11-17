---
name: cancel
description: Use when a current hotel email requests cancelling or releasing an existing guest reservation or booked room, including partial party cancellation, no-longer-travelling messages and cancellation-charge questions.
---

# Cancel

Read [common rules](../references/common.md), [scope and fees](references/rules.md), and [reply drafts](references/replies.md). For this workflow, the read-only instructions below govern any conflicting prepare or Save instructions in shared references.

1. Identify the current cancellation request and the affected stay. Withdrawing an unaccepted quote is not a cancellation; shortening a stay is an amendment. Preserve the requested guest, room and dates. Do not infer group-wide authority.
2. Search and read the saved reservation by property, confirmation, guest and dates as available. Match the source to one current stay. If the target, identity, scope or current status is unclear, publish a specific clarification or staff review; do not assert that a failed search proves no booking exists. An already cancelled or unsupported-status stay needs staff review, not another cancellation.
3. For an explicit whole-stay request on a uniquely matched Reserved stay, publish one `cancel` booking and action. Set `booking.reservation_id` to the verified confirmation and `action.booking_ids` to that booking's ID. Set `action.details.requested_scope` to `whole_stay`; use `specific_room` or `unspecified` only when supported by the request. Preserve real source evidence. Include editable field specs for `/actions/0/details/requested_scope` and, when known, target hints `/bookings/0/fields/guest_name` and `/bookings/0/fields/arrival_date`, so staff can correct them. Do not invent fields or a confirmation.
4. Publish the proposal for staff review. Staff edits and starts the native read/preflight on the current revision. Do not call `hms_prepare`, `hms_save` or any cancellation action yourself. Nothing is cancelled by preflight.
5. Report the fresh native target, status, scope coverage and policy facts as observed. The reader may not establish room/stay scope or a policy. A fee unknown before commit is unknown, never zero or waived. Do not claim a cancellation, fee decision or cancellation reference without an independently verified result. Draft only; never send.

Use the registered `skill_read`, `mail_read_thread`, `mail_read_attachment`, `hms_search_reservations`, `hms_read_reservation`, `proposal_publish`, and `reply_draft` tools as available. Exact [proposal bindings](../references/tools-and-proposal.md) apply except where the read-only flow above is more restrictive.
