# Define the full payment and voucher outcome

Type: grilling
Labels: wayfinder:grilling
Status: open
Assignee: unassigned
Blocked by: 03, 08
Mode: HITL

**Map:** [Centurion end-to-end reservation agent](../map.md)

**Dependencies:** [Trace the real Centurion payment workflow](03-payment-evidence.md), [Define one approval and partial-result recovery](08-single-approval.md)

## Question

How should the already-chosen full staff payment workflow handle a prepaid new booking, agent voucher, proof attached to an existing stay, deposit/guarantee, and any actual payment posting?

Base the answer on the traced Centurion staff workflow. Specify what is asserted as paid, what remains unverified, which native changes and possible confirmations are in the reviewed plan, and what must be read back. Do not ask the owner again whether payment work belongs in scope.

**Starting evidence:** [payment and voucher corpus](../../../docs/context/FACTS.md) · [staff observation](../../../docs/research/2026-10-20-arch-lanes/l5-reservationist-workflow.md) · [existing document attachment path](../../../apps/server-pilot/tooling/playwright-quote/attach-document.mjs).
