# Centurion Task 11 — Spam FP regression harness

Status: DONE

## Scope

Added synthetic v6 spam false-positive fixtures for AE12–AE19 plus a negative
newsletter case. The harness sends every fixture through canonical workflow
classification/refinement with a fake adapter that initially returns spam,
then applies the refined output through a mocked durable-apply DB. It asserts
zero `legitimate-mail-marked-spam` protected regressions, expected workflow
folders/policy flags, newsletter retention in spam, and `spamAt` clear/set
behavior.

Quality evaluation now retains the refined canonical v6 output as
`actualWorkflow`, preserves causal recipient metadata (`to`/`cc`/`bcc`), and
uses canonical `isSpam` when calculating the protected regression. Existing
legacy category/urgency metrics remain unchanged; evaluator remains read-only.

## TDD evidence

RED, after fixture and harness test were added and before the quality-eval seam
change:

```text
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS NODE_ENV
pnpm --filter @zero/server exec vitest run tests/spam-fp-v6.test.ts --reporter=dot

1 failed. AssertionError: AE12: expected undefined to be defined
The missing value was `QualityCaseOutcome.actualWorkflow`.
```

Focused GREEN:

```text
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS NODE_ENV
pnpm --filter @zero/server exec vitest run tests/spam-fp-v6.test.ts --reporter=dot

Test Files  1 passed (1)
Tests       1 passed (1)
```

Related quality/refinement/contract suite:

```text
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS NODE_ENV
pnpm --filter @zero/server exec vitest run \
  tests/spam-fp-v6.test.ts tests/ai-quality-eval.test.ts \
  tests/ai-triage-refine.test.ts tests/ai-triage-contract.test.ts --reporter=dot

Test Files  4 passed (4)
Tests       82 passed | 9 skipped (91)
```

Server typecheck:

```text
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS NODE_ENV
pnpm --filter @zero/server exec tsc --noEmit --pretty false -p tsconfig.json

PASS (no output)
```

Diff check:

```text
git diff --cached --check

PASS (no output)
```

No `DATABASE_URL`, `VITEST_ALLOW_PILOT_RDS`, or `NODE_ENV` was set for Vitest;
no pilot/production DB, HMS activation, dashboard, or draft path was used.

## Follow-up fix — prompt-version hashes

Reviewer finding fixed: `runQualityEval` now passes each input's `promptVersion`
to `classifyWorkflowMailTriage`. This keeps v6 as the classifier default for
legacy callers while making v5 quality cases hash as v5; legacy category,
urgency, and joint metrics remain unchanged.

TDD RED, before the adapter seam fix:

```text
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS NODE_ENV
pnpm --filter @zero/server exec vitest run tests/ai-quality-eval.test.ts \
  -t 'passes input prompt version through to workflow hashes' --reporter=dot

1 failed: v5 and v6 case prompt hashes were equal (both defaulted to v6)
```

Focused GREEN:

```text
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS NODE_ENV
pnpm --filter @zero/server exec vitest run tests/ai-quality-eval.test.ts \
  -t 'passes input prompt version through to workflow hashes' --reporter=dot

Test Files  1 passed (1)
Tests       1 passed | 20 skipped (21)
```

Task 11/related suite:

```text
unset DATABASE_URL VITEST_ALLOW_PILOT_RDS NODE_ENV
pnpm --filter @zero/server exec vitest run \
  tests/spam-fp-v6.test.ts tests/ai-quality-eval.test.ts \
  tests/ai-triage-refine.test.ts tests/ai-triage-contract.test.ts --reporter=dot

Test Files  4 passed (4)
Tests       83 passed | 9 skipped (92)
```

The regression asserts v5/v6 `promptHash` and `inputHash` differ while
canonical output and all legacy error metrics match. Server tsc passed; staged
Task 11 diff check passed. Vitest ran with DB env vars unset.

## Changed files

- `apps/server-pilot/tests/fixtures/spam-fp-v6.jsonl`
- `apps/server-pilot/tests/spam-fp-v6.test.ts`
- `apps/server-pilot/tests/ai-quality-eval.test.ts`
- `apps/server-pilot/src/ai/quality-eval.ts`

## Commit

Implementation: `47c0a923` (`test(ai): add v6 spam false-positive harness`)
Fixture-shape follow-up: `68465f07` (`test(ai): cover long quoted spam FP body`)
Prompt-version hash fix: `2865fa7f` (`fix(ai): preserve quality eval prompt version hashes`)

## Concerns

- Apply assertions use an in-memory mocked DB by design; no disposable/pilot
  database was required or contacted.
- Fixture sender addresses are synthetic acceptance shapes from AE12–AE19;
  no raw mailbox bodies or live corpus data are included.
- Quality reports now carry the canonical refined output for local harnesses;
  legacy scoring fields and evaluator write-safety contract remain intact.
- Repository-wide `git diff --check` still reports pre-existing trailing
  whitespace in unrelated dirty paths; Task 11 staged/commit-scoped checks pass.
