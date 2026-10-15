# Reservationist agent Promptfoo replay

Local MIT CLI. Scores the **shipped Mastra agent** on gold pairs: same path as `replay-ops` (stub HMS, Azure Luna). Spine: score what ships.

**One scorer:** `score-row.ts` (`scoreRow` + `runReservationistEvalAgent`). Promptfoo asserts, `aop-eval.ts` (replaces Driver C `runs/c-eval/aop-eval.ts`), and the GEPA adapter all import this module. Same-move = `staffMoveToOperations` + `decisionToOperations` + `opKey`. Required stay fields counted on the decision (`fieldsFound`). Gold `unknown` + predicted `unknown` is `abstain-ok`.

## Promptfoo provider

`provider.ts` `callApi(prompt, context)` loads one snapshot row (`vars.pairsPath` + `vars.messageId`), runs the agent helper, returns `{output: JSON.stringify({workflow, operations, decision})}`. Promptfoo `metric` is the gold workflow.

## Generate tests (no bodies in git)

Private labels+pairs under `/home/orca/nava-research/gold/…`. Config stores paths and ids only. `--split` is `train` or `dev` — never `test`.

```bash
cd apps/server-pilot
pnpm exec tsx evals/agent/provider.ts \
  --labels /home/orca/nava-research/gold/all711/labels.dev.shard0.jsonl \
  --pairs /home/orca/nava-research/gold/all711/pairs.jsonl \
  --split dev --limit 25 --offset 0 \
  --out /tmp/nava-agent-promptfoo-tests.json
```

Merge `tests` from that JSON into a local copy of `promptfooconfig.yaml` (do not commit ids from prod gold). Then:

```bash
PROMPTFOO_DISABLE_TELEMETRY=1 PROMPTFOO_DISABLE_REMOTE_GENERATION=true \
  pnpm exec promptfoo eval -c evals/agent/promptfooconfig.yaml --share false
```

## CLI (Driver C replacement)

```bash
pnpm exec tsx evals/agent/aop-eval.ts --gold FILE [--sop PATH --export NAME] [--limit N] [--concurrency 6] [--out FILE]
```

`--gold` is snapshot+label JSONL (private). Prints aggregate counts. `--out` is ids + labels, no mail text.

## aopSops

Optional Promptfoo `vars.sops` = path to JSON `{workflow: text}`. **TODO(BRAIN-B):** `createReservationistAgent` on main has no `aopSops` option, so the provider loads the file but does not append it until that option exists (`agentAcceptsAopSops()`). CLI `--sop` still appends SOP text to `hotelRules` (Driver C behaviour).

## Not in this lane

Do not run against real gold here. The driver runs slices. Unit tests use synthetic fixtures only.
