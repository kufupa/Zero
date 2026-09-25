# 4 Freeze

Checks: `map.complete`, `map.no.invented`, `review.resolved`

1. Draft schema at `pipeline.json.schema` (request under `inputPointer`, result beside it).
2. Write `field-map.json`: one entry per `01-docs.json` item and per `03-screen.json` control.

```json
{
  "entries": [
    { "id": "scr.org.name", "schemaPath": "query.organizationName" },
    { "id": "doc.save", "reason": "banned_click" },
    { "id": "scr.bacontract", "reason": "system_filled" },
    { "id": "scr.rate", "reason": "other_tool:hms_quote_stay" }
  ]
}
```

Reasons allowed: `system_filled`, `banned_click`, `not_on_property`, `other_tool:<id>`. Nothing else. "Gray" / "hard" / "later" are not reasons: do the docs click in stage 3.

3. Review: fresh Astra high session, brief = `../grader.md` mode `map`. Astra opens the screens live and challenges every `reason` entry and every unmapped-looking control.
4. Write `04-review.json`; resolve each blocking finding (`fixed` with change, or `rebutted` with png/URL).

```json
{ "findings": [ { "id": "r1", "blocking": true, "status": "open", "claim": "...", "evidence": "png/x.png" } ] }
```
