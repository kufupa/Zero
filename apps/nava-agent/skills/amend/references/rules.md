# Amend rules + field order

- A01 Match exact native booking/property/guest/stay before patch. Same thread may refer to different confirmation numbers. Agency/booking refs are not HMS confirmations; with no digit/`-N` conf, search by surname + arrival. Backend search `reservation_id` is not permission to guess from confirmation number; use candidate identity returned by supported lookup.
- A02 Latest current delta wins. Fresh saved `current_state` stays separate from requested patch. Include explicitly requested targets even when HMS already matches, with an already-matches warning; staff decides whether to proceed. R6: pre-stay confirmation notice = existing stay; 20/107 self-mails had guest text → surface actual note/change candidate.
- A03 Each guest/room targeted independently. Extension/shortening existing stay → amend; adding genuinely new room → create task; removing one entire booked room → cancel that item; group allotment release → staff review. “Cancel last night” normally means shorten dates; inspect actual request before selecting full cancel.
- A04 Date/occupancy/room/rate changes require native re-rating/Check Availability after staging, not old rate assumption. Standalone quote price ≠ held-inventory amendment proof. Expose changed native prices/unknown restrictions; never invent totals/eligibility or silently keep an inapplicable old rate.
- A05 Guest-name correction, replacement occupant and guest-profile modification are different scopes. Use supported stay field; disclose wider profile/linked-stay effects if native tool reports them. No same-name auto-bind or group-wide propagation from individual ask.
- A06 Native typed room/rate/source/track/guarantee codes + meaning where supported; billing/company/contact/note fields only actual adapter support. On an explicit room-change ask, call `hms_read_catalogue({property_code, kinds:["room_type"]})` and keep one unique directly supported returned `room_type` code (including when current state already matches); never handcode or guess codes; never publish free-text `room_mix` / invent keys — unsupported keys are stripped. Caller-supplied key order ≠ established HMS visual order. Old single-field/Labtest/2027 guard scope ≠ product refusal policy.
- A07 Invoice/pro-forma correction may be invoice-only, not room-rate amendment. Employer ≠ bill-to; exact payer scope required. Unsupported contact/billing/comment operation → explicit staff review. Late checkout/room preference noted ≠ availability or fulfillment guaranteed.
- A08 Missing target/room mapping/delta → needs info. A found Cancelled stay keeps its confirmation and the requested Amend; report the native status blocker for staff. Native business impossibility → factual review/decline. Unsupported preference remains staff review, never dismissed FYI. Tool failure never skip.
- A09 Publish and stop. Staff runs unsaved Prepare against the edited revision. Never claim a booking has changed from a preview.
- A10 This preview requires the existing CMS Send setting to be observed off and leaves it unchanged. If it is on or unknown, report that Prepare cannot safely proceed. Do not invent a recipient or send a confirmation.

## Native transaction + proposed staff groups

Verified legacy transaction: open Guest Stay → find confirmation + read current stay → validate target → apply requested fields in caller order (fill/blur/native read) → Check Availability → Save → settle → reopen by confirmation → fresh status/field readback.

Proposed editable grouping: target/current state → dates → occupancy → room/charge-room → rate/meal/native price → guest/contact → billing → notes → CMS controls → preview/Save/readback. Show requested/supported fields; CMS is staff control beside delta.

Native amendment fields depend on adapter: dates, adults/children, room type; rate, Booker/contact and track only when supported. These native aliases mapped by backend once; don't pass guessed JSON keys. No whole-form pins.
