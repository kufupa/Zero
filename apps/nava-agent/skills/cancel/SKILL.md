---
name: cancel
description: Use when a selected hotel email asks to cancel a booked stay or room, or asks about its cancellation terms.
---

# Cancel

Read [common rules](../references/common.md), [proposal bindings](../references/tools-and-proposal.md), [scope and fees](references/rules.md) and [reply drafts](references/replies.md).

[Stay action and target rules](../references/stay-action.md) take precedence over the common disposition guidance for this workflow.

1. Establish the current instruction and which bookings it covers. A question about a fee, a cancellation conditional on a future decision, a withdrawn unaccepted offer or an unsold allotment release authorizes no cancellation. If the request only removes nights, use Amend.
2. Collect all in-scope references, including lists in the selected subject or body and earlier context it points to. Deduplicate by stay, verify each independently using the common binding rule and keep references separate from guest/date evidence. Explicitly exclude stays the sender says to retain, even if adjacent or listed on the same thread. **Never** pass `"unknown"`, `"TBD"`, PNR codes (e.g. `GVQMVXR`), or agency voucher references into `criteria.reservation_id` — only numeric HMS confirmations (`6–10` digits, optional `-1` suffix). When no HMS confirmation is stated, **always** call `hms_search_reservations` with `guest_name` (surname) + `arrival_date` before `proposal_publish`; never skip search and jump to `staff_review` with `reservation_id: null`.
3. Choose disposition for each target:
   - `skip`: HMS shows the matching stay is already Cancelled. Retain its verified ID, dates and status; no cancel action.
   - `propose`: a clear, supported whole-stay instruction, even if the stay is unresolved. Keep a null bound ID and current state when unverified. An unknown fee or native reason does not block the draft. Honor known status blockers; if status could not be read, staff must check it in HMS.
   - `staff_review`: ambiguous group/shared scope, room-level request, fee inquiry, conditional instruction or unsupported status. Keep a review-only draft for each actual stay instruction, with null bound ID if unverified and the source reference labeled in warnings. An inquiry alone has no cancel action.
   - `needs_info`: the request lacks material information to identify what the sender wants, rather than a lookup failing on an identifiable request.
4. Publish one booking and one linked `cancel` action per actual stay instruction to be drafted, using the scope and note fields in the reference. Keep review drafts separate from proposed work. Staff can use Find the stay for a single-stay review draft. Stop after publishing and any grounded reply draft.
