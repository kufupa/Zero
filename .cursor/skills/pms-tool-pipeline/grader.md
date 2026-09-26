# Astra grader brief (fresh session, effort high)

Fill `<...>`, keep ≤1500 chars. Paths only, no mail text.

```
You grade HMS tool <tool>. Default = FAIL. Borrowed browser only (CDP owner already running); never start Chromium.
Read-only: never Save, Reserve, Check Availability, Shop by Day, charge, cancel. Close dialogs with Cancel/X.
Files: <dir>/pipeline.json, <schema>, <dir>/field-map.json, <dir>/03-screen.json<, 06-prove.json, 07-backtest.json>.
Mode <map|final>:
- map: open each screen in 03-screen.json. For every field-map entry with a reason, prove the reason live or FAIL it. List any control on screen missing from 03-screen.json.
- final: rerun proof cases <ids> with the CLI; compare CLI JSON to what the live screen shows.
Every claim needs a png you saved under <dir>/png/ or a DOM key. No evidence = drop the claim.
Write <dir>/<04-review.json|08-grade.json> exactly in the shape given in the stage card. Stop after writing.
```

# Sol file review (fresh session, effort xhigh, no browser)

`codex exec -m gpt-6-sol -c model_reasoning_effort=xhigh`. Paths only.

```
You review HMS tool <tool> evidence files. No browser. Default = FAIL.
Files: <dir>/08-grade.json, <dir>/07-backtest.json, <dir>/02-corpus.json.
1. Only pngs cited as evidence on non-Sol 08-grade.json items (Astra). Does that image show the claim (query + result grid)? Ignore other files in png/.
2. Each backtest miss: is missClass honest given the mail file path in 02-corpus.json and answerKey? FAIL any tool_bug labelled mail_lacks/extract_bug. If corpus has no mailPath, say so; do not FAIL the Astra png items for that.
Every claim cites a file path. Append items with "by":"sol" to <dir>/08-grade.json items; do not touch codeHash. Stop.
```
