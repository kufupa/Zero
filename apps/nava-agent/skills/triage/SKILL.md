---
name: triage
description: Use when an inbound hotel email needs routing, including multiple guests, stays, documents or overlapping requests.
---

# Triage

Read the selected message and relevant earlier context. Treat the selected message as current and ignore later thread messages. If it answers a staff clarification for an unresolved quote, continue the Quote using the earlier request and the answer. Load `../references/common.md`, `../references/tools-and-proposal.md` and `references/rules.md` using `skill_read`.

**Automated notices:** Skip automated no-reply, bedbank and channel notices without a current human request. Publish `workflow: "triage"`, `disposition: "skip"` and no actions, including when an automated cancellation notice has a supplier reference or boilerplate telling the hotel to cancel. A human travel-agent request stays in scope, including a new request in a forward.

Route each current request separately, preserving its guest, stay, dates, document and other known fields. Then load the relevant skill and publish its editable proposal **with that skill's workflow** (publish `create` / `quote` / `amend` / `cancel` / `filing` — do not leave `workflow: "triage"` when a supported action is clear). The current body takes precedence over an old subject or quoted request. An existing-confirmation or pre-stay notice is about an existing stay; retain any separate new request. Mixed work is common: 590/1,439 model-labelled decisions had multiple workflow labels.

**Primary ask wins.** A clear book/reserve/check-in request is Create even when the same mail also asks about commission, dinner wording, an invoice link, or a shuttle — and even when an old confirmation number appears in the subject or quoted thread (that number is context, not an instruction to Amend). "Assist with an invoice for the below booking" / "confirm as per below" with guest+dates+room is Create. A clear rate/availability/how-much ask is Quote when the mail does **not** ask to book/reserve/proceed/accept; missing room count or occupancy does not turn Quote into Create or Triage. Extend/shorten stay or updated rooming list ("add one more room") is Amend even if the same mail also asks about a scam confirmation email. **Cancel:** cancel/cancellation/release wording plus a confirmation number (subject or body) is Cancel even when polite, forwarded, or asking fee/refund/policy for that stay — publish `cancel` (use `skip` only when HMS already shows Cancelled). Keep the secondary question in `warnings` or `missing` for staff; do not stay on Triage solely because a side question is "other". Use Triage lookup for status, reconfirmation, invoice-only or logistics requests with no action from the table below.

For a new stay, “make a booking”, “please book” or “confirm the booking” means Create even when the same email also asks about rates or board; a pure rate or availability question stays Quote.

**Filing:** When the current sender supplies a voucher or proof of payment ("please find attached", "here is the POP"), route to Filing even alongside an invoice request, payment link or logistics. If the selected PDF is unavailable, publish `workflow: "filing"` with `disposition: "needs_info"` and no attachment action. Ask staff to select the PDF and keep the secondary request visible. Earlier quoted documents, a promise to pay, and a request for someone to send a voucher do not count as a current submission.

When the selected message has a blank or near-blank body and a PDF identified by its filename or available extracted text as a voucher, POP or proof of payment, route the file to Filing for staff review. Preserve its selected message and attachment IDs and use any extracted text for the booking reference. A filename is a document hint, not proof of its contents or payment; leave uncertain PDFs for staff review.

| Current request | Route |
|---|---|
| Price or availability (no book/proceed) | `quote` |
| Book, reserve, proceed, or accept an offer (new stay) | `create` |
| Change a booked stay or shorten its dates | `amend` |
| Cancel / cancellation fee-policy-refund for a named confirmation | `cancel` |
| Submit a voucher or proof of payment | `filing` |
| Existing reservation status only | `triage` lookup; include known confirmation, surname and dates |
| Invoice, payment or logistics question (no cancel/book/quote) | Preserve as a separate question for staff or supported read |

A request may have several routes: e.g. quote a new stay and release a previous booking. Do not turn explicit booking intent into Quote merely because an earlier subject says quotation. A request to change an existing confirmation remains Amend for staff review if HMS now shows it cancelled or checked out; do not turn it into Create unless a new booking is requested. A disputed offer or a statement that someone will not stay is not by itself a request to cancel an existing reservation. Use `propose` for an identifiable supported action with editable fields, even when staff must complete a choice or run a lookup. Ask for information only if the request or affected stay cannot be identified from available context. Skip thanks, completed duplicate tasks, OTA/channel, automated and spam notices; agency/GDS requests remain in scope. More than 8 rooms needs staff handling; keep independent supported work.

If a current cancellation request refers to a stay already shown as Cancelled in HMS, keep the `cancel` workflow and publish a `skip` disposition with the verified bookings and no cancel action. Preserve each confirmation and observed stay dates; do not route this completed cancellation to Triage or cancel it again.

When the current message asks staff to assist with rooms for specified guests and dates and frames it as a reservation or booking, route to Create even if it does not use the word "book". A request solely for price or availability remains Quote.

For an existing-stay question needing reservation context, use a scoped `hms_read_reservation` or `hms_search_reservations` with the source confirmation or guest and available dates. A guest-profile search alone does not establish whether a reservation exists. Keep separate lookups for distinct identified stays, alongside any invoice or payment work for staff. For each lookup, publish an action with `type: "triage"` and `details.lookup` keys `reservation_id`, `guest_name` (surname), `arrival_date`, `departure_date`; unknown values null and known values editable. `lookup` and `triage_lookup` are not supported action types. Each lookup field spec must use its full JSON pointer, for example `/actions/0/details/lookup/guest_name`. Do not declare `booking.property_code`, `booking.reservation_id` or `booking.current_state` editable; the pane cannot edit those paths. `native_result` is null. Do not claim a reservation was found or changed without an actual read, or that a request was forwarded or handed off without an actual handoff. Draft only, never send.
