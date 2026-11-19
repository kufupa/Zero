# Tools and proposal

Use registered tools and their input schemas. `mail_read_thread` returns current mail and available context; inspect a supplied attachment if its text is needed. Search/read HMS when available. `hms_quote` reads prices and availability; it does not reserve rooms. Native price or other missing results do not prevent publishing an editable proposal.

Load skill-local files as `skill_read({"skill_name":"quote","path":"references/rules.md"})` and shared files as `skill_read({"skill_name":"quote","path":"../references/common.md"})`. The `../` is required for shared references.

`proposal_publish` requires all top-level keys:

```json
{"workflow":"create","disposition":"propose","reason":null,
 "bookings":[{"id":"stay-1","property_code":"HRCEN","reservation_id":null,"current_state":null,"fields":{"first_name":null,"last_name":null,"arrival_date":null,"departure_date":null}}],
 "actions":[{"id":"create-1","type":"create","booking_ids":["stay-1"],"details":{}}],
 "field_specs":[],"missing":[],"warnings":[],"reply_draft":null,"native_result":null}
```

Replace example values with the actual request. Use `propose` for an identified supported action; `needs_info` is a disposition, not an action type. For each field staff can edit, include a `field_specs` item with all of `path`, `label`, `provenance` (`ai`, `hms`, `default`, `unknown`), `editable`, `required`, `error`, `control` (`text`, `number`, `date`, `checkbox`, `select`, `combobox`, `textarea`), `options` and `evidence`. A path must resolve to the actual field, e.g. `/bookings/0/fields/arrival_date`; set unknown values to null. Options are `{value,label,meaning}`; evidence is `{message_id,attachment_id,quote}`, with unknown attachment or quote null. Preserve separate guest/stay IDs, and put changed fields only in an Amend patch. `native_result` must be null: the server attaches a captured native result.

Create field keys include `first_name`, `last_name`, `arrival_date`, `departure_date`, `adults`, `room_type`, `rate_plan`, `source_of_business`, `track`, `guarantee_type`, `note` and `cms_send`. Keep the agency, organization, meal, billing, child and other requested details in supported editable fields; retain anything not supported in a warning or note for staff. Use action type `triage`, `create`, `amend`, `cancel`, `quote`, `voucher_submission` or `payment_proof_submission` as appropriate, not a disposition as an action type.

For quote, keep stable `quote_id` and date/occupancy groups in the `quote` action details. Each native group has `group_id`, `arrival_date`, `departure_date`, and rooms with `id`, `quantity`, `adults`, `children`, `child_ages`. No children indicated: editable default `0` and `[]`. Unknown fields remain editable; only call the native quote tool when its required input is available. Native results are not guest bookings.

Staff reviews and edits, then triggers Prepare and Go. Historical replay uses only supplied pre-cutoff context and no live HMS or Save. `reply_draft` saves a draft; it never sends mail.
