# Is mem0 / Letta / Graphiti / Hermes a cheat code for Nava? (Exa agent, 2026-10-20)

Exa agent run `agent_run_77b382aaa3564f0c993bd3b12c974a7b`, effort auto, $0.52, 35 searches, ~11:20Z. Owner ask 160 follow-up. Opus reviewed the claims against our own evidence (§4).

## Verdict

**No.** A memory layer is not the decisive advantage. Nava's hard problems are (1) which HMS profile and rate a sender is entitled to, (2) which booking an email belongs to, (3) safe PMS writes, (4) asking instead of guessing. These are exact-key lookups, entity resolution and a state machine, which Postgres plus deterministic code handles better than extracted "memories".

## Findings (sources in the run; key ones linked)

| Tool | What it actually is | Fit for Nava |
|---|---|---|
| mem0 OSS v3 | One LLM pass extracts *facts* from messages, add-only; conflicting facts coexist until deleted. Vector search with BM25/entity boosts. Graph memory is hosted-only now. TS SDK exists (`mem0ai/oss`). Apache-2.0. [how it works](https://docs.mem0.ai/core-concepts/how-it-works), [v3](https://docs.mem0.ai/migration/oss-v2-to-v3) | Soft preferences only. Bad authority for contract rate or booking state |
| mem0 benchmarks | LoCoMo/LongMemEval gains are vendor-reported; maintainer says paper scores came from SaaS, not OSS ([#2800](https://github.com/mem0ai/mem0/issues/2800)); open audit flags 99/1,540 answers ([audit](https://github.com/dial481/locomo-audit/blob/main/AUDIT_REPORT.md)) | Don't trust as evidence for us |
| Letta (MemGPT) | Git-backed markdown memory files the agent edits ([MemFS](https://docs.letta.com/concepts/memfs/index.md)) | Agent notes/procedures, not a booking ledger |
| Zep Graphiti | Temporal knowledge graph, needs graph DB + extraction ([repo](https://github.com/getzep/graphiti)) | Maybe for relationships later; adds ops; IDs still deterministic |
| Hermes Agent (Nous) | `MEMORY.md` ≤2,200 chars + `USER.md` ≤1,375 chars + `SKILL.md` procedures ([memory](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/memory.md)) | Skills/memory split is a good pattern; not a hotel database |
| Mastra (what we have) | Already ships working memory, semantic recall (vector + filters), observational memory, suspend/resume HITL, experiments/evals ([semantic recall](https://mastra.ai/docs/memory/semantic-recall), [HITL](https://mastra.ai/docs/workflows/human-in-the-loop)) | Overlaps mem0; use before adding a second memory service |
| Sierra / Decagon / Fin / Agentforce / HiJiffy / AskSuite / Canary / Mews | Public docs: constrained agents with tools **inside procedures/flows** (Decagon AOPs, Fin workflow step, Agentforce Topics + Flow actions), customer-system context, escalation to humans. Memory algorithms not disclosed. Mews Jun-2026 post is a vision, partly beta ([Mews](https://www.mews.com/en/blog/beyond-the-chatbot-the-agentic-future-of-hospitality)) | Matches "workflow spine + LLM nodes + bounded agent" |

## What to build instead (Exa list, Opus-ordered)

1. Hotel-scoped tables: sender → HMS profile (effective-dated, source = staff picks + letters), contracts/rate entitlements, request → booking lineage.
2. Explicit procedure (SOP) graph: request intent × booking state → steps; missing field → clarify, never default.
3. Searchable email corpus (Postgres full-text + trigram, then pgvector) to show "how staff answered similar asks" as evidence, with source links.
4. PMS write queue with pre-write recheck, idempotency/read-back, approval bound to exact write.
5. Replay + shadow eval scoring wrong profile/rate, invented fields, link precision, abstention.

## 4. Opus check against our evidence

- Agrees with our 2026-10-19 party result: deterministic sender history 82/107 right, 0 wrong vs LLM loop v3 14/22 ([decision](2026-10-19-party-strategy-decision.md)).
- Agrees with [r6](/home/orca/nava-research/reports/r6-agent-architecture-sota.md) (2026-10-13). New since then: Hermes/Letta skill-file pattern, mem0 v3 add-only change, Mews 2026 vision.
- Weak spots: vendor architecture is inferred from marketing; no independent hotel-email benchmark exists. Gap worth a second, longer Exa run only if we consider an LLM-first "one agent with all tools" design seriously — **not recommended now**.
