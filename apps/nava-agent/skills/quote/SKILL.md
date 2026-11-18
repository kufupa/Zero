---
name: quote
description: Use when a current hotel email requests room prices, availability, accommodation quotations, negotiated rates, meal options or several room and occupancy scenarios without explicit new-booking authority.
---

# Quote

Use the shared rules and tools-and-proposal bindings already supplied in the pinned context; do not load them again. If either is absent, load that file with `skill_read({"skill_name":"quote","path":"../references/common.md"})` or `skill_read({"skill_name":"quote","path":"../references/tools-and-proposal.md"})`. The `../` is required for both shared files; retry the exact call if a needed shared file is unavailable. Only `references/rules.md` and `references/replies.md` are relative to Quote without `../`.

1. Gather property, dates, rooms/quantity, per-room adults/children/ages, room/meal requests, native party context. Keep distinct room groups inside one client quote unless separate quotes requested or staff split. For partial, rate-match or conflicting requests, publish an editable `quote-1` group with confirmed facts; use `needs_info` and ask specific questions. Leave unknown or conflicting dates, room quantity and adults null; preserve conflicts in `missing` and do not infer allocations. Per Q02, when no children are indicated, use editable `children:0` and `child_ages:[]` as a labelled default, not a fact; if children are indicated but their number or ages are unclear, clarify.
2. Call `hms_read_catalogue` only when the request supplies native codes needing validation or explicitly asks a code question. Resolve those codes and meanings only from the verified thread property and native catalogue. Leave unknown property and native codes null or absent in the draft; never invent a code or price or copy an example into the request. Request other kinds only for an explicit party or code question. Apply board defaults in R5 only on a native-supported plan; company/government wording guides search, not eligibility. Staff typed code/price overrides stay distinct from native prices.
3. Once required criteria are complete and any supplied native codes are verified, call `hms_quote` with stable quote ID and separate date/room groups. Start with nightly `summary` and the native option limit; lowering the limit can hide matching options and make the search partial. Read native availability, price and restrictions per group. Absent combination/criteria unavailable ≠ sold out. No quote read holds rooms.
4. Publish grouped criteria in `actions[].details` with editable `field_specs` even when incomplete; preserve known dates and room bindings, and expose unknown required fields as null for staff. Omit unknown optional code arrays. Put a known guest's full name in `party_name`, never a company. When separate quotes are requested, publish one action per person or party, each with its own unique `quote_id` and full requested guest `party_name`. Add an editable `party_name` field and include the name in its field labels. A party may have multiple room groups within its action. Staff edits and rechecks that request only after required criteria and any supplied native codes are validated. Use `native_result:null`; backend owns the capture and native display rows. Cover text may cite room/rate code + meaning, meal scope, dated price/currency/basis and availability with missing/unsupported details. Official total only native-supported; estimates labelled, no invented extras/discounts.
5. Draft one cover email for all requested parties, plus one signable PDF and editable Excel per party (R4 owner 2026-11-17; 44/338 attachment-template, 23/338 inline prices). Staff selects verified native options after recheck. Say attached only once all files are on the unsent draft. Greet known first name; never name the company in the reply.
6. Native confirmed unavailability → 1–3 sentences; say which requested nights/rooms remain available and offer to quote. Sister hotel only if staff adds (R2: 6/12 alternatives, 1/12 sister hotel). End turn; no `hms_prepare` or `hms_save`. Later explicit proceed → create skill.

Tools: `skill_read`, `mail_read_thread`, `mail_read_attachment`, `hms_read_catalogue`, `hms_quote`, `proposal_publish`, `reply_draft`. Exact [inputs/proposal](../references/tools-and-proposal.md); unavailable capabilities explicit.

Example: a partial quote draft when no children are indicated. Replace each null with a source-confirmed value when known; never send this incomplete draft to `hms_quote`.

```js
const details = {quote_id:"quote-1",property_code:null,details:"summary",
  groups:[{group_id:"stay-1",arrival_date:null,departure_date:null,rooms:[
    {id:"room-1",quantity:null,adults:null,children:0,child_ages:[]}
  ]}]};
const field_specs = [
  ["/actions/0/details/property_code", "Property", "text"],
  ["/actions/0/details/groups/0/arrival_date", "Arrival", "date"],
  ["/actions/0/details/groups/0/departure_date", "Departure", "date"],
  ["/actions/0/details/groups/0/rooms/0/quantity", "Rooms", "number"],
  ["/actions/0/details/groups/0/rooms/0/adults", "Adults", "number"],
  ["/actions/0/details/groups/0/rooms/0/children", "Children (editable default)", "number", "default"],
  ["/actions/0/details/groups/0/rooms/0/child_ages", "Child ages", "text"],
].map(([path,label,control,provenance="unknown"]) => ({path,label,control,provenance,
  editable:true,required:true,error:null,options:[],evidence:[]}));
proposal_publish({workflow:"quote",disposition:"needs_info",reason:"Quote criteria need confirmation",
  bookings:[],actions:[{id:"quote-1",type:"quote",booking_ids:[],details}],
  field_specs,missing:["Confirm missing quote criteria"],warnings:[],reply_draft:null,native_result:null});
```

One `rooms[]` entry per different occupancy/board. `required` and `preferred` may carry `roomCodes`, `rateCodes`, `bedTypes`, `mealPlanBases`. Publish editable fields for dates, room quantity, per-room occupancy, and supplied constraints at their actual paths. Include the actual `adults`, `children` and `child_ages` paths together, even when the age array is empty, so staff can correct the classification in one edit. Keep reported ages in evidence when classification is provisional. Never invent a room count from a guest count. Missing required facts → `needs_info` with the actual gaps; do not make a speculative HMS read.
