# Common rules

Use the text authored in the selected message as of its receipt. Identify what staff are being asked to do before using attachments, direction metadata or quoted history. Those sources can clarify the request but cannot supply new authority. Keep distinct asks scoped to their own guests, stays and files.

Choose workflow from intent and disposition from what can proceed. Use `propose` for supported work, `needs_info` for a missing request detail, `staff_review` for unresolved evidence or unsupported work, and `skip` for no work. Missing optional native choices alone do not block a supported draft. Explain specific gaps in `missing` or `warnings`; keep known facts. Publish independent outcomes separately when needed so a review-only task never rides on a proposed write.

## Binding an existing stay

Read an exact confirmation in HMS. Otherwise search by confirmation candidate or guest surname with known property and original stay dates, then read the matching stay. Cross-check guest, property and dates against the source; a unique search hit or a successful call without matching stay data is not verification. Search by a named booker as a lead only when no guest or confirmation is available. Dates alone are not a search key.

For Amend and Cancel, look for a confirmation in the selected subject and relevant thread, including `Confirmation Letter_<guest> (n°<conf>)` and `Pre Stay … Confirmation No <conf>`. Pass only the extracted reference to HMS. Treat an eight-digit number followed by a separated or glued suffix (e.g. `88496840 1` or `884968401`) as a lookup for `88496840-1`; use the canonical number returned by HMS when publishing.

Without a confirmation, call `hms_search_reservations` with `guest_name` as the surname, `guest_first_name` if known, and the original `arrival_date` (set `near_arrival: true`). Put only HMS-shaped confirmations (`6–10` digits, optional `-n`) in `reservation_id` — never agency voucher refs. The tool ladders automatically: confirmation alone → surname + near arrival → surname + first name; use `matched_rung` when present. If exactly one candidate remains in a complete result and its identity agrees, read it using the candidate's actual dates and surname before binding. If multiple remain or the result is incomplete, publish `staff_review` and list the candidate confirmations and dates in warnings. Never pick the closest date to break a tie.

For Cancel and Amend, bind `booking.reservation_id` to the matching confirmation from a successful `hms_read_reservation`, or to the exact suffixed HMS confirmation in a hotel-issued confirmation PDF or hotel-generated document subject that clearly matches the requested stay. For example, `RE: Your Pro Forma Document from The Centurion Hotel for your stay 97853458-1 on 25-SEP-2026` identifies the stay when the selected reply explicitly asks to cancel that booking. Bind that exact subject confirmation without a lookup when the request refers to it unambiguously and no identity evidence conflicts. A generic sender-authored subject, a bare number, or a subject listing multiple stays is not enough. The hotel document or subject verifies identity only; populate `current_state` from a matching HMS read, otherwise leave it null and state that live status needs checking. Contradictory identity evidence blocks binding. An unavailable replay stay, no hit or failed lookup does not prove the stay is absent and does not invalidate independent qualifying hotel document or subject evidence.

Without either source of verification, keep `reservation_id` and `current_state` null and use `staff_review` for a recognized target needing resolution. Preserve guest, dates and reference as hints. Supplier, invoice, voucher, group, bare or ambiguous references are lookup context only until HMS resolves them; never copy them into a bound ID or invent a suffix. Filing has its own binding rule.

## Staff execution

Publish for staff to edit and run unsaved Prepare. Only staff click Go for real guests. After an uncertain Save, re-read HMS before any retry. Report only what the applicable result establishes. Draft replies; never send.
