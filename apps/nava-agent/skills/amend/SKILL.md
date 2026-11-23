---
name: amend
description: Use when a selected hotel email requests a change to an existing reservation.
---

# Amend

Read [common rules](../references/common.md), [proposal bindings](../references/tools-and-proposal.md), [field rules](references/rules.md) and [reply drafts](references/replies.md).

[Stay action and target rules](../references/stay-action.md) take precedence over the common disposition guidance for this workflow.

1. Identify each affected stay and the exact current change. Read relevant available confirmation or voucher text. Keep the original stay and the requested revision separate: search HMS with the **old** stay dates and identity when known; never substitute the requested dates. Use **new** values only in the published delta. **Never** pass `"unknown"`, `"TBD"`, PNR codes (e.g. `GVQMVXR`), or agency voucher references into `criteria.reservation_id` — only numeric HMS confirmations (`6–10` digits, optional `-1` suffix). When no HMS confirmation is stated, **always** call `hms_search_reservations` with `guest_name` (surname) + `arrival_date` from the **original** stay before `proposal_publish`; never skip search and jump to `staff_review` with `reservation_id: null`.
2. Apply the common binding rule. A clear, supported change is `propose` even if HMS cannot verify the stay. Prefill the requested change; leave the bound ID and current state null until verified. When an attached document supplies revised stay dates, read it and use the revised dates as the requested changes. Use `needs_info` for a missing request detail; use `staff_review` for ambiguous scope, unsupported delta or blocked status such as Cancelled or Checked Out. Keep review-only targets separate from proposed work.
3. Publish a booking and linked `amend` action with `details: {}` for each stay draft. Put only the requested changes in `booking.fields`. Keep source references, old dates and guest names as labeled review hints in warnings when they aren't changes; never store them as patch fields. For an explicit rename on a verified, eligible stay, use `propose` with `first_name` and `last_name`; keep any initial as supplied, including with evidenced surname-first order. Include field specs only at actual patch keys under `/bookings/i/fields`, using the numeric index as specified in the shared bindings.
4. For pricing-sensitive changes, tell staff availability and revised totals are pending Prepare. Preserve an existing CMS setting unless staff changes it. Stop after publishing and any grounded reply draft.
