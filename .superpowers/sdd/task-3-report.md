# Task 3 Report — Add real read-only quality evaluation

Date: 2026-07-30  
Branch: `triage-v5-quality`  
Base HEAD: `1c648564d98178762307ffb582704bb22c3dc1e6`  
Commit: (see git log after checkpoint)  
Subject: `feat(ai): add read-only triage quality evaluator`  
Pushed: no

## Status

**DONE**

## What changed

| Path | Change |
|------|--------|
| `apps/server-pilot/src/ai/quality-eval.ts` | **New.** `qualityLabelSchema`, `runQualityEval`, `compareQualityReports`, exact primary text-visible counts, per-category precision/recall/F1/confusion, per-case outcomes, source/prompt/input hashes, token/latency/cost metadata, protected-regression list, export builders + mutually exclusive CLI arg parser |
| `apps/server-pilot/src/ai/eval-runner.ts` | Quality CLI mode; `assertQualityCliRuntime` / `createQualityModelAdapter` construct explicit `BedrockModelAdapter`; abort unless `NODE_ENV=production` + AI enabled + Bedrock instance |
| `apps/server-pilot/scripts/export-centurion-triage-quality.ts` | **New.** Read-only exporter: `--labels` / `--all-inbound-triggers` / `--targets`; SELECT-only; causal cutoff via `buildCausalTriageMessages`; labels never on model inputs |
| `apps/server-pilot/tests/ai-quality-eval.test.ts` | **New.** High-confidence wrong stays wrong; incomplete injection paths; duplicate/unmatched IDs; attachment-informed exclusion; zero-support F1; no durable writes; exhaustive export causality; paired comparison |
| `apps/server-pilot/tests/ai-eval-runner.test.ts` | Quality CLI parse + production/AI/Bedrock abort contracts |

## TDD evidence

### RED (before impl)

Command:

```bash
pnpm --dir apps/server-pilot exec vitest run \
  tests/ai-quality-eval.test.ts \
  tests/ai-eval-runner.test.ts
```

Result: **2 failed files** — missing `quality-eval.js`; `unsupported eval mode: quality`; `assertQualityCliRuntime` not a function.

Artifact: `.superpowers/sdd/task-3-red.txt`

### GREEN (after impl)

Same targeted suite: **2 files / 25 passed**.

Artifact: `.superpowers/sdd/task-3-green-targeted.txt`

## Verification

| Check | Result |
|-------|--------|
| Targeted vitest (quality + eval-runner) | PASS (25/25) |
| `pnpm --dir apps/server-pilot build` | PASS (`tsc -p tsconfig.json`) |
| Exporter static: insert/update/delete | **zero** |
| Evaluator static: durable apply / DB writes | **zero** |
| Injected JSON/schema/adapter/missing-trigger | report `complete=false`, cases `incomplete` |
| Absolute % release gate | **none** |
| `confidence` branches scoring | **zero** |

Artifact: `.superpowers/sdd/task-3-build.txt`

## Design notes

- Primary metrics count only `evidenceScope='text-visible'` + `adjudication='locked'`.
- Attachment-informed cases remain in `cases[]` but excluded from `categoryErrors` / `urgentErrors` / `jointErrors`.
- Ambiguous labels marked incomplete (`ambiguous-label`) and listed as protected regressions.
- `compareQualityReports` uses baseline best vs candidate worst; eligibility requires `jointErrors` strictly lower, category/urgent no worse, zero protected regressions, complete reports.
- Quality CLI never uses `createFakeModelAdapter` / `resolveModelAdapter`.

## Commit files (explicit stage)

- `apps/server-pilot/src/ai/quality-eval.ts`
- `apps/server-pilot/src/ai/eval-runner.ts`
- `apps/server-pilot/scripts/export-centurion-triage-quality.ts`
- `apps/server-pilot/tests/ai-quality-eval.test.ts`
- `apps/server-pilot/tests/ai-eval-runner.test.ts`

## Concerns

1. Exporter DB path not exercised in Vitest (no pilot RDS); pure builders cover causal export semantics; live export is operator-only under `.tmp/triage-quality/`.
2. Invalid-JSON adapter fixture surfaces as schema incomplete when adapter returns a non-triage object (structured JSON already parsed); true parse failures still map to `invalid-json` via message classifier.
3. `loadNormalRunAsOfByTrigger` takes earliest run `createdAt` per trigger; multiple historical runs for same trigger keep first-by-createdAt.
