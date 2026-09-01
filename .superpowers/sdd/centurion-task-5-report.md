# Centurion Task 5 — Mastra mail-triage v6

## Result

Implemented Mastra `mail-triage` v6 plus inbound worker seam.

- Canonical output now carries eleven workflow folders, `P0`–`P5`, `urgent`, overlays, `isSpam`, read-only `suggestedTools`, `sourceScope`, `automationState`, `humanAction`, confidence, rationale, policy flags, and `abstainReason`.
- `TRIGGER_BODY_LIMIT = 8192`; `CONTEXT_BODY_LIMIT = 2000`.
- Trigger body remains full for refine/apply; only model prompt context is capped.
- User prompt includes causal `threadSignals`, Legacy Hotels outbound evidence, and validated ReserveCloud Penny staff metadata.
- System prompt documents R22/R23, wrapper/noreply boundaries, 10+ group threshold, and forbids legacy `ops` as v6 primary.
- Workflow metrics stamp `promptVersion: triage-v6` while retaining model, usage, prompt/input hashes, raw output, rationale, policy flags, and sanitized thread signals.
- Worker validates canonical output, passes sender/recipient metadata into durable apply, accepts v5 runs through compatibility while stamping the v6 seam, and no longer enqueues candidate drafts from inbound triage.
- Read-tool IDs remain tags only; no tool invocation, draft AI activation, or HMS activation added.

## TDD evidence

RED test added first for body budgets, v6 folders/priorities/schema, R22/R23 prompt text, no `ops` primary teaching, thread signals, and worker canonical/draft boundary.

Focused command (RDS safety env unset):

```text
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS NODE_ENV
pnpm --filter @zero/server exec vitest run tests/ai-triage-contract.test.ts tests/ai-triage-input.test.ts tests/ai-worker-contract.test.ts
```

Result: `3` files passed, `65` tests passed, `20` DB-gated tests skipped.

Build/typecheck:

```text
pnpm --filter @zero/server exec tsc --noEmit -p tsconfig.json
pnpm --filter @zero/server build
```

Both passed. `git diff --check` passed for Task 5 paths.

## Compatibility/divergence

`classifyMailTriage` retains a v5-shaped return adapter for existing direct callers; Mastra and worker paths are canonical v6. Legacy run prompt versions remain accepted by the worker during cutover, but Mastra input and metrics use `triage-v6`. Existing explicit `candidate_draft` execution code remains available for its legacy gate; inbound triage no longer creates candidate-draft runs.

No DB-required tests ran because no disposable DB was required/available; pilot/production RDS was not touched.
