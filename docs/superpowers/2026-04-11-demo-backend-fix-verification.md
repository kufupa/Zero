# 2026-04-11 Demo Backend Fix Verification

Task: `frontend-demo-backend-decoupling_94bd12d0`, Task 7

## 1) Test pack and lint

### `pnpm --filter=@zero/mail run test:demo`
- Result: **Passed**
- Output summary:
  - `Test Files  18 passed (18)`
  - `Tests  112 passed (112)`
- Note:
  - pnpm prints `No projects matched the filters ...` for the workspace root context, but still executes under `apps/mail` and completes successfully.

### `pnpm --filter=@zero/mail run lint`
- Result: **Failed**
- Blocker summary:
  - `239 problems (191 errors, 48 warnings)`
  - Failures are widespread and include:
    - `@typescript-eslint/no-explicit-any`
    - `react-hooks/rules-of-hooks`
    - `react/no-unescaped-entities`
    - `react/jsx-no-target-blank`
    - `@typescript-eslint/no-unused-vars`
    - generated locale bundles and existing mail UI/route files
- Representative failure classes are in:
  - `apps/mail/app/(auth)/*.tsx` (unused vars, `any`, entities)
  - `apps/mail/components/**/*.tsx` (`any`, hook rules, hook deps, prop validation)
  - `apps/mail/hooks/*.ts` and `apps/mail/lib/**/*.ts` (`any`, hook usage)
  - `apps/mail/paraglide/messages/*.js` (unused vars)
- Risk: lint failure is not isolated to the Task 7 changes and blocks a fully green lint gate until baseline or scoped remediation is done.

## 2) Smoke check

### `pnpm run dev:demo:frontend`
- Result: **Ran successfully**
- Command exists and starts the frontend-only demo flow.
- Observed startup lines:
  - `[local-dev] FE-only demo mode active; skipping backend startup.`
  - `➜  Local:   http://localhost:3000/`
- Note:
  - Process stayed running during the smoke check window with the expected local URL printed.

## Remaining risks
- The current lint baseline appears materially pre-existing and noisy; if CI requires lint clean, this must be resolved before claiming task completion.
- There are too many existing lint blockers across settings/auth/route files and generated artifacts to confidently classify as introduced-only by this task.

