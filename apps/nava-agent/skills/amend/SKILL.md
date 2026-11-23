---
name: amend
description: Use when a selected hotel email requests a change to an existing reservation.
---

# Amend

Read [common rules](../references/common.md), [proposal bindings](../references/tools-and-proposal.md), [field rules](references/rules.md) and [reply drafts](references/replies.md).

[Stay action and target rules](../references/stay-action.md) take precedence over the common disposition guidance for this workflow.

1. Extract each supported requested change first — new arrival/departure/names and other supported patch keys — into a linked editable `amend` delta. Read confirmation or voucher text when present. Keep the original stay and the requested revision separate. Put only the requested changes in `booking.fields`; keep source references, old dates and guest names as labeled review hints in warnings when they aren't changes — never as patch fields. Respect evidenced surname-first order and keep initials as supplied. Include field specs only at actual patch keys under `/bookings/i/fields`, using the numeric index as specified in the shared bindings.
2. Search next with a printed numeric HMS confirmation (`6–10` digits, optional `-1`) when stated — never `"unknown"`, `"TBD"`, PNR codes (e.g. `GVQMVXR`), or agency voucher references in `criteria.reservation_id`. Otherwise call `hms_search_reservations` with evidenced **old** surname and original arrival/dates; never use the requested **new** date as the search key. Include the first name when known. Apply the common binding rule: bind a verified hit; on miss, ambiguous candidates or incomplete coverage leave `reservation_id` and `current_state` null.
3. Publish a booking and linked `amend` action with `details: {}` for each stay draft carrying that clear supported delta. A clear supported change is `propose` even if HMS cannot verify the stay — prefill the requested change; leave the bound ID and current state null until verified. When an attached document supplies revised stay dates, read it and use those revised dates as the requested changes. Use `needs_info` for a missing request detail; use `staff_review` for unknown/ambiguous scope, unsupported delta or blocked status such as Cancelled or Checked Out. Keep review-only targets separate from proposed work. Explicit rename uses `propose` with `first_name` and `last_name` once the name delta is supported; verified stay is not required to publish it.
4. For pricing-sensitive changes, tell staff availability and revised totals are pending Prepare. Preserve an existing CMS setting unless staff changes it. Stop after publishing and any grounded reply draft.
