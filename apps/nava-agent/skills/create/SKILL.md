---
name: create
description: Use when a current hotel email explicitly requests booking or proceeding with a new reservation, including several guests, rooms, agency billing, meals, vouchers and confirmation details.
---

# Create

Load shared rules with `skill_read({"skill_name":"create","path":"../references/common.md"})` and bindings with `skill_read({"skill_name":"create","path":"../references/tools-and-proposal.md"})`. Paths are relative to the Create directory. Read [decisions + fields](references/rules.md) and [reply drafts](references/replies.md) as `references/rules.md` and `references/replies.md` under `skill_name:"create"`.

1. Confirm current explicit booking intent. Enquiry → quote; existing-confirmation notice → read/Amend, never Create (R6). Resolve guest/stay assignments; search duplicates on repeat/reconfirm/rebook.
2. Capture guest, property, dates, per-room occupancy/child ages, requested room/rate/meals, bill-to and relevant docs. For the selected email or any email you rely on, if `attachment_status` is `unknown`, `has_unread`, or omitted, add a proposal warning asking staff to check its attachments in Outlook. If a required detail depends on an unavailable attachment, name the gap; do not infer its contents. HRCEN Create: a stated age of 17 is a child, not an adult; include `child_count` and `child_ages` (e.g. one 17-year-old → `child_count:1, child_ages:[17]`). Put identified booking agency in `fields.agency_name`. Put conditional room fallback in `fields.note`; keep requested room count. Verify profile match; no arbitrary same-name profile.
3. Resolve native codes + meanings; fetch exact stay's availability/price. Company ≠ negotiated-rate eligibility; employer ≠ bill-to; voucher ≠ POP.
4. Stage business fields in verified legacy sequence: arrival → departure → adults → source → room type → rate plan → track → guarantee → guest first/last name → Check Availability. Optional fields use supported native controls; placement not fully evidenced.
5. Publish editable proposal per guest/stay: ordered fields, native price evidence when available, docs, gaps, warnings and CMS Send (R3; default on, Labtest off), editable requester recipient. Preserve staff overrides. Always set Create `native_result:null`; do not paste raw prepare output or fabricate a result.
6. `hms_save` waits for staff Go on real guest. Multi-room → sequential single-room saves/readbacks, no hard count cap; ≥10 → staff group review first (R8). Uncertain result → read/reconcile, never blind retry.
7. Verify actual created identifier + intended business fields for each item. Draft confirmation only for verified items; uncertain/partial result remains explicit. Filing follow-up uses separate task.

Staff pilot (2026-11-17): Prepare only. Publish and stop; staff runs Prepare on the edited proposal. Save is off, including Labtest. Steps 6–7 apply only when Save is enabled. Clear booking intent with an unresolved native choice → `propose` so staff can edit and Prepare. For an agency “series rate” without a verified code, set `bookings[0].fields.rate_plan:null`; expose `/bookings/0/fields/rate_plan` as required, editable, `provenance:"unknown"`. Put the requested agency and rate wording in evidence/warnings. Use `staff_review` for unsupported terms the editor cannot resolve.

Tools: `skill_read`, `mail_read_thread`, `mail_read_attachment`, `hms_search_reservations`, `hms_read_reservation`, `hms_read_catalogue`, `hms_quote`, `hms_prepare`, `hms_save`, `proposal_publish`, `reply_draft`. Exact [inputs/proposal](../references/tools-and-proposal.md); runtime capabilities govern availability.

### Exact Create wire example

Reuse the same booking and action in prepare and publish. Use `first_name` and `last_name`. Put the reservation note in `bookings[].fields.note`, never in `action.details` (must be `null` or `{}`). Every field spec points into `/bookings/<index>/fields/<key>`. If native controls cannot represent a requested meal or bill-to arrangement, preserve the exact request in `warnings` and publish `staff_review`; do not invent keys such as `meal_plan` or `organization_bill_to`, substitute a rate/payer, or treat a note as fulfilling the request.

Shape only: replace sample values with verified inputs, add required native selections before prepare, and include a field spec for each displayed field in staff order. This example still needs staff review for billing.

```js
const booking = {id:"stay-1", property_code:"HRCEN", reservation_id:null, current_state:null,
  fields:{arrival_date:"2027-08-24", departure_date:"2027-08-25", adults:1,
    first_name:"Proof", last_name:"Labtest", note:"Quiet room requested", cms_send:false}};
const action = {id:"create-1", type:"create", booking_ids:["stay-1"], details:null};
hms_prepare({workflow:"create", booking, action});
proposal_publish({workflow:"create", disposition:"staff_review", reason:"Billing needs staff review",
  bookings:[booking], actions:[action], field_specs:[{path:"/bookings/0/fields/first_name",
    label:"First name", provenance:"ai", editable:true, required:true, error:null,
    control:"text", options:[], evidence:[]}], missing:[],
  warnings:["Agency requests room charges only; confirm payer and billing setup."],
  reply_draft:null, native_result:null});
```
