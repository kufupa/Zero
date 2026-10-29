# Define native Add-On and Guest Details behavior

Type: grilling
Labels: wayfinder:grilling
Status: open
Assignee: unassigned
Blocked by: 02, 08
Mode: HITL

**Map:** [Centurion end-to-end reservation agent](../map.md)

**Dependencies:** [Map Centurion native booking fields and Add-Ons](02-native-fields-evidence.md), [Define one approval and partial-result recovery](08-single-approval.md)

## Question

How should a requested hotel-specific Add-On and any Guest Details changes be selected, priced, included in the single reviewed plan, applied to the correct saved room or stay, and independently verified?

Decide behavior for unknown catalog options, dates, quantity, charges, removal and a partial failure. A quoted shuttle, meal/board and reservation note are not proof of a native Add-On. Use existing staff observations first; do not copy another hotel's provider or codes into Centurion.

**Starting evidence:** [booking parity audit](../../../docs/research/2026-10-27-next-run/booking-parity.md) · [current create contract](../../../apps/server-pilot/src/ai/pane-stay-save.ts) · [owner's Guest Details observation](../../../docs/context/OWNER-ASKS.md).
