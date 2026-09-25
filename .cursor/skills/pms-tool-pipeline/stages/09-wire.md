# 9 Wire

Checks: `wire.consumers`, `learn.doc`

1. Consumers named in `tools/<tool>.md`: accept this tool's output ids in their request schema; tests green.
2. Auto-fill side effects (`03-screen.json` `autoFills`): consumer fields changed by the link → consumer `field-map.json` `system_filled`, and consumer fill order sets them after the link.
3. One trap → `.cursor/skills/building-hms-playwright-tools/references/traps.md`.
4. One learning → `docs/solutions/` (non-obvious, verified only).

Output `09-wire.json`:

```json
{ "consumers": [ { "path": "apps/server-pilot/tooling/playwright-quote/quote-tool.schema.json", "done": true } ], "learnDoc": "docs/solutions/workflow-issues/<slug>.md" }
```
