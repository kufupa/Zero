# Product details

These task-specific sections extend `PRODUCT.md`. Read the relevant sections before assessing, planning, implementing or evaluating product behavior. Proposed bars remain proposals unless owner-confirmed. The old golden-set gate is in [archive](archive/2026-10-golden-set-done-gate.md).

## Front door specifics

A TMC cancellation notification needs no action; a person asking to cancel is a cancellation. A group shuttle request is group/event; other shuttle requests are amendments. A voucher or proof of payment for an existing stay is a filing task (find the stay, file the document); a paid voucher for a new stay is a new booking. For evaluation labels, use staff outbound action first; otherwise require two models to agree and send disagreements to the owner. The owner recorded exact-host exclusions for Profitroom, Tiket.com, RateTiger and H-Pay (`hospitality.cloud`); Travelit and TBO remain in scope. Current source has exceptions for human Profitroom enquiries and non-notice H-Pay finance mail. Reconcile that conflict with the owner before changing those paths; see the [original request](../../PRODUCT-ASKS-HISTORY.md#asks-logged).

## Pane (staff)

Keep the V1 look. One primary action per step. Hide dead controls.

- Header: active mailbox + sync status, then selected email, then **read as** (same vocabulary as Needs-you: quote / booking / amendment / cancellation / voucher-POP / other).
- **Quote contact — appears in the PDF** at top (name / email / phone). Company/agency on the quote is a separate field. Edits save to this request; they do **not** write HMS unless staff hits the explicit book action.
- Stay by date range. Room-**type** rows with counts and occupancy. Totals. No “Room 1 / Room 2”.
- Rates: HMS rates + one-off/saved + required “Authorised by” for discounts.
- After an HMS match: facts + **one** Copy confirmation + Open HMS only if the target is real. Hide Find after a result.
- Quote review: PDF, Excel, editable reply, save unsent draft. Nava never sends.
- Attachments: filing into HMS Documents is an approved write with readback; label any download-only action as **Download to this computer**.
- Needs-you: short to-do list. Dismiss has Undo and a Finished path.
- Client-requested follow-up: about 66 hours after a staff quote states a validity or hold window, draft an in-thread follow-up for staff review and add a Needs-you item; never send. The original client example was a 72-hour quote; scope for other windows is unsettled.
