---
name: create
description: Use when the selected hotel email asks staff to place or proceed with a new room reservation.
---

# Create

Read [common rules](../references/common.md), [proposal bindings](../references/tools-and-proposal.md), [field rules](references/rules.md) and [reply drafts](references/replies.md).

1. “Kindly reserve”, “book” or “confirm the rooms” after a quote is Create. An agency order can also be Create even when formatted as a voucher. Distinguish this from a document for an existing stay (Filing) or a VCC settlement notice (Triage). Start with the selected request and read the accepted quotation, earlier messages and rooming list it refers to. Carry forward unchanged terms and use newer explicit corrections on the affected rooms.
2. Build `bookings[]` before deciding disposition. Put every parsed Centurion booking in the draft, one row per requested room in source order. Retain named guests, dates and all other evidenced fields even if checkout, room allocation, a guest profile or an attachment needs staff. If the count is unknown, keep the known stay details in a draft row and say the count is unresolved. Preserve the scope of orders over eight rooms without offering to prepare them.
3. Use `propose` when staff can prepare the booking at Centurion and fill any missing native choices in the pane. Publish one grouped `create` action with `details: {}` linking every row. For a split across hotels, prefill the stated Centurion portion and call out the other property or dates in `warnings`. If staff must resolve the allocation, property or a material conflict before the Centurion request can proceed, use `staff_review` with `actions: []` and keep the booking rows intact. A missing profile or catalog match by itself does not block the draft.
4. Put facts in `booking.fields`, with separate `first_name` and `last_name`, ISO dates, occupancy, catalogue room and rate codes, board, matched organization and agency, and the supplied billing reference. Repeat a shared value on every room it covers; keep room-specific overrides on their own rows. Leave only unknown values null and list them in `missing`. Use editable specs for extracted fields as needed; the editor adds standard Create controls. Put side asks (invoice, transfer, payment link) in `warnings`.
5. Staff confirms and prepares the booking. After verified Create readback, if the original selected message also supplied a genuine voucher or POP for that new stay, publish a separate Filing draft using that exact file and the readback target. Do not publish a pending filing target.
