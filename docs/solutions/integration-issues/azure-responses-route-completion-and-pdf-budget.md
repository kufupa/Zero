---
title: "Bind Azure Responses route, completed output and PDF input budget"
date: "2026-10-04"
category: integration-issues
module: server-pilot
problem_type: integration_issue
component: assistant
severity: high
symptoms:
  - "An injected SDK model could call another endpoint while reporting configured route provenance."
  - "Incomplete JSON was accepted as complete output."
  - "PDF input required a processed-token bound independent of file bytes."
  - "The model-facing fact schema differed from the server validator."
root_cause: missing_validation
resolution_type: code_fix
tags:
  - "azure-foundry"
  - "responses-api"
  - "pdf"
  - "token-budget"
  - "unknown-spend"
---

# Bind Azure Responses route, completed output and PDF input budget

The reservationist's explicit Azure adapter now constructs its SDK model from the admitted endpoint, key and deployment. It rejects arbitrary model injection, checks the outgoing Responses URL, and reports the admitted purpose and dated cost estimate. Equal model names alone cannot establish physical route identity.

Parsed JSON requires independent completion evidence. The adapter checks the SDK finish reason, raw completed envelope and message, exact returned model and token invariants before consuming facts. Valid ancillary encrypted reasoning is allowed. Incomplete, refused, tool-only, malformed or inconsistent output fails; the existing collector and budget guard stop subsequent calls when spend is unproved.

PDF bytes limit resource use; they cannot bound processed multimodal tokens. Optional quota admission binds the published Azure GPT-6 Luna input ceiling of 922,000 tokens to provider/model/source URL/hash/time/version. It reserves the full input ceiling plus output allowance for every permitted call and separately caps request bytes. Missing quota refuses files. Reported usage, protocol, cost and immutable admission are checked after each call. No model route, quota, release, source grant or paid factory is installed by default.

The model now receives the full discriminated schema derived from `documentPlanSchema`, including exact scalar party values, allowed rate fields and original source spans. A real synthetic Azure request exposed a format difference: Zod's fixed coordinate tuple emitted an array of `items`, which the provider rejected. Extraction v8 converts only identical, fixed-length tuple entries to a homogeneous `items` object, retaining exactly four coordinates bounded zero to one. Other canonical constraints remain unchanged. This provider format repair is locally tested; actual Azure acceptance of v8 remains unverified.

Exact source wording such as “room only” now maps to its canonical native board after original text verification. Independent review caught negated aliases that the earlier exclusion pattern did not cover; the final local repair rejects exact preposed and postposed negation without discarding an affirmative label because of unrelated negation. Literal canonical board tokens are no longer parsed as extra room IDs. Unknown inclusion prose and wrong group targets still fail. Prompt instructions retain explicit group ID tokens, source wording and unresolved conflicting monetary rows; the server never repairs invented model facts into approval.

Actual installed-SDK tests with local fetch prove physical PDF wire, completion negatives, reported usage, quota overrun and terminal unknown spend. Independent review reproduced and closed endpoint-injection and incomplete-JSON defects. These tests establish local contracts, not authentic extraction accuracy or historical qualification.

Eight actual synthetic requests remain in private ledgers: seven returned reported usage totalling 12,238 input and 38,030 output tokens, estimated conservatively at USD0.0378984; the eighth returned HTTP400 schema validation with no usage. The original USD25/eight-hour cap checkpointed with unknown spend and stopped further paid requests. The estimate uses published Standard EU long-context maxima, including cache-write input, rather than claiming invoice charges. Failed attempts remain nonpasses. No customer corpus input was used, and authentic development/untouched-holdout qualification remains open.

Construct and test the actual SDK wire, preserve response completion and usage evidence, derive schemas from validators, keep bytes separate from processed-token limits, and retain every failed attempt. A changed implementation requires a fresh manifest; unknown cost never becomes zero by assumption.

Related sources:

- [Azure model limits](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/reasoning)
- [Azure published pricing table](https://azure.microsoft.com/en-us/blog/gpt-6-astra-sol-and-luna-for-production-agents-in-microsoft-foundry/)
- [Earlier Azure/Mastra and gold-pairing investigation](reservationist-backtest-luna-azure-and-gold-pairing.md)
- [Reservationist replay runbook](../../infor-hms/2026-10-04-reservationist-replay-runbook.md)

The earlier investigation's occupancy/date workarounds are historical context. The canonical reservationist contract requires explicit source facts and forbids invented defaults.
