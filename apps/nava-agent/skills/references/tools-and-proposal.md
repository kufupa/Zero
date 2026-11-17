# Backend bindings

Normative wire owner: `/home/orca/nava-rewrite/contracts/nava-agent-backend.md`, v0 2026-11-17. Use actual registered input schema; capabilities govern availability. Names below exact, not proposed aliases. Missing handler/unsupported native field → explicit staff review or needs info; no invented tool, no no-op success.

## Tools

| Tool | Input | Result/use |
|---|---|---|
| `skill_read` | `skill_name` (`triage|quote|create|amend|cancel|filing`), optional `path` | Pinned `SKILL.md` default or contained relative reference; whole skills tree mounted |
| `mail_read_thread` | `{}` | Authorized session messages + attachment metadata |
| `mail_read_attachment` | `message_id`, `attachment_id` | Supplied document text/metadata or explicit unavailable |
| `hms_search_reservations` | `property_code`, `criteria` | Criteria only `reservation_id`, `guest_name`, `arrival_date`, `departure_date`; candidate list |
| `hms_read_reservation` | `property_code`, `reservation_id` | Fresh saved state; verify identity/status/business fields |
| `hms_read_catalogue` | `property_code`, `kinds` | Kinds: `room_type`, `rate_plan`, `meal_plan`, `source_of_business`, `track`, `guarantee_type`, `organization`, `agency` |
| `hms_quote` | `property_code`, `arrival_date`, `departure_date`, `rooms`; optional `search`, `details`, `max_options_per_group` | Native capture, not booked inventory |
| `hms_prepare` | `workflow`, `booking`, `action` | Workflow `create|amend|cancel|filing`; complete Booking/Action below; unsaved stage, session closes |
| `proposal_publish` | Complete ProposalDraft below | Returns `proposal_id`, `revision`, `phase`; no Save |
| `hms_save` | `proposal_id`, `expected_revision` | Real guest idle until staff Go; backend pins edited revision; actual Save + fresh readback result |
| `reply_draft` | `proposal_id`, `text` | Draft only; never sends |

`hms_quote.rooms[]`: `id` string, `quantity` integer ≥1, `adults` integer ≥1, `children` integer ≥0, `child_ages` integer array ≥0; all required. Groups share top-level dates/search in each call; split incompatible dates/search, preserve quote/group identity across calls. Search subkeys use registered native schema; never guess keys or code IDs. `details` = `summary|full`. Required gaps stay missing except declared editable quote default: no children indicated → zero + empty ages, not AI extraction. Native boolean defaults supplied by adapter. Don't guess adults or quantity.

Load linked files using `skill_read`; e.g. quote rules `{"skill_name":"quote","path":"references/rules.md"}`, common rules `{"skill_name":"quote","path":"../references/common.md"}`, bindings `{"skill_name":"quote","path":"../references/tools-and-proposal.md"}`. Paths normalized inside mounted whole skills tree; no arbitrary source-dataset/host reads. If runtime lacks contained shared-reference access, report packaging gap; do not act without loaded rules. Backend must preserve these links when bundling/uploads.

Result envelope: `ok`, `data`, `error` (`code`, `message`, `retryable`, `outcome`). `retryable` never authorizes blind Save retry. Unavailable quote criteria ≠ hotel sold out; null/absent results ≠ zero inventory.

## ProposalDraft

`proposal_publish` requires all keys; no extra top-level keys:

```json
{
  "workflow": "triage",
  "disposition": "needs_info",
  "reason": "Booking target unclear",
  "bookings": [],
  "actions": [],
  "field_specs": [],
  "missing": ["reservation reference or guest/stay details"],
  "warnings": [],
  "reply_draft": null,
  "native_result": null
}
```

- Workflow: `triage|quote|create|amend|cancel|filing`.
- Disposition: `propose|needs_info|decline|skip|staff_review`.
- Booking: `{id,property_code,reservation_id,current_state,fields}`. Stable opaque `id`; unknown identities null; `current_state` object/null from saved read; `fields` only intended proposed business values. Never merge untouched saved values into amendment patch.
- Action: `{id,type,booking_ids,details}`. Stable opaque `id`; `booking_ids` refer only to listed bookings. Preserve multi-guest/document/action association; never infer room scope from array position.
- `field_specs[]` ordered in staff task order. Every item: `path`, `label`, `provenance`, `editable`, `required`, `error`, `control`, `options`, `evidence`.
- `path`: RFC6901 JSON Pointer into proposal, e.g. `/bookings/0/fields/arrival_date`. Distinct array indices with stable booking IDs; never reuse another guest's pointer.
- `provenance`: `ai|staff|hms|unknown`; `control`: `text|number|date|checkbox|select|combobox|textarea`. Staff edits preserve `staff`, not AI.
- `options[]`: `{value,label,meaning}` from native choices, not historical hard-coded lists. `evidence[]`: `{message_id,attachment_id,quote}`; attachment ID/quote nullable. Cite available current/earlier source only.
- `native_result`: original native price/availability/staging evidence; distinguish staff override from native price. `missing`/`warnings`: concrete strings, not invented policy.
- Backend adds proposal/session/thread IDs, integer revision, phase/stage/result/error. Never supply invented confirmation number or backend-owned fields to `proposal_publish`.
- `display_rows` backend-owned, derived from saved native capture. Calculated nightly sums `basis:"calculated",official:false`; preserve native price basis. Agent never authors payable total or typed display rows from guesswork.

Canonical create field keys: `arrival_date`, `departure_date`, `first_name`, `last_name`, `adults`, `room_type`, `rate_plan`, `source_of_business`, `track`, `guarantee_type`; supported native optional keys only. Quote keys: `arrival_date`, `departure_date`, `rooms`, `search`, `details`, `max_options_per_group`. Amend/cancel/filing native field keys come from registered adapter, not fabricated aliases. Action type mapping follows supported adapter; semantic types documented per skill, not guarantee of implemented handler.

## Checkpoints

- Quote/triage: publish proposal → draft if needed → end turn; no fake staging/Save.
- Mutations: read + prepare → publish → `hms_save` returned ID/revision → wait; no repeated Save request while pending.
- Staff edits invalidate old staged revision. Tool resumes with backend-re-staged staff-approved result; assess returned saved state, not original AI proposal.
- Historical mode: supplied pre-cutoff mail/fixtures only; no live HMS/catalogue/price, Save or outgoing side effects. If fixture unavailable, report missing; never fill from future corpus/HMS. At pending Save, stop without invented tool result.
- Initial thin backend advertises only implemented tools (quote/Create first); declarative contract ≠ live capability/e2e proof. PDF/Excel generation, native penalty preview, filing document options may need adapter support; no extra tool names invented.
