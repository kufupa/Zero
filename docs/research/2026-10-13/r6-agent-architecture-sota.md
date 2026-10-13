# R6: Agent architecture, state of the art, for Nava (hotel reservationist, email)

Date: 2026-10-13. Method: Exa web search plus page excerpts. Sources ranked primary > practitioner > vendor. Vendor numbers are self-reported. Quotes and figures were checked against retrieved page text; anything not found there was dropped or marked "(rec)" (my call, no external source).

**Bottom line: workflow spine with LLM nodes. One bounded read-only agent for open lookups. No LLM-chosen writes; writes = propose, staff approve, commit once. Reliability comes from evals and staff-edit labels, not prompt wording. Multi-hotel = shared code + versioned per-property config.**

---

## 1. Architecture (Q1)

**Answer: deterministic workflow is the default. Single agent only for open-ended, read-only work. Multi-agent only for parallel reads.**

### 1.1 Options

| Option | What sources say | Nava fit |
|---|---|---|
| Single tool-using agent | "Our general recommendation is to maximize a single agent's capabilities first" ([OpenAI guide](https://cdn.openai.com/business-guides-and-resources/a-practical-guide-to-building-agents.pdf)). "We recommend finding the simplest solution possible, and only increasing complexity when needed" ([Anthropic](https://www.anthropic.com/engineering/building-effective-agents)) | (rec) Read-only triage and Q&A. Not the write path |
| Workflow + LLM nodes | "Workflows offer predictability and consistency for well-defined tasks" ([Anthropic](https://www.anthropic.com/engineering/building-effective-agents)). "Use workflows for tasks that are clearly defined upfront" ([Mastra](https://mastra.ai/en/docs/workflows/overview)) | (rec) Spine for quote, book, amend, cancel, payment proof, billing |
| Router + specialists | Routing fits "where classification can be handled accurately" ([Anthropic](https://www.anthropic.com/engineering/building-effective-agents)). Multi-agent beat single agent by 90.2% on Anthropic's research eval, using about 15x more tokens than chats; "some domains that require all agents to share the same context" are "not a good fit" ([Anthropic](https://www.anthropic.com/engineering/multi-agent-research-system)). 2025: "running multiple agents in collaboration only results in fragile systems" ([Cognition](https://cognition.com/blog/dont-build-multi-agents)). 2026: works "when writes stay single-threaded" ([Cognition](https://cognition.com/blog/multi-agents-working)) | (rec) Router yes. Specialists read-only only |

### 1.2 What named vendors and frameworks document

| Who | Documented pattern | Source |
|---|---|---|
| Sierra | Declarative goals plus "deterministic guardrails that the agent cannot cross". Every production agent is managed by several supervisory agents that keep it on policy while staying flexible. Goal is "bounded error rates", not "perfect adherence" | [ADLC](https://sierra.ai/blog/agent-development-life-cycle), [enterprise](https://sierra.ai/blog/enterprise-grade-agents) |
| Decagon | AOP = natural-language instructions "backed by code", like an SOP for AI. Pipeline: extract intent, select the AOP, fall back to retrieval-augmented generation if none matches | [platform](https://decagon.ai/modules/decagon-platform), [AOPs](https://decagon.ai/modules/aops) |
| Intercom Fin | One agent that switches roles by conversation context. Guidance shapes how answers are phrased; Procedures are a separate mechanism for how conversations are handled. Email: multiple questions in one message are processed separately | [Fin](https://www.intercom.com/help/en/articles/7120684-fin-ai-agent-explained), [Guidance vs Procedures](https://www.intercom.com/help/en/articles/14623785-when-to-use-fin-guidance-vs-procedures), [email build](https://www.intercom.com/blog/fin-over-email-how-we-built/) |
| Mastra | Workflows for tasks "clearly defined upfront". Workflow state persists across suspend/resume (used for human approval, rec) | [agents](https://mastra.ai/en/docs/agents/overview), [workflows](https://mastra.ai/en/docs/workflows/overview) |
| LangGraph | "Workflows have predetermined code paths"; "Agents are dynamic and define their own processes and tool usage". LangChain: "most agentic systems in production are a combination of workflows and agents" | [docs](https://docs.langchain.com/oss/python/langgraph/workflows-agents), [LangChain blog](https://www.langchain.com/blog/how-to-think-about-agent-frameworks) |

### 1.3 Reliability numbers

- tau-bench (retail and airline domains): gpt-4o function calling about 61% pass^1 on retail and 35% on airline; pass^8 under 25% on retail ([arXiv 2406.12045](https://arxiv.org/html/2406.12045v1)).
- Ablation: removing the policy from the prompt cut gpt-4o by -22.4% vs -1.2% for gpt-3.5-turbo, in the airline example ([arXiv PDF](https://arxiv.org/pdf/2406.12045)). (rec) Hard rules belong in code.
- Sierra reports the best models "crossing 80% pass^1" on retail, the easier domain ([Sierra](https://sierra.ai/blog/tau-bench-shaping-development-evaluation-agents)).
- Consistency math: 75% per-trial success over 3 trials = (0.75)^3 ≈ 42% all-pass ([Anthropic evals](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)). (rec) Measure Nava with pass^k (k = 3 or more), not single-run accuracy.

### 1.4 Nava call (rec)

- Each case type = graph. Steps are LLM (extract, draft) or code (dates, occupancy, cutoffs, rate math, approval rules).
- "Other" and unknown = router, then one bounded read-only agent (capped tool calls), then draft, then staff.
- Keep Mastra; its workflows persist state across suspend/resume ([docs](https://mastra.ai/en/docs/workflows/overview)). No source found that argues for switching to LangGraph.
- Internal rule: only HMS reads run automatically; writes need approve plus review ([memory: project-nava-product-stages](/home/orca/.claude/projects/-home-ubuntu-projects-zero/memory/project-nava-product-stages.md)).

---

## 2. Tool design for slow lookups (Q2)

- **Candidates, not dumps.** Return high-signal fields. Anthropic's concise vs detailed tool response example: 72 vs 206 tokens ([Anthropic tools](https://www.anthropic.com/engineering/writing-tools-for-agents)).
- **Cap and steer.** Search returns at most 50 hits; above that the agent is told to "write a more specific query" ([SWE-agent](https://arxiv.org/html/2405.15793v3)). Error responses should be "specific and actionable", not "opaque error codes or tracebacks" ([Anthropic tools](https://www.anthropic.com/engineering/writing-tools-for-agents)).
- **No next-result browsing.** SWE-agent ablation: iterative next/prev browsing scored 12.0 vs 15.7 with no search; summarized search scored 18.0. Agents "look through every match exhaustively" ([SWE-agent](https://arxiv.org/html/2405.15793v3)).
- **Split read and write tools.** (rec) Writes = `propose_*`, then staff approve, then `commit(proposal_id)`. (rec) Rate each tool by risk.
- **Cache by exact key, not semantic similarity.** Eugene Yan: cache "other than via semantic similarity (e.g., item IDs)" ([Eugene Yan](https://eugeneyan.com/writing/llm-problems/)). (rec) Key: property, arrival, nights, room type, occupancy, rate plan, as-of bucket. Purge on any write.
- **Drop re-fetchable results from context.** Clearing is "one of the safest, lightest-touch ways to recover that space" ([Anthropic cookbook](https://platform.claude.com/cookbook/tool-use-context-engineering-context-engineering-tools)).
- **Prefetch.** Anthropic's hybrid: "retrieving some data up front for speed" ([Anthropic context](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)). (rec) Prefetch rates for dates and room types named in the email.
- **Loop caps.** Simple fact-finding = 1 agent with 3-10 tool calls; comparisons = 10-15 calls per subagent ([Anthropic multi-agent](https://www.anthropic.com/engineering/multi-agent-research-system)). Exit conditions include "reaching a maximum number of turns" ([OpenAI guide](https://cdn.openai.com/business-guides-and-resources/a-practical-guide-to-building-agents.pdf)).
- **Idempotency.**
  - Classify each tool: read-only, naturally idempotent, idempotency-key protected, compensatable, or non-repeatable ([Edilec](https://edilec.com/blog/ai-11008/idempotent-agent-tool-calls/)).
  - (rec) Generate the key before dispatch and persist it with the workflow. Never let the model choose it.
  - "A timeout does not prove an agent's write failed" ([Zenovae](https://zenovae.ai/blog/ai-agent-tool-retries-prevent-duplicate-writes/)). "An absent receipt is not proof of no effect" ([Koç](https://omerfkoc.dev/writing/the-write-may-have-succeeded)).
- **HMS specifics.** No Infor API ([memory: project-nava-adoption-gap](/home/orca/.claude/projects/-home-ubuntu-projects-zero/memory/project-nava-adoption-gap.md)). (rec) Assume no native idempotency key. Treat every HMS write as non-repeatable. Read back by confirmation number before any retry.
- **Single browser lock.** No external source found. (rec) Per-property single-writer queue. Reads share the cache. After a timeout, return `pending` plus job ID instead of blocking the thread.

---

## 3. Classification stability (Q3)

### 3.1 Why labels flip

| Cause | Evidence | Fix |
|---|---|---|
| Prompt formatting | Formatting-only changes swing accuracy up to 76 points (LLaMA-2-13B); about 10 points on average across 50+ tasks. Variance is not removed by more model size, few-shot examples, or instruction tuning ([Sclar et al.](https://arxiv.org/abs/2310.11324)) | (rec) Freeze templates as versioned files. Report accuracy across format variants before release |
| Nondeterminism at temperature 0 | 1,000 completions at temp 0 gave 80 unique outputs; first divergence at token 103. With batch-invariant kernels, all 1,000 were identical ([Thinking Machines](https://thinkingmachines.ai/blog/defeating-nondeterminism-in-llm-inference/)) | Do not assume determinism. (rec) Pin the snapshot. Run each eval case 3+ times and track agreement |
| Criteria drift | Grading outputs changes the criteria. "It is impossible to completely determine evaluation criteria prior to human judging" ([Shankar et al.](https://arxiv.org/abs/2404.12272)) | (rec) Re-label a sample after each model or prompt change |
| Model or API swap | "LLM APIs can be replaced with new models, resulting in prompt drift" ([Shankar et al.](https://arxiv.org/abs/2404.12272)) | (rec) Run evals on every agent change and model upgrade |

### 3.2 Fixes

- **Taxonomy by action.** (rec) Labels = what you would do, e.g. `quote_single_stay`, `book_new`, `amend`, `cancel`, `payment_proof`, `billing`, `ota_info_only`, `other_needs_human`. Merge labels that map to the same action. Decagon likewise selects the workflow from the extracted intent ([Decagon](https://decagon.ai/modules/decagon-platform)).
- **Enum-constrained output.** Strict JSON schema prevents "hallucinating an invalid enum value" ([OpenAI docs](https://developers.openai.com/api/docs/guides/structured-outputs)), but "doesn't prevent all kinds of model mistakes" ([OpenAI launch](https://openai.com/index/introducing-structured-outputs-in-the-api/)). (rec) Keep an `unknown` value.
- **Few-shot from labelled set.** No source found this pass (gap). (rec) Use staff-verified cases only.
- **LLM judges.** A single call with one rubric and a 0.0-1.0 plus pass/fail score was "the most consistent and aligned with human judgements" ([Anthropic multi-agent](https://www.anthropic.com/engineering/multi-agent-research-system)). Give the judge an "Unknown" exit and grade each dimension with an isolated LLM-as-judge ([Anthropic evals](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)). Calibrate judges closely with human experts (same source).
- **Adjudication.** Hand-validate every label used to test a judge ([Husain FAQ](https://hamel.dev/blog/posts/evals-faq/index.html)). Husain recommends one domain expert as the quality decision maker (same source). (rec) When staff disagree, write the criterion down.
- **Versioning.** Sierra's immutable agent release = source code, prompts, model version dependencies, and a snapshot of all knowledge. Customers can "roll back agent behavior instantly" ([ADLC](https://sierra.ai/blog/agent-development-life-cycle)).

---

## 4. HITL to evals to autonomy (Q4)

### 4.1 Capture staff actions as labels

| Staff signal | Becomes | Used for |
|---|---|---|
| Edit to a draft | Before/after pair plus reason code | Draft-quality eval; prompt fixes |
| Approve, reject, or edit a proposal | Action-level agreement row | Autonomy gate per action type |
| Route or label correction | Corrected class | Classifier eval set |
| Thread outcome (booked, lost, escalated) | Trace-level label | Error taxonomy; pass^k cases |

- Sierra: annotated conversations "become the basis for the agent's regression tests" ([ADLC](https://sierra.ai/blog/agent-development-life-cycle)).
- Fin: "Ratings and comments are captured in a report" ([Fin](https://www.intercom.com/help/en/articles/7120684-fin-ai-agent-explained)).
- Eugene Yan: collecting user feedback builds "our data flywheel" ([patterns](https://eugeneyan.com/writing/llm-patterns/)).

### 4.2 Error analysis

- Husain: open-code 30-50 traces yourself, axial-code them into a taxonomy, and review at least 100 traces. Stop when about 20 traces bring no new category ([FAQ](https://hamel.dev/blog/posts/evals-faq/index.html)). (rec) Re-run after prompt or model changes.
- Field guide: "Custom data viewers that make it easy to examine AI outputs yield more insights than complex dashboards with generic metrics" ([field guide](https://hamel.dev/blog/posts/field-guide/index.html)).
- Anthropic: "You won't know if your graders are working well unless you read the transcripts" ([evals](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)).

### 4.3 Promotion to autonomy

- **Per action type, not per agent.** "Autonomy should arrive one action type at a time" ([CodeDTX](https://codedtx.com/insights/roll-out-an-ai-agent-in-stages)). (rec) Track acceptance and edit rates by action.
- **Stage ladder.** Offline replay, shadow, suggestions, approval-gated actions, bounded autonomy ([makeyouragent](https://makeyouragent.ai/blog/agent-rollout-strategy-shadow-mode-bounded-autonomy)). "One severe policy violation should block promotion even when the average score looks good" (same source).
- **Example gates (vendor config).** 25 minimum observations, 0.90 agreement threshold, 168-hour critical-miss window ([AgentVault](https://docs.agentvault.chat/guides/shadow-mode)). Graduation is explicit and can be reversed; the owner can demote "at any time" (same source). (rec) Set Nava's own numbers.
- **Triage each disagreement.** Agent wrong, person wrong, specification silent, data problem, or human-only ([FISTA](https://www.fistasolutions.com/blog/how-to-run-shadow-mode-deployments)). "Person wrong" reveals control gaps (same source).
- **Limits in runtime.** "Keep hard limits outside the model" ([makeyouragent](https://makeyouragent.ai/blog/agent-rollout-strategy-shadow-mode-bounded-autonomy)). (rec) Enforce in code, not prompt.
- **Model confidence is a weak gate.** Claude pauses for clarification more often on complex tasks, but Anthropic warns against overstating this as calibration ([Anthropic autonomy](https://www.anthropic.com/research/measuring-agent-autonomy)). (rec) Gate on deterministic checks plus agreement; use confidence only to route.
- **Trust grows with exposure.** Auto-approve: roughly 20% of sessions for new Claude Code users, over 40% as they gain experience. Interrupts: new users interrupt in 5% of turns, experienced users around 9% ([Anthropic autonomy](https://www.anthropic.com/research/measuring-agent-autonomy)). (rec) Instrument the pane now; approve-by-exception only after weeks of use.

---

## 5. Hotel specifics (Q5)

### 5.1 Vendors and what they document

| Product | Documented capability | Quote or option output | Source |
|---|---|---|---|
| Cvent (CventIQ) | RFP Insights rank leads by estimated revenue and profit, date and pattern fit, and lead quality. Response Assistant auto-generates answers to RFP custom questions from the last 13 months of responses, venue profile data, and RFP details. Passkey automates room-block pickup and PMS data entry. Auto-assigning meeting rooms in proposals is "coming soon" | Proposal draft; no guest-room picker documented | [RFP](https://www.cvent.com/en/supplier-venue/hotel-rfp-management), [release](https://release.cvent.com/supplierandvenuesolutions/announcements/cvent-s-new-response-assistant), [platform](https://www.cvent.com/en/platform/hospitality-professionals) |
| Thynk | AI reads inquiry details, pricing history and availability, then suggests room blocks, rates and terms. PMS integrations: Opera, Mews, Stayntouch, Protel | "Custom-branded proposals for various room combinations" | [features](https://knowledge.thynk.cloud/thynk-features/), [product](https://thynk.cloud/product/group-bookings) |
| Canary | Agentic Sales Coordinator (launched 2026-06-15): "from first inquiry to confirmed booking" | Not detailed | [PR](https://www.knowledgenile.com/news-post/canary-technologies-launches-agentic-sales-coordinator-for-hotel-group-and-event-sales/), [Agent Studio](https://canarytechnologies.com/products/hospitality-ai-agent-studio) |
| Mews Lobby | Closest to Nava's email flow. Reads inquiries, checks real-time availability and rates in Mews, sends branded responses, pushes reservations "when allowed", and asks staff for approval when needed. Pings Mews inventory and pricing "the instant an email arrives". Mews-only | Quote from live Mews rates | [Lobby](https://www.mews.com/en/products/marketplace/lobby) |
| HiJiffy | Chat on Mews availability; room carousel with images and pricing; pre-filled Mews booking page. Vendor claims it "automatically resolves over 85% of queries" | Redirect to booking page | [Mews integration](https://www.hijiffy.com/integrations/mews), [Mews marketplace](https://www.mews.com/en/products/marketplace/hijiffy) |
| Asksuite | Quotes via booking engines: the AI page says both 400+ and 500+; the integrations page says more than 400. Transfers conversations to a human "when needed". Vendor claims $586M direct revenue | Quote via engine | [AI page](https://asksuite.com/ai-chatbot-for-hotels/), [integrations](https://asksuite.com/integrations/) |
| Vella (LinkedIn) | "Automated proposals, dynamic pricing", 10-minute turnaround. Vendor claim, unverified | Not detailed | [post](https://www.linkedin.com/posts/vellaai_hitec2025-e20x-hospitalitytech-activity-7328879352832503809-0qTz) |
| Groups360, Apaleo | Not found in this pass | n/a | n/a |

### 5.2 "30 guests, which rooms?"

- No source found an optimizer that assigns guest rooms to a headcount. Vendors stop at blocks, rates, and proposals (table above).
- (rec) Treat it as an inventory check, block builder, and rate card. Not an LLM decision.

### 5.3 Revenue-aware rate and room logic

- **Displacement math** ([Cloudbeds](https://www.cloudbeds.com/hotel-group-business/displacement-analysis/)): displaced rooms = expected transient rooms + group rooms - total rooms. Displaced contribution = displaced transient revenue - variable cost x displaced room-nights. Minimum group rate = displaced contribution / group room-nights + variable cost.
- **Worked example** (same source): 75 displaced room-nights bring $6,750 revenue; less $17 x 75 variable cost = $5,475 contribution. Spread over the group's 150 room-nights (50 rooms x 3 nights), plus $17 variable cost = $53.50 minimum vs $60 offered: accept.
- **Two forecasts and ancillaries.** (rec) Compare the forecast with and without the group. Duetto's expert: "If you have $10,000 from room revenue, 70% goes to profit. However, F&B on the other hand is 30% profit" ([Duetto](https://www.duettocloud.com/en-us/library/how-to-complete-a-hotel-revenue-displacement-analysis)).
- **Group ceiling.** Group ceiling = capacity - protected transient rooms, where protected transient rooms = expected unconstrained transient demand; this varies by season ([Peaqplus](https://peaqplus.com/academy/en/advanced/group-ceiling-allotment-strategy.html)). Example from the same source: a 14-day release against an 18-day median transient booking window lets rooms come back after the booking peak.
- **Nava (rec).** LLM never sets rate or room count. Code reads HMS rates per room type and occupancy, runs displacement against on-the-books, and the LLM drafts the email. Totals only once counts are committed.

---

## 6. Multi-tenant (Q6)

| Per tenant (versioned data) | Shared (code) |
|---|---|
| Property ID, PMS adapter credentials, room-type map and aliases, rate-plan codes, cutoffs and release rules, displacement and ceiling inputs, approval thresholds, autonomy level per action type, brand voice, language, escalation contacts, knowledge snapshot, eval set | Workflow graphs, action taxonomy, tool implementations per PMS adapter, policy rule types, eval harness, cache and idempotency layer, staff UI |

- AWS: "tenant context directly affects how you build agents." The control plane covers tenant identity, tiering, provisioning per-tenant resources, and configuring tenant policies ([AWS guidance](https://docs.aws.amazon.com/pdfs/prescriptive-guidance/latest/agentic-ai-multitenant/agentic-ai-multitenant.pdf)). Silo model: "each tenant is provided with a fully isolated experience and a dedicated set of agents" (same source).
- Google Cloud: per-tenant MCP servers in each tenant project for tenant-specific datastores; shared MCP servers for common tools; "tenant-level rate limiting" ([Google](https://docs.cloud.google.com/architecture/multi-tenant-agentic-ai-system)).
- AWS SaaS Builders Day deck: "Capture metrics with tenant context and aggregate by tenant"; "Enable throttling based on LLM tenant token usage" ([AWS Builders Day](https://pages.awscloud.com/rs/112-TZM-766/images/2025-03-18_SaaS_Builders_Day_GenerativeAI_meets_Multitenancy.pdf)).
- Mastra: "Swap instructions or models based on request context" ([Mastra](https://mastra.ai/en/docs/agents/overview)).
- Cvent: "shared rules to route leads to the right hotel" across portfolios ([Cvent](https://www.cvent.com/en/supplier-venue/hotel-rfp-management)).
- (rec) Second hotel = config plus eval set. No hotel-specific code branches. Matches the internal rule against entity-specific rules ([memory: feedback-generalize-no-overfit](/home/orca/.claude/projects/-home-ubuntu-projects-zero/memory/feedback-generalize-no-overfit.md)).

---

## 7. Recommended architecture for Nava (250 words or fewer)

All items are (rec) unless a source is cited for the principle.

1. **Spine per case type.** Mastra workflows; suspend for staff approval ([Mastra](https://mastra.ai/en/docs/workflows/overview)). One agent only for open threads ([OpenAI](https://cdn.openai.com/business-guides-and-resources/a-practical-guide-to-building-agents.pdf)).
2. **Action enum.** Strict schema, pinned snapshot, `unknown` and `other_needs_human` values. OTA-origin = info-only ([memory](/home/orca/.claude/projects/-home-ubuntu-projects-zero/memory/project-ota-out-of-scope.md)).
3. **Rules in code.** Dates, occupancy, cutoffs, rate math, displacement, approvals. Prompt does extraction and tone ([tau-bench](https://arxiv.org/pdf/2406.12045), [ADLC](https://sierra.ai/blog/agent-development-life-cycle)).
4. **Lookups.** One read-only agent per thread, 10 calls max. Candidates with IDs, paginated. Exact-key cache. Prefetch named dates. HMS reads via per-property queue returning `pending` plus job ID ([Anthropic tools](https://www.anthropic.com/engineering/writing-tools-for-agents), [SWE-agent](https://arxiv.org/html/2405.15793v3)).
5. **Writes.** Never LLM-chosen. Propose, staff approve, commit once with a persisted key. Timeout = unknown: reconcile by confirmation number, never blind retry ([Zenovae](https://zenovae.ai/blog/ai-agent-tool-retries-prevent-duplicate-writes/), [Edilec](https://edilec.com/blog/ai-11008/idempotent-agent-tool-calls/)).
6. **Groups.** Displacement and ceiling decide accept and rate; LLM drafts ([Cloudbeds](https://www.cloudbeds.com/hotel-group-business/displacement-analysis/), [Peaqplus](https://peaqplus.com/academy/en/advanced/group-ceiling-allotment-strategy.html)).
7. **HITL = data.** Every edit, approve, reject stored as a labelled row. Code 100+ traces; hand-validate judge labels ([Husain](https://hamel.dev/blog/posts/evals-faq/index.html)).
8. **Autonomy per action type.** Shadow, suggest, approve-gated, bounded auto. Agreement gates; demote at any time ([makeyouragent](https://makeyouragent.ai/blog/agent-rollout-strategy-shadow-mode-bounded-autonomy), [AgentVault](https://docs.agentvault.chat/guides/shadow-mode)).
9. **Multi-hotel.** Shared code and evals; per-property versioned config. New hotel = config plus eval set ([AWS](https://docs.aws.amazon.com/pdfs/prescriptive-guidance/latest/agentic-ai-multitenant/agentic-ai-multitenant.pdf)).
10. **One flow first.** Single-stay quote proven on prod, then widen ([memory](/home/orca/.claude/projects/-home-ubuntu-projects-zero/memory/feedback-ship-one-flow-first.md)).

---

## 8. Gaps and caveats

- Few-shot selection from labelled sets: no source fetched this pass.
- HMS single-browser lock: no external source. Queue design is (rec).
- Groups360 and Apaleo: not found. Thynk pricing: not verified.
- Vendor stats (85% automation, $586M revenue, Vella's 10-minute turnaround, Asksuite's 400+ vs 500+) are self-reported. Not used for decisions.
- HiJiffy's "about 80%" figure: not found in retrieved text; only the "over 85%" claim is documented.
- Confidence calibration: no solid source. Use deterministic gates plus agreement.
- $ impact not computed. Anthropic's 15x is a token multiple only. Pricing not pulled.
- Whether HMS offers any idempotency or confirmation lookup: unknown. Needs a check on the live UI.
- Internal constraints used (memory files): project-nava-product-stages, project-nava-adoption-gap, project-ota-out-of-scope, feedback-generalize-no-overfit, feedback-ship-one-flow-first.
