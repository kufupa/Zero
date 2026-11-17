---
name: quote
description: Use when a current hotel email requests room prices, availability, accommodation quotations, negotiated rates, meal options or several room and occupancy scenarios without explicit new-booking authority.
---

# Quote

Load shared rules with `skill_read({"skill_name":"quote","path":"../references/common.md"})` and bindings with `skill_read({"skill_name":"quote","path":"../references/tools-and-proposal.md"})`. The `../` is required for both shared files; retry the exact call if a shared file is unavailable. Only `references/rules.md` and `references/replies.md` are relative to Quote without `../`.

1. Gather property, dates, rooms/quantity, per-room adults/children/ages, room/meal requests, native party context. Keep distinct room groups inside one client quote unless separate quotes requested or staff split. Missing required criteria → inspect supplied spec, then specific question. No children indicated → editable zero, not AI-prefilled fact; children indicated → confirm count/ages as needed.
2. Resolve needed native codes + meanings. For a normal room/rate lookup use `hms_read_catalogue({"property_code":"HRCEN","kinds":["room_type","rate_plan"]})` with the thread property. Request other kinds only for an explicit party or code question. Apply board defaults in R5; company/government wording guides search, not eligibility. Staff typed code/price overrides stay distinct from native prices.
3. Call `hms_quote` with stable quote ID and separate date/room groups. Start with nightly `summary` and the native option limit; lowering the limit can hide matching options and make the search partial. Read native availability, price and restrictions per group. Absent combination/criteria unavailable ≠ sold out. No quote read holds rooms.
4. Publish the exact grouped request in `actions[].details`; staff edits and rechecks that request. Use `native_result:null`; backend owns the capture and native display rows. Cover text may cite room/rate code + meaning, meal scope, dated price/currency/basis and availability with missing/unsupported details. Official total only native-supported; estimates labelled, no invented extras/discounts.
5. Draft cover email + signable PDF + editable Excel (R4 owner 2026-11-17; 44/338 attachment-template, 23/338 inline prices). Simple price can appear inline too. Staff selects verified native options and requests the artifact pair after recheck. Say attached only once both files are on the unsent draft. Greet known first name; normally omit organization (R1: 0/33 priced replies named it).
6. Native confirmed unavailability → 1–3 sentences; say which requested nights/rooms remain available and offer to quote. Sister hotel only if staff adds (R2: 6/12 alternatives, 1/12 sister hotel). End turn; no `hms_prepare` or `hms_save`. Later explicit proceed → create skill.

Tools: `skill_read`, `mail_read_thread`, `mail_read_attachment`, `hms_read_catalogue`, `hms_quote`, `proposal_publish`, `reply_draft`. Exact [inputs/proposal](../references/tools-and-proposal.md); unavailable capabilities explicit.

Example (replace all values with actual request and resolved codes):

```js
const details = {quote_id:"quote-1",property_code:"HRCEN",details:"summary",
  groups:[{group_id:"stay-1",arrival_date:"2027-02-01",departure_date:"2027-02-02",rooms:[
    {id:"room-1",quantity:1,adults:2,children:0,child_ages:[]}
  ]}]};
hms_quote(details);
proposal_publish({workflow:"quote",disposition:"propose",reason:null,bookings:[],
  actions:[{id:"quote-1",type:"quote",booking_ids:[],details}],
  field_specs:[{path:"/actions/0/details/groups/0/rooms/0/adults",label:"Adults per room",
    provenance:"ai",editable:true,required:true,error:null,control:"number",options:[],evidence:[]}],
  missing:[],warnings:[],reply_draft:null,native_result:null});
```

One `rooms[]` entry per different occupancy/board. `required` and `preferred` may carry `roomCodes`, `rateCodes`, `bedTypes`, `mealPlanBases`. Publish editable fields for dates, room quantity, per-room occupancy, and supplied constraints at their actual paths. Include the actual `adults`, `children` and `child_ages` paths together, even when the age array is empty, so staff can correct the classification in one edit. Keep reported ages in evidence when classification is provisional. Never invent a room count from a guest count. Missing required facts → `needs_info` with the actual gaps; do not make a speculative HMS read.
