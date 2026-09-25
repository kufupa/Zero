# 7 Backtest

Checks: `bt.no.tool_bug`

Chain per case: mail (+PDF) → Luna (max, batches of 7) → tool request JSON → CLI live → compare to `answerKey` by script.

1. Luna prompt file lives in `.private/pms-pipeline/<tool>/luna-prompt.txt`. Luna gets file paths, never pasted mail.
2. Tune on `tune` cases. Then run all `test` cases. Rerun test after fixes; fix classes, not single cases.
3. Compare exact native ids. Tool-specific hit rule in `tools/<tool>.md`.
4. Classify every miss:

| missClass | Means | Blocks |
|---|---|---|
| `tool_bug` | Right input, wrong/no output | yes |
| `extract_bug` | Luna built wrong input | no (fix prompt anyway) |
| `mail_lacks` | Mail never names it | no |
| `hms_lacks` | Profile absent in HMS | only if `astraConfirmed` false |

`hms_lacks` needs a fresh Astra high search proving absence (`astraConfirmed: true`, png).

Output `07-backtest.json`:

```json
{ "cases": [ { "id": "<case>", "split": "test", "result": "miss", "missClass": "hms_lacks", "astraConfirmed": true, "evidence": "png/m3-absent.png" } ], "summary": { "hitAt1": 0.0, "hitAtK": 0.0 } }
```
