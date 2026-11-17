---
name: quote
description: Use when a current hotel email requests room prices, availability, accommodation quotations, negotiated rates, meal options or several room and occupancy scenarios without explicit new-booking authority.
---

# Quote

Read [common rules](../references/common.md), [rules + native order](references/rules.md), [reply wording](references/replies.md).

1. Gather property, dates, rooms/quantity, per-room adults/children/ages, room/meal requests, native party context. Keep distinct room groups inside one client quote unless separate quotes requested or staff split. Missing required criteria → inspect supplied spec, then specific question. No children indicated → editable zero, not AI-prefilled fact; children indicated → confirm count/ages as needed.
2. Resolve native rate/room/party codes + meanings. Apply board defaults in R5; company/government wording guides search, not eligibility. Staff typed code/price overrides stay distinct from native prices.
3. Call `hms_quote` with stable quote ID and separate date/room groups. Read native availability + price + restrictions per group. Absent combination/criteria unavailable ≠ sold out. No quote read holds rooms.
4. Publish options with room/rate code + meaning, meal scope, dated price/currency/basis, native availability, missing/unsupported details. Official total only native-supported; estimates labelled, no invented extras/discounts.
5. Draft cover email + signable PDF + editable Excel (R4 owner 2026-11-17; 44/338 attachment-template, 23/338 inline prices). Simple price can appear inline too. After publish, call available `quote_artifacts`; name only files returned. Greet known first name; normally omit organization (R1: 0/33 priced replies named it).
6. Native confirmed unavailability → 1–3 sentences; say which requested nights/rooms remain available and offer to quote. Sister hotel only if staff adds (R2: 6/12 alternatives, 1/12 sister hotel). End turn; no `hms_prepare` or `hms_save`. Later explicit proceed → create skill.

Tools: `skill_read`, `mail_read_thread`, `mail_read_attachment`, `hms_read_catalogue`, `hms_quote`, `proposal_publish`, `quote_artifacts`, `reply_draft`. Exact [inputs/proposal](../references/tools-and-proposal.md); unavailable capabilities explicit.

Example: two singles BB plus one double DBB → separate quantity/occupancy groups, priced board per group; no guest-count→room-count guess.
