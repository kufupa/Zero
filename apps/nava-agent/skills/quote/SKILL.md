---
name: quote
description: Use when a current hotel email requests room prices, availability, accommodation quotations, negotiated rates, meal options or several room and occupancy scenarios without explicit new-booking authority.
---

# Quote

Read [common rules](../references/common.md), [rules + native order](references/rules.md), [reply wording](references/replies.md).

1. Gather property, dates, rooms/quantity, per-room adults/children/ages, room/meal requests, native party context. Keep distinct room groups inside one client quote unless separate quotes requested or staff split. Missing required criteria → inspect supplied spec, then specific question. No children indicated → editable zero, not AI-prefilled fact; children indicated → confirm count/ages as needed.
2. Resolve native rate/room/party codes + meanings. Company/government wording guides search, not eligibility. Staff typed code/price overrides remain visible and distinct from native prices.
3. `hms_quote` per date window and compatible native search criteria; preserve group IDs, combine results under same quote. Read native availability + price + restrictions. Absent combination/criteria unavailable ≠ sold out. No quote read holds rooms.
4. Publish options with room/rate code + meaning, meal scope, dated price/currency/basis, native availability, missing/unsupported details. Official total only native-supported; estimates labelled, no invented extras/discounts.
5. Draft offer. “Attached” only real returned artifact. Signed-quote wording observed, not universal auto-book rule. Explicit proceed later → create skill; real Save still staff Go.
6. End turn. Quote never calls `hms_prepare` or `hms_save`. Native confirmed unavailability → factual decline or verified alternative; no silent substitution.

Tools: `skill_read`, `mail_read_thread`, `mail_read_attachment`, `hms_read_catalogue`, `hms_quote`, `proposal_publish`, `reply_draft`. Exact [inputs/proposal](../references/tools-and-proposal.md); unavailable capabilities explicit.

Example: two singles BB plus one double DBB → separate quantity/occupancy groups, priced board per group; no guest-count→room-count guess.
