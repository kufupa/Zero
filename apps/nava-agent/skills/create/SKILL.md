---
name: create
description: Use when a current hotel email explicitly requests booking or proceeding with a new reservation, including several guests, rooms, agency billing, meals, vouchers and confirmation details.
---

# Create

Read [common rules](../references/common.md), [decisions + fields](references/rules.md), [reply drafts](references/replies.md).

1. Confirm current explicit booking intent. Enquiry → quote; existing-stay check → read, not new booking. Resolve guest/stay assignments; search duplicate candidates when request repeats/reconfirms/rebooks.
2. Capture guest, property, dates, per-room occupancy/child ages, requested room/rate/meals, bill-to and relevant docs. Verify profile match; no arbitrary same-name profile.
3. Resolve native codes + meanings; fetch exact stay's availability/price. Company ≠ negotiated-rate eligibility; employer ≠ bill-to; voucher ≠ POP.
4. Stage business fields in verified legacy sequence: arrival → departure → adults → source → room type → rate plan → track → guarantee → guest first/last name → Check Availability. Optional fields use supported native controls; placement not fully evidenced.
5. Publish complete editable proposal: each guest/stay, ordered fields, code meanings, native price, docs, missing details, warning. Preserve staff overrides. Do not claim optional billing field persists without tool proof.
6. `hms_save` waits for staff Go on real guest. Staff edits → backend re-stage → Save → fresh readback. Labtest exception only per common rules. Uncertain result → read/reconcile, never blind retry.
7. Verify actual created identifier + intended business fields for each item. Draft confirmation only for verified items; uncertain/partial result remains explicit. Filing follow-up uses separate task.

Tools: `skill_read`, `mail_read_thread`, `mail_read_attachment`, `hms_search_reservations`, `hms_read_reservation`, `hms_read_catalogue`, `hms_quote`, `hms_prepare`, `hms_save`, `proposal_publish`, `reply_draft`. Exact [inputs/proposal](../references/tools-and-proposal.md); runtime capabilities govern availability.

Example: “Book two rooms, Guest A BB, Guest B DBB; agency pays rooms” → two scoped stays, distinct meals, explicit room-billing instruction; no inferred incidental-payment policy.
