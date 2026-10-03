---
title: Reservationist backtest - Luna on Azure Foundry, gold-reply pairing, HMS string rates
date: 2026-10-02
category: integration-issues
problem_type: integration_issue
module: server-pilot
component: assistant
severity: medium
applies_when:
  - Running a Mastra agent on GPT-6 Luna when Bedrock Luna is unavailable
  - Pairing inbound Centurion mail with the staff reply that answered it
  - Grounding money in agent drafts against HMS quote output
tags:
  - luna
  - azure-foundry
  - mastra
  - backtest
  - threading
  - hms-quote
---

# Reservationist backtest: Luna on Azure Foundry, gold-reply pairing, HMS string rates

## Luna through Azure Foundry

Bedrock `openai.gpt-6-luna` failed the marketplace agreement with
`INVALID_PAYMENT_INSTRUMENT` (account has no card on file). The Azure Foundry
resource Codex uses on the VPS serves the same model as deployment `gpt-6-luna`
on the OpenAI v1 Responses wire. `createAzureLunaModel()` in
`src/ai/bedrock/luna.ts` is `createOpenAI({ baseURL, apiKey, headers: {'api-key': key} }).responses('gpt-6-luna')`
with `AZURE_OPENAI_BASE_URL` (`.../openai/v1`) and `AZURE_FOUNDRY_API_KEY`.

- Mastra 1.70 tools + `structuredOutput` work unchanged on it.
- `LUNA_PROVIDER_OPTIONS` sends `reasoning.effort: "max"` and Azure reports
  reasoning tokens, so effort is honoured. Trivial prompts still report
  near-zero reasoning; check with a non-trivial prompt before concluding it
  was dropped.

## Pairing a trigger with its gold reply

Pairing by `threadId` alone lost about 40% of 26-28 Sep cases. Outlook-synced
staff replies often land in a different thread from the inbound they answer.
What worked (`findGoldPair` in `src/ai/reservationist-backtest.ts`):

1. Scan every sent outbound in the thread, not just the first.
2. Resolve the trigger via `inReplyTo` against a corpus-wide Message-ID map.
3. Without `inReplyTo`, only pair when the subject starts `RE:`, using the
   latest earlier inbound. Staff-initiated mail otherwise pairs with
   unrelated inbound.
4. Drop unsent queue states (`pending`, `sending`, `cancelled`) and empty
   forwards whose text starts with `From:` / `-----Original Message-----`.

The ingest quarantine (`missing_owner_header`) was not the loss: all rows were
other legacy mailboxes, none addressed to Centurion.

## HMS rates are decimal strings

`fetch-quote.mjs` `result.json` serialises amounts as `"1940.00"`. A
grounding check that only collects JSON numbers flags every correct rate as
invented. Parse numeric strings too.

## Agent behaviour worth knowing

- "Do not guess occupancy" made Luna ask guests for details staff assume, so
  it never quoted. Staff defaults (one named guest = 1 adult/1 room, named
  guests per room = single, day-month = next occurrence) fixed it.
- Luna multiplies nightly rates into stay totals. Totals are not in HMS
  output, so the money gate reports them as ungrounded by design.
- Gold replies frequently perform actions (attach pro forma, payment link,
  bank letter) outside the toolset; LLM review marks those drafts bad even
  when workflow and tools are right. Read verdicts with that in mind.
