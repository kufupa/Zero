# Agent stack and staff workflow builder

Status: **Proposed** (2026-10-14). The owner approves or vetoes.

Hotel staff will teach Nava workflows in chat, e.g. "draft a follow-up 3 days after no reply". Staff must see the workflow, test it on past mail, and keep it scoped to their hotel. Nothing we need may sit behind a paywall. We researched off-the-shelf builders: Sim's natural-language copilot needs a sim.ai key or a Sim licence; Langflow is Python and has no per-user isolation in its OSS edition; Windmill embedding, Activepieces embedding/chat, and Kestra tests/tenancy are all paid; Flowise is end-of-life; Mastra's Agent Builder is Enterprise. None clears every gate (R1b, R4, R5 in `docs/research/CATALOG.md`).

We will keep **Mastra core** as the runtime. On top of it we assemble large, VC-backed MIT/Apache projects, and Nava owns only the thin layer none of them provides:

| Layer | Pick | Runner-up |
|---|---|---|
| Runtime | Mastra core (Apache, $35M) | LangGraph.js (MIT) |
| Evals / regression on past mail | Promptfoo (MIT) + Mastra datasets/experiments | Langfuse MIT core (its RBAC/audit are EE, so never our audit ledger) |
| Staff chat + canvas | CopilotKit core (MIT, $27M) + React Flow (MIT) | — |
| Durable waits (3-day timers) | Mastra suspend/resume + snapshots, after a restart/deploy test | Temporal (MIT) |
| Per-staff preferences | Plain tenant-scoped table; mem0 (Apache) only if semantic recall is needed | — |
| Nava-owned | Chat → typed workflow graph compiler, visible diff, hotel-scoped versions + approval + rollback, replay on redacted past mail, per-action re-authorization | — |

Per-hotel separation: an immutable `hotel_id` comes from authenticated server state, never from model output. It is applied in every row, trace, namespace and workflow record, enforced by Postgres row-level security under a non-owner role, and re-checked inside every tool. Cross-hotel negative tests are release gates. Hotel policy, prices and reservation truth live in versioned Nava data, never in memory stores.

Consequences: no runtime migration now. Swapping runtimes later stays cheap because AI agents do migrations in hours. The bespoke layer is the price of avoiding paywalls, and its first slices are scoped in R5 §"Build for Nava". Revisit if a fully OSS builder appears that passes all four gates (visible NL build, past-mail replay, per-hotel isolation, embeddable without a licence).
