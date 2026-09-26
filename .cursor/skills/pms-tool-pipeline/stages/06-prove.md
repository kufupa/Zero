# 6 Prove

Checks: `prove.pngs`, `prove.pngs.fresh`, `prove.outcomes`

Run the shipped CLI (zero model) live on every `tune` case from `02-corpus.json`, plus one forced empty result and one forced ambiguous result.

- Astra only if CLI fails on selectors: repair locators, persist, rerun CLI. CLI is the proof, not Astra.
- Copy each case's pngs into `png/`.

Output `06-prove.json`:

```json
{ "cases": [ { "id": "<case>", "outcome": "resolved", "pngs": { "criteria": "png/c1-criteria.png", "results": "png/c1-results.png" }, "output": "out/c1.json" } ] }
```

`execution_failure` in any case = fail. Fix, rerun.

Last step: `node apps/server-pilot/tooling/pms-pipeline/pipeline.mjs seal <tool>` writes `pngHashes` into `06-prove.json`. After sealing, never overwrite these proof pngs; later stages save their own files (e.g. `png/grade-g1.png`). Rerunning proof = rerun CLI, copy pngs, seal again.
