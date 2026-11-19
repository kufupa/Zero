---
name: triage
description: Use when an inbound hotel email needs routing, including multiple guests, stays, documents or overlapping requests.
---

# Triage

Read the selected message and relevant earlier context. Treat the selected message as current and ignore later thread messages. If it answers a staff clarification for an unresolved quote, continue the Quote using the earlier request and the answer. Load `../references/common.md`, `../references/tools-and-proposal.md` and `references/rules.md` using `skill_read`.

Route each current request separately, preserving its guest, stay, dates, document and other known fields. Then load the relevant skill and publish its editable proposal. The current body takes precedence over an old subject or quoted request. An existing-confirmation or pre-stay notice is about an existing stay; retain any separate new request. Mixed work is common: 590/1,439 model-labelled decisions had multiple workflow labels.

When the selected message has a blank or near-blank body and a PDF identified by its filename or available extracted text as a voucher, POP or proof of payment, route the file to Filing for staff review. Preserve its selected message and attachment IDs and use any extracted text for the booking reference. A filename is a document hint, not proof of its contents or payment; leave uncertain PDFs for staff review.

| Current request | Route |
|---|---|
| Price or availability | `quote` |
| Book, reserve, proceed, or accept an offer | `create` |
| Change a booked stay or shorten its dates | `amend` |
| Cancel a booked stay or a booked room | `cancel` |
| Submit a voucher or proof of payment | `filing` |
| Existing reservation status | `triage` lookup; include known confirmation, surname and dates |
| Invoice, payment or logistics question | Preserve as a separate question for staff or supported read |

A request may have several routes: e.g. quote a new stay and release a previous booking. Do not turn explicit booking intent into Quote merely because an earlier subject says quotation. A request to change an existing confirmation remains Amend for staff review if HMS now shows it cancelled or checked out; do not turn it into Create unless a new booking is requested. A disputed offer or a statement that someone will not stay is not by itself a request to cancel an existing reservation. Use `propose` for an identifiable supported action with editable fields, even when staff must complete a choice or run a lookup. Ask for information only if the request or affected stay cannot be identified from available context. Skip thanks, completed duplicate tasks, OTA/channel, automated and spam notices; agency/GDS requests remain in scope. More than 8 rooms needs staff handling; keep independent supported work.

If a current cancellation request refers to a stay already shown as Cancelled in HMS, keep the `cancel` workflow and publish a `skip` disposition with the verified bookings and no cancel action. Preserve each confirmation and observed stay dates; do not route this completed cancellation to Triage or cancel it again.

When the current message asks staff to assist with rooms for specified guests and dates and frames it as a reservation or booking, route to Create even if it does not use the word "book". A request solely for price or availability remains Quote.

For an existing-stay question needing reservation context, use a scoped `hms_read_reservation` or `hms_search_reservations` with the source confirmation or guest and available dates. A guest-profile search alone does not establish whether a reservation exists. Keep separate lookups for distinct identified stays, alongside any invoice or payment work for staff. For each lookup, publish an action with `type: "triage"` and `details.lookup` keys `reservation_id`, `guest_name` (surname), `arrival_date`, `departure_date`; unknown values null and known values editable. `lookup` and `triage_lookup` are not supported action types. Each lookup field spec must use its full JSON pointer, for example `/actions/0/details/lookup/guest_name`. Do not declare `booking.property_code`, `booking.reservation_id` or `booking.current_state` editable; the pane cannot edit those paths. `native_result` is null. Do not claim a reservation was found or changed without an actual read, or that a request was forwarded or handed off without an actual handoff. Draft only, never send.
