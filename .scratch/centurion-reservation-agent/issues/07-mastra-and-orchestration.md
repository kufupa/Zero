# Choose Mastra and durable execution responsibilities

Type: grilling
Labels: wayfinder:grilling
Status: open
Assignee: unassigned
Blocked by: none
Mode: HITL

**Map:** [Centurion end-to-end reservation agent](../map.md)

**Related:** [Trace existing one-click execution and recovery](04-one-click-evidence.md) provides context; its remaining test does not block this decision.

## Question

How should Mastra's extraction/reasoning, existing jobs and HMS runners divide responsibility so that the staff member can approve one plan and execution survives pane closure or worker restart?

Start with the smallest proposal: retain Mastra where it already helps, reuse existing work items and job/approval machinery, and make ordered action results durable on the server. Compare that to a Mastra workflow or replacement only if an existing capability changes the trade-off. The optional pane-agent path currently runs without HMS runners, drops party details, and uses zero as each child's age; source presence and deployed flags are different facts.

The chosen design must account for stored plan identity, individual step results, property lock, readback and unknown outcomes without creating an unnecessary general-purpose framework.

**Starting evidence:** [pane brain](../../../apps/server-pilot/src/ai/pane-brain.ts) · [pane agent adapter](../../../apps/server-pilot/src/ai/agent-pane-adapter.ts) · [Mastra tool wrappers](../../../apps/server-pilot/src/ai/reservationist-agent.ts) · [queued approval](../../../apps/server-pilot/src/ai/hms-approval.ts).
