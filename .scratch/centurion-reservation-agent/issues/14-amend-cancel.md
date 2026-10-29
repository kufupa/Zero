# Define amendment and cancellation outcomes

Type: grilling
Labels: wayfinder:grilling
Status: open
Assignee: unassigned
Blocked by: 03, 08
Mode: HITL

**Map:** [Centurion end-to-end reservation agent](../map.md)

**Dependencies:** [Trace the real Centurion payment workflow](03-payment-evidence.md), [Define one approval and partial-result recovery](08-single-approval.md)

## Question

How should the shared case, lookup and approval model cover amendments and cancellations, including date/room/party changes, paid or unknown status and any fee or channel restrictions?

Reuse the dated evidence: an adult amendment narrowly passed, a date change reopened with old dates, and HMS changed a stay to Cancelled before showing a penalty dialog. Define the necessary pre-action information and post-action readback. Cancellation remains lab-only until the owner changes the current execution authority; never assume refusing a later dialog prevented the earlier write.

**Starting evidence:** [dated booking and cancellation handoff](../../../docs/context/HANDOFF-2026-10-27-booking-completeness-planning.md) · [paid/unpaid evidence](../../../docs/research/2026-10-20-arch-lanes/l2-amend-payment.md) · [current write contract](../../../apps/server-pilot/src/ai/pane-stay-save.ts).
