| Fact | Answer | Evidence |
|---|---|---|
| Rules, schema, version | Yes: `ACTION_CLASSIFICATION_RULES` lives in extraction prompt and output already has top-level `action`, `needsAction`, `actionEvidence`, `actionConfidence`. `stays[]` has no `guestNames` field in current schema. Version hash includes action rules and serialized extraction schema; schema/prompt edits normally create a new extraction version/read. **Inference:** extra fields can shift action output because same model call emits both. | [extract.ts:68](/tmp/opus-run-1020/plan-src/apps/server-pilot/src/ai/extraction/extract.ts:68), [extract.ts:226](/tmp/opus-run-1020/plan-src/apps/server-pilot/src/ai/extraction/extract.ts:226), [schema.ts:32](/tmp/opus-run-1020/plan-src/apps/server-pilot/src/ai/extraction/schema.ts:32), [schema.ts:60](/tmp/opus-run-1020/plan-src/apps/server-pilot/src/ai/extraction/schema.ts:60), [inbound-run.ts:77](/tmp/opus-run-1020/plan-src/apps/server-pilot/src/ai/extraction/inbound-run.ts:77), [inbound-run.ts:97](/tmp/opus-run-1020/plan-src/apps/server-pilot/src/ai/extraction/inbound-run.ts:97), [inbound-run.ts:160](/tmp/opus-run-1020/plan-src/apps/server-pilot/src/ai/extraction/inbound-run.ts:160). |
| Frozen eval + input | Export used production `loadSyncedQuoteSelectionFromMailbox`/attachment text, then local `buildInboundPrompt` with prior-only thread context. Text-only: images omitted. Flow: `export.ts` on EC2 → `build-prompts.ts` on VPS → `work/predict.py` → `work/score.py`; frozen files live under `/home/orca/nava-research/triage-20261019/`. | [eval doc:3](/home/ubuntu/projects/zero/.worktrees/oct18-c1-classify/docs/research/2026-10-19-leak-free-triage-eval.md:3), [eval doc:15](/home/ubuntu/projects/zero/.worktrees/oct18-c1-classify/docs/research/2026-10-19-leak-free-triage-eval.md:15), [eval doc:16](/home/ubuntu/projects/zero/.worktrees/oct18-c1-classify/docs/research/2026-10-19-leak-free-triage-eval.md:16), [build-prompts.ts:2](/home/ubuntu/projects/zero/.worktrees/oct18-c1-classify/apps/server-pilot/scripts/triage-dataset/build-prompts.ts:2), [export.ts:119](/home/ubuntu/projects/zero/.worktrees/oct18-c1-classify/apps/server-pilot/scripts/triage-dataset/export.ts:119), [eval doc:79](/home/ubuntu/projects/zero/.worktrees/oct18-c1-classify/docs/research/2026-10-19-leak-free-triage-eval.md:79). |
| Run size | Frozen test = 431/431 rows. Historical prediction batch = 617/617 test+val rows (431 test + 186 val); `predict.py` accepts an IDs file to run test-only. Default concurrency 32; default effort `xhigh`. | [eval doc:20](/home/ubuntu/projects/zero/.worktrees/oct18-c1-classify/docs/research/2026-10-19-leak-free-triage-eval.md:20), [RUNLOG.md:11](/home/orca/nava-research/triage-20261019/RUNLOG.md:11), [predict.py:9](/home/orca/nava-research/triage-20261019/work/predict.py:9), [predict.py:11](/home/orca/nava-research/triage-20261019/work/predict.py:11). |
| Wall-clock | Logged checkpoints: v4 reached 600/617 in 239s; baseline run 2 reached 600/617 in 414s; both then completed 617/617. Final elapsed time omitted. **Inference:** roughly 4–7 min per historical 617-row batch; exact 431-only time not recorded. | [pred-v4.log:3](/home/orca/nava-research/triage-20261019/work/pred-v4.log:3), [pred-v4.log:4](/home/orca/nava-research/triage-20261019/work/pred-v4.log:4), [pred-base2.log:3](/home/orca/nava-research/triage-20261019/work/pred-base2.log:3), [pred-base2.log:4](/home/orca/nava-research/triage-20261019/work/pred-base2.log:4). |
| Model cost | Predictor uses `gpt-6-luna`; labels use Luna + `gpt-6.1-sol`. Existing v4 test rows logged 3,147,799 input + 3,282,366 output tokens / 431 rows (2026-10-19). Report gives ≈$31 / 1 initial eval campaign at Luna list price, with Sol share imputed at Luna rate—not a per-pass or per-model breakdown. **Per-run USD: not found.** | [predict.py:26](/home/orca/nava-research/triage-20261019/work/predict.py:26), [label.py:120](/home/orca/nava-research/triage-20261019/work/label.py:120), [label.py:122](/home/orca/nava-research/triage-20261019/work/label.py:122), [eval doc:79](/home/ubuntu/projects/zero/.worktrees/oct18-c1-classify/docs/research/2026-10-19-leak-free-triage-eval.md:79); token counts: appendix script. |
| Branch prompt replay | Yes, with rebuild: `build-prompts.ts` imports prompt/schema from its checkout and writes `.parts.json`; run it from candidate branch on saved exports, then point runner at rebuilt files. Existing `predict.py` alone loads frozen `.parts.json`; rules-file argument swaps only action rules. Prediction still calls model API; no call made here. **Inference:** branch replay needs no fresh prod/HMS read, but does need network for inference. | [build-prompts.ts:4](/home/ubuntu/projects/zero/.worktrees/oct18-c1-classify/apps/server-pilot/scripts/triage-dataset/build-prompts.ts:4), [build-prompts.ts:9](/home/ubuntu/projects/zero/.worktrees/oct18-c1-classify/apps/server-pilot/scripts/triage-dataset/build-prompts.ts:9), [build-prompts.ts:96](/home/ubuntu/projects/zero/.worktrees/oct18-c1-classify/apps/server-pilot/scripts/triage-dataset/build-prompts.ts:96), [predict.py:12](/home/orca/nava-research/triage-20261019/work/predict.py:12), [predict.py:13](/home/orca/nava-research/triage-20261019/work/predict.py:13), [llm.py:34](/home/orca/nava-research/triage-20261019/work/llm.py:34). |
| Historical noise | On frozen test, prod runs scored 349/431 and 359/431 correct (81.0% and 83.3%); their action labels differed on 20/431 rows. V4 scored 389/431. **Inference:** 20/431 flips and 10/431 correct-count spread (~2.3pp) are rough noise markers, not a confidence interval; baseline runs are not repeated v4 runs. | [eval doc:26](/home/ubuntu/projects/zero/.worktrees/oct18-c1-classify/docs/research/2026-10-19-leak-free-triage-eval.md:26), [eval doc:27](/home/ubuntu/projects/zero/.worktrees/oct18-c1-classify/docs/research/2026-10-19-leak-free-triage-eval.md:27), [eval doc:30](/home/ubuntu/projects/zero/.worktrees/oct18-c1-classify/docs/research/2026-10-19-leak-free-triage-eval.md:30); exact counts: appendix script. |

**Cheapest gate (inference):** rebuild prompt/schema from candidate branch on saved inputs; run one Luna pass over 431/431 test rows; compare each top-level action with frozen v4 preds; check parse failures and score with `score.py`. Treat >20/431 action flips or >10/431 fewer correct than v4 as review triggers—not automatic pass/fail bands. Scorer checks action only, not `guestNames`; validate new stay fields separately. Use holdout once; further prompt tuning needs fresh test. [score.py:17](/home/orca/nava-research/triage-20261019/work/score.py:17), [eval doc:50](/home/ubuntu/projects/zero/.worktrees/oct18-c1-classify/docs/research/2026-10-19-leak-free-triage-eval.md:50). The Oct 19 afternoon D lane was separate and had no valid score due input-parity failure. [afternoon retro:15](/home/ubuntu/projects/zero/.worktrees/oct18-c1-classify/docs/context/ledger/2026-10-19-afternoon-retro.md:15), [afternoon retro:39](/home/ubuntu/projects/zero/.worktrees/oct18-c1-classify/docs/context/ledger/2026-10-19-afternoon-retro.md:39).

**Appendix — count script** (reads local files; prints counts only)

```python
import json
from pathlib import Path

R = Path("/home/orca/nava-research/triage-20261019")
test = set(json.load(open(R / "work/split-centurion.json"))["test"])
gold = {r["id"]: r["label"] for r in json.load(
    open(R / "work/silver-transport-centurion.json"))}
pred = {}
for tag in ("base1", "base2", "v4"):
    rows = {}
    for line in open(R / f"preds/pred-centurion-{tag}.jsonl"):
        r = json.loads(line)
        if r.get("id") in test:
            rows[r["id"]] = r
    pred[tag] = rows
    good = sum(r["result"].get("action") == gold[i]
               for i, r in rows.items())
    bad = sum("_error" in r["result"] or "_parse_error" in r["result"]
              for r in rows.values())
    ins = sum(r.get("usage", {}).get("input_tokens", 0)
              for r in rows.values())
    outs = sum(r.get("usage", {}).get("output_tokens", 0)
               for r in rows.values())
    print(tag, f"correct={good}/{len(rows)} errors={bad}/{len(rows)}",
          f"input={ins} output={outs} tokens/{len(rows)} test rows")
flips = sum(pred["base1"][i]["result"].get("action")
            != pred["base2"][i]["result"].get("action") for i in test)
print(f"base1/base2 action flips={flips}/{len(test)}")
```