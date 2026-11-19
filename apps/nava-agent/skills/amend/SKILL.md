---
name: amend
description: Use when a current hotel email requests changing an existing reservation, including dates, occupancy, guest details, room, rate, contact or preferences.
---

# Amend

Read `../references/common.md`, `../references/tools-and-proposal.md`, `references/rules.md` and `references/replies.md` with `skill_read`.

1. Read the selected message and conversation. Use the latest request, preserving the exact guest and stay scope. If attachments are unknown, unread or omitted, warn staff to check them; never invent their contents.
2. Identify the property and confirmation. For each distinct requested stay, search once with the available confirmation, guest and original stay dates together, then read the unique candidate once to verify guest, current stay and Reserved status. A confirmation is a candidate, not proof that it belongs to the requested guest. If the search is ambiguous or the read fails, preserve the request for staff review rather than repeating searches or trying more candidates without new information. Continue any independent stay.
3. Publish one editable Amend proposal for each independently identified stay. Set `booking.reservation_id` to the confirmation, `booking.current_state` to verified current stay facts or null, and `booking.fields` to the requested changes only. When a date correction supplies both check-in and check-out, preserve both supplied dates as editable requested targets. Do not infer which date changed solely from a later HMS value when the source confirmation describes a different state; note the disagreement for staff. Prepare requires verified `current_state.first_name`, `current_state.last_name` and `current_state.arrival_date` matching the saved stay; if unknown, do not invent them. Supported change keys are `arrival_date`, `departure_date`, `adults`, `room_type`, `rate_plan`, `first_name`, `last_name`, `booker_name`, `booker_contact` and `reservation_note`. Omit unrequested fields; never copy current dates or rates into the change. Dates use YYYY-MM-DD. Include an editable `field_specs` path for each requested field and its source evidence. Use action `{id,type:"amend",booking_ids:[booking.id],details:{}}`; use `details.confirmation_number` only when the booking identifier is a native ID rather than the confirmation.
4. Publish `native_result:null`. For date, occupancy, room or rate changes, tell staff native availability and revised totals are pending Prepare. The backend reads the exact saved stay, verifies CMS and identity, and checks availability and price on the staff-edited revision. Rate Shop options are observations, not held inventory.
5. Stop after publishing. Staff reviews attachments and runs Prepare on the current revision. Prepare is unsaved. Do not call a staging tool, Save, Go or send a message. Draft text may acknowledge the request but must not claim the booking changed.

Example: “Guest A leaves one day earlier; Guest B unchanged” means a departure-date change for A and no change to B. Do not cancel the party or reset B's rate.
