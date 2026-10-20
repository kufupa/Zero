# Nava: updated decision as of 20 October 2026

## Bottom line

**The product owner is right about the category, but not yet proven right about the implementation choice.** Source-linked precedent retrieval is a legitimate memory-framework use case. It was too categorical to imply otherwise. Current Hindsight, Graphiti, Cognee and Mastra provide relevant retrieval or provenance primitives—not merely a small persistent scratchpad. Hindsight’s current release supports a particularly credible experiment without introducing a separate graph database. [Hindsight v1.0.0, 13 Oct 2026](https://github.com/vectorize-io/hindsight/releases/tag/v1.0.0) · [versioned architecture](https://github.com/vectorize-io/hindsight/blob/v1.0.0/README.md) · [Graphiti v0.31.1, 15 Oct 2026](https://github.com/getzep/graphiti/releases/tag/v0.31.1) · [Mastra October 2026 releases](https://github.com/mastra-ai/mastra/releases).

**My recommendation:** keep Mastra and Postgres; build an application-owned, source-faithful case/fact/booking model; test **Hindsight 1.0.0 as the first optional retrieval engine** behind that model. Do not replace Mastra with another agent runtime. Do not make any memory framework authoritative for PMS identity, current rates, booking state, or hotel isolation.

That is a **deployment recommendation, not a demonstrated retrieval winner**. I found **no qualifying April–October 2026 controlled comparison showing Graphiti/GraphRAG-style memory beating a properly configured BM25+vector hybrid on email or support-ticket corpora**. Conversely, absence of that comparison is not evidence that graphs cannot help. The closest real-ticket study uses hybrid retrieval and reports qualitative gains, not the required graph-versus-hybrid experiment. [FRAGATA, 15 Apr 2026](https://arxiv.org/abs/2604.13721).

**The mem0 benchmark objection must be updated.** Public OSS result artifacts now exist: a dated April commit added an OSS LongMemEval evaluation reporting **91.0% with GPT-5 extraction**, alongside other extraction-model configurations. This does not establish September’s SDK performance on Nava, but it invalidates using a 2025 issue as evidence that current OSS evaluation is unavailable. [Benchmark artifacts, 9 Apr 2026](https://github.com/mem0ai/memory-benchmarks/commit/edcd6f1d42400837b1fcb6997716f1769dc51a37).

### Reading the evidence

- **Current** below means a dated release, commit, issue, publication, or version-specific package/source within **1 April–20 October 2026**. An undated documentation page is not treated as newly validated merely because it was retrieved now.
- Versions are the **newest verifiable releases found before the cutoff**. Where an exact package publication date or current capability was not established, I say so.
- Tables contain the requested values; dated source notes immediately following them provide the citations.
- Engineering days, call-count budgets, targets and recommendations are **my estimates/proposals**, not vendor measurements. “Not found” does not mean a feature cannot exist.

# 1. Separate verdicts for U1–U5

The distinction between the recommended Postgres implementation and the “plain baseline” matters: **an application-owned case/fact model is more than a bag of embedded emails**.

## U1 — Precedent retrieval

| Position | Option | Pros | Cons | Confidence |
|---|---|---|---|---|
| Best for Nava now | Postgres case bundles with FTS, pgvector and reranking | Exact ask–answer–letter association; explicit filters and recency; source text stays authoritative; no new database service | You must build case assembly, ranking, evaluation and source-span display | High on controllability; medium on ranking quality |
| Runner-up / first framework experiment | Hindsight 1.0.0 behind the same case-bundle interface | Fact/entity/time retrieval and source chunks; Postgres deployment path; TypeScript client | Extraction and consolidation add cost; retrieved facts are not automatically complete booking precedents | Medium |
| Plain baseline | Independent email/PDF chunks in FTS + pgvector | Fastest baseline; no additional extraction call required | Can retrieve the right question but wrong reply; thread similarity is not booking identity | High as a baseline; unproven as sufficient |

**Verdict:** U1 is genuinely a memory-framework use case. But the retrieval unit must be a **past request and its actual handling**, not a free-floating extracted fact. Preserve the original staff response and its PDF separately; then attach both to the same case. Hindsight’s source-chunk support is relevant, while Zendesk’s current similar-ticket feature independently validates hybrid, staff-facing precedent retrieval as a product pattern. Neither establishes that Nava’s case assembly is solved automatically. [Hindsight source-chunk change, 31 Jul 2026](https://github.com/vectorize-io/hindsight/commit/cd406493937fae3e4135ff3a0d497fd07b84984a) · [Hindsight 1.0.0, 13 Oct](https://github.com/vectorize-io/hindsight/releases/tag/v1.0.0) · [Zendesk, 19 Aug 2026](https://support.zendesk.com/hc/en-us/articles/11140948616346-Announcing-improvements-to-the-Copilot-similar-tickets-feature).

## U2 — Sender/account knowledge

| Position | Option | Pros | Cons | Confidence |
|---|---|---|---|---|
| Best for Nava now | Versioned Postgres account facts, populated by existing extraction and staff correction | Explicit authority, validity dates, correction history and source; current-email conflicts can be shown rather than hidden | Entity resolution and contradiction policy are application work | High |
| Runner-up | Hindsight as a non-authoritative fact-discovery layer | Consolidated observations, entities and supporting evidence can reduce manual history review | Consolidation is probabilistic; application still decides currentness and authority | Medium |
| Plain baseline | Retrieve matching sender/account messages using FTS + pgvector | Transparent supporting evidence with little ingest complexity | Does not maintain a stable account profile or distinguish superseded from merely old facts | High on limitation; medium on practical sufficiency |

**Verdict:** let memory propose “usually government rate” or “previously used profile Y”; do not let it silently fill an authoritative current rate/profile. An explicit current-email statement remains the current **request/assertion**. If it conflicts with approved account information, surface the conflict for staff—not an automatic overwrite in either direction.

Hindsight has current evidence-grounded observations, but that is not a guarantee of business-validity semantics. Graphiti is the stronger alternative if explicit temporal relationships become the main bottleneck: its tagged source separates fact validity from system invalidation and retains episode references. [Hindsight 1.0.0 source, 13 Oct 2026](https://github.com/vectorize-io/hindsight/blob/v1.0.0/README.md) · [Graphiti 0.31.1 edge model, 15 Oct 2026](https://github.com/getzep/graphiti/blob/v0.31.1/graphiti_core/edges.py).

## U3 — Request/booking linkage over time

| Position | Option | Pros | Cons | Confidence |
|---|---|---|---|---|
| Best for Nava now | Postgres booking/event ledger with deterministic links and human-reviewed candidate matches | Auditable request → approved write → booking → letter lineage; separate requests can share a sender or thread | Must implement matching, pending-letter reconciliation and ambiguity handling | High |
| Runner-up | Graphiti 0.31.1 for candidate entity/temporal links | Explicit entities, relationships, episode provenance and temporal fields | Additional graph infrastructure; inferred links are not safe canonical booking merges | Medium |
| Plain baseline | FTS + pgvector candidate search | Finds differently worded references and likely amendments | Similarity scores cannot establish that two records are the same booking | High on limitation |

**Verdict:** memory can assist entity resolution; saying it is irrelevant to linkage would be wrong. But keep the **accepted link** in a transactional ledger with its evidence and reviewer. Graphiti’s actual current data model supports the assistance claim; it does not prove domain-specific merge accuracy. [Graphiti tagged README and backend requirements, 15 Oct 2026](https://github.com/getzep/graphiti/blob/v0.31.1/README.md) · [episode and temporal fields](https://github.com/getzep/graphiti/blob/v0.31.1/graphiti_core/edges.py).

## U4 — Hotel procedures/SOPs

| Position | Option | Pros | Cons | Confidence |
|---|---|---|---|---|
| Best for Nava now | Owner-approved, effective-dated SOP versions in Postgres with a small editing UI | Staff-editable; approval and rollback are explicit; no second runtime | You build the editor and publication workflow | High |
| Runner-up | Letta MemFS behind an approved Git editing workflow | Files and Git history suit procedural memory and reviewable changes | Git is not automatically a staff-friendly editor; agent edits must not publish hotel policy | Medium |
| Plain baseline | Versioned SOP chunks in FTS + pgvector | Good discovery of relevant procedure text | Search alone supplies neither editorial approval nor effective-version selection | High |

**Verdict:** procedural memory is real, but hotel policy must be **published**, not autonomously inferred from what someone did once. Letta’s August Agent SDK and October package are relevant procedural-memory options; the precise MemFS deployment details come from current SDK documentation, not the older MemGPT description. [Agent SDK launch, 17 Aug 2026](https://www.letta.com/blog/introducing-the-letta-agent-sdk/) · [Agent SDK 0.8.47, updated 18 Oct 2026](https://www.npmjs.com/package/@letta-ai/letta-agent-sdk).

## U5 — Working memory inside one task

| Position | Option | Pros | Cons | Confidence |
|---|---|---|---|---|
| Best | Existing Mastra thread-scoped working state and durable workflow state | Native to the current TypeScript stack; avoids a second agent runtime | IDs, concurrency and resume behavior still require testing | High |
| Runner-up | LangGraph checkpointer and explicit state | Mature state/checkpoint abstraction with current TS releases | Orchestration migration without a demonstrated Nava benefit | Medium-high |
| Plain baseline | Task-state JSON and append-only events in Postgres | Explicit and inspectable; no model calls for persistence | You implement resumability, concurrency and checkpoint semantics | High |

**Verdict:** do not deploy a long-term memory service merely to retain scratch state across tool calls. Also, do not enable observational memory indiscriminately: a current Mastra report reproduces substantial sequential database overhead even with **zero Observer/Reflector calls**. Its artificial 220-ms database RTT is not Nava’s latency, but the mechanism merits testing. [Mastra releases, 13–16 Oct 2026](https://github.com/mastra-ai/mastra/releases) · [open latency report, 16–17 Oct 2026](https://github.com/mastra-ai/mastra/issues/27319) · [LangGraph JS releases, 16 Oct 2026](https://github.com/langchain-ai/langgraphjs/releases).

# 2. Candidate comparison

For readability, the candidate table is split into release/deployment, memory semantics, and operational panels. **All three panels refer to the same candidates.**

## A. Current release, TypeScript, infrastructure and licence

| Candidate | Newest verified release and date | TypeScript | Self-host infrastructure | Licence |
|---|---|---|---|---|
| Letta | Server 0.16.8, 2026-05-14; Agent SDK 0.8.47, updated 2026-10-18; REST client 1.12.1, 2026-06-02 | Official SDK/client; not a TS-only server | Self-hosted runtime plus persistent state and Git/filesystem memory; not Postgres-only | Apache-2.0 |
| Graphiti | 0.31.1, 2026-10-15 | Python core; official TS core parity not found | Neo4j or FalkorDB; Neptune path also documented; maintained Postgres-only backend not found | Apache-2.0 |
| mem0 OSS | Python 2.2.1 and Node 3.3.1, 2026-09-25 | Native OSS Memory API, distinct from hosted client | Configurable vector/history storage; pgvector path available; graph DB not required by OSS v3 | Apache-2.0 |
| Cognee | 1.6.5, 2026-10-16 | Official TS SDK over Python service | Embedded SQLite/LanceDB/graph defaults; Postgres + pgvector possible; free Postgres graph adapter described as demo rather than production-ready | Apache-2.0 |
| Hermes Agent | 0.22.2, 2026-10-15 | API/process integration; Python runtime | Persistent filesystem and SQLite; optional external memory service | MIT |
| Memobase | Container 0.0.42 found; exact publication date and current stable release not found | Node SDK advertised; current TS package/version not verified | Historical documentation describes FastAPI + Postgres + Redis; current release validation insufficient | Current dated verification not found |
| LangMem / LangGraph Store | LangGraph JS 1.5.1 and Python 1.2.16, 2026-10-16; Postgres checkpointer 3.2.0, 2026-10-14; LangMem 0.0.30 is older | LangGraph yes; LangMem Python, TS parity not found | Postgres Store/checkpointer; no graph DB required | MIT |
| Mastra memory | Core 1.78.0, 2026-10-16; memory 1.38.0 and pg 1.31.2 corroborated on 2026-10-16; exact package publication dates not found | Native TS | Existing Postgres; pgvector for semantic retrieval | Apache-2.0 for memory package |
| Hindsight | 1.0.0, 2026-10-13 | Official TS client; Python engine | Postgres + pgvector; native text-search configuration; local embedding/reranker models; no separate graph DB required | MIT |
| Engram | Successful core 3.4.0, 2026-10-12; 3.5.0 publication failed on 2026-10-20 | HTTP/MCP integration; Go core | SQLite + FTS5 and local files | MIT |
| memU | 2.0.0-beta.0, 2026-07-23; newer stable release not found | Adapters/API integration; Python core | SQLite or Postgres + pgvector; document/model pipeline | Apache-2.0 |
| OpenViking | 0.5.1, 2026-10-19 | Current official TS parity not found | Self-hosted context server with filesystem/vector components; not established as RDS-only | AGPLv3 stated, with additional README restrictions requiring legal review |
| Supermemory self-hosted | Server 0.0.9, 2026-10-12 | API integration; proprietary server binary | Local binary/Docker with embedded storage; optional local models | Proprietary server; public SDK licence is not the server licence |

**Release/licence evidence:**

- **Letta:** [server release, 14 May](https://github.com/letta-ai/letta/releases/tag/0.16.8), [REST-client releases, 2 Jun](https://github.com/letta-ai/letta-node/releases), [versioned Agent SDK package, 18 Oct](https://www.npmjs.com/package/@letta-ai/letta-agent-sdk). No newer server release was verified; that is not a claim the whole project stopped developing.
- **Graphiti:** [release, 15 Oct](https://github.com/getzep/graphiti/releases/tag/v0.31.1), [README at that release](https://github.com/getzep/graphiti/blob/v0.31.1/README.md).
- **mem0:** [releases, 25 Sep](https://github.com/mem0ai/mem0/releases), [version-specific Python package/licence](https://pypi.org/project/mem0ai/2.2.1/), [current SDK changelog](https://docs.mem0.ai/changelog/sdk).
- **Cognee:** [1.6.5 changelog, 16 Oct](https://docs.cognee.ai/changelog), [1.6.5 package/licence](https://pypi.org/project/cognee/). The current store documentation distinguishes the demo Postgres graph from the production/licensed option; do not budget a free production Postgres-only graph without confirming that distinction. [Store configurations](https://docs.cognee.ai/guides/store-configurations).
- **Hermes:** [0.22.2 release, 15 Oct](https://github.com/NousResearch/hermes-agent/releases), [repository/licence snapshot, 20 Oct](https://github.com/nousresearch/hermes-agent).
- **Memobase:** [release listing](https://github.com/memodb-io/memobase/releases) has no GitHub releases; [container listing](https://github.com/memodb-io/memobase/pkgs/container/memobase) did not establish an exact current date. Architecture/licence descriptions in its undated README are **possibly stale background**, not qualifying current validation. [Repository](https://github.com/memodb-io/memobase).
- **LangGraph/LangMem:** [Python releases, 12–16 Oct](https://github.com/langchain-ai/langgraph/releases), [JS releases, 16 Oct](https://github.com/langchain-ai/langgraphjs/releases), [current JS package](https://www.npmjs.com/package/@langchain/langgraph). LangMem 0.0.30's release evidence is **2025, possibly stale**; recent PRs do not establish a new released package. [Release-publication issue](https://github.com/langchain-ai/langmem/issues/125) · [recent PRs](https://github.com/langchain-ai/langmem/pulls).
- **Mastra:** [October releases](https://github.com/mastra-ai/mastra/releases), [current-version reproduction, 16 Oct](https://github.com/mastra-ai/mastra/issues/27319). Package licence is also reported by [version-specific package analysis](https://security.snyk.io/package/npm/%40mastra%2Fmemory/1.37.0); this is secondary evidence, not a legal audit.
- **Hindsight:** [release, 13 Oct](https://github.com/vectorize-io/hindsight/releases/tag/v1.0.0), [tagged README](https://github.com/vectorize-io/hindsight/blob/v1.0.0/README.md), [tagged configuration](https://github.com/vectorize-io/hindsight/blob/v1.0.0/.env.example).
- **Engram:** [release listing, including 20 Oct publication warning](https://github.com/Gentleman-Programming/engram/releases), [release workflow, successful 12 Oct build](https://github.com/Gentleman-Programming/engram/actions/workflows/release.yml), [dated 19 Oct repository/licence snapshot](https://www.gstars.dev/repo/Gentleman-Programming/engram). Do not mistake a failed tag or a Pi integration release for a shipped core binary.
- **memU:** [beta release, 23 Jul](https://github.com/NevaMind-AI/memU/releases/tag/v2.0.0-beta.0), [current architecture](https://github.com/NevaMind-AI/memU/blob/main/docs/architecture.md), [licence](https://github.com/NevaMind-AI/memU/blob/main/LICENSE.txt).
- **OpenViking:** [releases, 19 Oct](https://github.com/volcengine/OpenViking/releases), [current README/licensing statement](https://github.com/volcengine/OpenViking/blob/main/README.md). Treat the combined licensing language as procurement work, not an automatic permissive-OSS approval.
- **Supermemory:** [server release, 12 Oct](https://github.com/supermemoryai/supermemory/releases/tag/server-v0.0.9), [licence-limit release, 15 Aug 2026](https://github.com/supermemoryai/supermemory/releases/tag/server-v0.0.7), [server-source discussion, Jul–Sep 2026](https://github.com/supermemoryai/supermemory/issues/1299).

**Zep CE status:** do not start a new CE deployment. Current versioned Zep documentation says CE is deprecated/unsupported; maintained Zep SDK/ingestion releases are not new CE server releases. Graphiti is the relevant OSS project. The original **2 April 2025 announcement is possibly stale background**, not the sole basis for this conclusion. [Current v4 FAQ](https://help.getzep.com/v4/faq.md) · [Zep releases through 14 Oct 2026](https://github.com/getzep/zep/releases).

## B. What is stored, how retrieval works, time and provenance

| Candidate | Stored material and retrieval | Temporal/change handling | Provenance and hotel-isolation implications |
|---|---|---|---|
| Letta | Agent-owned files/Git memory plus conversation history; local and hosted search capabilities differ | Git versions and message chronology; native bitemporal business-fact model not established | Raw history/file paths are useful, but email/PDF citation mapping and tenant authorization are application work |
| Graphiti | Source episodes plus extracted entity/fact graph; semantic, keyword and graph retrieval | Separate valid_at/invalid_at and created_at/expired_at fields; temporal fact invalidation | Edges reference source episode IDs; group partitions are not a complete authorization layer |
| mem0 OSS | Extracted facts with entity signals; raw ingestion option; vector candidates boosted by BM25/entity scores | OSS v3 is ADD-only; conflicting old/new facts can coexist; no hosted temporal/Dream assumptions | Retain source IDs as metadata and originals separately; user/agent/run scopes require authenticated enforcement |
| Cognee | Documents/chunks/provenance in relational storage; embeddings plus entity graph | Current temporal search exists and changed during October releases; full bitemporal correctness not established | Source-aware retrieval is a credible fit; use documented backend access control and supported isolated stores |
| Hermes Agent | Full sessions in SQLite/FTS5, compact durable notes, skills; external provider plugins | Session chronology and editable notes; provider-specific temporal behavior | Profiles/processes isolate local state; source-email mapping and SaaS authorization are not supplied by session search |
| Memobase | Background description: profiles, buffered blobs, events and event gists | Current released contradiction/version semantics not verified | Background docs allow raw-blob removal; fresh source-retention and tenant guarantees not found |
| LangMem / LangGraph Store | Generic Store records and semantic search; checkpointer holds task state; LangMem adds extraction/consolidation | Application-designed versions and corrections; checkpoint history is not business bitemporality | Namespace is a scoping primitive, not authorization; source spans and booking schema are yours |
| Mastra memory | Raw messages, semantic recall, working memory and optional observations/reflections | Chronology and observation history; no native authoritative account-validity ledger established | Retrieval mode can recover source messages; resource/thread/scopes need trusted routing and independent tenant controls |
| Hindsight | Facts, experiences, consolidated observations and mental models; semantic, keyword, graph and time retrieval with fusion/reranking | Temporal metadata, consolidation and curation; not a demonstrated complete bitemporal truth engine | Source chunks and evidence quotes are useful; configure tenant/bank authorization; local defaults are not a security boundary |
| Engram | Session observations and text stored in SQLite/FTS5; HTTP/MCP access | Observation version history; not a temporal entity-resolution engine | Project/session scoping; no demonstrated hotel-grade source-document model or tenant boundary |
| memU | Raw resources, extracted entries, topic/skill files and relations; hierarchical/embedding retrieval | Current beta; robust bitemporal and correction guarantees not found | Raw-resource hierarchy is promising; immutable email/PDF-page linkage and tenant authorization require validation |
| OpenViking | Hierarchical resources/memory/skills/sessions; abstract, overview and original-content layers; directory-scoped search | Session commits and editable memories; bitemporal guarantee not found | Source URIs are useful; accounts/ACL configuration must be checked; not an established RDS-only shortcut |
| Supermemory self-hosted | Local graph/memory extraction and hybrid search; document/PDF ingestion | Time-aware features described; immutable bitemporal guarantee not found | Local has one organization/API-key model; enterprise tenancy is a separate offering |

**Important current-source qualifications:**

1. **Graphiti really has two temporal dimensions in its representation.** The tagged edge source explicitly distinguishes when a fact became/stopped being true from when an edge was created/invalidated, and includes episode IDs. That is stronger than “timestamps only,” but still not proof that the LLM infers every hotel amendment correctly. [0.31.1 source, 15 Oct 2026](https://github.com/getzep/graphiti/blob/v0.31.1/graphiti_core/edges.py).
2. **mem0 OSS is not the hosted graph engine.** Current OSS v3 documentation describes single-pass ADD-only ingestion and BM25/entity ranking boosts over vector candidates. Do not describe that as independent lexical recall or import hosted graph/decay/consolidation guarantees into OSS. [Current v3 migration documentation](https://docs.mem0.ai/migration/oss-v2-to-v3), corroborated by the [September SDK line](https://github.com/mem0ai/mem0/releases) and [April evaluation implementation](https://github.com/mem0ai/memory-benchmarks/commit/edcd6f1d42400837b1fcb6997716f1769dc51a37).
3. **Mastra's October recall is more than lossy summaries.** Release notes describe paging around observation groups, confirming details against raw source messages, and labeling reflected groups as lossy. Its October working-memory fix adds row-locked Postgres merges; it is not a blanket guarantee for every adapter/path. [Releases, 5–16 Oct 2026](https://github.com/mastra-ai/mastra/releases).
4. **Hindsight does not require a separate graph DB, nor necessarily an exotic Postgres extension.** Its 1.0.0 configuration defaults to pgvector and native PostgreSQL text search, with optional alternatives. Its README calls the keyword arm BM25; for a fair experiment, record the actual configured scorer rather than assuming native PostgreSQL FTS is textbook BM25. [Tagged configuration, 13 Oct 2026](https://github.com/vectorize-io/hindsight/blob/v1.0.0/.env.example).
5. **Use Hindsight's current REST/TS client, not an obsolete wrapper.** The 1.0.0 release removes an agent-SDK/agent_knowledge integration package while publishing the TS client. Earlier source-chunk examples therefore need adaptation, not blind copying. [Release, 13 Oct 2026](https://github.com/vectorize-io/hindsight/releases/tag/v1.0.0).
6. **Cognee is a real U1 contender, not dismissed.** Its October changelog covers temporal and ingestion work. Its personalized-email cookbook demonstrates the right inbound/sent-mail separation, but that page's publication date was not established, so it is **possibly stale background**, not proof of an October production deployment. A September bank case study is current but vendor-authored and anonymized. [Changelog, 7–16 Oct](https://docs.cognee.ai/changelog) · [email cookbook](https://docs.cognee.ai/cookbooks/personalized-email) · [bank case, updated 3 Sep 2026](https://www.cognee.ai/tier-1-us-bank-meets-cognee-ai-memory).

## C. Ingestion cost, maturity, issues and relevant use

Completion counts below are **additional to Nava's existing extraction call** unless the same result can be reused. They are planning estimates, not measured per-email guarantees. Embeddings, reranking, retries and PDF/OCR processing are separate.

| Candidate | Additional completion-call budget | Current maturity / issue signal | Email, support or named production evidence |
|---|---|---|---|
| Letta | Zero for storing supplied files/history; agent-driven memory edits add variable calls | Server release evidence lags SDK activity; current self-host compatibility needs pinning | Relevant named OSS email/support deployment not found |
| Graphiti | Several extraction/resolution operations; budget 3–10 per short episode for pilot sizing, then measure | October extraction/temporal fixes; current governance/access-control requests remain | Do not count Zep Cloud customers as Graphiti OSS deployments; relevant named deployment not found |
| mem0 OSS | Approximately one extraction pass per add; raw mode can avoid extraction; embeddings additional | September release fixes false successful inserts and filtering; July scope bug is closed and later released fixes exist | Public OSS benchmark artifacts exist; named matching email deployment not found |
| Cognee | Budget 1–5 per short document/chunk depending pipeline; synthesis optional | Frequent Jun–Oct releases; October retrieval-grounding and build-publication reports need triage | Email cookbook is background; September anonymized bank is vendor-reported, not named OSS proof |
| Hermes Agent | Zero for core session persistence/search; agent/provider calls variable | 0.22.2 repairs incorrect 0.22.1 publication; current session-search/provider integration issues | Email gateway exists; qualifying named reservation/support deployment not found |
| Memobase | Current count not found; older fixed-three-calls-per-flush claim is possibly stale | No current dated stable release; September open PR addresses silently discarded profile merges | Relevant named user/deployment not found |
| LangMem / LangGraph Store | Store/checkpointer zero; extraction/consolidation one or more when enabled | LangGraph actively released in October; LangMem released-package freshness weak | Project metadata names Replit, Uber, LinkedIn and GitLab for LangGraph generally, not this memory deployment |
| Mastra memory | Semantic recall adds embeddings, not a required completion; Observer/Reflector calls depend on thresholds | October concurrency improvements; open October OM storage-latency report | Current support-orchestration issue reports, but named comparable deployment not found |
| Hindsight | At least one extraction pass per chunk/batch plus asynchronous consolidation; recall need not use an LLM | 1.0.0 contains tag-scope and ingestion fixes; very recent major release | Public agent integrations, not established named hotel/email production users |
| Engram | Zero required model calls in core storage/FTS | October version-history work; 20 October core-publication failure is explicitly disclosed | Coding-agent use; relevant email/support deployment not found |
| memU | Structured ingestion one or more; agent-prepared workspace files can avoid extraction | Latest verified release is beta; no qualifying critical-issue conclusion established | Document ingestion capability, not demonstrated named hotel use |
| OpenViking | Summarization/extraction and embeddings; exact per-document count not found | Frequent releases; 0.5.1 includes migration/API/storage-change risk | Email-channel capability is not production case-based-retrieval evidence |
| Supermemory self-hosted | Extraction/embedding workflow; exact count not found | Frequent early server releases; proprietary-source concerns remain | Named relevant self-hosted customer not found; platform connectors are not Local connectors |

**Latency:** comparable end-to-end measurements for Nava's email/PDF workload were **not found for any candidate**. Hindsight's July local-stack article reports an illustrative retain around eight seconds and recall under a second; this is **project-reported, not a production SLA or a controlled Nava benchmark**. [17 Jul 2026](https://hindsight.vectorize.io/blog/2026/07/17/hermes-hindsight-open-stack).

**Stars trend:** comparable, dated primary-source star histories were **not found** for the candidates; I will not turn single snapshots into growth rates. Engram has a secondary tracker reporting 7.5K stars and weekly growth in an October 19 snapshot, but that is weaker evidence than a reproducible primary history and does not establish production maturity. [Tracker, 19 Oct 2026](https://www.gstars.dev/repo/Gentleman-Programming/engram).

**Current issues—not stale scare stories:**

- **mem0:** the July identity-scope issue is **closed**; the August Node release explicitly strips identity keys from add metadata. September also fixes false success on rejected vector inserts. These are reasons to pin and regression-test, not grounds to call the old defect still open. [Issue 6342, Jul 2026](https://github.com/mem0ai/mem0/issues/6342) · [Node 3.1.4, 4 Aug](https://github.com/mem0ai/mem0/releases/tag/ts-v3.1.4) · [25 Sep release](https://github.com/mem0ai/mem0/releases).
- **Hindsight:** the retired-facts report **3475 is closed**, with follow-on fixes referenced in August. It must not be recycled as an unresolved October defect. Test the scenario anyway. The August control-plane issue was closed with the maintainer explicitly saying the UI is deliberately single-tenant; data-plane tenancy and UI tenancy are different. [3475, 13–19 Aug](https://github.com/vectorize-io/hindsight/issues/3475) · [3183, 5 Aug](https://github.com/vectorize-io/hindsight/issues/3183). The October release itself includes a tag-scoping security fix. [13 Oct](https://github.com/vectorize-io/hindsight/releases/tag/v1.0.0).
- **Mastra:** open issue 27319 reports 13 sequential Postgres round trips per model step with the tested OM configuration. Co-locating app and RDS mitigates network RTT, not the existence of those round trips. [16–17 Oct 2026](https://github.com/mastra-ai/mastra/issues/27319).
- **Graphiti:** current governance-hook requests discuss fact-level access controls and audit requirements; provenance is not equivalent to authorization. [Issue 1679, 24 Jul 2026](https://github.com/getzep/graphiti/issues/1679).
- **Cognee:** current reports concern graph-completion context/empty-context handling and Docker publication ordering. Prefer raw retrieval and pinned image digests during evaluation. These are reports, not an independent severity audit. [6077, 20 Oct](https://github.com/topoteretes/cognee/issues/6077) · [6075, 20 Oct](https://github.com/topoteretes/cognee/issues/6075).
- **Hermes:** session search remains a distinct retrieval path from external memory-provider search in a report updated October 17. The 0.22.2 release also discloses a session-deletion limitation for sessions run under 0.22.1. [29902, updated 17 Oct](https://github.com/NousResearch/hermes-agent/issues/29902) · [release, 15 Oct](https://github.com/NousResearch/hermes-agent/releases).
- **Memobase:** an open September PR addresses profile-merge actions silently discarded by a parser/prompt mismatch; an open PR is not a shipped fix. [PR 167, 18 Sep 2026](https://github.com/memodb-io/memobase/pull/167).

**Cost translation for your volume:** for each *additional* full-email extraction pass, budget approximately **250 additional completions/day** on live inbound mail, or **12,000 completions for a 12,000-message backfill**, before chunking, retries and consolidation. As an explicit planning assumption, 1,000 input + 150 output tokens per pass means **12 million input + 1.8 million output tokens** per backfill pass. Multiply those by your actual model rates; add embeddings, OCR and compute. Do not apply cloud subscription prices to self-hosted OSS. A framework doing several passes can dominate the incremental cost even at this modest live volume.

**Supermemory qualification:** the user requirement is self-hostable, not universally OSS. Therefore it is eligible to discuss, rather than automatically exclude. However, Local's documented lite limit is **10,000 documents**, below the stated 12,000-message corpus if messages are stored individually, before attachments. Proprietary licensing, one-local-org tenancy and enterprise terms make it a poor first experiment here. [Current Local/Enterprise documentation](https://supermemory.ai/docs/self-hosting/local-vs-enterprise) · [limit-bearing release, 15 Aug 2026](https://github.com/supermemoryai/supermemory/releases/tag/server-v0.0.7) · [current server, 12 Oct 2026](https://github.com/supermemoryai/supermemory/releases/tag/server-v0.0.9).

# 3. What 2026 evidence actually says

## Customer-support precedent retrieval is established—not a speculative category

**Zendesk is the cleanest current analogue to U1.** Its August announcement specifies keyword + semantic matching over subject, description and meaningful comments, retrieving solved/closed tickets from the previous 90 days. It explicitly says generative AI is not used to find similar tickets. July auto-assist documentation says agents can inspect relevant tickets behind a suggestion and that procedures remain primary. This supports a staff-facing case-retrieval product, not a requirement to adopt a knowledge graph. [19 Aug 2026](https://support.zendesk.com/hc/en-us/articles/11140948616346-Announcing-improvements-to-the-Copilot-similar-tickets-feature) · [14 Jul 2026](https://support.zendesk.com/hc/en-us/articles/10468772618522-Announcing-auto-assist-improvements-using-similar-solved-tickets).

**Intercom now has explicit memory.** Fin Memory's current documentation distinguishes recent messages, episodic summaries and personal facts, and its August changelog says context follows customers from chat to email. This is strong evidence for U2/continuity, but not equivalent to showing staff arbitrary past cases with verbatim replies: the memory is internal rather than a teammate-visible precedent browser. [Documentation, 22 Jul 2026](https://www.intercom.com/help/en/articles/16001516-fin-memory) · [changelog, 13 Aug 2026](https://www.intercom.com/changes/en/154444-fin-now-remembers-past-conversations).

**FRAGATA is the closest real-corpus architecture.** CESGA's authors describe approximately 20 years of email-driven Request Tracker support history, full conversations and text attachments, dense retrieval + BM25 + fusion + cross-encoder reranking, with metadata filtering. Results are qualitative; a curated quantitative evaluation and conversational source-citing interface are future work. It is evidence that historical-ticket retrieval is useful, not a measured graph-memory victory. [Paper, 15 Apr 2026](https://arxiv.org/abs/2604.13721).

**DQA makes the strongest case against “retrieval alone is enough.”** Its authors evaluated 150 anonymized IT-support scenarios and reported 78.7% trajectory success versus 41.3% for a multi-turn RAG baseline, using persistent diagnostic state and root-cause aggregation. Those are paper-reported experimental results, not hotel production metrics or a Graphiti-versus-hybrid comparison. [DQA, 7 Apr 2026](https://arxiv.org/abs/2604.05350).

### Does graph memory beat hybrid search on this domain?

**Not established by the qualifying evidence found.** The nearest graph-memory comparison located is a September NeuG evaluation using **LongMemEval**, comparing memory systems/backends—not the required real-email/ticket corpus against an independently tuned BM25+vector baseline. It is also vendor-run. [NeuG, 14 Sep 2026](https://neug.io/blog/agent-memory-benchmark/).

Accordingly, neither “graphs definitely win” nor “Postgres hybrid is already sufficient” is defensible as an empirical conclusion for Nava.

## Benchmarks beyond the old LoCoMo/LongMemEval headlines

| Benchmark / update | Qualifying 2026 evidence | Who ran/published it | What it adds | Why it does not settle Nava |
|---|---|---|---|---|
| MemoryArena | ICML proceedings, 6–11 July | He and co-authors; academic/industry research team | Interdependent multi-session agent tasks where remembered information must guide later actions | Not actual hotel email/PMS execution |
| AMA-Bench | ICML proceedings page, 29 September | Zhao and co-authors | Long-horizon agent trajectories, causal inference and state updates | Not a controlled comparison on Nava's corpus |
| MemoryBench | Off-policy result update, 24 June | THUIR research team | Learning from accumulated feedback; compares memory methods and RAG baselines | Simulated feedback; original paper predates 2026 |
| MemoryAgentBench | Paper revision, 28 June; May result update | Hu, Wang and McAuley | Incremental ingestion, retrieval, learning and selective forgetting | Initial work is 2025; no hotel source-linkage test |
| EmailBench | September preprint | Microsoft-affiliated authors | Enterprise email/productivity tasks and executable checks | Synthetic, small email corpus; not a graph-versus-hybrid retrieval study |
| BEAM as used in current mem0 evaluation | Published evaluation artifacts, 9 April | BEAM research authors; mem0 ran the cited implementation | Long conversations and contradiction, update, order and temporal probes | Vendor configuration; conversational rather than reservation-case data |

Sources: [MemoryArena, ICML 2026](https://proceedings.mlr.press/v306/he26am.html) · [AMA-Bench, 29 Sep 2026](https://proceedings.mlr.press/v306/zhao26bs.html) · [MemoryBench June 2026 updates](https://github.com/THUIR/MemoryBench) · [MemoryAgentBench 2026 revisions/results](https://github.com/HUST-AI-HYZ/MemoryAgentBench) · [EmailBench, Sep 2026](https://arxiv.org/html/2609.31906v1) · [BEAM primary repository](https://github.com/mohammadtavakoli78/BEAM) · [dated BEAM/OSS evaluation artifacts, 9 Apr 2026](https://github.com/mem0ai/memory-benchmarks/commit/edcd6f1d42400837b1fcb6997716f1769dc51a37).

### The corrected mem0 benchmark position

1. **There is now an OSS-capable runner and published OSS output.** April's artifacts report LongMemEval 91.0% with GPT-5 extraction, 89.8% with GPT-OSS-120B, and 88.6% for two other extraction configurations. The documented OSS setup uses Qwen embeddings through SageMaker, Qdrant, and GPT-5 answering/judging. These are **mem0-reported results**, not independent confirmation and not Nava's TS/Postgres deployment. [9 Apr artifacts](https://github.com/mem0ai/memory-benchmarks/commit/edcd6f1d42400837b1fcb6997716f1769dc51a37) · [configuration/results tables](https://github.com/mem0ai/memory-benchmarks).
2. **Managed and OSS scores remain distinct.** The repository labels the 94.4% LongMemEval and 92.5% LoCoMo headlines as managed-platform results and warns not to expect identical OSS results. Differences in models, embeddings, retrieval depth and evaluation configuration prevent a clean subtraction of those scores. [Current results and caveats, introduced 9 Apr 2026](https://github.com/mem0ai/memory-benchmarks).
3. **Independent results conflict, rather than settle the matter.** A May Bench'd report gives 32.4% OSS LongMemEval and was closed by maintainers as not relevant. Its different harness/models and extreme discrepancies make it a replication question, not a reason to declare current mem0 broken. [Issue 5141, 13–14 May 2026](https://github.com/mem0ai/mem0/issues/5141).
4. **Current reproducibility details still matter.** A July benchmark issue asks which LongMemEval variant was used. Also, April result artifacts do not prove that September SDK 2.2.1/3.3.1 was tested. Pin the current release, dataset variant, ingestion configuration, answerer, judge and retrieval depth in Nava's experiment. [Issue 19, 7 Jul 2026](https://github.com/mem0ai/memory-benchmarks/issues/19) · [SDK releases, 25 Sep 2026](https://github.com/mem0ai/mem0/releases).

# 4. Recommended stack and migration effort

## Production architecture

**Keep:** TypeScript, Mastra workflows, AWS RDS Postgres, the existing extraction call, deterministic Playwright scripts, human approval of every PMS write, and no automatic email sending.

**Add an application-owned evidence model:**

- `source_document`: hotel, mailbox, original message/PDF identity, timestamps, immutable content hash, source link, and original content/object reference.
- `request_case`: one actual ask, possibly a fragment of an email; linked staff replies, letters, outcome and provenance. One email can contain multiple cases; one case can span multiple threads.
- `booking_event` and `case_booking_link`: approved write, booking identifier, provisional letter, amendment/cancellation, match evidence, uncertainty and reviewer.
- `account_fact_version`: subject, predicate, value, valid-from/to, recorded-at, source span, authority, correction actor and supersession. Keep “requested rate,” “usual rate” and “approved entitlement” separate.
- `sop_version`: hotel, effective period, draft/published state, approving owner and source text.
- `retrieval_projection`: searchable case text, structured filters, embeddings and index/model version. This is rebuildable, not the authoritative record.

These are **proposed schemas**, not claims that a library already supplies them.

For U1, run independent lexical and vector candidate retrieval, fuse/rerank, then hydrate the **complete case bundle**. Show 3–5 cards with exact historical ask/reply excerpts, the actual linked letter, and the provenance of each rate/room/profile field. If the historical record does not show which HMS profile was actually used, display **unknown**—do not promote an inferred account mapping into an observed fact.

Start with tenant-filtered exact vector search at pilot scale; benchmark before adding ANN complexity. AWS's June production guidance notes that small vector sets can favor sequential scans and that ANN entails recall trade-offs. Native PostgreSQL FTS is **not automatically BM25**; if testing a literature BM25 baseline, implement that comparator explicitly. [AWS pgvector guidance, 25 Jun 2026](https://aws.amazon.com/blogs/database/running-pgvector-in-production-on-amazon-aurora-postgresql/) · [PostgreSQL 18 text-search documentation, current 2026 version](https://www.postgresql.org/docs/18/textsearch-intro.html).

For delayed letters, retain an explicit pending correlation record from the **approved PMS write**. Match a later letter using booking identifiers and guest/stay evidence; keep ambiguous matches pending. Do not use sender, subject or conversation adjacency as booking identity. This is a design response to your supplied 2–20-minute, separate-thread behavior.

## Optional Hindsight integration

Deploy a private API service and background processing alongside the current stack. Use the TS client; use RDS-supported pgvector/native-text configuration first; validate migrations against the actual RDS engine. Retain original documents in Nava's store, and pass case/document IDs into Hindsight. Resolve retrieved IDs back through Nava's authorized evidence API before display.

Use one authenticated hotel boundary—not just a caller-supplied tag. Start with API integration rather than exposing the framework's control-plane UI to hotel staff. Hindsight's current release/configuration supports the Postgres path, while its August maintainer response specifically distinguishes data-plane tenancy from the single-tenant UI. [1.0.0 configuration, 13 Oct](https://github.com/vectorize-io/hindsight/blob/v1.0.0/.env.example) · [tenancy discussion, 5 Aug 2026](https://github.com/vectorize-io/hindsight/issues/3183).

**Data residency is a whole-pipeline requirement.** Self-hosting a memory database while sending email text to an external extraction, embedding, OCR, reranking, tracing or telemetry endpoint does not satisfy the literal “data stays in our AWS” requirement. Select approved AWS-resident/local endpoints and verify egress. If the existing GPT-class call leaves that boundary, changing memory frameworks does not fix it. This is an architectural implication of your requirement, not a POPIA/GDPR compliance certification.

## Estimated migration effort

Assumptions: existing ingestion/Outlook pane and deployment are usable; one developer plus coding agents; staff can help label examples. These are **engineering estimates**, excluding procurement and large-scale historical data cleanup.

| Work | Incremental developer days | What changes |
|---|---:|---|
| Case/source/fact/SOP schema and projection | 2–3 | Add migrations, provenance IDs, case assembly and idempotent ingestion |
| Hybrid retrieval and source-faithful Outlook cards | 2–3 | Add retrieval endpoint, filters, reranking and evidence display |
| Evaluation, tenant tests and replay harness | 1–2 | Add chronological test set, metrics and adversarial cases |
| Baseline total | 5–8 | No orchestration replacement; no new graph database |
| Hindsight comparison after shared schema exists | 2–3 | Private service, TS adapter, retain/recall mapping and instrumentation |
| Hindsight production hardening if it wins | 3–5 | Auth boundaries, deletion, backup/recovery, migration and failure tests |
| Graphiti experiment instead | 5–10 | Python integration plus graph deployment, extraction tuning and provenance mapping |

Do not schedule a Letta/Hermes orchestration migration merely for memory: its cost and risk are not justified by the evidence gathered. Keep U5 in Mastra and initially leave observational compression off for short reservation tasks unless measured context pressure warrants it.

# 5. Smallest experiment that can change the decision

**Goal:** falsify a bad framework choice quickly, not pretend a tiny test proves production safety.

### Dataset and arms

- **1,000 representative historical messages**, with their actual attachments, targeting at least **200 complete past cases**. Include agencies, government desks, vouchers, amendments, cancellations, groups and delayed letters.
- **120 held-out queries:** 80 real later asks plus 40 deliberately difficult cases. Include same sender/different booking, same guest/different dates, new thread/same booking, corrected rate/profile and expired SOP.
- Add **40 explicit-current-email-versus-history conflicts**, **100 difficult linkage pairs**, and **100 cross-hotel access probes**. If the second hotel's data is unavailable, use a separate synthetic canary tenant for isolation testing; do not call that real-world second-hotel validation.
- Apply a **per-query chronological cutoff**. Never let the index contain the eventual answer, later correction or future letter for that query. Deduplicate quoted reply chains across splits.

Compare:

1. **A: Postgres baseline** — independent FTS + vector retrieval, fusion/reranker, same case bundles.
2. **B: Hindsight 1.0.0** — same source material, same tenant/case identifiers, raw source chunks requested, same presentation.
3. **C, only if cheap:** mem0 OSS 3.3.1 or Mastra semantic recall as a lower-complexity memory comparison. Do not add every framework to the first experiment.

Hold embedding/reranking/answering choices constant where practical; disclose where framework architecture prevents parity. Allocate the same tuning budget to each arm. Judge retrieval before generating any answer.

### Proposed pass bars

| Metric | Pass bar |
|---|---|
| Relevant precedent recall@5 | At least 85% on adjudicated answerable queries |
| Incremental value over baseline | At least 10 percentage points better recall@5 or staff-rated useful-case success, with paired confidence interval above zero |
| Verbatim evidence fidelity | 100% of displayed quotes and fields trace to the correct source; no invented profile/rate/room values |
| Current-email precedence | Zero silent overrides in the 40 conflict tests |
| Hotel isolation | Zero cross-tenant documents, chunks, facts, histories or links in 100 probes |
| Booking linkage | Zero false accepted merges in 100 hard pairs; ambiguous cases may abstain |
| Retrieval latency | Warm p95 at most 1.5 seconds, excluding generation |
| Ingestion freshness | p95 evidence searchable within 60 seconds, with queue lag and failures visible |
| Incremental completion budget | At most two extra completions per incoming email on average, including background work over a full day |
| Recovery | Retry/replay produces no duplicate cases or accepted links; failed ingestion is visible |

Have staff judge **whether the previous response is actually useful**, not just semantically similar. An old cancellation reply can resemble a new cancellation email while being the wrong policy, rate or booking.

**Decision rule:** adopt the framework only if it meets all safety bars and produces the specified practical gain. If quality is tied, prefer the lower operational burden—unless measured implementation savings clearly outweigh maintaining another service. If it wins, expand to the full 12,000-message corpus and a larger chronological test before relying on it in production. Zero failures in a small test is a gate, not a statistically demonstrated zero failure rate.

# 6. Steelman and attack both choices

### “Use a memory framework”

**Best argument:** temporal/entity indexing, consolidation, source-chunk retrieval and reusable client APIs are real engineering work. Hindsight can supply several of these on Postgres; Graphiti supplies an explicit temporal graph; Mastra now retrieves underlying history. Rebuilding all of this casually can cost more than integrating a framework. [Hindsight 1.0.0, 13 Oct](https://github.com/vectorize-io/hindsight/blob/v1.0.0/README.md) · [Graphiti 0.31.1, 15 Oct](https://github.com/getzep/graphiti/blob/v0.31.1/graphiti_core/edges.py) · [Mastra October releases](https://github.com/mastra-ai/mastra/releases).

**Strongest attack:** a useful extracted memory is not necessarily an exact past resolution, an authorized current fact, or the correct booking. Framework ingestion introduces another probabilistic transformation, model cost and migration surface. Current releases and issue reports demonstrate that authorization, provenance/currentness and ingestion behavior still require application tests—not trust in a benchmark score. [Hindsight 1.0.0 fixes](https://github.com/vectorize-io/hindsight/releases/tag/v1.0.0) · [mem0 September correctness fixes](https://github.com/mem0ai/mem0/releases).

### “Use plain Postgres retrieval”

**Best argument:** it fits the current deployment, keeps original evidence and accepted facts under one auditable schema, and can reuse Nava's extraction call. Current support systems and research validate hybrid historical-case retrieval without establishing that a graph is necessary. [Zendesk, 19 Aug](https://support.zendesk.com/hc/en-us/articles/11140948616346-Announcing-improvements-to-the-Copilot-similar-tickets-feature) · [FRAGATA, 15 Apr 2026](https://arxiv.org/abs/2604.13721).

**Strongest attack:** “just add pgvector” hides the hard work: request segmentation, linking, source spans, correction versions, ranking, recency, deletion and evaluation. Native FTS is not BM25; raw chunks do not encode resolution state. DQA's results are a concrete warning that maintaining task state can outperform retrieval-only designs, even though they do not prove any particular framework wins here. [DQA, 7 Apr 2026](https://arxiv.org/abs/2604.05350).

# 7. Where the previous run was wrong or stale

1. **The blanket opening was too strong.** “No, a memory layer is not decisive” should have been scoped: **not required as the system of record or PMS execution authority; legitimately useful and testable for U1/U2 and candidate links in U3**. Current source-linked and temporal-memory features make the narrower position necessary. [Hindsight and Graphiti October sources](https://github.com/vectorize-io/hindsight/blob/v1.0.0/README.md) · [Graphiti temporal source](https://github.com/getzep/graphiti/blob/v0.31.1/graphiti_core/edges.py).
2. **The mem0 benchmark caveat relied too heavily on historical evidence.** Issue 2800 was opened in **May 2025** and closed in **March 2026**: **possibly stale background** for this question. April 2026 now supplies public OSS artifacts and results. The correct caveat is configuration/platform/domain mismatch and lack of a pinned newest-SDK Nava evaluation—not “current OSS is unreproducible.” [Historical issue](https://github.com/mem0ai/mem0/issues/2800) · [9 Apr 2026 artifacts](https://github.com/mem0ai/memory-benchmarks/commit/edcd6f1d42400837b1fcb6997716f1769dc51a37).
3. **The Hermes description was materially incomplete.** The small built-in files remain only one layer; current Hermes also has sessions, external memory providers, skills and an email gateway. That does not make it the cheapest Nava integration, but it invalidates judging the entire product by those two files. [Current release, 15 Oct 2026](https://github.com/NousResearch/hermes-agent/releases) · [current memory documentation](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory).
4. **The comparison omitted important challengers.** Hindsight's October 1.0 release and Cognee's current retrieval/provenance work deserve explicit U1 evaluation. Hindsight also weakens the argument that a richer memory engine necessarily requires operating a separate graph database. [Hindsight, 13 Oct](https://github.com/vectorize-io/hindsight/releases/tag/v1.0.0) · [Cognee, 16 Oct](https://docs.cognee.ai/changelog).
5. **The vendor evidence is no longer accurately summarized as merely procedures plus unspecified context.** Zendesk now explicitly documents hybrid similar-ticket retrieval, and Intercom explicitly documents memory across chat/email. Neither proves an OSS framework winner, but both support the product owner's category objection. [Zendesk, Aug 2026](https://support.zendesk.com/hc/en-us/articles/11140948616346-Announcing-improvements-to-the-Copilot-similar-tickets-feature) · [Intercom, Aug 2026](https://www.intercom.com/changes/en/154444-fin-now-remembers-past-conversations).
6. **Some previous distinctions were correct and remain so.** The previous answer already said mem0's July tenant issue was closed; it should not be accused of presenting that as open. Separating Graphiti from unsupported Zep CE, preserving human PMS approval, and refusing to equate historical staff behavior with present rate entitlement remain the right architectural boundaries. [mem0 released scope fix, 4 Aug 2026](https://github.com/mem0ai/mem0/releases/tag/ts-v3.1.4) · [current Zep v4 status](https://help.getzep.com/v4/faq.md).

**Final decision:** build Nava's evidence and accepted-fact model once, keep U5 in Mastra, and run the small **Postgres-versus-Hindsight** experiment before adopting another service. The framework is a credible accelerator—not an authority—and plain Postgres is a credible baseline—not a proven winner.
