# Implications (every tool)

Checks: `implications.present`, `implications.deltas`

Write `.private/pms-pipeline/<tool>/implications.json` in stage 1. Update it whenever docs, screen, or freeze **change what tools exist**.

Purpose: one pass can spawn or kill sibling tools. Example already used: A/R is not its own lookup because HMS auto-adds it from org/agency. User must see that flip (`researchDeltas` with `flagUser: true`).

```json
{
  "tool": "party-lookup",
  "kinds": [
    { "kind": "organization", "inThisTool": true, "reason": "..." },
    { "kind": "arAccount", "inThisTool": false, "reason": "...", "instead": "associationEffects.linkedArAccount" }
  ],
  "affectsOtherTools": [
    { "tool": "hms_quote_stay", "effect": "...", "status": "flagged" }
  ],
  "unbuiltTools": [
    { "name": "group-name-lookup", "whyNotNow": "...", "revisitWhen": "..." }
  ],
  "researchDeltas": [
    { "id": "ar-not-a-search-kind", "was": "...", "now": "...", "flagUser": true, "evidence": "01-docs.json doc.org.ar.autofill" }
  ]
}
```

Rules:
- `kinds`: every entity the overall task named, in or out of this tool, with reason.
- `affectsOtherTools`: quote, create, and any existing reader this pass changes. `flagged` = consumer schema/fill-order must change.
- `unbuiltTools`: tools this research says we should build later, not now.
- `researchDeltas`: only when a **prior call** in this pipeline (seed card, earlier stage, earlier chat decision) flipped. `flagUser: true` requires `was`, `now`, `evidence`. Copy those into `DONE.md` / `STOP.md`.
- Update this file at freeze and wire if the split changes. Silent flip = fail `implications.deltas`.
