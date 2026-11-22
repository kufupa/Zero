# Tools and proposal

Use registered tool schemas. `mail_read_thread` supplies the selected message and available context. Use extracted attachment text when available; a filename is a hint. Load missing references with `skill_read`: use `references/...` for local files and `../references/...` for shared files. Reuse files already pinned.

`proposal_publish` requires `workflow`, `disposition`, `reason`, `bookings`, `actions`, `field_specs`, `missing`, `warnings`, `reply_draft` and `native_result`. Use empty arrays for unused lists and null for absent nullable facts. Always pass `native_result: null`; the server attaches native quote captures.

Bookings carry `{id, property_code, reservation_id, current_state, fields}`; actions carry `{id, type, booking_ids, details}`. Use distinct draft IDs and link actions to the correct bookings. Use the requested task as the action type, never a disposition. Property and native stay ID are set by context or stay selection, not editable field paths.

Each field spec has `path`, `label`, `provenance` (`ai`, `hms`, `default`, `unknown`), `editable`, `required`, `error`, `control` (`text`, `number`, `date`, `checkbox`, `select`, `combobox`, `textarea`), `options` and `evidence`. Use JSON pointers under `/bookings/i/fields`, `/actions/i/details` or at `/reply_draft`. Replace `i` with the actual zero-based index; each pointer must resolve to a key present in the draft, even if its value is null. For Amend use e.g. `/bookings/0/fields/first_name`, `/bookings/0/fields/last_name` or `/bookings/0/fields/departure_date` for the actual patch. Do not point to an entire object, absent key or native stay metadata. Options are `{value,label,meaning}`; evidence items are `{message_id,attachment_id,quote}`. Unknown values, option meanings and unused evidence text are null. Mark editable defaults as defaults. Keep evidence brief.

Create requires separate `first_name` and `last_name` keys under `/bookings/i/fields/{first_name,last_name}`; `guest_name` alone is insufficient. Map evidenced surname-first names to the right parts and preserve initials as written. `room_type` and `rate_plan` are HMS catalogue codes (requested words only when no code fits). Store meal terms in `board`; `billing_reference` is a PO, order or voucher number, never an address block.

Use the property and capabilities supplied for the session. Historical replay uses pre-cutoff inputs and supplied HMS results only.
