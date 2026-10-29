# Map Centurion native booking fields and Add-Ons

Type: task
Labels: wayfinder:task
Status: open
Assignee: unassigned
Blocked by: none
Mode: AFK

**Map:** [Centurion end-to-end reservation agent](../map.md)

## Question

After reusing existing screenshots, staff evidence, field maps and current source, which Centurion fields, native IDs, lookup options and exact readback steps are still missing for a complete booking?

Pay particular attention to the native Add-On catalog and rows; Guest Details arrival/departure information; room and child bands; agency versus company; CMS message ID and recipient; guarantee; and any staff-entered rate override. Distinguish a genuine Add-On from a note or quoted extra. Current PaneStay input contains CMS and child ages but no native Add-On; the Add Record path refuses one older-child band.

Gather only missing observations under current HMS rules. Report each source as existing code, dated observation or new independent proof. Do not generate a giant field census merely to recreate known work.

**Starting evidence:** [current create input](../../../apps/server-pilot/src/ai/pane-stay-save.ts) · [linked-room reader](../../../apps/server-pilot/tooling/playwright-quote/add-room-stay.mjs) · [booking field audit](../../../docs/research/2026-10-27-next-run/booking-parity.md) · [CMS message evidence](../../../docs/research/2026-10-28-hrdav-cms-message-id-codes.md).
