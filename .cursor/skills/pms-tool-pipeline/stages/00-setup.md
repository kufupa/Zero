# 0 Setup

Checks: `setup.config`

Write `.private/pms-pipeline/<tool>/pipeline.json`:

```json
{
  "tool": "party-lookup",
  "schema": "apps/server-pilot/tooling/playwright-quote/party-lookup.schema.json",
  "inputPointer": "/$defs/request",
  "toolFiles": [
    "apps/server-pilot/tooling/playwright-quote/party-lookup.mjs",
    "apps/server-pilot/tooling/playwright-quote/party-lookup.schema.json"
  ],
  "minKeyed": 30,
  "criticalPngs": ["criteria", "results"],
  "testCmd": ["node", "--test", "apps/server-pilot/tooling/playwright-quote/party-lookup.test.mjs"]
}
```

- `inputPointer`: JSON pointer to request object inside schema. Every leaf under it must trace to docs/screen (`map.no.invented`).
- `toolFiles`: hashed for `grade.fresh`. Edit any → Astra regrade.
- `criticalPngs`: names every proof case must carry.
- Seed facts: `tools/<tool>.md`.
