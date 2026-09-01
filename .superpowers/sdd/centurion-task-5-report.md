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

## Review-fix pass (2026-09-01)

Fixed all five P1/P2 findings:

- Durable metrics now include stable `canonicalOutput` with final refined v6 payload; raw message bodies/recipient inputs remain absent from metrics.
- Input hash now covers causal `to`/`cc`/`bcc` plus resolved thread signals. Prompt hash covers system prompt, dynamic user prompt, and prompt version.
- New inbound enqueue/default resolver is `triage-v6`; explicit `AI_TRIAGE_PROMPT_VERSION=triage-v5` remains the legacy drain seam.
- Refine enforces internal delivery-failure routing/source/automation constraints, recognizes `branding.legacyhotels.co.za`, and routes `hospitality.cloud` finance mail to Money & Billing with payment overlay.
- Prompt group rule now explicitly requires 10+ rooms/delegates; sub-10 multi-room alone remains Bookings.

TDD RED command (expected failures before production fixes):

```text
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS NODE_ENV; pnpm --filter @zero/server exec vitest run tests/ai-triage-contract.test.ts tests/ai-triage-input.test.ts tests/ai-worker-contract.test.ts tests/ai-triage-refine.test.ts tests/ai-enqueue-contract.test.ts
```

Result: exit `1`; `4` files failed, `1` skipped; `9` tests failed, `82` passed, `28` skipped.

Focused GREEN command:

```text
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS NODE_ENV; pnpm --filter @zero/server exec vitest run tests/ai-triage-contract.test.ts tests/ai-triage-input.test.ts tests/ai-worker-contract.test.ts tests/ai-triage-refine.test.ts tests/ai-enqueue-contract.test.ts
```

Result: `4` files passed, `1` skipped; `91` tests passed, `28` skipped.

Relevant ledger/quality/store/tool GREEN command:

```text
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS NODE_ENV; pnpm --filter @zero/server exec vitest run tests/ai-workflow-run-contract.test.ts tests/ai-quality-eval.test.ts tests/suggested-tools.test.ts tests/ai-candidate-draft-contract.test.ts tests/ingest-store.test.ts
```

Result: `5` files passed; `39` tests passed, `35` skipped.

Type/build verification:

```text
pnpm --filter @zero/server exec tsc --noEmit -p tsconfig.json
```

Result: exit `0`, no output.

```text
pnpm --filter @zero/server build
```

Result: exit `0`; `@zero/server@0.0.0 build` ran `tsc -p tsconfig.json`.

Scoped `git diff --check` passed. All Vitest commands unset `DATABASE_URL`, `VITEST_ALLOW_PILOT_RDS`, and `NODE_ENV`; no pilot/production RDS access.
