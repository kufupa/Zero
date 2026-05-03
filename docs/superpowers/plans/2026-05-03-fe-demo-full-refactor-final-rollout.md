# FE-demo Full Refactor — Rollout Log

## Worktree and branch

- **Branch:** `FE-demo-refactor` (created from `FE-demo` @ `ff05946b`).
- **Worktree path:** `C:/Users/gamin/.config/superpowers/worktrees/zero/FE-demo-refactor` (isolated from main workspace dirty files).

## Baseline (pre-refactor)

### Commands

```bash
cd apps/mail && pnpm exec paraglide-js compile --project ./project.inlang --outdir ./paraglide
cd ../.. && pnpm --filter=@zero/mail exec vitest run tests/demo-runtime.test.ts tests/demo-backend-guards.test.ts tests/demo-query-policy.test.ts tests/entry-server-wait.test.ts
```

### Result

**PASS** — 4 files, 56 tests, after Paraglide compile.

### Blocker discovered

`vitest` importing `app/(routes)/settings/general/page.tsx` failed with `Cannot find module '@/paraglide/runtime'` until Paraglide output existed. Output lives under `apps/mail/paraglide/` (generated, not committed). Mitigation: `apps/mail` now exposes `pnpm paraglide:compile`; `test:demo` runs compile first.

### Original workspace (not this worktree)

Known dirty at plan time: `.gitignore`, `apps/mail/vercel.json`. Left unchanged unless a task edits them.

## Task checkpoints

Append pass/fail and SHAs here as tasks complete.
