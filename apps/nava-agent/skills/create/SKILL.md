---
name: create
description: Use when the selected hotel email asks staff to place or proceed with a new room reservation.
---

# Create

Read [common rules](../references/common.md), [proposal bindings](../references/tools-and-proposal.md), [field rules](references/rules.md) and [reply drafts](references/replies.md).

1. “Kindly reserve”, “book” or “confirm the rooms” after a quote is Create. An agency order can also be Create even when formatted as a voucher. Distinguish this from a document for an existing stay (Filing) or a VCC settlement notice (Triage). Start with the selected request and read the accepted quotation, earlier messages and rooming list it refers to. Carry forward unchanged terms and use newer explicit corrections on the affected rooms.
2. Build `bookings[]` before deciding disposition. Use one row per requested room in source order, with its own guest and stay details. If a list names guests but does not establish their room allocation, retain one draft row per listed guest, with shared facts copied to each. Note that the room count or sharing still needs confirmation. If neither count nor names are known, keep the shared facts in one review row.
3. An order for 1–8 rooms at Centurion with a clear room count and scope is an ordinary Create. Publish `propose` and one `create` action with `details: {}` linking every row; Prepare handles each room separately. A missing or conflicting editable detail (bed, rate, dates or guest profile) does not remove the action. Keep evidenced values, leave unresolved values blank, and explain what staff must check before preparing.
   For more than eight rooms, publish every room row with `staff_review`, no action, and a note that staff must handle the larger order. For a hotel split, prefill the evidenced Centurion portion and note the other property or dates. If the Centurion portion or requested room allocation itself is unresolved, keep every parsed row with `staff_review`, no action, and explain the open decision.
4. Put facts in `booking.fields`, with separate `first_name` and `last_name`, ISO dates, occupancy, catalogue room and rate codes, board, matched organization and agency, and the supplied billing reference. Repeat a shared value on every room it covers; keep room-specific overrides on their own rows. Leave only unknown values null and list them in `missing`. Use editable specs for extracted fields as needed; the editor adds standard Create controls. Put side asks (invoice, transfer, payment link) in `warnings`.
5. Staff confirms and prepares the booking. After verified Create readback, if the original selected message also supplied a genuine voucher or POP for that new stay, publish a separate Filing draft using that exact file and the readback target. Do not publish a pending filing target.
