# 1 Docs

Checks: `docs.cited`, `docs.exa.agent`

Inputs:
- Infor HMS help `https://docs.infor.com/hms/2026.08/en-us/hmsolh/...` (seed URLs in `tools/<tool>.md`).
- Exa Agent (`agent_run`, effort `high`) for public API **and** missing help pages. Ordinary `web_search_exa` / fetch is the follow-up, not the whole stage.

Method:
1. Run **one** Exa Agent (`codex`/MCP `exa.agent_run`, effort `high`). Objective: public/partner API for this tool's entities **plus** official help URLs for every search dialog, field, auto-fill rule. Pass `/95-exa-agent` output schema. Generic query; no mail, no PII, no credentials.
2. Independently fetch each cited primary URL (`web_fetch_exa`). Quote verbatim. One contradiction query (advanced Exa or WebSearch) on the strongest competing hypothesis.
3. Follow "see also" one level. Every field, button, list, search dialog, auto-fill rule → one item.
4. Click class: `read` (search/open/close), `hold` (changes unsaved form), `write` (Save, Reserve, charge, cancel).

Output `01-docs.json`:

```json
{
  "items": [
    { "id": "doc.org.search", "label": "Organization Search", "url": "https://docs.infor.com/...", "quote": "exact sentence", "clickClass": "read" }
  ],
  "publicApi": {
    "found": false,
    "searched": ["HTNG registry", "Infor API gateway", "Databridge"],
    "exaAgent": { "runId": "agent_run_<hex>", "effort": "high" },
    "notes": "verbatim conclusion + URLs"
  }
}
```

Rules:
- Quote verbatim. No quote → no item.
- Auto-fill rules ("selecting X fills Y") are items too; stage 9 needs them.
- Public API names (OHIP, OTA) = vocabulary only. Never become schema fields unless screen shows them.
- `docs.exa.agent` fails without `publicApi.exaAgent.runId` matching `agent_run_[hex]`. Ordinary search-only = fail.
- Also write `implications.json` (see `stages/implications.md`). Tool splits, consumer effects, and `flagUser` research flips live there, not only in chat.
- Auth/quota denial: record `found: false`, `exaAgent.runId` still required unless STOP `model_rejected`. Do not skip the Agent call.
