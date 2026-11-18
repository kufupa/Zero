---
name: triage
description: Use when an inbound hotel email needs routing, including multiple guests, stays, documents or overlapping requests.
---

# Triage

Read the selected message and relevant earlier context. Load `../references/common.md`, `../references/tools-and-proposal.md` and `references/rules.md` using `skill_read`.

Route each current request separately, preserving its guest, stay, dates, document and other known fields. Then load the relevant skill and publish its editable proposal. The current body takes precedence over an old subject or quoted request. An existing-confirmation or pre-stay notice is about an existing stay; retain any separate new request. Mixed work is common: 590/1,439 model-labelled decisions had multiple workflow labels.

| Current request | Route |
|---|---|
| Price or availability | `quote` |
| Book, reserve, proceed, or accept an offer | `create` |
| Change a booked stay or shorten its dates | `amend` |
| Cancel a booked stay or a booked room | `cancel` |
| Submit a voucher or proof of payment | `filing` |
| Existing reservation status | `triage` lookup; include known confirmation, surname and dates |
| Invoice, payment or logistics question | Preserve as a separate question for staff or supported read |

A request may have several routes: e.g. quote a new stay and release a previous booking. Do not turn explicit booking intent into Quote merely because an earlier subject says quotation. A disputed offer or a statement that someone will not stay is not by itself a request to cancel an existing reservation. Use `propose` for an identifiable supported action with editable fields, even when staff must complete a choice or run a lookup. Ask for information only if the request or affected stay cannot be identified from available context. Skip thanks, completed duplicate tasks, OTA/channel, automated and spam notices; agency/GDS requests remain in scope. More than 8 rooms needs staff handling; keep independent supported work.

For a status lookup, publish a `triage` action with `details.lookup` keys `reservation_id`, `guest_name` (surname), `arrival_date`, `departure_date`; unknown values null and known values editable. Each lookup field spec must use its full JSON pointer, for example `/actions/0/details/lookup/guest_name`. Do not declare `booking.property_code`, `booking.reservation_id` or `booking.current_state` editable; the pane cannot edit those paths. `native_result` is null. Do not claim a reservation was found or changed without an actual read, or that a request was forwarded or handed off without an actual handoff. Draft only, never send.
