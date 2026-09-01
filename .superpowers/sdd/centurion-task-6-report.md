# Centurion Task 6 — Suggested-tool planner tags

## Status

**DONE_WITH_CONCERNS**

## Scope

- Added pure `suggestReadTools` planner.
- Supports workflow folder/overlay/action mapping; spam always yields `[]`.
- Tags read IDs only; no invocation, HMS activation, write IDs, or candidate-draft default changes.
- Wired deterministic tags after `refineTriageOutput`; model-provided tags no longer control planner output.

## TDD evidence

RED (module absent):

```text
pnpm --filter @zero/server exec vitest run tests/suggested-tools.test.ts
Error: Cannot find module '../src/ai/suggested-tools.js'
```

GREEN/final focused run (safety env unset):

```text
4 files passed; 86 passed; 21 skipped
```

Covered planner mapping, neutral/spam empty behavior, exception tags, read-only IDs,
candidate active-set characterization, and post-refine wiring.

## Verification

- `pnpm --filter @zero/server exec tsc --noEmit --pretty false` — pass
- `pnpm --filter @zero/server build` — pass
- Prettier check on owned paths — pass
- `git diff --check` — pass

## Concern

Server package has no `eslint` binary/script; scoped ESLint command unavailable. Typecheck,
build, focused Vitest, and Prettier passed.

## Files

- `apps/server-pilot/src/ai/suggested-tools.ts`
- `apps/server-pilot/tests/suggested-tools.test.ts`
- `apps/server-pilot/src/ai/workflows/mail-triage.ts` (post-refine seam)
- `.superpowers/sdd/centurion-task-6-report.md`

## Commit

`feat(ai): add suggested read tool planner` (final SHA in handoff)
