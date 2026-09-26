# 8 Grade

Checks: `grade.fresh`, `grade.pass`, `grade.sol`

Two graders, both fresh:

1. Astra high (live screen only). Brief = `../grader.md` mode `final`. Never resume the stage-3 session. Reruns 3 proof cases live, compares CLI output to screen. These items have **no** `"by"` field.
2. Sol xhigh (files only, no browser). Brief = `../grader.md` "Sol file review". Checks **cited** Astra evidence pngs match those claims, and backtest miss classes are honest. Appends `"by":"sol"` items. Do **not** grade leftover files in `png/`.

Write `08-grade.json`:

```json
{ "codeHash": "<from pipeline.mjs codeHash(toolFiles)>", "items": [ { "id": "g1", "pass": true, "claim": "...", "evidence": "png/g1.png" } ] }
```

`grade.pass` = every **non-Sol** item `pass === true` with evidence (live Astra grade), and every cited `.png` exists under the tool dir.
`grade.sol` = at least one `"by":"sol"` item, and every Sol item whose evidence path equals an Astra evidence path must pass. Sol FAILs on stale diagnostic / uncited pngs do **not** fail the gate.

Get hash: `node apps/server-pilot/tooling/pms-pipeline/pipeline.mjs hash <tool>`

Any tool-file edit after grading → `grade.fresh` fails → regrade.
