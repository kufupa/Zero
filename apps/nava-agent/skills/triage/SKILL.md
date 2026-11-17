---
name: triage
description: Use when a new hotel email needs routing, several guests or tasks overlap, quoted history obscures current intent, or voucher, payment, group, agency and notification requests need separating.
---

# Triage

Read [common rules](../references/common.md), then [routing rules](references/rules.md). Current request first; one task per guest/stay/document.

1. Read current inbound + earlier chronology. Separate quoted history. Body missing → original message/MIME if available; do not infer no request from empty parser output.
2. Apply R7 host rules + exceptions. Extract current asks, dates/guests/booking refs, relevant documents. Existing-confirmation mail → existing stay; surface pre-stay guest text per R6.
3. Route each task using table below. Preserve independent tasks and explicit missing info. Earlier staff reply ≠ every current task complete.
4. Publish ordered task list + target + reason + source IDs + unresolved conflicts. Read existing booking when current ask is status/check; never re-create from quoted booking request.
5. Open relevant skill. Triage itself never calls `hms_save`. Draft only when useful; skip acknowledgments without manufactured reply.

| Current intent | Route |
|---|---|
| Price/availability enquiry | `quote` |
| Explicit book/proceed instruction | `create` |
| Change existing booking | `amend` |
| Cancel existing booking | `cancel` |
| Supplied voucher/POP/booking document | `filing`; distinct document roles |
| Invoice/payment/status/logistics question | Read-supported answer or staff review; not automatic document filing |
| ≥10 rooms to book | Rooming-list/group review; preserve supported quote and individual work (R8) |
| Missing task-critical evidence | Needs info; ask exact missing detail |
| Thanks/duplicate with same completed task verified/no new ask | Skip with reason; no automatic reply |
| Excluded host / Booking.com notice | Skip unless R7 exception; other agency/GDS/no-reply signals alone insufficient |

No universal automatic decline policy found. Active unsupported task → staff review. Native unavailability → quote-specific decline, not global triage suppression.

Tools: `skill_read`, `mail_read_thread`, `mail_read_attachment`, `hms_search_reservations`, `hms_read_reservation`, `proposal_publish`, `reply_draft`. Exact [inputs/proposal](../references/tools-and-proposal.md); runtime capability may be unavailable. Never invent tool or silent success.

Example: quoted “book two rooms”; current “cancel one, voucher attached for other” → cancel target + filing target, not two creates.
