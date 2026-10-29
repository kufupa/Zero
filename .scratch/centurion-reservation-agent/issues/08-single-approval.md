# Define one approval and partial-result recovery

Type: grilling
Labels: wayfinder:grilling
Status: open
Assignee: unassigned
Blocked by: none
Mode: HITL

**Map:** [Centurion end-to-end reservation agent](../map.md)

## Question

Given the owner's chosen one-click experience, what exactly must the reviewed plan show, when should changed guest data, price or HMS state require fresh review, and what happens if an earlier step may have committed or a later Add-On fails?

Recommend one explicit approval covering every displayed action and possible HMS-native confirmation, with per-step confirmed, failed or uncertain results. Preserve successful confirmation numbers; reconcile uncertain writes before retry; do not pretend multiple writes are atomic. Discuss selective automatic writes only as a later policy. This ticket records product semantics, not permission for a live guest write.

**Starting evidence:** [existing single-use approval](../../../apps/server-pilot/src/ai/hms-approval.ts) · [current multi-room pane](../../../apps/mail/components/quote-workflow/booking-card.tsx) · [cancellation side-effect finding](../../../docs/context/HANDOFF-2026-10-27-booking-completeness-planning.md).
